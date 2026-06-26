import { markPlaybackUnlocked, PCMAudioPlayer } from "../audio/pcm-audio-player";
import type { PlayerConfig } from "../config";
import type { PlayerImpl, PlayerSegment } from "../types";
import type { WorkerCommand, WorkerEvent } from "../worker/messages";
import TransmuxWorker from "../worker/transmux-worker.ts?worker&inline";
import { setupLiveSync } from "./live-sync";
import { createMSE, type MSE } from "./mse";
import type { LiveSessionAnchor } from "./wall-clock";

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
const VOD_FORWARD_BUFFER_RESUME = 15;

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

  let watermarkTimer: ReturnType<typeof setInterval> | null = null;
  let watermarkPaused = false;

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
    if (msg.type !== "init-segment") {
      flushPendingInits();
    }
    switch (msg.type) {
      case "init-segment":
        pendingInits.push({ track: msg.track, data: msg.data, codec: msg.codec, container: msg.container });
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
        if (!msg.live) {
          mse?.setDuration(msg.totalDuration);
          startWatermarkThrottle();
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

  /** Throttle fetching for HLS VOD/EVENT: pause the worker when buffered far ahead of playback. */
  function startWatermarkThrottle(): void {
    if (watermarkTimer) return;
    watermarkTimer = setInterval(() => {
      const buffered = video.buffered;
      // Measure forward buffer within the range containing currentTime; after a seek
      // to an unbuffered position, stale ranges further ahead must not count.
      let ahead = 0;
      for (let i = 0; i < buffered.length; i++) {
        if (video.currentTime >= buffered.start(i) && video.currentTime <= buffered.end(i)) {
          ahead = buffered.end(i) - video.currentTime;
          break;
        }
      }
      if (!watermarkPaused && ahead > VOD_FORWARD_BUFFER_PAUSE) {
        watermarkPaused = true;
        worker?.postMessage({ type: "pause" } satisfies WorkerCommand);
      } else if (watermarkPaused && ahead < VOD_FORWARD_BUFFER_RESUME) {
        watermarkPaused = false;
        worker?.postMessage({ type: "resume" } satisfies WorkerCommand);
      }
    }, 1000);
  }

  /** Resume segment fetching after an in-buffer seek (worker may have paused on buffer full). */
  function resumeWorkerAfterBufferSeek(): void {
    if (watermarkPaused) {
      watermarkPaused = false;
    }
    worker?.postMessage({ type: "resume" } satisfies WorkerCommand);
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

  function stopWatermarkThrottle(): void {
    if (watermarkTimer) {
      clearInterval(watermarkTimer);
      watermarkTimer = null;
    }
    watermarkPaused = false;
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
      const cmd: WorkerCommand = { type: "pause" };
      worker?.postMessage(cmd);
    };

    mse.onBufferAvailable = () => {
      // Don't resume while the VOD watermark throttle is intentionally holding the worker
      if (watermarkPaused) return;
      const cmd: WorkerCommand = { type: "resume" };
      worker?.postMessage(cmd);
    };

    mse.onStartStreaming = () => {
      if (watermarkPaused) return;
      const cmd: WorkerCommand = { type: "resume" };
      worker?.postMessage(cmd);
    };

    // Note: onEndStreaming intentionally does NOT pause the worker. For continuous
    // live TS streams, pausing aborts the in-flight fetch and resumes via a Range
    // request, which restarts a live stream mid-flow and corrupts the timeline.
    // The MSE layer already defers appends while ManagedMediaSource streaming=false.

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
      destroyLiveSync = setupLiveSync(video, config, () => liveSessionAnchor);
    }
  }

  const onVideoPlay = () => markPlaybackUnlocked();
  video.addEventListener("play", onVideoPlay);

  const impl: PlayerImpl = {
    onError: null,

    loadSegments(segments: PlayerSegment[]) {
      mseGeneration++;
      pendingInits = [];
      pendingSegments = segments;
      stopWatermarkThrottle();
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
        destroyLiveSync = setupLiveSync(video, config, () => liveSessionAnchor);
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
      seekTo(targetMseSeconds);
    },

    setLiveSessionAnchor(anchor: LiveSessionAnchor) {
      liveSessionAnchor = anchor;
    },

    suspend() {
      mseGeneration++;
      stopWatermarkThrottle();
      pendingInits = [];
      pendingSegments = null;
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
