import { PCMAudioPlayer } from "../audio/pcm-audio-player";
import type { PlayerConfig } from "../config";
import type { PlayerImpl, PlayerSegment } from "../types";
import Log from "../utils/logger";
import type { WorkerCommand, WorkerEvent } from "../worker/messages";
import TransmuxWorker from "../worker/transmux-worker.ts?worker&inline";
import { type StallJumper, setupLiveSync, setupStartupStallJumper } from "./live-sync";
import { createMSE, type MSE } from "./mse";

const TAG = "Player";

/** Attach verbose listeners to media element events for diagnosing playback stalls. */
function setupVideoDebugLogs(video: HTMLVideoElement): () => void {
  const events = ["loadedmetadata", "canplay", "playing", "waiting", "stalled", "pause", "seeking", "seeked", "error"];
  const handler = (e: Event) => {
    const buffered: string[] = [];
    for (let i = 0; i < video.buffered.length; i++) {
      buffered.push(`${video.buffered.start(i).toFixed(2)}-${video.buffered.end(i).toFixed(2)}`);
    }
    Log.v(
      TAG,
      `video event '${e.type}': currentTime=${video.currentTime.toFixed(2)}, readyState=${video.readyState}, paused=${video.paused}, buffered=[${buffered.join(",")}]${e.type === "error" ? `, error=${video.error?.code}:${video.error?.message}` : ""}`,
    );
  };
  for (const ev of events) {
    video.addEventListener(ev, handler);
  }
  return () => {
    for (const ev of events) {
      video.removeEventListener(ev, handler);
    }
  };
}

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
  let stallJumper: StallJumper | null = null;
  let mseGeneration = 0;
  let liveSyncEnabled = config.liveSync;

  // HLS playlist info reported by the worker (null when playing a non-HLS source)
  let hlsInfo: { live: boolean; totalDuration: number } | null = null;
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

  function handleWorkerMessage(e: MessageEvent): void {
    const msg = e.data as WorkerEvent | { type: "destroyed" };
    if (msg.type === "destroyed") return;
    // Discard stale messages from a previous load generation
    if (msg.gen !== mseGeneration) return;
    switch (msg.type) {
      case "init-segment":
        mse?.appendInit(msg.track, msg.data, msg.codec, msg.container);
        break;
      case "media-segment":
        mse?.appendMedia(msg.track, msg.data);
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
        hlsInfo = { live: msg.live, totalDuration: msg.totalDuration };
        if (!msg.live) {
          mse?.setDuration(msg.totalDuration);
          startWatermarkThrottle();
        }
        break;
      case "pcm-audio-data": {
        const player = ensurePCMPlayer();
        const pcm = new Float32Array(msg.pcm);
        pcmPlayerInitPromise?.then(() => {
          player.feed(pcm, msg.channels, msg.sampleRate, msg.pts / 1000);
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

    // Buffered ranges change exactly on SourceBuffer updateend; re-check for startup
    // stalls there (iOS does not reliably fire progress/stalled on the media element).
    mse.onBufferedChange = () => stallJumper?.check();

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

  let destroyVideoDebugLogs: (() => void) | null = null;

  function initLiveHelpers(): void {
    if (!destroyLiveSync && liveSyncEnabled) {
      destroyLiveSync = setupLiveSync(video, config);
    }
    stallJumper?.destroy();
    stallJumper = setupStartupStallJumper(video);
    destroyVideoDebugLogs?.();
    destroyVideoDebugLogs = setupVideoDebugLogs(video);
  }

  const impl: PlayerImpl = {
    onError: null,

    loadSegments(segments: PlayerSegment[]) {
      mseGeneration++;
      hlsInfo = null;
      stopWatermarkThrottle();
      if (mse) {
        mse.destroy();
        mse = null;
      }
      destroyPCMPlayer();
      initMSE();
      initLiveHelpers();
      pendingSegments = segments;
    },

    setLiveSync(enabled: boolean) {
      if (enabled && !destroyLiveSync) {
        liveSyncEnabled = true;
        destroyLiveSync = setupLiveSync(video, config);
      } else if (!enabled && destroyLiveSync) {
        liveSyncEnabled = false;
        destroyLiveSync();
        destroyLiveSync = null;
      }
    },

    seek(seconds: number) {
      if (isBuffered(video, seconds)) {
        video.currentTime = seconds;
      } else if (hlsInfo && !hlsInfo.live) {
        // HLS VOD/EVENT: reposition inside the playlist (worker reschedules segments)
        const cmd: WorkerCommand = { type: "seek", seconds };
        worker?.postMessage(cmd);
        // The watermark throttle may be holding the worker paused; the seek target
        // needs data now, so resume immediately (the throttle re-pauses if needed)
        if (watermarkPaused) {
          watermarkPaused = false;
          worker?.postMessage({ type: "resume" } satisfies WorkerCommand);
        }
        video.currentTime = seconds;
      } else {
        for (const h of seekHandlers) {
          h(seconds);
        }
      }
    },

    suspend() {
      stopWatermarkThrottle();
      hlsInfo = null;
      if (mse) {
        mse.destroy();
        mse = null;
      }
      destroyPCMPlayer();
      destroyLiveSync?.();
      destroyLiveSync = null;
      stallJumper?.destroy();
      stallJumper = null;
      destroyVideoDebugLogs?.();
      destroyVideoDebugLogs = null;
    },

    destroy() {
      impl.suspend();
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
