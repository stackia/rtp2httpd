import { defaultConfig, type PlayerConfig } from "./config";
import { createMpegtsPlayer } from "./player/mpegts-player";
import type { LiveSessionAnchor, Player, PlayerError, PlayerEventMap, PlayerImpl, PlayerSegment } from "./types";

export { defaultConfig } from "./config";
export type { LiveSessionAnchor, Player, PlayerConfig, PlayerError, PlayerEventMap, PlayerSegment };

export function createPlayer(video: HTMLVideoElement, config?: Partial<PlayerConfig>): Player {
  const fullConfig: PlayerConfig = { ...defaultConfig, ...config };

  // Resolve WASM URLs to absolute so they work inside inline blob workers
  if (fullConfig.wasmDecoders.mp2) {
    fullConfig.wasmDecoders = {
      ...fullConfig.wasmDecoders,
      mp2: new URL(fullConfig.wasmDecoders.mp2, document.baseURI).href,
    };
  }

  let destroyed = false;

  const errorHandlers = new Set<(e: PlayerError) => void>();
  const seekHandlers = new Set<(s: number) => void>();
  const audioSuspendedHandlers = new Set<() => void>();

  let impl: PlayerImpl | null = null;

  function getImpl(): PlayerImpl {
    if (!impl) {
      impl = createMpegtsPlayer(video, fullConfig, seekHandlers);
      impl.onError = (e) => {
        for (const h of errorHandlers) {
          h(e);
        }
      };
      impl.onAudioSuspended = () => {
        for (const h of audioSuspendedHandlers) {
          h();
        }
      };
    }
    return impl;
  }

  return {
    loadSegments(segments: PlayerSegment[]) {
      if (destroyed || !segments.length) return;
      getImpl().loadSegments(segments);
    },

    seek(seconds: number) {
      impl?.seek(seconds);
    },

    goLive(targetMseSeconds: number) {
      impl?.goLive(targetMseSeconds);
    },

    setLiveSessionAnchor(anchor: LiveSessionAnchor) {
      impl?.setLiveSessionAnchor(anchor);
    },

    setLiveSync(enabled: boolean) {
      impl?.setLiveSync(enabled);
    },

    stop() {
      if (destroyed) return;
      impl?.suspend();
    },

    destroy() {
      destroyed = true;
      impl?.destroy();
      impl = null;
    },

    on<K extends keyof PlayerEventMap>(event: K, handler: PlayerEventMap[K]) {
      if (event === "error") errorHandlers.add(handler as (e: PlayerError) => void);
      if (event === "seek-needed") seekHandlers.add(handler as (s: number) => void);
      if (event === "audio-suspended") audioSuspendedHandlers.add(handler as () => void);
    },

    off<K extends keyof PlayerEventMap>(event: K, handler: PlayerEventMap[K]) {
      if (event === "error") errorHandlers.delete(handler as (e: PlayerError) => void);
      if (event === "seek-needed") seekHandlers.delete(handler as (s: number) => void);
      if (event === "audio-suspended") audioSuspendedHandlers.delete(handler as () => void);
    },
  };
}

export function isSupported(): boolean {
  const avcMime = 'video/mp4; codecs="avc1.42E01E,mp4a.40.2"';
  const mse = (self as unknown as Record<string, unknown>).MediaSource as
    | { isTypeSupported?: (t: string) => boolean }
    | undefined;
  const mms = (self as unknown as Record<string, unknown>).ManagedMediaSource as
    | { isTypeSupported?: (t: string) => boolean }
    | undefined;
  return !!(mse?.isTypeSupported?.(avcMime) || mms?.isTypeSupported?.(avcMime));
}
