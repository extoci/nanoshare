# flitty – local screen sharing, as simple as it gets

you shouldn't have to mess with vnc, rdp or ssh to view your laptop's screen on your computer (or any other device on your network).

## usage

run flitty using [bun](https://bun.com):

```bash
bunx flitty
```

macos will ask for permission to access your screen, and you might have to restart your terminal before the permission is granted by the os.

this will obviously require bun.

## requirements

- [bun](https://bun.com) installed
- `ffmpeg` installed and available in your `PATH`
- host and viewer on the same network
- screen-recording permission granted to terminal (macos)

## features

`flitty` runs on port `37777` by default, at **30fps** with **14M** video bitrate. you can change settings by passing flags when running `bunx flitty`.

- `--port <number>` – change the port to listen on
- `--fps <number>` – change the framerate
- `--video-bitrate <bitrate>` – change the video bitrate
- `--use-hwaccel` – enable hardware acceleration on macOS
- `--source <screen|testsrc>` – use a test pattern or screen capture
- `--rtp-port <number>` – change the local port for ffmpeg → webrtc ingress
- `--pin <pin>` – change the pin to require to access the live stream

## quick examples

default:

```bash
bunx flitty
```

custom port + pin:

```bash
bunx flitty --port 3000 --pin 123456
```

use a test source (great for debugging without sharing your actual screen):

```bash
bunx flitty --source testsrc
```

macos hardware encoding:

```bash
bunx flitty --use-hwaccel
```

## environment variables

if you prefer env vars over cli flags:

- `FLITTY_PORT` (default: `37777`)
- `FLITTY_PIN` (default: random 6-digit pin)
- `FLITTY_FPS` (default: `30`)
- `FLITTY_VIDEO_BITRATE` (default: `14M`)
- `FLITTY_USE_HWACCEL=1` to enable hw acceleration on macos
- `FLITTY_SOURCE=screen|testsrc` (default: `screen`)
- `FLITTY_RTP_PORT` (default: `5004`)
- `FLITTY_DISPLAY` (linux only, optional override for X11 display)

example:

```bash
FLITTY_PORT=3000 FLITTY_FPS=60 FLITTY_VIDEO_BITRATE=8M bunx flitty
```

## what you'll see

when flitty starts, it prints:

- local url (for same machine)
- lan url (for other devices on your network)
- a 6-digit pin

open the url on another device, enter the pin once, and you're in.

## troubleshooting

- `ffmpeg: command not found`  
  install ffmpeg first (`brew install ffmpeg`, `sudo apt install ffmpeg`, etc). on windows, have it in your `PATH`.
- macos keeps denying capture  
  enable your terminal in system settings → privacy & security → screen recording, then fully restart your terminal.
- viewer can't connect  
  make sure both devices are on the same lan and your firewall allows the selected port. if the port is in use, try passing a different one with `--port <number>`.
- linux black screen  
  check that `FLITTY_DISPLAY` (or system `DISPLAY`) is set correctly (for example `:0.0`).

## acknowledgements

built by [exotic](https://x.com/ex0t1clol) with gpt-5.3-codex in a couple hours. feel free to contribute if you want, or fork and improve.
