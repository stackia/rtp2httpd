import type { PlayerConfig } from "../config";
import Log from "../utils/logger";

type Track = "video" | "audio";

interface RemoveRange {
  start: number;
  end: number;
}

interface PendingSegment {
  data: ArrayBuffer;
  timestampOffset?: number;
}

interface InitSegmentRecord {
  data: ArrayBuffer;
  codec: string;
  container: string;
}

interface MSEMediaSource {
  readyState: string;
  duration: number;
  streaming?: boolean;
  handle?: unknown;
  addSourceBuffer(mimeType: string): SourceBuffer;
  removeSourceBuffer(sb: SourceBuffer): void;
  endOfStream(): void;
  addEventListener(type: string, listener: unknown): void;
  removeEventListener(type: string, listener: unknown): void;
}

export interface MediaSourceController {
  open(onOpen: () => void): void;
  appendInit(track: Track, data: ArrayBuffer, codec: string, container: string): void;
  appendMedia(track: Track, data: ArrayBuffer, timestampOffset?: number): void;
  /** Set the MediaSource duration (e.g. from an HLS VOD playlist) so seeks beyond buffered data are not clamped. */
  setDuration(seconds: number): void;
  endOfStream(): void;
  destroy(): void;
  onBufferFull: (() => void) | null;
  /** Fired when buffer space becomes available again after a previous onBufferFull. */
  onBufferAvailable: (() => void) | null;
  /** Fired after SourceBuffer updateend, when buffered ranges may have changed. */
  onBufferUpdated: (() => void) | null;
  /** ManagedMediaSource: UA wants more media data appended (streaming → true). */
  onStartStreaming: (() => void) | null;
  /** ManagedMediaSource: UA has enough buffered data (streaming → false). */
  onEndStreaming: (() => void) | null;
  /** Fired when the MediaSource is closed by the UA (not by destroy), e.g. iOS reclaiming the media pipeline in background. */
  onSourceClose: (() => void) | null;
  onError: ((info: { code: number; msg: string; name?: string; track?: Track; codec?: string }) => void) | null;
}

const TAG = "MSE";

export function createMediaSourceController(video: HTMLVideoElement, config: PlayerConfig): MediaSourceController {
  // Use ManagedMediaSource only if w3c MediaSource is not available (e.g. iOS Safari)
  const selfRecord = self as unknown as Record<string, unknown>;
  const useManagedMediaSource = "ManagedMediaSource" in self && !("MediaSource" in self);

  let mediaSource: MSEMediaSource | null = null;
  let objectURL: string | null = null;
  let destroying = false;

  const sourceBuffers: Record<Track, SourceBuffer | null> = { video: null, audio: null };
  const pendingSegments: Record<Track, PendingSegment[]> = { video: [], audio: [] };
  const pendingRemoveRanges: Record<Track, RemoveRange[]> = { video: [], audio: [] };
  const mimeTypes: Record<Track, string | null> = { video: null, audio: null };
  const lastInitSegments: Record<Track, InitSegmentRecord | null> = { video: null, audio: null };
  const disabledTracks = new Set<Track>();

  let isBufferFull = false;
  let hasPendingEos = false;
  let pendingDuration: number | null = null;

  // Deferred init segments: queued before sourceopen fires
  let pendingSourceBufferInit: { track: Track; data: ArrayBuffer; codec: string; container: string }[] = [];

  let sourceOpenCallback: (() => void) | null = null;

  // Event handler references for cleanup
  let onSourceOpenHandler: (() => void) | null = null;
  let onSourceEndedHandler: (() => void) | null = null;
  let onSourceCloseHandler: (() => void) | null = null;
  let onStartStreamingHandler: (() => void) | null = null;
  let onEndStreamingHandler: (() => void) | null = null;
  let onQualityChangeHandler: (() => void) | null = null;

  // Per-track event handler references for cleanup
  const sbErrorHandlers: Record<Track, ((e: Event) => void) | null> = { video: null, audio: null };
  const sbUpdateEndHandlers: Record<Track, (() => void) | null> = { video: null, audio: null };

  // --- Internal helpers ---

  function hasPendingSegments(): boolean {
    return pendingSegments.video.length > 0 || pendingSegments.audio.length > 0;
  }

  function hasPendingRemoveRanges(): boolean {
    return pendingRemoveRanges.video.length > 0 || pendingRemoveRanges.audio.length > 0;
  }

  function disableTrack(track: Track): void {
    disabledTracks.add(track);
    pendingSegments[track] = [];
    pendingRemoveRanges[track] = [];
    pendingSourceBufferInit = pendingSourceBufferInit.filter((pending) => pending.track !== track);
    lastInitSegments[track] = null;
  }

  function doRemoveRanges(): void {
    const tracks: Track[] = ["video", "audio"];
    for (const track of tracks) {
      const sb = sourceBuffers[track];
      if (!sb || sb.updating) {
        continue;
      }
      const ranges = pendingRemoveRanges[track];
      while (ranges.length > 0 && !sb.updating) {
        const range = ranges.shift() as RemoveRange;
        sb.remove(range.start, range.end);
      }
    }
  }

  let appendGateLogged = false;

  function canAppendToManagedSource(): boolean {
    // ManagedMediaSource only accepts appends while streaming === true.
    // When the property is absent (regular MediaSource), always allow appends.
    const allowed = !useManagedMediaSource || mediaSource?.streaming !== false;
    if (!allowed && !appendGateLogged) {
      appendGateLogged = true;
      Log.v(
        TAG,
        `Appends deferred: MMS streaming=false (pending video:${pendingSegments.video.length} audio:${pendingSegments.audio.length})`,
      );
    }
    return allowed;
  }

  function bufferedSummary(): string {
    const fmt = (sb: SourceBuffer | null): string => {
      if (!sb) return "-";
      const parts: string[] = [];
      for (let i = 0; i < sb.buffered.length; i++) {
        parts.push(`${sb.buffered.start(i).toFixed(2)}-${sb.buffered.end(i).toFixed(2)}`);
      }
      return parts.join(",") || "empty";
    };
    return `video[${fmt(sourceBuffers.video)}] audio[${fmt(sourceBuffers.audio)}]`;
  }

  function flushPendingSourceBufferInit(): void {
    if (pendingSourceBufferInit.length === 0 || mediaSource?.readyState !== "open") {
      return;
    }
    const pendings = pendingSourceBufferInit;
    pendingSourceBufferInit = [];
    for (const pending of pendings) {
      createSourceBuffer(pending.track, pending.codec, pending.container);
      if (disabledTracks.has(pending.track)) {
        continue;
      }
      lastInitSegments[pending.track] = {
        data: pending.data,
        codec: pending.codec,
        container: pending.container,
      };
    }
  }

  function tryAppendPending(): void {
    if (mediaSource?.readyState !== "open" || !canAppendToManagedSource()) {
      return;
    }
    if (hasPendingRemoveRanges()) {
      doRemoveRanges();
      return;
    }
    if (hasPendingSegments()) {
      doAppendSegments();
    }
  }

  function doAppendSegments(): void {
    const tracks: Track[] = ["video", "audio"];
    for (const track of tracks) {
      const sb = sourceBuffers[track];
      if (!sb || sb.updating) {
        continue;
      }
      if (!canAppendToManagedSource()) {
        return;
      }

      if (pendingSegments[track].length > 0) {
        const entry = pendingSegments[track].shift() as PendingSegment;

        if (!entry || entry.data.byteLength === 0) {
          continue;
        }

        try {
          if (entry.timestampOffset !== undefined) {
            sb.timestampOffset = entry.timestampOffset / 1000;
          }
          sb.appendBuffer(entry.data);
          if (isBufferFull) {
            isBufferFull = false;
            mse.onBufferAvailable?.();
          }
        } catch (error: unknown) {
          pendingSegments[track].unshift(entry);
          if ((error as DOMException).code === 22) {
            // QuotaExceededError
            if (!isBufferFull) {
              mse.onBufferFull?.();
            }
            isBufferFull = true;
          } else {
            Log.e(TAG, (error as Error).message);
            mse.onError?.({
              code: (error as DOMException).code,
              msg: (error as Error).message,
            });
          }
        }
      }
    }
  }

  function needCleanupSourceBuffer(): boolean {
    const currentTime = video.currentTime;
    const tracks: Track[] = ["video", "audio"];
    for (const track of tracks) {
      const sb = sourceBuffers[track];
      if (sb) {
        const buffered = sb.buffered;
        if (buffered.length >= 1) {
          if (currentTime - buffered.start(0) >= config.bufferCleanupMaxBackward) {
            return true;
          }
        }
      }
    }
    return false;
  }

  function doCleanupSourceBuffer(): void {
    const currentTime = video.currentTime;
    const tracks: Track[] = ["video", "audio"];
    for (const track of tracks) {
      const sb = sourceBuffers[track];
      if (sb) {
        const buffered = sb.buffered;
        let doRemove = false;

        for (let i = 0; i < buffered.length; i++) {
          const start = buffered.start(i);
          const end = buffered.end(i);

          if (start <= currentTime && currentTime < end + 3) {
            // padding 3 seconds
            if (currentTime - start >= config.bufferCleanupMaxBackward) {
              doRemove = true;
              const removeEnd = currentTime - config.bufferCleanupMinBackward;
              pendingRemoveRanges[track].push({ start, end: removeEnd });
            }
          } else if (end < currentTime - config.bufferCleanupMaxBackward) {
            // Drop stale ranges left behind after a forward seek (e.g. Go Live), but
            // keep recent rewind history — immediate removal on end < currentTime was
            // wiping the DVR window users expect to seek back into.
            doRemove = true;
            pendingRemoveRanges[track].push({ start, end });
          }
        }

        if (doRemove && !sb.updating) {
          doRemoveRanges();
        }
      }
    }
  }

  function tryApplyDuration(): void {
    if (pendingDuration === null || mediaSource?.readyState !== "open") {
      return;
    }
    if (sourceBuffers.video?.updating || sourceBuffers.audio?.updating) {
      return; // retried on the next updateend
    }
    try {
      if (!(mediaSource.duration >= pendingDuration)) {
        mediaSource.duration = pendingDuration;
      }
      pendingDuration = null;
    } catch (error: unknown) {
      Log.w(TAG, `Failed to set duration: ${(error as Error).message}`);
    }
  }

  function onSourceBufferUpdateEnd(): void {
    mse.onBufferUpdated?.();
    tryApplyDuration();
    if (hasPendingRemoveRanges()) {
      doRemoveRanges();
    } else if (hasPendingSegments()) {
      tryAppendPending();
    } else if (hasPendingEos) {
      mse.endOfStream();
    } else if (isBufferFull) {
      // All queued segments drained and removals finished — buffer has room again
      isBufferFull = false;
      mse.onBufferAvailable?.();
    }
  }

  function onSourceBufferError(e: Event): void {
    Log.e(TAG, `SourceBuffer Error:`, e);
  }

  function createSourceBuffer(track: Track, codec: string, container: string): void {
    if (disabledTracks.has(track)) {
      return;
    }
    if (mediaSource?.readyState !== "open") {
      return;
    }

    let mimeType = container;
    if (codec && codec.length > 0) {
      // Quoting is required when the codec list contains commas (muxed fMP4 renditions)
      mimeType += `;codecs="${codec}"`;
    }

    if (mimeType !== mimeTypes[track]) {
      const existing = sourceBuffers[track];
      if (existing) {
        // Mid-stream codec change: addSourceBuffer would throw QuotaExceededError once
        // the media engine has initialized, so switch the existing SourceBuffer's type.
        try {
          existing.changeType(mimeType);
          mimeTypes[track] = mimeType;
        } catch (error: unknown) {
          Log.e(TAG, `changeType failed: ${(error as Error).message}`);
          if ((error as DOMException).name === "NotSupportedError") {
            disableTrack(track);
          }
          mse.onError?.({
            code: (error as DOMException).code,
            msg: (error as Error).message,
            name: (error as DOMException).name,
            track,
            codec,
          });
        }
        return;
      }
      try {
        const sb = mediaSource.addSourceBuffer(mimeType);
        sourceBuffers[track] = sb;

        const errorHandler = (e: Event) => onSourceBufferError(e);
        const updateEndHandler = () => onSourceBufferUpdateEnd();
        sbErrorHandlers[track] = errorHandler;
        sbUpdateEndHandlers[track] = updateEndHandler;

        sb.addEventListener("error", errorHandler);
        sb.addEventListener("updateend", updateEndHandler);
      } catch (error: unknown) {
        Log.e(TAG, (error as Error).message);
        if ((error as DOMException).name === "NotSupportedError") {
          disableTrack(track);
        }
        mse.onError?.({
          code: (error as DOMException).code,
          msg: (error as Error).message,
          name: (error as DOMException).name,
          track,
          codec,
        });
        return;
      }
      mimeTypes[track] = mimeType;
    }
  }

  // --- The MSE object ---

  const mse: MediaSourceController = {
    onBufferFull: null,
    onBufferAvailable: null,
    onBufferUpdated: null,
    onStartStreaming: null,
    onEndStreaming: null,
    onSourceClose: null,
    onError: null,

    open(onOpen: () => void): void {
      if (mediaSource) {
        Log.e(TAG, "MediaSource has already been attached");
        return;
      }

      if (useManagedMediaSource) {
        Log.v(TAG, "Using ManagedMediaSource");
      }

      sourceOpenCallback = onOpen;

      const MSEConstructor = (useManagedMediaSource ? selfRecord.ManagedMediaSource : selfRecord.MediaSource) as {
        new (): MSEMediaSource;
      };
      const ms = new MSEConstructor();
      mediaSource = ms;

      onSourceOpenHandler = () => {
        Log.v(TAG, "MediaSource onSourceOpen");
        ms.removeEventListener("sourceopen", onSourceOpenHandler);

        flushPendingSourceBufferInit();
        tryAppendPending();

        sourceOpenCallback?.();
        sourceOpenCallback = null;
      };

      onSourceEndedHandler = () => {
        Log.v(TAG, "MediaSource onSourceEnded");
      };

      onSourceCloseHandler = () => {
        Log.v(TAG, "MediaSource onSourceClose");
        if (mediaSource) {
          mediaSource.removeEventListener("sourceopen", onSourceOpenHandler);
          mediaSource.removeEventListener("sourceended", onSourceEndedHandler);
          mediaSource.removeEventListener("sourceclose", onSourceCloseHandler);
          if (useManagedMediaSource) {
            mediaSource.removeEventListener("startstreaming", onStartStreamingHandler);
            mediaSource.removeEventListener("endstreaming", onEndStreamingHandler);
            mediaSource.removeEventListener("qualitychange", onQualityChangeHandler);
          }
        }
        // The SourceBuffers are detached now; accessing them (even .buffered)
        // throws InvalidStateError. Drop the refs so queued appends become no-ops.
        sourceBuffers.video = null;
        sourceBuffers.audio = null;
        mimeTypes.video = null;
        mimeTypes.audio = null;
        if (!destroying) {
          Log.w(TAG, "MediaSource closed unexpectedly (e.g. reclaimed by the OS in background)");
          mse.onSourceClose?.();
        }
      };

      ms.addEventListener("sourceopen", onSourceOpenHandler);
      ms.addEventListener("sourceended", onSourceEndedHandler);
      ms.addEventListener("sourceclose", onSourceCloseHandler);

      if (useManagedMediaSource) {
        onStartStreamingHandler = () => {
          appendGateLogged = false;
          Log.v(
            TAG,
            `ManagedMediaSource onStartStreaming, pending video:${pendingSegments.video.length} audio:${pendingSegments.audio.length}, buffered: ${bufferedSummary()}`,
          );
          flushPendingSourceBufferInit();
          tryAppendPending();
          mse.onStartStreaming?.();
        };
        onEndStreamingHandler = () => {
          Log.v(TAG, `ManagedMediaSource onEndStreaming, buffered: ${bufferedSummary()}`);
          mse.onEndStreaming?.();
        };
        onQualityChangeHandler = () => {
          Log.v(TAG, "ManagedMediaSource onQualityChange");
        };

        ms.addEventListener("startstreaming", onStartStreamingHandler);
        ms.addEventListener("endstreaming", onEndStreamingHandler);
        ms.addEventListener("qualitychange", onQualityChangeHandler);
      }

      // Attach MediaSource to video element (blob URL for both MSE and MMS per spec examples)
      if (useManagedMediaSource) {
        video.disableRemotePlayback = true;
      }
      objectURL = URL.createObjectURL(ms as unknown as MediaSource);
      video.src = objectURL;
    },

    appendInit(track: Track, data: ArrayBuffer, codec: string, container: string): void {
      if (disabledTracks.has(track)) {
        return;
      }
      if (mediaSource?.readyState !== "open" || mediaSource.streaming === false) {
        pendingSourceBufferInit.push({ track, data, codec, container });
        pendingSegments[track].push({ data });
        return;
      }

      const mimePreview = codec ? `${container};codecs="${codec}"` : container;
      Log.v(TAG, `Received Initialization Segment, mimeType: ${mimePreview}`);
      lastInitSegments[track] = { data, codec, container };

      createSourceBuffer(track, codec, container);
      if (disabledTracks.has(track)) {
        return;
      }
      pendingSegments[track].push({ data });
      tryAppendPending();
    },

    appendMedia(track: Track, data: ArrayBuffer, timestampOffset?: number): void {
      if (disabledTracks.has(track)) {
        return;
      }
      pendingSegments[track].push({ data, timestampOffset });

      // After the MediaSource closes (e.g. iOS background reclaim), the
      // SourceBuffers are dead — touching them throws InvalidStateError.
      if (mediaSource?.readyState !== "open") {
        return;
      }

      if (needCleanupSourceBuffer()) {
        doCleanupSourceBuffer();
      }

      tryAppendPending();
    },

    setDuration(seconds: number): void {
      pendingDuration = seconds;
      tryApplyDuration();
    },

    endOfStream(): void {
      if (mediaSource?.readyState !== "open") {
        if (mediaSource?.readyState === "closed" && hasPendingSegments()) {
          hasPendingEos = true;
        }
        return;
      }
      const sbVideo = sourceBuffers.video;
      const sbAudio = sourceBuffers.audio;
      if (sbVideo?.updating || sbAudio?.updating) {
        hasPendingEos = true;
      } else {
        hasPendingEos = false;
        mediaSource.endOfStream();
      }
    },

    destroy(): void {
      destroying = true;
      if (mediaSource) {
        const ms = mediaSource;
        const tracks: Track[] = ["video", "audio"];

        for (const track of tracks) {
          pendingSegments[track].splice(0, pendingSegments[track].length);
          pendingRemoveRanges[track].splice(0, pendingRemoveRanges[track].length);
          lastInitSegments[track] = null;

          const sb = sourceBuffers[track];
          if (sb) {
            if (ms.readyState !== "closed") {
              try {
                ms.removeSourceBuffer(sb);
              } catch (error: unknown) {
                Log.e(TAG, (error as Error).message);
              }
              if (sbErrorHandlers[track]) {
                sb.removeEventListener("error", sbErrorHandlers[track] as EventListener);
                sbErrorHandlers[track] = null;
              }
              if (sbUpdateEndHandlers[track]) {
                sb.removeEventListener("updateend", sbUpdateEndHandlers[track] as EventListener);
                sbUpdateEndHandlers[track] = null;
              }
            }
            mimeTypes[track] = null;
            sourceBuffers[track] = null;
          }
        }

        ms.removeEventListener("sourceopen", onSourceOpenHandler);
        ms.removeEventListener("sourceended", onSourceEndedHandler);
        ms.removeEventListener("sourceclose", onSourceCloseHandler);
        if (useManagedMediaSource) {
          ms.removeEventListener("startstreaming", onStartStreamingHandler);
          ms.removeEventListener("endstreaming", onEndStreamingHandler);
          ms.removeEventListener("qualitychange", onQualityChangeHandler);
        }

        video.removeAttribute("src");
        video.load();

        onSourceOpenHandler = null;
        onSourceEndedHandler = null;
        onSourceCloseHandler = null;
        onStartStreamingHandler = null;
        onEndStreamingHandler = null;
        onQualityChangeHandler = null;

        pendingSourceBufferInit = [];
        disabledTracks.clear();
        isBufferFull = false;
        hasPendingEos = false;
        pendingDuration = null;
        mediaSource = null;
      }

      if (objectURL) {
        URL.revokeObjectURL(objectURL);
        objectURL = null;
      }

      mse.onBufferFull = null;
      mse.onBufferAvailable = null;
      mse.onBufferUpdated = null;
      mse.onStartStreaming = null;
      mse.onEndStreaming = null;
      mse.onSourceClose = null;
      mse.onError = null;
      sourceOpenCallback = null;
    },
  };

  return mse;
}
