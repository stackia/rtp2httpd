import { isLGWebOS } from "../../lib/platform";
import { defaultConfig, type PlayerConfig } from "../config";
import { PlayerErrors } from "../errors";
import type { LiveSessionAnchor, PlaybackBackend, PlayerMediaInfo, PlayerSegment } from "../types";
import { createPlaybackEventEmitter, resolveMediaUrl } from "./backend-utils";

type SegmentEntry = PlayerSegment & { start: number };

function mediaErrorMessage(error: MediaError | null): string {
  if (!error) return "Native media element playback failed";
  return error.message || `HTMLMediaElement.error code=${error.code}`;
}

function containsTime(ranges: TimeRanges, time: number): boolean {
  if (!Number.isFinite(time)) return false;
  for (let i = 0; i < ranges.length; i++) {
    if (time >= ranges.start(i) && time <= ranges.end(i)) return true;
  }
  return false;
}

export function createNativePlaybackBackend(video: HTMLVideoElement, config?: Partial<PlayerConfig>): PlaybackBackend {
  const fullConfig: PlayerConfig = { ...defaultConfig, ...config };
  // LG reports seekable/buffered ranges for live TS but ignores currentTime writes within them.
  const alwaysRebuildSeek = isLGWebOS();
  const events = createPlaybackEventEmitter();

  let entries: SegmentEntry[] = [];
  let segmentIndex = 0;
  let mediaOrigin = 0;
  let logicalTime = 0;
  let destroyed = false;
  let shouldPlay = false;
  let loadGeneration = 0;
  let detachLoadListeners: (() => void) | null = null;

  const currentEntry = () => entries[segmentIndex];
  const isLiveSource = () => entries.length === 1 && (entries[0]?.duration ?? 0) === 0;

  const updateMediaInfo = () => {
    const info: PlayerMediaInfo = {};
    if (video.videoWidth > 0 || video.videoHeight > 0) {
      info.video = { width: video.videoWidth || undefined, height: video.videoHeight || undefined };
    }
    events.emit("media-info", info);
  };

  const updateLogicalTime = (generation: number) => {
    if (generation !== loadGeneration) return;
    const entry = currentEntry();
    if (!entry) return;
    logicalTime = entry.start + Math.max(0, video.currentTime - mediaOrigin);
    events.emit("time-update", logicalTime);
  };

  const attachLoadListeners = (generation: number) => {
    const isCurrentLoad = () => !destroyed && generation === loadGeneration;
    const onLoadedMetadata = () => {
      if (!isCurrentLoad()) return;
      mediaOrigin = Number.isFinite(video.currentTime) ? video.currentTime : 0;
      updateMediaInfo();
      updateLogicalTime(generation);
    };
    const onDurationChange = () => {
      if (isCurrentLoad()) updateMediaInfo();
    };
    const onTimeUpdate = () => updateLogicalTime(generation);
    const onCanPlay = (event: Event) => {
      if (isCurrentLoad()) events.emit("playback-state-change", "canplay", event.timeStamp);
    };
    const onPlaying = (event: Event) => {
      if (isCurrentLoad()) events.emit("playback-state-change", "playing", event.timeStamp);
    };
    const onPause = (event: Event) => {
      if (isCurrentLoad()) events.emit("playback-state-change", "paused", event.timeStamp);
    };
    const onWaiting = (event: Event) => {
      if (isCurrentLoad()) events.emit("playback-state-change", "waiting", event.timeStamp);
    };
    const onEnded = () => {
      if (!isCurrentLoad()) return;
      if (segmentIndex + 1 < entries.length) {
        segmentIndex++;
        loadCurrentEntry(shouldPlay);
        return;
      }
      events.emit("ended");
    };
    const onError = () => {
      if (!isCurrentLoad() || !video.getAttribute("src")) return;
      const mediaError = video.error;
      const isNetworkError = mediaError?.code === MediaError.MEDIA_ERR_NETWORK;
      const isUnsupported = mediaError?.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED;
      events.emit("error", {
        category: isNetworkError ? "io" : isUnsupported ? "demux" : "media",
        detail: isNetworkError
          ? PlayerErrors.REQUEST_FAILED
          : isUnsupported
            ? PlayerErrors.FORMAT_UNSUPPORTED
            : PlayerErrors.MEDIA_ELEMENT_ERROR,
        info: mediaErrorMessage(mediaError),
        code: mediaError?.code,
        url: video.currentSrc || currentEntry()?.url,
      });
    };

    const listeners: Array<[string, EventListener]> = [
      ["loadedmetadata", onLoadedMetadata],
      ["durationchange", onDurationChange],
      ["timeupdate", onTimeUpdate],
      ["ended", onEnded],
      ["error", onError],
      ["canplay", onCanPlay],
      ["playing", onPlaying],
      ["pause", onPause],
      ["waiting", onWaiting],
    ];
    for (const [event, listener] of listeners) video.addEventListener(event, listener);

    detachLoadListeners = () => {
      for (const [event, listener] of listeners) video.removeEventListener(event, listener);
    };
  };

  const loadCurrentEntry = (autoplay: boolean) => {
    const entry = currentEntry();
    if (!entry || destroyed) return;
    const generation = ++loadGeneration;
    detachLoadListeners?.();
    detachLoadListeners = null;
    video.pause();
    mediaOrigin = 0;
    logicalTime = entry.start;
    // Install the new generation's listeners before changing src: cached media and
    // immediate failures may dispatch metadata/error events as soon as loading starts.
    attachLoadListeners(generation);
    video.src = entry.url;
    video.load();
    events.emit("time-update", logicalTime);
    if (autoplay) {
      void video.play().catch((error: Error) => {
        if (generation !== loadGeneration) return;
        if (error.name === "NotAllowedError") events.emit("audio-suspended");
      });
    }
  };

  const onVolumeChange = () => events.emit("volume-change", video.volume, video.muted);
  video.addEventListener("volumechange", onVolumeChange);

  return {
    kind: "native",
    mediaElement: video,

    loadSegments(segments) {
      if (destroyed || !segments.length) return;
      let start = 0;
      entries = segments.map((segment) => {
        const entry = { ...segment, url: resolveMediaUrl(segment.url), start };
        start += segment.duration ?? 0;
        return entry;
      });
      segmentIndex = 0;
      events.emit("render-state-change", { active: false, deinterlacing: false });
      events.emit("live-state-change", isLiveSource());
      loadCurrentEntry(shouldPlay);
    },

    async play() {
      shouldPlay = true;
      const generation = loadGeneration;
      try {
        await video.play();
      } catch (error) {
        if (generation !== loadGeneration) return;
        throw error;
      }
    },

    pause() {
      shouldPlay = false;
      video.pause();
    },

    setVolume(volume) {
      video.volume = volume;
    },

    setMuted(muted) {
      video.muted = muted;
    },

    getState() {
      return {
        currentTime: logicalTime,
        duration: entries.reduce((total, entry) => total + (entry.duration ?? 0), 0) || video.duration,
        paused: video.paused,
        playbackRate: video.playbackRate || 1,
        volume: video.volume,
        muted: video.muted,
      };
    },

    seek(seconds) {
      const entry = currentEntry();
      if (!entry) return;
      const localTarget = mediaOrigin + seconds - entry.start;
      if (
        !alwaysRebuildSeek &&
        (containsTime(video.seekable, localTarget) || containsTime(video.buffered, localTarget))
      ) {
        try {
          video.currentTime = localTarget;
          return;
        } catch {
          // Let the upper layer rebuild the catch-up URL when the native pipeline rejects the buffered seek.
        }
      }
      events.emit("seek-needed", seconds);
    },

    goLive() {
      if (video.seekable.length > 0) {
        const last = video.seekable.length - 1;
        video.currentTime = Math.max(
          video.seekable.start(last),
          video.seekable.end(last) - fullConfig.liveSyncTargetLatency,
        );
        return;
      }
      loadCurrentEntry(shouldPlay);
    },

    setLiveSessionAnchor(_anchor: LiveSessionAnchor) {},
    setLiveSync(_enabled: boolean) {},
    setAutoDeinterlace(_enabled: boolean) {},
    setPictureEnhancement(_enabled: boolean) {},

    stop() {
      shouldPlay = false;
      loadGeneration++;
      detachLoadListeners?.();
      detachLoadListeners = null;
      entries = [];
      segmentIndex = 0;
      logicalTime = 0;
      video.pause();
      video.removeAttribute("src");
      video.load();
    },

    destroy() {
      if (destroyed) return;
      destroyed = true;
      loadGeneration++;
      detachLoadListeners?.();
      detachLoadListeners = null;
      video.removeEventListener("volumechange", onVolumeChange);
      entries = [];
      video.pause();
      video.removeAttribute("src");
      video.load();
      events.clear();
    },

    on(event, handler) {
      events.on(event, handler);
    },

    off(event, handler) {
      events.off(event, handler);
    },
  };
}
