import { spawn, spawnSync } from "node:child_process";
import { networkInterfaces, platform } from "node:os";
import { randomBytes } from "node:crypto";
import mpegtsRuntime from "mpegts.js/dist/mpegts.js" with { type: "text" };

type CaptureConfig = {
  ffmpegInputArgs: string[];
  source: string;
};

type SessionStore = Map<string, number>;
type LiveSocket = Bun.ServerWebSocket<{ sessionId: string }>;

const PORT = Number(process.env.PORT ?? 37777);
const PIN = process.env.PIN ?? generatePin();
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const FPS = Number(process.env.FPS ?? 30);
const VIDEO_BITRATE = process.env.VIDEO_BITRATE ?? "14M";
const USE_HWACCEL = process.env.USE_HWACCEL === "1";
const SOURCE = process.env.SOURCE ?? "screen";

const sessions: SessionStore = new Map();
const liveSockets = new Set<LiveSocket>();

let ffmpegProcess: ReturnType<typeof spawn> | null = null;
let ffmpegLogs = "";

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
  const sessionId = parseCookies(cookie).get("screenshare_session");
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
    { text: "LAN Screen Share Realtime", tone: "title" as const },
    { text: "Open URL on same network, enter PIN once.", tone: "hint" as const },
    { text: `LAN URL : ${lanUrl}`, tone: "normal" as const },
    { text: `Local   : ${localUrl}`, tone: "normal" as const },
    { text: `PIN     : ${PIN}`, tone: "pin" as const },
    { text: `Video   : ${FPS} fps | ${VIDEO_BITRATE}`, tone: "normal" as const },
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
    const display = process.env.DISPLAY ?? ":0.0";
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
      "28M",
      "-g",
      String(FPS * 2),
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
    "28M",
    "-g",
    String(FPS * 2),
    "-keyint_min",
    String(FPS * 2),
    "-bf",
    "0",
    "-sc_threshold",
    "0",
    "-pix_fmt",
    "yuv420p"
  ];
}

function broadcastChunk(chunk: Buffer): void {
  for (const ws of liveSockets) {
    try {
      ws.send(chunk);
    } catch {
      liveSockets.delete(ws);
    }
  }
}

function startFfmpegCapture(): Promise<void> {
  const capture = buildCaptureConfig();
  const codecArgs = buildCodecArgs();

  const args = [
    "-hide_banner",
    "-loglevel",
    "warning",
    "-fflags",
    "+genpts",
    ...capture.ffmpegInputArgs,
    "-an",
    ...codecArgs,
    "-r",
    String(FPS),
    "-fps_mode",
    "cfr",
    "-f",
    "mpegts",
    "-flush_packets",
    "1",
    "-muxdelay",
    "0",
    "-muxpreload",
    "0",
    "pipe:1"
  ];

  ffmpegProcess = spawn("ffmpeg", args, {
    stdio: ["ignore", "pipe", "pipe"]
  });

  if (!ffmpegProcess.stdout) {
    throw new Error("Failed to open FFmpeg stdout pipe.");
  }

  if (ffmpegProcess.stderr) {
    ffmpegProcess.stderr.setEncoding("utf8");
    ffmpegProcess.stderr.on("data", (chunk: string) => {
      ffmpegLogs = `${ffmpegLogs}${chunk}`.slice(-8000);
    });
  }

  console.log(`Capture source: ${capture.source}`);

  return new Promise((resolve, reject) => {
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

    ffmpegProcess?.stdout?.on("data", (chunk: Buffer) => {
      if (!settled) resolveOnce();
      broadcastChunk(chunk);
    });

    ffmpegProcess?.on("exit", (code, signal) => {
      const abnormal = !(code === 0 || signal === "SIGTERM" || signal === "SIGKILL");

      if (!settled) {
        rejectOnce(new Error("FFmpeg exited before stream became ready."));
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
      rejectOnce(new Error("Timed out waiting for realtime stream packets."));
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

  for (const ws of liveSockets) {
    try {
      ws.close();
    } catch {
      // ignore
    }
  }
  liveSockets.clear();
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
  <title>LAN Screen Share</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Archivo:wght@500;700&family=IBM+Plex+Sans:wght@400;500&display=swap" rel="stylesheet" />
  <style>
    :root {
      --bg: #f2f6f5;
      --panel: #ffffffdd;
      --ink: #14211f;
      --muted: #54716a;
      --accent: #1a8d73;
      --accent-ink: #e9fffa;
      --danger: #8f2f2f;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100dvh;
      display: grid;
      place-items: center;
      font-family: "IBM Plex Sans", sans-serif;
      color: var(--ink);
      background:
        radial-gradient(circle at 12% 18%, #b5f3df 0 18%, transparent 40%),
        radial-gradient(circle at 84% 82%, #b9deff 0 20%, transparent 42%),
        linear-gradient(140deg, #f9fcfb 0%, #eef5f3 45%, #f9fafc 100%);
      padding: 1.25rem;
    }
    .panel {
      width: min(460px, 100%);
      background: var(--panel);
      border: 1px solid #d0ddd8;
      border-radius: 20px;
      padding: 1.4rem;
      box-shadow:
        0 15px 45px #213d3a1f,
        inset 0 1px 0 #ffffff;
      backdrop-filter: blur(10px);
      animation: settle .48s ease-out;
    }
    .badge {
      font-size: .75rem;
      letter-spacing: .18em;
      text-transform: uppercase;
      color: #2f6558;
      margin: 0 0 .55rem;
      font-family: "Archivo", sans-serif;
    }
    h1 {
      margin: 0;
      font: 700 clamp(1.45rem, 2.5vw, 1.85rem) "Archivo", sans-serif;
      letter-spacing: -.02em;
    }
    p {
      margin: .55rem 0 1.2rem;
      color: var(--muted);
      line-height: 1.35;
    }
    .alert {
      margin: 0 0 .9rem;
      padding: .65rem .8rem;
      border-radius: .7rem;
      border: 1px solid #ebbbbb;
      background: #fff2f2;
      color: var(--danger);
      font-size: .95rem;
    }
    form { display: grid; gap: .72rem; }
    label { font-size: .9rem; color: #25554a; }
    input {
      width: 100%;
      border: 1px solid #bad4cb;
      border-radius: .82rem;
      padding: .9rem .95rem;
      font-size: 1.02rem;
      letter-spacing: .08em;
      font-family: "Archivo", sans-serif;
      color: var(--ink);
      background: #fbfffe;
      outline: none;
      transition: border-color .2s ease, box-shadow .2s ease;
    }
    input:focus {
      border-color: #1a8d73;
      box-shadow: 0 0 0 4px #1a8d7324;
    }
    button {
      border: 0;
      border-radius: .82rem;
      padding: .9rem 1rem;
      font: 700 .95rem "Archivo", sans-serif;
      letter-spacing: .03em;
      cursor: pointer;
      color: var(--accent-ink);
      background: linear-gradient(95deg, #177961, #1ca786);
      box-shadow: 0 8px 20px #0d54442c;
    }
    button:hover { filter: brightness(1.05); }
    .hint {
      margin-top: .8rem;
      font-size: .84rem;
      color: #3f655e;
    }
    @keyframes settle {
      from { opacity: 0; transform: translateY(8px) scale(.99); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }
  </style>
</head>
<body>
  <main class="panel">
    <div class="badge">LAN Realtime Stream</div>
    <h1>Enter Access PIN</h1>
    <p>Use the 6-digit code shown on the host machine to unlock this local stream.</p>
    ${errorBanner}
    <form method="post" action="/auth">
      <label for="pin">PIN</label>
      <input id="pin" name="pin" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" placeholder="123456" required autofocus />
      <button type="submit">Open Live View</button>
    </form>
    <div class="hint">Low-latency LAN mode is tuned for near-realtime playback.</div>
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
  <title>Watching Live Screen</title>
  <style>
    * { box-sizing: border-box; }
    html, body { width: 100%; height: 100%; }
    body {
      margin: 0;
      background: #000;
      overflow: hidden;
    }
    video {
      width: 100vw;
      height: 100vh;
      background: #000;
      object-fit: contain;
    }
  </style>
</head>
<body>
  <video id="video" autoplay playsinline muted></video>

  <script>
    const video = document.getElementById("video");

    const loadScript = (src) =>
      new Promise((resolve, reject) => {
        const existing = document.querySelector('script[data-mpegts="1"]');
        if (existing) return resolve();
        const script = document.createElement("script");
        script.src = src;
        script.dataset.mpegts = "1";
        script.onload = () => resolve();
        script.onerror = () => reject(new Error("Failed to load MPEGTS runtime"));
        document.head.appendChild(script);
      });

    let player = null;
    let reconnectTimer = null;

    const cleanupPlayer = () => {
      if (!player) return;
      try {
        player.unload();
      } catch {}
      try {
        player.detachMediaElement();
      } catch {}
      try {
        player.destroy();
      } catch {}
      player = null;
    };

    const wsUrl = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      return proto + "://" + location.host + "/live/ws";
    };

    const connect = async () => {
      clearTimeout(reconnectTimer);

      await loadScript("/assets/mpegts.js");
      const mpegts = window.mpegts;
      if (!mpegts || !mpegts.isSupported()) {
        console.error("This browser cannot run realtime MPEG-TS playback.");
        return;
      }

      cleanupPlayer();

      player = mpegts.createPlayer(
        {
          type: "mpegts",
          isLive: true,
          url: wsUrl()
        },
        {
          enableWorker: true,
          lazyLoad: false,
          autoCleanupSourceBuffer: true,
          liveBufferLatencyChasing: true,
          liveBufferLatencyMaxLatency: 1.0,
          liveBufferLatencyMinRemain: 0.2,
          stashInitialSize: 64
        }
      );

      player.attachMediaElement(video);
      player.load();
      video.play().catch(() => {});

      player.on(mpegts.Events.ERROR, (_type, detail) => {
        console.error("Playback error:", String(detail || "unknown"));
        cleanupPlayer();
        reconnectTimer = setTimeout(() => {
          connect().catch((err) => {
            console.error(err);
          });
        }, 700);
      });
    };

    const requestFullscreen = () => {
      if (document.fullscreenElement) return;
      if (video.requestFullscreen) {
        video.requestFullscreen().catch(() => {});
      }
    };
    document.addEventListener("pointerdown", requestFullscreen, { once: true });
    document.addEventListener("keydown", requestFullscreen, { once: true });

    connect().catch((err) => {
      console.error(err);
    });

    window.addEventListener("beforeunload", () => {
      clearTimeout(reconnectTimer);
      cleanupPlayer();
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

  const server = Bun.serve<{ sessionId: string }>({
    hostname: "0.0.0.0",
    port: PORT,
    fetch: async (req: Request, srv) => {
      const url = new URL(req.url);
      const { pathname } = url;

      if (pathname === "/health") {
        return new Response("ok", { status: 200 });
      }

      if (pathname === "/assets/mpegts.js") {
        return new Response(mpegtsRuntime, {
          status: 200,
          headers: {
            "content-type": "text/javascript; charset=utf-8",
            "cache-control": "public, max-age=31536000"
          }
        });
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
            "set-cookie": `screenshare_session=${id}; Path=/; HttpOnly; SameSite=Lax; Expires=${expires}`
          }
        });
      }

      if (pathname === "/watch") {
        if (!isAuthorized(req)) return redirect("/");
        return html(watchPage());
      }

      if (pathname === "/live/ws") {
        const sessionId = getValidSessionId(req);
        if (!sessionId) return unauthorized();

        if (srv.upgrade(req, { data: { sessionId } })) {
          return;
        }

        return new Response("WebSocket upgrade failed", { status: 500 });
      }

      return new Response("Not found", { status: 404 });
    },
    websocket: {
      open(ws: LiveSocket) {
        if (!sessions.has(ws.data.sessionId)) {
          ws.close();
          return;
        }
        liveSockets.add(ws);
        console.log(paint(`[viewer] connected (${liveSockets.size} total)`, ANSI.dim));
      },
      message() {
        // viewer sockets are receive-only
      },
      close(ws: LiveSocket) {
        liveSockets.delete(ws);
        console.log(paint(`[viewer] disconnected (${liveSockets.size} total)`, ANSI.dim));
      }
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
