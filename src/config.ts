import { Command } from "commander";
import type { CliOptions, RuntimeConfig, SourceMode } from "./types";

function generatePin(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

export function parsePositiveInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return parsed;
}

export function parseSourceMode(value: string): SourceMode {
  if (value === "screen" || value === "testsrc") return value;
  throw new Error(`source must be either "screen" or "testsrc", received "${value}".`);
}

function parseCliOptions(): CliOptions {
  const program = new Command();
  program
    .name("nanoshare")
    .allowExcessArguments(false)
    .option("-p, --port <number>", "HTTP server port", (value) => parsePositiveInteger(value, "port"))
    .option("--pin <pin>", "Access PIN for viewers")
    .option("-f, --fps <number>", "Capture and encode frame rate", (value) => parsePositiveInteger(value, "fps"))
    .option("-b, --video-bitrate <bitrate>", "Video bitrate (for example 14M)")
    .option("--use-hwaccel", "Enable hardware encoder on macOS (h264_videotoolbox)")
    .option("--source <mode>", 'Capture source ("screen" or "testsrc")', parseSourceMode)
    .option("--rtp-port <number>", "Local RTP ingress port for video", (value) => parsePositiveInteger(value, "rtp-port"))
    .option("--audio", "Enable system audio streaming")
    .option("--audio-device <value>", "Optional system audio input device override")
    .option("--audio-rtp-port <number>", "Local RTP ingress port for audio", (value) =>
      parsePositiveInteger(value, "audio-rtp-port")
    );

  program.parse(process.argv);
  return program.opts<CliOptions>();
}

export function getRuntimeConfig(): RuntimeConfig {
  const cli = parseCliOptions();
  const env = process.env;

  return {
    port: cli.port ?? parsePositiveInteger(env.NANOSHARE_PORT ?? "37777", "NANOSHARE_PORT"),
    pin: cli.pin ?? env.NANOSHARE_PIN ?? generatePin(),
    fps: cli.fps ?? parsePositiveInteger(env.NANOSHARE_FPS ?? "30", "NANOSHARE_FPS"),
    videoBitrate: cli.videoBitrate ?? env.NANOSHARE_VIDEO_BITRATE ?? "14M",
    useHwaccel: cli.useHwaccel || env.NANOSHARE_USE_HWACCEL === "1",
    source: cli.source ?? parseSourceMode(env.NANOSHARE_SOURCE ?? "screen"),
    rtpPort: cli.rtpPort ?? parsePositiveInteger(env.NANOSHARE_RTP_PORT ?? "5004", "NANOSHARE_RTP_PORT"),
    audioEnabled: cli.audio || env.NANOSHARE_AUDIO === "1",
    audioDevice: cli.audioDevice ?? env.NANOSHARE_AUDIO_DEVICE,
    audioRtpPort: cli.audioRtpPort ?? parsePositiveInteger(env.NANOSHARE_AUDIO_RTP_PORT ?? "5006", "NANOSHARE_AUDIO_RTP_PORT")
  };
}
