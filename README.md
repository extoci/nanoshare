# casty

One-process screen broadcaster:
- Captures your screen with FFmpeg (host runs natively, no host browser needed).
- Publishes a low-latency WebRTC H.264 stream to browser viewers on your local network.
- Protects access behind a 6-digit PIN.

## Requirements

- [Bun](https://bun.sh)
- FFmpeg available on `PATH`
  - macOS: `brew install ffmpeg`
  - Windows: install FFmpeg and add `ffmpeg.exe` to `PATH`

## Run

```bash
bun install
bun run dev
```

Optional env vars:
- `PORT` (default `37777`)
- `PIN` (default random 6-digit)
- `FPS` (default `30`)
- `VIDEO_BITRATE` (default `14M`)
- `RTP_PORT` (default `5004`; local UDP ingress from FFmpeg into WebRTC)
- `USE_HWACCEL=1` (macOS only, enables `h264_videotoolbox`; default is reliability-first `libx264`)
- `SOURCE=testsrc` (debug mode; uses FFmpeg test pattern instead of screen capture)

CLI flags are also supported (flags take precedence over env vars):
- `--port <number>`
- `--pin <pin>`
- `--fps <number>`
- `--video-bitrate <bitrate>`
- `--use-hwaccel`
- `--source <screen|testsrc>`
- `--rtp-port <number>`

Example:

```bash
bun dev --fps 60 --video-bitrate 20M
```

## Build Standalone Executable

Local platform:

```bash
bun run build:local
```

Cross-target builds:

```bash
bun run build:mac
bun run build:win
```

Outputs go to `dist/`.

## Notes

- A single binary cannot run on both macOS and Windows. You get one executable per OS target.
- On first run, macOS will ask for Screen Recording permission.
- This mode targets near-realtime LAN playback (typically sub-second to low-single-digit seconds depending on network + browser buffering).
- After PIN entry, the viewer page is video-only (no playback controls/UI chrome).
