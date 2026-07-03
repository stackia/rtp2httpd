import { markPlaybackUnlocked, PCMAudioPlayer } from "../audio/pcm-audio-player";
import type { PlayerConfig } from "../config";
import type { PlayerImpl, PlayerSegment } from "../types";
import type { WorkerCommand, WorkerEvent } from "../worker/messages";
import TransmuxWorker from "../worker/transmux-worker.ts?worker&inline";
import { setupLiveSync } from "./live-sync";
import { createMSE, type MSE } from "./mse";
import { type LiveSessionAnchor, lagBehindLiveEdge } from "./wall-clock";

/** Check if a given time position is within any buffered range of the video element. */
export function isBuffered(video: HTMLMediaElement, seconds: number): boolean {
  const buffered = video.buffered;
  for (let i = 0; i < buffered.length; i++) {
    if (seconds >= buffered.start(i) && seconds <= buffered.end(i)) {
      return true;
    }
  }
  return false;
}

/** Forward buffer watermarks for HLS VOD/EVENT: pause fetching when far ahead of playback. */
const VOD_FORWARD_BUFFER_PAUSE = 30;
const BACKPRESSURE_RESUME_BUFFER_AHEAD = 15;
const LIVE_STATE_TOLERANCE = 3;
const HLS_URL_RE = /\.m3u8?($|\?)/i;

type SourceMode = "continuous-live-ts" | "static-ts-list" | "hls";

export function createMpegtsPlayer(
  video: HTMLVideoElement,
  config: PlayerConfig,
  seekHandlers: Set<(s: number) => void>,
): PlayerImpl {
  let mse: MSE | null = null;
  let worker: Worker | null = null;
  let workerInitialized = false;
  let pendingSegments: PlayerSegment[] | null = null;
  let destroyLiveSync: (() => void) | null = null;
  let mseGeneration = 0;
  let liveSyncEnabled = config.liveSync;
  /** Live edge assuming continuous playback since session start. */
  let liveSessionAnchor: LiveSessionAnchor | null = null;
  let sourceMode: SourceMode = "static-ts-list";
  let hlsLive: boolean | null = null;
  let lastLiveState: boolean | null = null;

  let hlsVodThrottleEnabled = false;
  let watermarkPaused = false;
  let bufferFullPaused = false;

  // PCM audio player for software-decoded audio (MP2)
  let pcmPlayer: PCMAudioPlayer | null = null;
  let pcmPlayerInitPromise: Promise<void> | null = null;

  function ensurePCMPlayer(): PCMAudioPlayer {
    if (!pcmPlayer) {
      pcmPlayer = new PCMAudioPlayer(config);
      pcmPlayer.onSuspended = () => impl.onAudioSuspended?.();
      pcmPlayerInitPromise = pcmPlayer.init();
      pcmPlayer.attachVideo(video);
    }
    return pcmPlayer;
  }

  function destroyPCMPlayer(): void {
    if (pcmPlayer) {
      pcmPlayer.destroy();
      pcmPlayer = null;
      pcmPlayerInitPromise = null;
    }
  }

  // Init segments are batched and flushed together when the first non-init message
  // arrives. Each worker message is delivered in its own event-loop task; appending
  // the video init segment and yielding lets the UA finish parsing it and lock the
  // SourceBuffer set before the audio init arrives — addSourceBuffer then throws
  // QuotaExceededError ("reached the limit") and the stream plays without sound.
  // Flushing both inits in one task creates all SourceBuffers before any init
  // segment parse can complete (the append algorithm runs as a queued task).
  let pendingInits: { track: "video" | "audio"; data: ArrayBuffer; codec: string; container: string }[] = [];

  function flushPendingInits(): void {
    if (pendingInits.length === 0) return;
    const inits = pendingInits;
    pendingInits = [];
    for (const init of inits) {
      mse?.appendInit(init.track, init.data, init.codec, init.container);
    }
  }

  function handleWorkerMessage(e: MessageEvent): void {
    const msg = e.data as WorkerEvent | { type: "destroyed" };
    if (msg.type === "destroyed") return;
    // Discard stale messages from a previous load generation
    if (msg.gen !== mseGeneration) return;
    // video-info is posted right before its init-segment; flushing on it would
    // split the batched init appends (see comment above pendingInits)
    if (msg.type !== "init-segment" && msg.type !== "video-info") {
      flushPendingInits();
    }
    switch (msg.type) {
      case "init-segment":
        pendingInits.push({ track: msg.track, data: msg.data, codec: msg.codec, container: msg.container });
        break;
      case "video-info":
        impl.onVideoInfo?.({ width: msg.width, height: msg.height, mayBeInterlaced: msg.mayBeInterlaced });
        break;
      case "media-segment":
        mse?.appendMedia(msg.track, msg.data, msg.timestampOffset);
        break;
      case "error":
        impl.onError?.({
          category: msg.category === "io" ? "io" : "demux",
          detail: msg.detail,
          info: msg.info,
        });
        break;
      case "complete":
        mse?.endOfStream();
        break;
      case "hls-info":
        sourceMode = "hls";
        hlsLive = msg.live;
        updateLiveState();
        if (!msg.live) {
          mse?.setDuration(msg.totalDuration);
          hlsVodThrottleEnabled = true;
          updateFetchBackpressure();
        }
        break;
      case "pcm-audio-data": {
        const player = ensurePCMPlayer();
        const pcm = new Float32Array(msg.pcm);
        const gen = mseGeneration;
        pcmPlayerInitPromise?.then(() => {
          if (gen !== mseGeneration) return;
          player.feed(pcm, msg.channels, msg.sampleRate, msg.time);
        });
        break;
      }
    }
  }

  function ensureWorker(): Worker {
    if (!worker) {
      worker = new TransmuxWorker();
      worker.onmessage = handleWorkerMessage;
      workerInitialized = false;
    }
    return worker;
  }

  function getForwardBufferAhead(): number {
    const buffered = video.buffered;
    // Measure forward buffer within the range containing currentTime; after a seek
    // to an unbuffered position, stale ranges further ahead must not count.
    for (let i = 0; i < buffered.length; i++) {
      if (video.currentTime >= buffered.start(i) && video.currentTime <= buffered.end(i)) {
        return buffered.end(i) - video.currentTime;
      }
    }
    return 0;
  }

  function getLastBufferedRange(): { start: number; end: number } | null {
    const buffered = video.buffered;
    if (buffered.length === 0) {
      return null;
    }

    const lastRange = buffered.length - 1;
    return { start: buffered.start(lastRange), end: buffered.end(lastRange) };
  }

  function getContinuousLiveTsGoLiveTarget(): number | null {
    const range = getLastBufferedRange();
    if (!range) {
      return null;
    }

    const target = range.end - config.liveSyncTargetLatency;

    if (target < range.start || target > range.end) {
      return null;
    }
    return target;
  }

  function isContinuousLiveTsLive(): boolean {
    const range = getLastBufferedRange();
    if (!range) {
      return true;
    }

    const target = Math.max(range.start, range.end - config.liveSyncTargetLatency);
    return video.currentTime >= target - LIVE_STATE_TOLERANCE && video.currentTime <= range.end + LIVE_STATE_TOLERANCE;
  }

  /** Seconds behind the source-mode live edge; live-sync keeps this near the target latency. */
  function getLiveEdgeLatency(): number | null {
    if (sourceMode === "continuous-live-ts") {
      const range = getLastBufferedRange();
      return range ? range.end - video.currentTime : null;
    }
    if (sourceMode === "hls") {
      if (hlsLive === false || !liveSessionAnchor) {
        return null;
      }
      return lagBehindLiveEdge(liveSessionAnchor, video.currentTime);
    }
    return null;
  }

  function computeLiveState(): boolean {
    if (sourceMode === "continuous-live-ts") {
      return isContinuousLiveTsLive();
    }
    if (sourceMode === "hls") {
      if (hlsLive === false) {
        return false;
      }
      if (!liveSessionAnchor) {
        return true;
      }
      return lagBehindLiveEdge(liveSessionAnchor, video.currentTime) < LIVE_STATE_TOLERANCE;
    }
    return false;
  }

  function updateLiveState(): void {
    const next = computeLiveState();
    if (next === lastLiveState) {
      return;
    }
    lastLiveState = next;
    impl.onLiveStateChange?.(next);
  }

  function pauseWorkerForBackpressure(kind: "watermark" | "buffer-full"): void {
    if (kind === "watermark") {
      watermarkPaused = true;
    } else {
      bufferFullPaused = true;
    }
    worker?.postMessage({ type: "pause" } satisfies WorkerCommand);
  }

  function resumeWorkerFromBackpressure(): void {
    watermarkPaused = false;
    bufferFullPaused = false;
    worker?.postMessage({ type: "resume" } satisfies WorkerCommand);
  }

  function updateFetchBackpressure(): void {
    const ahead = getForwardBufferAhead();

    if (watermarkPaused || bufferFullPaused) {
      if (ahead < BACKPRESSURE_RESUME_BUFFER_AHEAD) {
        resumeWorkerFromBackpressure();
      }
      return;
    }

    if (hlsVodThrottleEnabled && ahead > VOD_FORWARD_BUFFER_PAUSE) {
      pauseWorkerForBackpressure("watermark");
    }
  }

  /** Re-evaluate fetching after an in-buffer seek (worker may have paused on buffer full). */
  function resumeWorkerAfterBufferSeek(): void {
    updateFetchBackpressure();
    updateLiveState();
  }

  /** Seek within existing MSE buffer without reloading the stream. */
  function bufferSeek(seconds: number): boolean {
    if (!isBuffered(video, seconds)) {
      return false;
    }
    video.currentTime = seconds;
    resumeWorkerAfterBufferSeek();
    return true;
  }

  function seekTo(seconds: number): void {
    if (bufferSeek(seconds)) {
      return;
    }
    for (const h of seekHandlers) {
      h(seconds);
    }
  }

  function goLiveTo(targetMseSeconds: number): void {
    if (sourceMode === "continuous-live-ts") {
      const bufferedTarget = getContinuousLiveTsGoLiveTarget();
      if (bufferedTarget !== null && bufferSeek(bufferedTarget)) {
        return;
      }
      // Use the session target for the fallback so the outer handler treats it as a live-edge reload.
      for (const h of seekHandlers) {
        h(targetMseSeconds);
      }
      return;
    }

    seekTo(targetMseSeconds);
  }

  function inferSourceMode(segments: PlayerSegment[]): SourceMode {
    const firstSegment = segments[0];
    if (!firstSegment) {
      return "static-ts-list";
    }
    if (segments.length === 1 && HLS_URL_RE.test(firstSegment.url)) {
      return "hls";
    }
    if (segments.length === 1 && (firstSegment.duration ?? 0) === 0) {
      return "continuous-live-ts";
    }
    return "static-ts-list";
  }

  function resetFetchBackpressure(): void {
    hlsVodThrottleEnabled = false;
    watermarkPaused = false;
    bufferFullPaused = false;
  }

  function loadInWorker(segments: PlayerSegment[]): void {
    const w = ensureWorker();
    if (!workerInitialized) {
      const initCmd: WorkerCommand = { type: "init", segments, config, gen: mseGeneration };
      w.postMessage(initCmd);
      const startCmd: WorkerCommand = { type: "start" };
      w.postMessage(startCmd);
      workerInitialized = true;
    } else {
      const cmd: WorkerCommand = { type: "load-segments", segments, gen: mseGeneration };
      w.postMessage(cmd);
    }
  }

  /** Create (or recreate) MSE and attach to video element. */
  function initMSE(): void {
    mse = createMSE(video, config);

    mse.open(() => {
      if (pendingSegments) {
        loadInWorker(pendingSegments);
        pendingSegments = null;
      }
    });

    mse.onBufferFull = () => {
      pauseWorkerForBackpressure("buffer-full");
    };

    mse.onBufferAvailable = () => {
      updateFetchBackpressure();
    };

    mse.onBufferUpdated = () => {
      updateFetchBackpressure();
      updateLiveState();
    };

    mse.onStartStreaming = () => {
      if (watermarkPaused || bufferFullPaused) {
        updateFetchBackpressure();
        return;
      }
      worker?.postMessage({ type: "resume" } satisfies WorkerCommand);
    };

    // Note: onEndStreaming intentionally does NOT pause the worker. The MSE layer
    // already defers appends while ManagedMediaSource streaming=false.

    mse.onSourceClose = () => {
      // The UA killed the media pipeline (e.g. iOS reclaiming resources in
      // background). Stop fetching — this session cannot be revived.
      const cmd: WorkerCommand = { type: "pause" };
      worker?.postMessage(cmd);
      if (document.visibilityState === "visible") {
        // Unexpected closure while visible: surface as an error so the app retries
        impl.onError?.({
          category: "media",
          detail: "MediaSourceClosed",
          info: "MediaSource was closed unexpectedly",
        });
      }
      // When hidden, stay quiet: retrying in background would fail repeatedly and
      // exhaust the app's retry budget. The app reloads the stream on foreground.
    };

    mse.onError = (info) => {
      impl.onError?.({
        category: "media",
        detail: "MediaMSEError",
        info: info.msg,
      });
    };
  }

  function initLiveHelpers(): void {
    if (!destroyLiveSync && liveSyncEnabled) {
      destroyLiveSync = setupLiveSync(video, config, getLiveEdgeLatency);
    }
  }

  const onVideoPlay = () => {
    markPlaybackUnlocked();
    updateLiveState();
  };
  const onVideoTimeUpdate = () => {
    updateFetchBackpressure();
    updateLiveState();
  };
  video.addEventListener("play", onVideoPlay);
  video.addEventListener("timeupdate", onVideoTimeUpdate);

  const impl: PlayerImpl = {
    onError: null,

    loadSegments(segments: PlayerSegment[]) {
      mseGeneration++;
      pendingInits = [];
      pendingSegments = segments;
      sourceMode = inferSourceMode(segments);
      hlsLive = null;
      resetFetchBackpressure();
      updateLiveState();
      if (mse) {
        mse.destroy();
        mse = null;
      }
      destroyPCMPlayer();
      initMSE();
      initLiveHelpers();
    },

    setLiveSync(enabled: boolean) {
      if (enabled && !destroyLiveSync) {
        liveSyncEnabled = true;
        destroyLiveSync = setupLiveSync(video, config, getLiveEdgeLatency);
      } else if (!enabled && destroyLiveSync) {
        liveSyncEnabled = false;
        destroyLiveSync();
        destroyLiveSync = null;
      }
    },

    seek(seconds: number) {
      seekTo(seconds);
    },

    goLive(targetMseSeconds: number) {
      goLiveTo(targetMseSeconds);
    },

    setLiveSessionAnchor(anchor: LiveSessionAnchor) {
      liveSessionAnchor = anchor;
      updateLiveState();
    },

    suspend() {
      mseGeneration++;
      resetFetchBackpressure();
      pendingInits = [];
      pendingSegments = null;
      sourceMode = "static-ts-list";
      hlsLive = null;
      updateLiveState();
      if (worker) {
        const cmd: WorkerCommand = { type: "reset" };
        worker.postMessage(cmd);
        workerInitialized = false;
      }
      if (mse) {
        mse.destroy();
        mse = null;
      }
      destroyPCMPlayer();
      destroyLiveSync?.();
      destroyLiveSync = null;
    },

    destroy() {
      impl.suspend();
      video.removeEventListener("play", onVideoPlay);
      video.removeEventListener("timeupdate", onVideoTimeUpdate);
      if (worker) {
        const cmd: WorkerCommand = { type: "destroy" };
        worker.postMessage(cmd);
        worker.terminate();
        worker = null;
      }
      workerInitialized = false;
    },
  };

  return impl;
}
