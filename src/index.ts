import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { networkInterfaces, platform, tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import hlsScript from "hls.js/dist/hls.min.js" with { type: "text" };

type CaptureConfig = {
  ffmpegInputArgs: string[];
  source: string;
};

type SessionStore = Map<string, number>;

const PORT = Number(process.env.PORT ?? 37777);
const PIN = process.env.PIN ?? generatePin();
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const FPS = Number(process.env.FPS ?? 30);
const VIDEO_BITRATE = process.env.VIDEO_BITRATE ?? "12M";
const LIST_SIZE = Number(process.env.HLS_LIST_SIZE ?? 6);
const HLS_TIME = Number(process.env.HLS_TIME ?? 1);
const USE_HWACCEL = process.env.USE_HWACCEL === "1";
const SOURCE = process.env.SOURCE ?? "screen";

const streamId = randomBytes(6).toString("hex");
const hlsPrefix = `/hls/${streamId}/`;
const streamDir = mkdtempSync(join(tmpdir(), "lan-screenshare-"));
const playlistPath = join(streamDir, "live.m3u8");
const segmentPattern = join(streamDir, "seg_%05d.ts");
const sessions: SessionStore = new Map();

let ffmpegProcess: ReturnType<typeof spawn> | null = null;
let ffmpegLogs = "";

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

function isAuthorized(req: Request): boolean {
  const cookie = req.headers.get("cookie") ?? "";
  const sessionId = parseCookies(cookie).get("screenshare_session");
  if (!sessionId) return false;

  const expiresAt = sessions.get(sessionId);
  if (!expiresAt) return false;

  if (Date.now() > expiresAt) {
    sessions.delete(sessionId);
    return false;
  }

  return true;
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
      "24M",
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
    "24M",
    "-g",
    String(FPS * 2),
    "-keyint_min",
    String(FPS * 2),
    "-sc_threshold",
    "0",
    "-pix_fmt",
    "yuv420p"
  ];
}

function startFfmpegCapture(): void {
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
    "hls",
    "-hls_time",
    String(HLS_TIME),
    "-hls_list_size",
    String(LIST_SIZE),
    "-hls_flags",
    "delete_segments+append_list+independent_segments+omit_endlist",
    "-hls_segment_filename",
    segmentPattern,
    playlistPath
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

  ffmpegProcess.on("exit", (code, signal) => {
    if (code === 0 || signal === "SIGTERM") return;
    console.error("FFmpeg exited unexpectedly.");
    console.error(`Exit code: ${code} signal: ${signal ?? "none"}`);
    if (ffmpegLogs.trim()) {
      console.error("Recent FFmpeg logs:\n", ffmpegLogs);
    }
    process.exit(1);
  });

  console.log(`Capture source: ${capture.source}`);
}

async function waitForPlaylist(timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (existsSync(playlistPath)) return;
    await Bun.sleep(150);
  }

  throw new Error(`Timed out waiting for stream to start after ${timeoutMs}ms.`);
}

function stopEverything(): void {
  if (ffmpegProcess && ffmpegProcess.exitCode === null) {
    try {
      ffmpegProcess.kill("SIGKILL");
    } catch {
      // ignore
    }
  }
  rmSync(streamDir, { recursive: true, force: true });
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
    <div class="badge">LAN Secure Stream</div>
    <h1>Enter Access PIN</h1>
    <p>Use the 6-digit code shown on the host machine to unlock this local stream.</p>
    ${errorBanner}
    <form method="post" action="/auth">
      <label for="pin">PIN</label>
      <input id="pin" name="pin" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" placeholder="123456" required autofocus />
      <button type="submit">Open Stream</button>
    </form>
    <div class="hint">Tip: this works on phones, tablets, and laptops in the same network.</div>
  </main>
</body>
</html>`;
}

function watchPage(streamPath: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Watching Live Screen</title>
  <style>
    :root {
      --bg: #101418;
      --frame: #182129;
      --line: #2e404d;
      --ink: #eff5f8;
      --muted: #9ab0bd;
      --accent: #7fdbbe;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100dvh;
      display: grid;
      grid-template-rows: auto 1fr;
      background:
        radial-gradient(circle at 84% 0%, #203946 0 22%, transparent 42%),
        radial-gradient(circle at 0% 100%, #223332 0 24%, transparent 44%),
        var(--bg);
      color: var(--ink);
      font-family: "Avenir Next", "Segoe UI", sans-serif;
    }
    header {
      padding: .8rem 1rem;
      border-bottom: 1px solid #263541;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: .8rem;
    }
    .title {
      font-size: .92rem;
      letter-spacing: .08em;
      text-transform: uppercase;
      color: var(--muted);
    }
    .status {
      color: var(--accent);
      font-size: .9rem;
      white-space: nowrap;
    }
    .frame {
      width: min(100vw, 1700px);
      margin: 0 auto;
      padding: .8rem;
      display: grid;
      place-items: center;
    }
    video {
      width: 100%;
      max-height: calc(100dvh - 85px);
      background: #000;
      border: 1px solid var(--line);
      border-radius: 14px;
      box-shadow: 0 20px 55px #00000066;
    }
    .error {
      color: #ffb0b0;
      font-size: .9rem;
      text-align: center;
      margin-top: .9rem;
    }
  </style>
  <script type="module">
    const streamUrl = ${JSON.stringify(streamPath)};
    const video = document.getElementById("video");
    const status = document.getElementById("status");
    const error = document.getElementById("error");

    const setStatus = (text) => { status.textContent = text; };
    const setError = (text) => { error.textContent = text; };

    async function boot() {
      if (video.canPlayType("application/vnd.apple.mpegurl")) {
        video.src = streamUrl;
        setStatus("Live");
        return;
      }

      await new Promise((resolve, reject) => {
        const existing = document.querySelector('script[data-hls="1"]');
        if (existing) return resolve();
        const script = document.createElement("script");
        script.src = "/assets/hls.js";
        script.dataset.hls = "1";
        script.onload = () => resolve();
        script.onerror = () => reject(new Error("Failed to load HLS runtime"));
        document.head.appendChild(script);
      });

      const Hls = window.Hls;
      if (!Hls || !Hls.isSupported()) {
        setStatus("Unsupported");
        setError("This browser cannot play HLS. Try Safari or a modern Chromium browser.");
        return;
      }

      const hls = new Hls({
        maxLiveSyncPlaybackRate: 1.2,
        liveSyncDurationCount: 2,
        liveMaxLatencyDurationCount: 6
      });
      hls.loadSource(streamUrl);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => setStatus("Live"));
      hls.on(Hls.Events.ERROR, (_, data) => {
        if (data?.fatal) {
          setStatus("Recovering");
          setError("Stream hiccup detected. Reconnecting...");
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
          else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
          else window.location.reload();
        }
      });
    }

    boot().catch((e) => {
      setStatus("Error");
      setError(String(e));
    });
  </script>
</head>
<body>
  <header>
    <div class="title">LAN Screen Share</div>
    <div class="status" id="status">Loading...</div>
  </header>
  <main class="frame">
    <video id="video" controls autoplay playsinline muted></video>
    <div id="error" class="error"></div>
  </main>
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

function routeStreamAsset(pathname: string, req: Request): Promise<Response> | Response {
  if (!isAuthorized(req)) return unauthorized();
  const fileName = pathname.slice(hlsPrefix.length);
  if (!fileName || !/^[a-zA-Z0-9._-]+$/.test(fileName)) {
    return new Response("Not found", { status: 404 });
  }

  const fullPath = join(streamDir, fileName);
  if (!existsSync(fullPath)) return new Response("Not ready", { status: 503 });

  if (fileName.endsWith(".m3u8")) {
    return readFile(fullPath, "utf8").then((playlist) => {
      const fixed = playlist
        .split("\n")
        .map((line) => {
          if (line.startsWith("#") || !line.trim()) return line;
          return `${hlsPrefix}${line}`;
        })
        .join("\n");

      return new Response(fixed, {
        status: 200,
        headers: {
          "content-type": "application/vnd.apple.mpegurl; charset=utf-8",
          "cache-control": "no-store"
        }
      });
    });
  }

  if (fileName.endsWith(".ts")) {
    return new Response(Bun.file(fullPath), {
      status: 200,
      headers: {
        "content-type": "video/mp2t",
        "cache-control": "no-store"
      }
    });
  }

  return new Response("Unsupported", { status: 415 });
}

async function main(): Promise<void> {
  startFfmpegCapture();
  await waitForPlaylist(20000);

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

      if (pathname === "/assets/hls.js") {
        return new Response(hlsScript, {
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
        return html(watchPage(`${hlsPrefix}live.m3u8`));
      }

      if (pathname.startsWith(hlsPrefix)) {
        return routeStreamAsset(pathname, req);
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

  console.log("\nLAN Screen Share is live");
  console.log("------------------------");
  console.log(`Viewer URL (LAN):  ${publicUrl}`);
  console.log(`Viewer URL (local): ${localUrl}`);
  console.log(`PIN: ${PIN}`);
  console.log("\nPress Ctrl+C to stop.\n");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  if (ffmpegLogs.trim()) {
    console.error("Recent FFmpeg logs:\n", ffmpegLogs);
  }
  stopEverything();
  process.exit(1);
});
