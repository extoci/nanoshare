#!/usr/bin/env bun

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { networkInterfaces, platform } from "node:os";
import { Command } from "commander";
import {
  MediaStreamTrackFactory,
  RTCPeerConnection,
  useH264,
  type MediaStreamTrack
} from "werift";

type CaptureConfig = {
  ffmpegInputArgs: string[];
  source: string;
};

type SessionStore = Map<string, number>;
type ViewerStore = Map<string, RTCPeerConnection>;

type OfferPayload = {
  type: "offer";
  sdp: string;
};

type SessionDescriptionPayload = {
  type: "answer" | "offer";
  sdp: string;
};

type SourceMode = "screen" | "testsrc";

type CliOptions = {
  port?: number;
  pin?: string;
  fps?: number;
  videoBitrate?: string;
  useHwaccel?: boolean;
  source?: SourceMode;
  rtpPort?: number;
};

type RuntimeConfig = {
  port: number;
  pin: string;
  fps: number;
  videoBitrate: string;
  useHwaccel: boolean;
  source: SourceMode;
  rtpPort: number;
};

function parsePositiveInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return parsed;
}

function parseSourceMode(value: string): SourceMode {
  if (value === "screen" || value === "testsrc") return value;
  throw new Error(`source must be either "screen" or "testsrc", received "${value}".`);
}

function parseCliOptions(): CliOptions {
  const program = new Command();
  program
    .name("flitty")
    .allowExcessArguments(false)
    .option("-p, --port <number>", "HTTP server port", (value) => parsePositiveInteger(value, "port"))
    .option("--pin <pin>", "Access PIN for viewers")
    .option("-f, --fps <number>", "Capture and encode frame rate", (value) => parsePositiveInteger(value, "fps"))
    .option("-b, --video-bitrate <bitrate>", "Video bitrate (for example 14M)")
    .option("--use-hwaccel", "Enable hardware encoder on macOS (h264_videotoolbox)")
    .option("--source <mode>", 'Capture source ("screen" or "testsrc")', parseSourceMode)
    .option("--rtp-port <number>", "Local RTP ingress port", (value) => parsePositiveInteger(value, "rtp-port"));

  program.parse(process.argv);
  return program.opts<CliOptions>();
}

function getRuntimeConfig(): RuntimeConfig {
  const cli = parseCliOptions();
  const env = process.env;

  return {
    port: cli.port ?? parsePositiveInteger(env.FLITTY_PORT ?? "37777", "FLITTY_PORT"),
    pin: cli.pin ?? env.FLITTY_PIN ?? generatePin(),
    fps: cli.fps ?? parsePositiveInteger(env.FLITTY_FPS ?? "30", "FLITTY_FPS"),
    videoBitrate: cli.videoBitrate ?? env.FLITTY_VIDEO_BITRATE ?? "14M",
    useHwaccel: cli.useHwaccel ?? env.FLITTY_USE_HWACCEL === "1",
    source: cli.source ?? parseSourceMode(env.FLITTY_SOURCE ?? "screen"),
    rtpPort: cli.rtpPort ?? parsePositiveInteger(env.FLITTY_RTP_PORT ?? "5004", "FLITTY_RTP_PORT")
  };
}

const config = getRuntimeConfig();

const PORT = config.port;
const PIN = config.pin;
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const FPS = config.fps;
const VIDEO_BITRATE = config.videoBitrate;
const USE_HWACCEL = config.useHwaccel;
const SOURCE = config.source;
const RTP_PORT = config.rtpPort;

const sessions: SessionStore = new Map();
const viewers: ViewerStore = new Map();

let ffmpegProcess: ReturnType<typeof spawn> | null = null;
let ffmpegLogs = "";
let trackDispose: (() => void) | null = null;
let sharedVideoTrack: MediaStreamTrack | null = null;

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m"
} as const;

function generatePin(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function html(content: string): Response {
  return new Response(content, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function parseCookies(rawCookie: string): Map<string, string> {
  const cookieMap = new Map<string, string>();
  if (!rawCookie) return cookieMap;

  rawCookie.split(";").forEach((chunk) => {
    const [rawName, ...rest] = chunk.trim().split("=");
    if (!rawName || rest.length === 0) return;
    cookieMap.set(rawName, decodeURIComponent(rest.join("=")));
  });

  return cookieMap;
}

function createSession(): { id: string; expiresAt: number } {
  const id = randomBytes(24).toString("base64url");
  const expiresAt = Date.now() + SESSION_TTL_MS;
  sessions.set(id, expiresAt);
  return { id, expiresAt };
}

function getValidSessionId(req: Request): string | null {
  const cookie = req.headers.get("cookie") ?? "";
  const sessionId = parseCookies(cookie).get("flitty_session");
  if (!sessionId) return null;

  const expiresAt = sessions.get(sessionId);
  if (!expiresAt) return null;

  if (Date.now() > expiresAt) {
    sessions.delete(sessionId);
    return null;
  }

  return sessionId;
}

function isAuthorized(req: Request): boolean {
  return getValidSessionId(req) !== null;
}

function cleanupExpiredSessions(): void {
  const now = Date.now();
  for (const [id, expiresAt] of sessions.entries()) {
    if (expiresAt <= now) sessions.delete(id);
  }
}

function getLanIp(): string {
  const interfaces = networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    if (!entries) continue;
    for (const entry of entries) {
      if (entry.family === "IPv4" && !entry.internal) return entry.address;
    }
  }
  return "127.0.0.1";
}

function paint(text: string, ...codes: string[]): string {
  return `${codes.join("")}${text}${ANSI.reset}`;
}

function printCliPanel(lanUrl: string, localUrl: string): void {
  const rows = [
    { text: "Flitty Realtime", tone: "title" as const },
    { text: "Open URL on same network, enter PIN once.", tone: "hint" as const },
    { text: `LAN URL : ${lanUrl}`, tone: "normal" as const },
    { text: `Local   : ${localUrl}`, tone: "normal" as const },
    { text: `PIN     : ${PIN}`, tone: "pin" as const },
    { text: `Video   : ${FPS} fps | ${VIDEO_BITRATE} | WebRTC H.264`, tone: "normal" as const },
    { text: "Stop    : Ctrl+C", tone: "hint" as const }
  ];

  const width = rows.reduce((max, row) => Math.max(max, row.text.length), 0);
  const top = `┌${"─".repeat(width + 2)}┐`;
  const bottom = `└${"─".repeat(width + 2)}┘`;

  console.log("");
  console.log(paint(top, ANSI.cyan));
  for (const row of rows) {
    const line = `│ ${row.text.padEnd(width)} │`;
    if (row.tone === "title") {
      console.log(paint(line, ANSI.bold, ANSI.green));
      continue;
    }
    if (row.tone === "pin") {
      console.log(paint(line, ANSI.bold, ANSI.yellow));
      continue;
    }
    if (row.tone === "hint") {
      console.log(paint(line, ANSI.dim));
      continue;
    }
    console.log(line);
  }
  console.log(paint(bottom, ANSI.cyan));
  console.log("");
}

function detectMacScreenInputIndex(): number {
  const probe = spawnSync("ffmpeg", ["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""], {
    encoding: "utf8"
  });
  const output = `${probe.stdout ?? ""}\n${probe.stderr ?? ""}`;
  const regex = /\[(\d+)\]\s+Capture screen/i;
  const match = output.match(regex);
  if (!match) {
    throw new Error("Could not auto-detect a macOS capture device. Ensure Screen Recording permissions are granted.");
  }
  return Number(match[1]);
}

function detectWindowsPrimaryBounds(): { x: number; y: number; width: number; height: number } | null {
  const probe = spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      "Add-Type -AssemblyName System.Windows.Forms; $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; Write-Output \"$($b.X),$($b.Y),$($b.Width),$($b.Height)\""
    ],
    { encoding: "utf8" }
  );

  if (probe.status !== 0) return null;
  const output = `${probe.stdout ?? ""}`.trim();
  const match = output.match(/^(-?\d+),(-?\d+),(\d+),(\d+)$/);
  if (!match) return null;

  return {
    x: Number(match[1]),
    y: Number(match[2]),
    width: Number(match[3]),
    height: Number(match[4])
  };
}

function buildCaptureConfig(): CaptureConfig {
  if (SOURCE === "testsrc") {
    return {
      source: `FFmpeg lavfi testsrc (${FPS}fps)`,
      ffmpegInputArgs: [
        "-re",
        "-f",
        "lavfi",
        "-i",
        `testsrc2=size=1920x1080:rate=${FPS}`
      ]
    };
  }

  const currentPlatform = platform();

  if (currentPlatform === "darwin") {
    const screenIndex = detectMacScreenInputIndex();
    return {
      source: `macOS avfoundation screen index ${screenIndex}`,
      ffmpegInputArgs: [
        "-f",
        "avfoundation",
        "-framerate",
        String(FPS),
        "-capture_cursor",
        "1",
        "-capture_mouse_clicks",
        "1",
        "-i",
        `${screenIndex}:none`
      ]
    };
  }

  if (currentPlatform === "win32") {
    const bounds = detectWindowsPrimaryBounds();
    return {
      source: bounds
        ? `Windows gdigrab primary screen ${bounds.width}x${bounds.height} @ (${bounds.x},${bounds.y})`
        : "Windows gdigrab desktop",
      ffmpegInputArgs: [
        "-f",
        "gdigrab",
        "-framerate",
        String(FPS),
        "-draw_mouse",
        "1",
        ...(bounds
          ? [
              "-offset_x",
              String(bounds.x),
              "-offset_y",
              String(bounds.y),
              "-video_size",
              `${bounds.width}x${bounds.height}`
            ]
          : []),
        "-i",
        "desktop"
      ]
    };
  }

  if (currentPlatform === "linux") {
    const display = process.env.FLITTY_DISPLAY ?? process.env.DISPLAY ?? ":0.0";
    return {
      source: `Linux x11grab ${display}`,
      ffmpegInputArgs: ["-f", "x11grab", "-framerate", String(FPS), "-i", display]
    };
  }

  throw new Error(`Unsupported platform: ${currentPlatform}`);
}

function buildCodecArgs(): string[] {
  if (platform() === "darwin" && USE_HWACCEL) {
    return [
      "-vf",
      "scale=trunc(iw/2)*2:trunc(ih/2)*2",
      "-c:v",
      "h264_videotoolbox",
      "-realtime",
      "1",
      "-allow_sw",
      "1",
      "-b:v",
      VIDEO_BITRATE,
      "-maxrate",
      VIDEO_BITRATE,
      "-bufsize",
      "6M",
      "-g",
      String(FPS),
      "-profile:v",
      "baseline",
      "-level",
      "3.1",
      "-pix_fmt",
      "yuv420p"
    ];
  }

  return [
    "-vf",
    "scale=trunc(iw/2)*2:trunc(ih/2)*2",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-tune",
    "zerolatency",
    "-b:v",
    VIDEO_BITRATE,
    "-maxrate",
    VIDEO_BITRATE,
    "-bufsize",
    "6M",
    "-g",
    String(FPS),
    "-keyint_min",
    String(FPS),
    "-bf",
    "0",
    "-sc_threshold",
    "0",
    "-profile:v",
    "baseline",
    "-level",
    "3.1",
    "-pix_fmt",
    "yuv420p"
  ];
}

async function waitForIceGatheringComplete(peer: RTCPeerConnection, timeoutMs = 1500): Promise<void> {
  if (peer.iceGatheringState === "complete") return;

  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      subscription.unSubscribe();
      resolve();
    }, timeoutMs);

    const subscription = peer.iceGatheringStateChange.subscribe((state) => {
      if (state !== "complete") return;
      clearTimeout(timer);
      subscription.unSubscribe();
      resolve();
    });
  });
}

function createViewerPeer(viewerId: string): RTCPeerConnection {
  const peer = new RTCPeerConnection({
    codecs: {
      video: [useH264({ payloadType: 96 })],
      audio: []
    },
    iceUseIpv6: false
  });

  peer.connectionStateChange.subscribe((state) => {
    if (state === "connected") {
      console.log(paint(`[viewer:${viewerId}] connected (${viewers.size} total)`, ANSI.dim));
      return;
    }

    if (state === "failed" || state === "closed") {
      void closeViewer(viewerId, `connection=${state}`);
    }
  });

  peer.iceConnectionStateChange.subscribe((state) => {
    if (state === "disconnected" || state === "failed" || state === "closed") {
      void closeViewer(viewerId, `ice=${state}`);
    }
  });

  return peer;
}

async function createAnswerForOffer(viewerId: string, offer: OfferPayload): Promise<SessionDescriptionPayload> {
  if (!sharedVideoTrack) {
    throw new Error("Shared video track is not ready.");
  }

  const peer = createViewerPeer(viewerId);
  viewers.set(viewerId, peer);

  try {
    peer.addTrack(sharedVideoTrack);
    await peer.setRemoteDescription(offer);
    const answer = await peer.createAnswer();
    await peer.setLocalDescription(answer);
    await waitForIceGatheringComplete(peer);

    const local = peer.localDescription;
    if (!local) {
      throw new Error("Failed to generate local WebRTC answer.");
    }

    return { type: local.type, sdp: local.sdp };
  } catch (error) {
    await closeViewer(viewerId, "offer handling failed");
    throw error;
  }
}

async function closeViewer(viewerId: string, reason: string): Promise<void> {
  const peer = viewers.get(viewerId);
  if (!peer) return;

  viewers.delete(viewerId);
  console.log(paint(`[viewer:${viewerId}] disconnected (${viewers.size} total) ${reason}`, ANSI.dim));

  try {
    await peer.close();
  } catch {
    // ignore
  }
}

async function startFfmpegCapture(): Promise<void> {
  const capture = buildCaptureConfig();
  const codecArgs = buildCodecArgs();
  const [track, port, dispose] = await MediaStreamTrackFactory.rtpSource({
    kind: "video",
    port: RTP_PORT
  });

  sharedVideoTrack = track;
  trackDispose = dispose;

  const output = `rtp://127.0.0.1:${port}?pkt_size=1200`;
  const args = [
    "-hide_banner",
    "-loglevel",
    "warning",
    ...capture.ffmpegInputArgs,
    "-an",
    ...codecArgs,
    "-r",
    String(FPS),
    "-fps_mode",
    "cfr",
    "-f",
    "rtp",
    "-payload_type",
    "96",
    output
  ];

  ffmpegProcess = spawn("ffmpeg", args, {
    stdio: ["ignore", "ignore", "pipe"]
  });

  if (ffmpegProcess.stderr) {
    ffmpegProcess.stderr.setEncoding("utf8");
    ffmpegProcess.stderr.on("data", (chunk: string) => {
      ffmpegLogs = `${ffmpegLogs}${chunk}`.slice(-8000);
    });
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false;

    const resolveOnce = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve();
    };

    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    };

    track.onReceiveRtp.once(() => {
      resolveOnce();
    });

    ffmpegProcess?.on("exit", (code, signal) => {
      const abnormal = !(code === 0 || signal === "SIGTERM" || signal === "SIGKILL");

      if (!settled) {
        rejectOnce(new Error("FFmpeg exited before RTP stream became ready."));
        return;
      }

      if (abnormal) {
        console.error("FFmpeg exited unexpectedly.");
        console.error(`Exit code: ${code} signal: ${signal ?? "none"}`);
        if (ffmpegLogs.trim()) {
          console.error("Recent FFmpeg logs:\n", ffmpegLogs);
        }
        process.exit(1);
      }
    });

    const timeout = setTimeout(() => {
      rejectOnce(new Error("Timed out waiting for RTP packets from FFmpeg."));
    }, 20_000);
  });
}

function stopEverything(): void {
  if (ffmpegProcess && ffmpegProcess.exitCode === null) {
    try {
      ffmpegProcess.kill("SIGKILL");
    } catch {
      // ignore
    }
  }

  for (const [viewerId, peer] of viewers.entries()) {
    viewers.delete(viewerId);
    try {
      void peer.close();
    } catch {
      // ignore
    }
  }

  if (trackDispose) {
    try {
      trackDispose();
    } catch {
      // ignore
    }
    trackDispose = null;
  }

  if (sharedVideoTrack) {
    try {
      sharedVideoTrack.stop();
    } catch {
      // ignore
    }
    sharedVideoTrack = null;
  }
}

function loginPage(errorText?: string): string {
  const errorBanner = errorText
    ? `<div class="alert">${escapeHtml(errorText)}</div>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Flitty</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Geist+Mono:wght@400;500;700&display=swap" rel="stylesheet" />
  <style>
    :root {
      --bg: #050505;
      --bg-alt: #0c0c0c;
      --panel: #0a0a0a;
      --ink: #f5f5f5;
      --muted: #a3a3a3;
      --line: #262626;
      --line-strong: #404040;
      --danger: #ff6b6b;
      --button-bg: #f5f5f5;
      --button-ink: #050505;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100dvh;
      display: grid;
      place-items: center;
      font-family: "Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
      color: var(--ink);
      background:
        linear-gradient(180deg, #090909 0%, #050505 45%, #020202 100%),
        repeating-linear-gradient(
          0deg,
          transparent 0 31px,
          #121212 31px 32px
        );
      padding: 1.25rem;
    }
    .panel {
      width: min(460px, 100%);
      background: linear-gradient(180deg, #0d0d0d 0%, #090909 100%);
      border: 1px solid var(--line-strong);
      padding: 1.4rem 1.4rem 1.3rem;
      box-shadow:
        0 0 0 1px #000,
        0 22px 60px #00000066;
      animation: settle .36s ease-out;
    }
    .badge {
      font-size: .74rem;
      letter-spacing: .2em;
      text-transform: uppercase;
      color: var(--muted);
      margin: 0 0 .6rem;
    }
    h1 {
      margin: 0 0 .4rem;
      font-size: clamp(1.24rem, 2.2vw, 1.55rem);
      line-height: 1.2;
      letter-spacing: .01em;
      text-transform: uppercase;
    }
    p {
      margin: 0 0 1.2rem;
      color: var(--muted);
      line-height: 1.48;
      font-size: .93rem;
    }
    .alert {
      margin: 0 0 .95rem;
      padding: .68rem .78rem;
      border: 1px solid #7f1d1d;
      background: #2a0f0f;
      color: var(--danger);
      font-size: .88rem;
    }
    form { display: grid; gap: .68rem; }
    label {
      font-size: .85rem;
      color: #d4d4d4;
      letter-spacing: .03em;
      text-transform: uppercase;
    }
    input {
      width: 100%;
      border: 1px solid var(--line);
      padding: .86rem .88rem;
      font-size: 1rem;
      letter-spacing: .1em;
      font-family: inherit;
      color: var(--ink);
      background: #050505;
      outline: none;
      transition: border-color .15s ease, box-shadow .15s ease;
    }
    input:focus {
      border-color: #f5f5f5;
      box-shadow: inset 0 0 0 1px #f5f5f5;
    }
    button {
      border: 1px solid var(--button-bg);
      padding: .88rem 1rem;
      font: 700 .88rem "Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
      letter-spacing: .08em;
      text-transform: uppercase;
      cursor: pointer;
      color: var(--button-ink);
      background: var(--button-bg);
      transition: background-color .15s ease, color .15s ease;
    }
    button:hover {
      background: #050505;
      color: var(--button-bg);
    }
    .hint {
      margin-top: .88rem;
      font-size: .78rem;
      color: #8a8a8a;
      border-top: 1px solid var(--line);
      padding-top: .8rem;
      text-transform: uppercase;
      letter-spacing: .05em;
    }
    .hint a {
      color: #f5f5f5;
      text-decoration: none;
      border-bottom: 1px solid #404040;
      padding-bottom: 1px;
      transition: border-color .15s ease, color .15s ease;
    }
    .hint a:hover {
      color: #ffffff;
      border-color: #f5f5f5;
    }
    @keyframes settle {
      from { opacity: 0; transform: translateY(8px); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }
  </style>
</head>
<body>
  <main class="panel">
    <div class="badge">Flitty / Access Gateway</div>
    <h1>Enter Access PIN</h1>
    <p>Use the 6-digit code from the host machine to unlock this low-latency screen stream.</p>
    ${errorBanner}
    <form method="post" action="/auth">
      <label for="pin">PIN</label>
      <input id="pin" name="pin" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" placeholder="123456" required autofocus />
      <button type="submit">Open Live Feed</button>
    </form>
    <div class="hint"><a href="https://github.com/extoci/flitty" target="_blank" rel="noreferrer noopener">View Source on GitHub</a></div>
  </main>
</body>
</html>`;
}

function watchPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Flitty Live Screen</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Geist+Mono:wght@400;500;700&display=swap" rel="stylesheet" />
  <style>
    :root {
      --bg: #000;
      --bg-alt: #0a0a0a;
      --ink: #fafafa;
      --muted: #a3a3a3;
      --line: #262626;
      --ok: #3ddc84;
      --warn: #f8d66d;
      --err: #ff6b6b;
    }
    * {
      box-sizing: border-box;
      border-radius: 0 !important;
    }
    html, body { width: 100%; height: 100%; }
    body {
      margin: 0;
      background:
        linear-gradient(180deg, #050505 0%, #000 100%),
        repeating-linear-gradient(
          90deg,
          transparent 0 39px,
          #111 39px 40px
        );
      overflow: hidden;
      color: var(--ink);
      font-family: "Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    .frame {
      position: relative;
      width: 100vw;
      height: 100vh;
    }
    .chrome {
      position: absolute;
      inset: 0 0 auto 0;
      z-index: 5;
      height: 56px;
      border-bottom: 1px solid var(--line);
      background: #050505ee;
      backdrop-filter: blur(3px);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
      padding: 0 1rem;
    }
    .id {
      font-size: .82rem;
      letter-spacing: .08em;
      text-transform: uppercase;
      color: var(--muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .status {
      display: inline-flex;
      align-items: center;
      gap: .55rem;
      font-size: .82rem;
      letter-spacing: .06em;
      text-transform: uppercase;
      color: var(--ink);
      border: 1px solid var(--line);
      padding: .46rem .6rem;
    }
    .dot {
      width: 9px;
      height: 9px;
      background: var(--muted);
      animation: pulse 1.4s linear infinite;
      transform-origin: center;
    }
    .dot.connected { background: var(--ok); }
    .dot.connecting { background: var(--warn); }
    .dot.error { background: var(--err); }
    .actions {
      display: flex;
      gap: .52rem;
      align-items: center;
      flex-shrink: 0;
    }
    .action {
      border: 1px solid var(--ink);
      background: var(--ink);
      color: #050505;
      font: 700 .78rem "Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
      letter-spacing: .08em;
      text-transform: uppercase;
      padding: .47rem .72rem;
      cursor: pointer;
    }
    .viewport {
      width: 100vw;
      height: 100vh;
      padding-top: 56px;
    }
    video {
      display: block;
      width: 100vw;
      height: calc(100vh - 56px);
      background: #000;
      object-fit: contain;
      border-top: 1px solid #000;
      border-left: 1px solid #000;
      pointer-events: none;
    }
    .is-fullscreen .chrome {
      display: none;
    }
    .is-fullscreen .viewport {
      padding-top: 0;
    }
    .is-fullscreen video {
      height: 100vh;
    }
    @keyframes pulse {
      0%, 100% { opacity: .4; }
      50% { opacity: 1; }
    }
    @media (max-width: 640px) {
      .chrome {
        height: 64px;
        padding: 0 .72rem;
        gap: .6rem;
      }
      .id {
        max-width: 36vw;
        font-size: .74rem;
      }
      .status {
        font-size: .72rem;
        padding: .4rem .5rem;
      }
      .action {
        font-size: .72rem;
        padding: .42rem .55rem;
      }
      .viewport {
        padding-top: 64px;
      }
      video {
        height: calc(100vh - 64px);
      }
    }
  </style>
</head>
<body>
  <main class="frame">
    <header class="chrome">
      <div class="id">Flitty / Viewer</div>
      <div class="status">
        <span id="statusDot" class="dot connecting"></span>
        <span id="statusText">Connecting</span>
      </div>
      <div class="actions">
        <button id="fullscreenBtn" class="action" type="button">Fullscreen</button>
      </div>
    </header>
    <section class="viewport">
      <video id="video" autoplay playsinline muted tabindex="-1"></video>
    </section>
  </main>

  <script>
    const video = document.getElementById("video");
    const statusDot = document.getElementById("statusDot");
    const statusText = document.getElementById("statusText");
    const fullscreenBtn = document.getElementById("fullscreenBtn");
    let peer = null;
    let reconnectTimer = null;

    const setStatus = (state, label) => {
      statusText.textContent = label;
      statusDot.className = "dot " + state;
    };

    const closePeer = () => {
      if (!peer) return;
      try {
        peer.ontrack = null;
      } catch {}
      try {
        peer.close();
      } catch {}
      peer = null;
    };

    const waitForIceGatheringComplete = (pc, timeoutMs = 1500) =>
      new Promise((resolve) => {
        if (pc.iceGatheringState === "complete") {
          resolve();
          return;
        }

        const timer = setTimeout(() => {
          pc.removeEventListener("icegatheringstatechange", onChange);
          resolve();
        }, timeoutMs);

        const onChange = () => {
          if (pc.iceGatheringState !== "complete") return;
          clearTimeout(timer);
          pc.removeEventListener("icegatheringstatechange", onChange);
          resolve();
        };

        pc.addEventListener("icegatheringstatechange", onChange);
      });

    const scheduleReconnect = () => {
      clearTimeout(reconnectTimer);
      setStatus("connecting", "Reconnecting");
      reconnectTimer = setTimeout(() => {
        connect().catch((err) => console.error(err));
      }, 700);
    };

    const connect = async () => {
      clearTimeout(reconnectTimer);
      closePeer();
      setStatus("connecting", "Connecting");

      const pc = new RTCPeerConnection({
        iceServers: []
      });

      peer = pc;
      pc.addTransceiver("video", { direction: "recvonly" });

      pc.ontrack = (event) => {
        const stream = event.streams && event.streams[0]
          ? event.streams[0]
          : new MediaStream([event.track]);

        if (video.srcObject !== stream) {
          video.srcObject = stream;
        }
        video.play().catch(() => {});
      };

      pc.onconnectionstatechange = () => {
        const state = pc.connectionState;
        if (state === "connected") {
          setStatus("connected", "Live");
          return;
        }
        if (state === "connecting") {
          setStatus("connecting", "Connecting");
          return;
        }
        if (state === "failed") {
          setStatus("error", "Connection Failed");
        }
        if (state === "failed" || state === "disconnected" || state === "closed") {
          scheduleReconnect();
        }
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await waitForIceGatheringComplete(pc);

      const response = await fetch("/webrtc/offer", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(pc.localDescription)
      });

      if (!response.ok) {
        setStatus("error", "Signaling Error");
        throw new Error("Signaling failed (" + response.status + ")");
      }

      const answer = await response.json();
      await pc.setRemoteDescription(answer);
    };

    const toggleFullscreen = async () => {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
        return;
      }

      const target = document.documentElement;
      if (target.requestFullscreen) {
        await target.requestFullscreen();
      }
    };

    const syncFullscreenButton = () => {
      const isFullscreen = Boolean(document.fullscreenElement);
      fullscreenBtn.textContent = isFullscreen
        ? "Exit Fullscreen"
        : "Fullscreen";
      document.body.classList.toggle("is-fullscreen", isFullscreen);
    };

    fullscreenBtn.addEventListener("click", () => {
      toggleFullscreen().catch(() => {});
    });

    document.addEventListener("keydown", (event) => {
      if (event.key !== "f" && event.key !== "F") return;
      if (event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
      event.preventDefault();
      toggleFullscreen().catch(() => {});
    });

    document.addEventListener("fullscreenchange", syncFullscreenButton);
    syncFullscreenButton();

    connect().catch((err) => {
      console.error(err);
      setStatus("error", "Connection Failed");
      scheduleReconnect();
    });

    window.addEventListener("beforeunload", () => {
      clearTimeout(reconnectTimer);
      closePeer();
    });
  </script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function readPostedPin(req: Request): Promise<string> {
  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.includes("application/x-www-form-urlencoded")) return "";
  const body = await req.text();
  const params = new URLSearchParams(body);
  return (params.get("pin") ?? "").trim();
}

async function readPostedOffer(req: Request): Promise<OfferPayload | null> {
  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return null;

  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object") return null;

  const maybe = parsed as Record<string, unknown>;
  if (maybe.type !== "offer") return null;
  if (typeof maybe.sdp !== "string" || maybe.sdp.length === 0) return null;

  return {
    type: "offer",
    sdp: maybe.sdp
  };
}

function unauthorized(): Response {
  return new Response("Unauthorized", { status: 401 });
}

function redirect(path: string): Response {
  return new Response(null, {
    status: 302,
    headers: { location: path }
  });
}

async function main(): Promise<void> {
  await startFfmpegCapture();

  const lanIp = getLanIp();
  const publicUrl = `http://${lanIp}:${PORT}/`;
  const localUrl = `http://127.0.0.1:${PORT}/`;

  setInterval(cleanupExpiredSessions, 60_000).unref();

  const server = Bun.serve({
    hostname: "0.0.0.0",
    port: PORT,
    fetch: async (req: Request) => {
      const url = new URL(req.url);
      const { pathname } = url;

      if (pathname === "/health") {
        return new Response("ok", { status: 200 });
      }

      if (pathname === "/") {
        if (isAuthorized(req)) return redirect("/watch");
        return html(loginPage());
      }

      if (pathname === "/auth" && req.method === "POST") {
        const submitted = await readPostedPin(req);
        if (submitted !== PIN) return html(loginPage("Incorrect PIN. Try again."));

        const { id, expiresAt } = createSession();
        const expires = new Date(expiresAt).toUTCString();
        return new Response(null, {
          status: 302,
          headers: {
            location: "/watch",
            "set-cookie": `flitty_session=${id}; Path=/; HttpOnly; SameSite=Lax; Expires=${expires}`
          }
        });
      }

      if (pathname === "/watch") {
        if (!isAuthorized(req)) return redirect("/");
        return html(watchPage());
      }

      if (pathname === "/webrtc/offer" && req.method === "POST") {
        if (!isAuthorized(req)) return unauthorized();

        const offer = await readPostedOffer(req);
        if (!offer) {
          return new Response("Bad offer payload", { status: 400 });
        }

        const viewerId = randomBytes(8).toString("hex");

        try {
          const answer = await createAnswerForOffer(viewerId, offer);
          return new Response(JSON.stringify(answer), {
            status: 200,
            headers: { "content-type": "application/json; charset=utf-8" }
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`Offer handling failed for ${viewerId}: ${message}`);
          if (ffmpegLogs.trim()) {
            console.error("Recent FFmpeg logs:\n", ffmpegLogs);
          }
          return new Response("Failed to create WebRTC session", { status: 500 });
        }
      }

      return new Response("Not found", { status: 404 });
    }
  });

  const shutdown = () => {
    console.log("\nShutting down...");
    server.stop(true);
    stopEverything();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  printCliPanel(publicUrl, localUrl);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  if (ffmpegLogs.trim()) {
    console.error("Recent FFmpeg logs:\n", ffmpegLogs);
  }
  stopEverything();
  process.exit(1);
});
