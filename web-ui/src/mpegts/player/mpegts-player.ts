import { PCMAudioPlayer } from "../audio/pcm-audio-player";
import type { PlayerConfig } from "../config";
import type { PlayerImpl, PlayerSegment } from "../types";
import type { WorkerCommand, WorkerEvent } from "../worker/messages";
import TransmuxWorker from "../worker/transmux-worker.ts?worker&inline";
import { setupLiveSync, setupStartupStallJumper } from "./live-sync";
import { createMSE, type MSE } from "./mse";

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
  let destroyStallJumper: (() => void) | null = null;
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
      if (buffered.length === 0) return;
      const ahead = buffered.end(buffered.length - 1) - video.currentTime;
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

    mse.onEndStreaming = () => {
      const cmd: WorkerCommand = { type: "pause" };
      worker?.postMessage(cmd);
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
      destroyLiveSync = setupLiveSync(video, config);
    }
    destroyStallJumper?.();
    destroyStallJumper = setupStartupStallJumper(video);
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
      destroyStallJumper?.();
      destroyStallJumper = null;
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
