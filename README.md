# LAN Screen Share

One-process screen broadcaster:
- Captures your screen with FFmpeg.
- Serves a live HLS stream over your local network.
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
- `VIDEO_BITRATE` (default `12M`)
- `HLS_TIME` (default `1`)
- `HLS_LIST_SIZE` (default `6`)
- `USE_HWACCEL=1` (macOS only, enables `h264_videotoolbox`; default is reliability-first `libx264`)
- `SOURCE=testsrc` (debug mode; uses FFmpeg test pattern instead of screen capture)

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
