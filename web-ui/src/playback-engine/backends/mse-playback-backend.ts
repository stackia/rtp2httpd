import { getRuntimeLogLevel } from "../../lib/runtime-config";
import { defaultConfig, type PlayerConfig } from "../config";
import { createMSEPlaybackController } from "../mse/playback-controller";
import { createVideoRenderPipeline, type VideoRenderPipeline } from "../render";
import type { LiveSessionAnchor, MSEPlaybackController, PlaybackBackend } from "../types";
import Log from "../utils/logger";
import { createPlaybackEventEmitter, resolveSegmentUrls } from "./backend-utils";

function resolveConfig(config?: Partial<PlayerConfig>): PlayerConfig {
  const fullConfig: PlayerConfig = { ...defaultConfig, ...config };
  fullConfig.logLevel = config?.logLevel ?? getRuntimeLogLevel() ?? fullConfig.logLevel;
  Log.setLogLevel(fullConfig.logLevel);
  fullConfig.logLevel = Log.LOG_LEVEL;

  // Resolve WASM URLs to absolute so they work inside inline blob workers.
  if (fullConfig.wasmDecoders.mp2) {
    fullConfig.wasmDecoders = {
      ...fullConfig.wasmDecoders,
      mp2: new URL(fullConfig.wasmDecoders.mp2, document.baseURI).href,
    };
  }

  return fullConfig;
}

export function createMSEPlaybackBackend(video: HTMLVideoElement, config?: Partial<PlayerConfig>): PlaybackBackend {
  const fullConfig = resolveConfig(config);
  let destroyed = false;
  const events = createPlaybackEventEmitter();

  let renderPipeline: VideoRenderPipeline | null = null;
  if (fullConfig.renderCanvas) {
    renderPipeline = createVideoRenderPipeline(video, fullConfig.renderCanvas, (state) =>
      events.emit("render-state-change", state),
    );
    renderPipeline.setAutoDeinterlaceEnabled(fullConfig.autoDeinterlace);
    renderPipeline.setPictureEnhancementEnabled(fullConfig.pictureEnhancement);
  }

  let controller: MSEPlaybackController | null = null;

  const onTimeUpdate = () => events.emit("time-update", video.currentTime);
  const onEnded = () => events.emit("ended");
  const onCanPlay = (event: Event) => events.emit("playback-state-change", "canplay", event.timeStamp);
  const onPlaying = (event: Event) => events.emit("playback-state-change", "playing", event.timeStamp);
  const onPause = (event: Event) => events.emit("playback-state-change", "paused", event.timeStamp);
  const onWaiting = (event: Event) => events.emit("playback-state-change", "waiting", event.timeStamp);
  const onVolumeChange = () => events.emit("volume-change", video.volume, video.muted);
  video.addEventListener("timeupdate", onTimeUpdate);
  video.addEventListener("ended", onEnded);
  video.addEventListener("canplay", onCanPlay);
  video.addEventListener("playing", onPlaying);
  video.addEventListener("pause", onPause);
  video.addEventListener("waiting", onWaiting);
  video.addEventListener("volumechange", onVolumeChange);

  function getController(): MSEPlaybackController {
    if (!controller) {
      // DOM elements are not structured-cloneable, so keep the canvas out of the worker config.
      controller = createMSEPlaybackController(
        video,
        { ...fullConfig, renderCanvas: undefined },
        events.getHandlers("seek-needed"),
      );
      controller.onError = (error) => events.emit("error", error);
      controller.onLiveStateChange = (isLive) => events.emit("live-state-change", isLive);
      controller.onAudioSuspended = () => events.emit("audio-suspended");
      controller.onMediaInfo = (info) => events.emit("media-info", info);
    }
    return controller;
  }

  return {
    kind: "mse",
    mediaElement: video,

    loadSegments(segments) {
      if (destroyed || !segments.length) return;
      renderPipeline?.reset();
      getController().loadSegments(resolveSegmentUrls(segments));
    },

    play: () => video.play(),
    pause: () => video.pause(),
    setVolume: (volume) => {
      video.volume = volume;
    },
    setMuted: (muted) => {
      video.muted = muted;
    },

    getState: () => ({
      currentTime: video.currentTime,
      duration: video.duration,
      paused: video.paused,
      playbackRate: video.playbackRate || 1,
      volume: video.volume,
      muted: video.muted,
    }),

    seek: (seconds) => controller?.seek(seconds),
    goLive: (targetMseSeconds) => controller?.goLive(targetMseSeconds),
    setLiveSessionAnchor: (anchor: LiveSessionAnchor) => controller?.setLiveSessionAnchor(anchor),
    setLiveSync: (enabled) => controller?.setLiveSync(enabled),
    setAutoDeinterlace: (enabled) => renderPipeline?.setAutoDeinterlaceEnabled(enabled),
    setPictureEnhancement: (enabled) => renderPipeline?.setPictureEnhancementEnabled(enabled),

    stop() {
      if (destroyed) return;
      renderPipeline?.reset();
      controller?.suspend();
    },

    destroy() {
      if (destroyed) return;
      destroyed = true;
      video.removeEventListener("timeupdate", onTimeUpdate);
      video.removeEventListener("ended", onEnded);
      video.removeEventListener("canplay", onCanPlay);
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("waiting", onWaiting);
      video.removeEventListener("volumechange", onVolumeChange);
      renderPipeline?.destroy();
      renderPipeline = null;
      controller?.destroy();
      controller = null;
    },

    on(event, handler) {
      events.on(event, handler);
    },

    off(event, handler) {
      events.off(event, handler);
    },
  };
}

export function isMSEPlaybackSupported(): boolean {
  const avcMime = 'video/mp4; codecs="avc1.42E01E,mp4a.40.2"';
  const mse = (self as unknown as Record<string, unknown>).MediaSource as
    | { isTypeSupported?: (type: string) => boolean }
    | undefined;
  const managedMse = (self as unknown as Record<string, unknown>).ManagedMediaSource as
    | { isTypeSupported?: (type: string) => boolean }
    | undefined;
  return !!(mse?.isTypeSupported?.(avcMime) || managedMse?.isTypeSupported?.(avcMime));
}
