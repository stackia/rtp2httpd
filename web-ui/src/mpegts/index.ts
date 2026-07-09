import { getRuntimeLogLevel } from "../lib/runtime-config";
import { defaultConfig, type PlayerConfig } from "./config";
import { createMpegtsPlayer } from "./player/mpegts-player";
import { createVideoRenderPipeline, type VideoRenderPipeline } from "./render";
import type {
  LiveSessionAnchor,
  Player,
  PlayerError,
  PlayerEventMap,
  PlayerImpl,
  PlayerSegment,
  VideoTrackInfo,
} from "./types";
import Log from "./utils/logger";

export { defaultConfig } from "./config";
export type { LiveSessionAnchor, Player, PlayerConfig, PlayerError, PlayerEventMap, PlayerSegment, VideoTrackInfo };

function resolveSegmentUrl(url: string): string {
  try {
    return new URL(url, document.baseURI).href;
  } catch {
    return url;
  }
}

function resolveSegmentUrls(segments: PlayerSegment[]): PlayerSegment[] {
  return segments.map((segment) => ({
    ...segment,
    url: resolveSegmentUrl(segment.url),
  }));
}

export function createPlayer(video: HTMLVideoElement, config?: Partial<PlayerConfig>): Player {
  const fullConfig: PlayerConfig = { ...defaultConfig, ...config };
  fullConfig.logLevel = config?.logLevel ?? getRuntimeLogLevel() ?? fullConfig.logLevel;
  Log.setLogLevel(fullConfig.logLevel);
  fullConfig.logLevel = Log.LOG_LEVEL;

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
  const liveStateHandlers = new Set<(isLive: boolean) => void>();
  const audioSuspendedHandlers = new Set<() => void>();
  const videoInfoHandlers = new Set<(info: VideoTrackInfo) => void>();
  const renderActiveHandlers = new Set<(active: boolean) => void>();

  let renderPipeline: VideoRenderPipeline | null = null;
  if (fullConfig.renderCanvas) {
    renderPipeline = createVideoRenderPipeline(video, fullConfig.renderCanvas, (active) => {
      for (const h of renderActiveHandlers) {
        h(active);
      }
    });
    renderPipeline.setAutoDeinterlaceEnabled(fullConfig.autoDeinterlace);
    renderPipeline.setPictureEnhancementEnabled(fullConfig.pictureEnhancement);
  }

  let impl: PlayerImpl | null = null;

  function getImpl(): PlayerImpl {
    if (!impl) {
      // The impl posts its config to the transmux worker; DOM elements are not
      // structured-cloneable, so keep the canvas out of it
      impl = createMpegtsPlayer(video, { ...fullConfig, renderCanvas: undefined }, seekHandlers);
      impl.onError = (e) => {
        for (const h of errorHandlers) {
          h(e);
        }
      };
      impl.onLiveStateChange = (isLive) => {
        for (const h of liveStateHandlers) {
          h(isLive);
        }
      };
      impl.onAudioSuspended = () => {
        for (const h of audioSuspendedHandlers) {
          h();
        }
      };
      impl.onVideoInfo = (info) => {
        for (const h of videoInfoHandlers) {
          h(info);
        }
      };
    }
    return impl;
  }

  return {
    loadSegments(segments: PlayerSegment[]) {
      if (destroyed || !segments.length) return;
      // New source — forget the previous stream's interlace verdict
      renderPipeline?.reset();
      getImpl().loadSegments(resolveSegmentUrls(segments));
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

    setAutoDeinterlace(enabled: boolean) {
      renderPipeline?.setAutoDeinterlaceEnabled(enabled);
    },

    setPictureEnhancement(enabled: boolean) {
      renderPipeline?.setPictureEnhancementEnabled(enabled);
    },

    stop() {
      if (destroyed) return;
      renderPipeline?.reset();
      impl?.suspend();
    },

    destroy() {
      destroyed = true;
      renderPipeline?.destroy();
      renderPipeline = null;
      impl?.destroy();
      impl = null;
    },

    on<K extends keyof PlayerEventMap>(event: K, handler: PlayerEventMap[K]) {
      if (event === "error") errorHandlers.add(handler as (e: PlayerError) => void);
      if (event === "seek-needed") seekHandlers.add(handler as (s: number) => void);
      if (event === "live-state-change") liveStateHandlers.add(handler as (isLive: boolean) => void);
      if (event === "audio-suspended") audioSuspendedHandlers.add(handler as () => void);
      if (event === "video-info") videoInfoHandlers.add(handler as (info: VideoTrackInfo) => void);
      if (event === "render-active-change") renderActiveHandlers.add(handler as (active: boolean) => void);
    },

    off<K extends keyof PlayerEventMap>(event: K, handler: PlayerEventMap[K]) {
      if (event === "error") errorHandlers.delete(handler as (e: PlayerError) => void);
      if (event === "seek-needed") seekHandlers.delete(handler as (s: number) => void);
      if (event === "live-state-change") liveStateHandlers.delete(handler as (isLive: boolean) => void);
      if (event === "audio-suspended") audioSuspendedHandlers.delete(handler as () => void);
      if (event === "video-info") videoInfoHandlers.delete(handler as (info: VideoTrackInfo) => void);
      if (event === "render-active-change") renderActiveHandlers.delete(handler as (active: boolean) => void);
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
