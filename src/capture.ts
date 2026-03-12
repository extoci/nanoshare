import { spawn } from "node:child_process";
import { platform } from "node:os";
import {
  MediaStreamTrackFactory,
  type MediaStreamTrack
} from "werift";
import { buildAudioCaptureConfig, buildCodecArgs, buildVideoCaptureConfig } from "./capture-config";
import type { RuntimeConfig } from "./types";

type CaptureManagerOptions = {
  config: RuntimeConfig;
  paint: (text: string, ...codes: string[]) => string;
  onAudioTopologyChanged: (reason: string) => Promise<void>;
  onFatalError: () => never;
};

export function createCaptureManager({ config, paint, onAudioTopologyChanged, onFatalError }: CaptureManagerOptions) {
  let videoFfmpegProcess: ReturnType<typeof spawn> | null = null;
  let audioFfmpegProcess: ReturnType<typeof spawn> | null = null;
  let videoFfmpegLogs = "";
  let audioFfmpegLogs = "";
  let videoTrackDispose: (() => void) | null = null;
  let audioTrackDispose: (() => void) | null = null;
  let sharedVideoTrack: MediaStreamTrack | null = null;
  let sharedAudioTrack: MediaStreamTrack | null = null;
  let audioEnabled = config.audioEnabled;
  let audioSourceLabel = "Disabled";
  let audioToggleInProgress = false;

  function printRecentFfmpegLogs(): void {
    if (videoFfmpegLogs.trim()) {
      console.error("Recent Video FFmpeg logs:\n", videoFfmpegLogs);
    }
    if (audioFfmpegLogs.trim()) {
      console.error("Recent Audio FFmpeg logs:\n", audioFfmpegLogs);
    }
  }

  function killFfmpegProcess(proc: ReturnType<typeof spawn> | null): void {
    if (!proc || proc.exitCode !== null) return;
    try {
      proc.kill("SIGKILL");
    } catch {
      // ignore
    }
  }

  async function startVideoCapture(): Promise<void> {
    const capture = buildVideoCaptureConfig(config);
    const codecArgs = buildCodecArgs(config);
    const [track, port, dispose] = await MediaStreamTrackFactory.rtpSource({
      kind: "video",
      port: config.rtpPort
    });

    sharedVideoTrack = track;
    videoTrackDispose = dispose;

    const output = `rtp://127.0.0.1:${port}?pkt_size=1200`;
    const args = [
      "-hide_banner",
      "-loglevel",
      "warning",
      "-fflags",
      "nobuffer",
      "-flags",
      "low_delay",
      "-flush_packets",
      "1",
      "-max_delay",
      "0",
      ...capture.ffmpegInputArgs,
      "-an",
      ...codecArgs,
      "-r",
      String(config.fps),
      "-fps_mode",
      "cfr",
      "-f",
      "rtp",
      "-payload_type",
      "96",
      output
    ];

    videoFfmpegProcess = spawn("ffmpeg", args, {
      stdio: ["ignore", "ignore", "pipe"]
    });

    if (videoFfmpegProcess.stderr) {
      videoFfmpegProcess.stderr.setEncoding("utf8");
      videoFfmpegProcess.stderr.on("data", (chunk: string) => {
        videoFfmpegLogs = `${videoFfmpegLogs}${chunk}`.slice(-8000);
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

      videoFfmpegProcess?.on("exit", (code, signal) => {
        const abnormal = !(code === 0 || signal === "SIGTERM" || signal === "SIGKILL");

        if (!settled) {
          rejectOnce(new Error("FFmpeg exited before RTP stream became ready."));
          return;
        }

        if (abnormal) {
          console.error("Video FFmpeg exited unexpectedly.");
          console.error(`Exit code: ${code} signal: ${signal ?? "none"}`);
          printRecentFfmpegLogs();
          onFatalError();
        }
      });

      const timeout = setTimeout(() => {
        rejectOnce(new Error("Timed out waiting for RTP packets from FFmpeg."));
      }, 20_000);
    });
  }

  function stopAudioCapture(): void {
    killFfmpegProcess(audioFfmpegProcess);
    audioFfmpegProcess = null;
    audioSourceLabel = "Disabled";

    if (audioTrackDispose) {
      try {
        audioTrackDispose();
      } catch {
        // ignore
      }
      audioTrackDispose = null;
    }

    if (sharedAudioTrack) {
      try {
        sharedAudioTrack.stop();
      } catch {
        // ignore
      }
      sharedAudioTrack = null;
    }
  }

  async function startAudioCapture(): Promise<void> {
    if (sharedAudioTrack) return;

    const capture = buildAudioCaptureConfig(config);
    const [track, port, dispose] = await MediaStreamTrackFactory.rtpSource({
      kind: "audio",
      port: config.audioRtpPort
    });

    sharedAudioTrack = track;
    audioTrackDispose = dispose;
    audioSourceLabel = capture.source;

    const output = `rtp://127.0.0.1:${port}?pkt_size=1200`;
    const args = [
      "-hide_banner",
      "-loglevel",
      "warning",
      "-fflags",
      "nobuffer",
      "-flags",
      "low_delay",
      "-flush_packets",
      "1",
      "-max_delay",
      "0",
      ...capture.ffmpegInputArgs,
      "-vn",
      "-c:a",
      "libopus",
      "-application",
      "lowdelay",
      "-frame_duration",
      "20",
      "-ar",
      "48000",
      "-ac",
      "2",
      "-b:a",
      "128k",
      "-f",
      "rtp",
      "-payload_type",
      "111",
      output
    ];

    audioFfmpegProcess = spawn("ffmpeg", args, {
      stdio: ["ignore", "ignore", "pipe"]
    });

    if (audioFfmpegProcess.stderr) {
      audioFfmpegProcess.stderr.setEncoding("utf8");
      audioFfmpegProcess.stderr.on("data", (chunk: string) => {
        audioFfmpegLogs = `${audioFfmpegLogs}${chunk}`.slice(-8000);
      });
    }

    try {
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

        audioFfmpegProcess?.on("exit", (code, signal) => {
          const abnormal = !(code === 0 || signal === "SIGTERM" || signal === "SIGKILL");

          if (!settled) {
            rejectOnce(new Error("Audio FFmpeg exited before RTP stream became ready."));
            return;
          }

          if (abnormal) {
            console.error("Audio FFmpeg exited unexpectedly.");
            console.error(`Exit code: ${code} signal: ${signal ?? "none"}`);
            printRecentFfmpegLogs();
            onFatalError();
          }
        });

        const timeout = setTimeout(() => {
          rejectOnce(new Error("Timed out waiting for audio RTP packets from FFmpeg."));
        }, 12_000);
      });
    } catch (error) {
      stopAudioCapture();
      throw error;
    }
  }

  async function tryEnableAudio(reason: "startup" | "runtime"): Promise<void> {
    try {
      await startAudioCapture();
      audioEnabled = true;
      console.log(paint(`[audio] enabled (${audioSourceLabel})`, "\x1b[2m"));
    } catch (error) {
      audioEnabled = false;
      audioSourceLabel = "Disabled";
      const message = error instanceof Error ? error.message : String(error);
      const reasonHint =
        platform() === "darwin"
          ? "On macOS you usually need a loopback device like BlackHole/Loopback and may need --audio-device."
          : "Try passing --audio-device with a valid system-output input for your platform.";
      console.warn(`Audio unavailable (${reason}): ${message}`);
      console.warn(reasonHint);
    }
  }

  async function toggleAudioRuntime(): Promise<void> {
    if (audioToggleInProgress) return;
    audioToggleInProgress = true;

    try {
      if (audioEnabled) {
        audioEnabled = false;
        stopAudioCapture();
        await onAudioTopologyChanged("audio toggled off");
        console.log(paint("[audio] disabled", "\x1b[2m"));
        return;
      }

      await tryEnableAudio("runtime");
      if (audioEnabled) {
        await onAudioTopologyChanged("audio toggled on");
      }
    } finally {
      audioToggleInProgress = false;
    }
  }

  function stopEverything(closeAllViewersSync: () => void): void {
    killFfmpegProcess(videoFfmpegProcess);
    videoFfmpegProcess = null;
    stopAudioCapture();
    closeAllViewersSync();

    if (videoTrackDispose) {
      try {
        videoTrackDispose();
      } catch {
        // ignore
      }
      videoTrackDispose = null;
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

  return {
    getState() {
      return {
        videoTrack: sharedVideoTrack,
        audioTrack: sharedAudioTrack,
        audioEnabled,
        audioSourceLabel
      };
    },
    async start(): Promise<void> {
      await startVideoCapture();
      if (audioEnabled) {
        await tryEnableAudio("startup");
      }
    },
    toggleAudioRuntime,
    stopEverything,
    printRecentFfmpegLogs
  };
}
