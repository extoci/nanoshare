import {
  RTCPeerConnection,
  useH264,
  useOPUS,
  type MediaStreamTrack
} from "werift";
import type { OfferPayload, SessionDescriptionPayload, ViewerStore } from "./types";

type TrackProvider = () => {
  videoTrack: MediaStreamTrack | null;
  audioTrack: MediaStreamTrack | null;
  audioEnabled: boolean;
};

export function createViewerManager(paint: (text: string, ...codes: string[]) => string, getTracks: TrackProvider) {
  const viewers: ViewerStore = new Map();

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
        audio: [useOPUS({ payloadType: 111 })]
      },
      iceUseIpv6: false
    });

    peer.connectionStateChange.subscribe((state) => {
      if (state === "connected") {
        console.log(paint(`[viewer:${viewerId}] connected (${viewers.size} total)`, "\x1b[2m"));
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
    const { videoTrack, audioTrack, audioEnabled } = getTracks();
    if (!videoTrack) {
      throw new Error("Shared video track is not ready.");
    }

    const peer = createViewerPeer(viewerId);
    viewers.set(viewerId, peer);

    try {
      peer.addTrack(videoTrack);
      if (audioEnabled && audioTrack) {
        peer.addTrack(audioTrack);
      }
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

  async function closeAllViewers(reason: string): Promise<void> {
    const viewerIds = [...viewers.keys()];
    await Promise.all(viewerIds.map((viewerId) => closeViewer(viewerId, reason)));
  }

  async function closeViewer(viewerId: string, reason: string): Promise<void> {
    const peer = viewers.get(viewerId);
    if (!peer) return;

    viewers.delete(viewerId);
    console.log(paint(`[viewer:${viewerId}] disconnected (${viewers.size} total) ${reason}`, "\x1b[2m"));

    try {
      await peer.close();
    } catch {
      // ignore
    }
  }

  function closeAllViewersSync(): void {
    for (const [viewerId, peer] of viewers.entries()) {
      viewers.delete(viewerId);
      try {
        void peer.close();
      } catch {
        // ignore
      }
    }
  }

  return {
    createAnswerForOffer,
    closeAllViewers,
    closeAllViewersSync
  };
}
