export function watchPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Nanoshare Live Screen</title>
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
    audio {
      display: none;
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
      <div class="id">Nanoshare / Viewer</div>
      <div class="status">
        <span id="statusDot" class="dot connecting"></span>
        <span id="statusText">Connecting</span>
      </div>
      <div class="actions">
        <button id="enableSoundBtn" class="action" type="button" hidden>Enable Sound</button>
        <button id="fullscreenBtn" class="action" type="button">Fullscreen</button>
      </div>
    </header>
    <section class="viewport">
      <video id="video" autoplay playsinline muted tabindex="-1"></video>
      <audio id="audio" autoplay playsinline></audio>
    </section>
  </main>

  <script>
    const video = document.getElementById("video");
    const audio = document.getElementById("audio");
    const statusDot = document.getElementById("statusDot");
    const statusText = document.getElementById("statusText");
    const fullscreenBtn = document.getElementById("fullscreenBtn");
    const enableSoundBtn = document.getElementById("enableSoundBtn");
    let peer = null;
    let reconnectTimer = null;
    let audioBlocked = false;

    const configureReceiverForLowLatency = (receiver) => {
      if (!receiver) return;
      if ("playoutDelayHint" in receiver) {
        receiver.playoutDelayHint = 0;
      }
      if ("jitterBufferTarget" in receiver) {
        receiver.jitterBufferTarget = 0;
      }
    };

    const setStatus = (state, label) => {
      statusText.textContent = label;
      statusDot.className = "dot " + state;
    };

    const setAudioBlockedState = (blocked) => {
      audioBlocked = blocked;
      enableSoundBtn.hidden = !blocked;
      if (!blocked && peer && peer.connectionState === "connected") {
        setStatus("connected", "Live");
      }
      if (blocked && peer && peer.connectionState === "connected") {
        setStatus("connecting", "Live / Tap Enable Sound");
      }
    };

    const attemptAudioPlayback = () => {
      const playPromise = audio.play();
      if (!playPromise || typeof playPromise.then !== "function") {
        setAudioBlockedState(false);
        return;
      }
      playPromise
        .then(() => {
          setAudioBlockedState(false);
        })
        .catch(() => {
          setAudioBlockedState(true);
        });
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
      setAudioBlockedState(false);
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
      pc.addTransceiver("audio", { direction: "recvonly" });
      pc.getReceivers().forEach(configureReceiverForLowLatency);

      pc.ontrack = (event) => {
        configureReceiverForLowLatency(event.receiver);
        const stream = event.streams && event.streams[0]
          ? event.streams[0]
          : new MediaStream([event.track]);

        if (video.srcObject !== stream) {
          video.srcObject = stream;
        }
        if (audio.srcObject !== stream) {
          audio.srcObject = stream;
        }
        video.play().catch(() => {});
        if (event.track.kind === "audio") {
          attemptAudioPlayback();
        }
      };

      pc.onconnectionstatechange = () => {
        const state = pc.connectionState;
        if (state === "connected") {
          setStatus(audioBlocked ? "connecting" : "connected", audioBlocked ? "Live / Tap Enable Sound" : "Live");
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

    enableSoundBtn.addEventListener("click", () => {
      attemptAudioPlayback();
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
