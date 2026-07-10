import { getRuntimeLogLevel } from "../lib/runtime-config";
import { defaultConfig, type PlayerConfig } from "./config";
import { createMpegtsPlayer } from "./player/mpegts-player";
import { createVideoRenderPipeline, type VideoRenderPipeline } from "./render";
import type { LiveSessionAnchor, Player, PlayerEventMap, PlayerImpl, PlayerSegment } from "./types";
import Log from "./utils/logger";

export type { PlayerConfig } from "./config";
export { defaultConfig } from "./config";
export type {
  LiveSessionAnchor,
  Player,
  PlayerDynamicRange,
  PlayerError,
  PlayerEventMap,
  PlayerMediaInfo,
  PlayerRenderState,
  PlayerSegment,
  PlayerVideoScanType,
} from "./types";

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

  const eventHandlers: { [EventName in keyof PlayerEventMap]: Set<PlayerEventMap[EventName]> } = {
    error: new Set(),
    "seek-needed": new Set(),
    "live-state-change": new Set(),
    "audio-suspended": new Set(),
    "media-info": new Set(),
    "render-state-change": new Set(),
  };

  function getEventHandlers<EventName extends keyof PlayerEventMap>(event: EventName): Set<PlayerEventMap[EventName]> {
    return eventHandlers[event] as Set<PlayerEventMap[EventName]>;
  }

  function emitPlayerEvent<EventName extends keyof PlayerEventMap>(
    event: EventName,
    ...eventArguments: Parameters<PlayerEventMap[EventName]>
  ): void {
    for (const handler of getEventHandlers(event)) {
      const invokeHandler = handler as (...handlerArguments: Parameters<PlayerEventMap[EventName]>) => void;
      invokeHandler(...eventArguments);
    }
  }

  let renderPipeline: VideoRenderPipeline | null = null;
  if (fullConfig.renderCanvas) {
    renderPipeline = createVideoRenderPipeline(video, fullConfig.renderCanvas, (state) =>
      emitPlayerEvent("render-state-change", state),
    );
    renderPipeline.setAutoDeinterlaceEnabled(fullConfig.autoDeinterlace);
    renderPipeline.setPictureEnhancementEnabled(fullConfig.pictureEnhancement);
  }

  let impl: PlayerImpl | null = null;

  function getImpl(): PlayerImpl {
    if (!impl) {
      // The impl posts its config to the transmux worker; DOM elements are not
      // structured-cloneable, so keep the canvas out of it
      impl = createMpegtsPlayer(video, { ...fullConfig, renderCanvas: undefined }, getEventHandlers("seek-needed"));
      impl.onError = (error) => emitPlayerEvent("error", error);
      impl.onLiveStateChange = (isLive) => emitPlayerEvent("live-state-change", isLive);
      impl.onAudioSuspended = () => emitPlayerEvent("audio-suspended");
      impl.onMediaInfo = (info) => emitPlayerEvent("media-info", info);
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
      getEventHandlers(event).add(handler);
    },

    off<K extends keyof PlayerEventMap>(event: K, handler: PlayerEventMap[K]) {
      getEventHandlers(event).delete(handler);
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
