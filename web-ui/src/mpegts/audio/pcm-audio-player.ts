/*
 * PCM Audio Player
 *
 * Plays decoded PCM audio using the Web Audio API, kept in sync with the
 * video element's clock.
 *
 * Design (no AudioWorklet — must work in non-secure contexts):
 *
 *  - Continuous scheduling chain: output chunks are scheduled strictly
 *    back-to-back on the AudioContext clock (`nextStartTime` accumulates),
 *    which is sample-accurate and therefore gapless. Chunk timing is never
 *    derived from video.currentTime (whose jitter caused audible clicks).
 *
 *  - Rate matching instead of frame dropping: a low-frequency control loop
 *    measures drift between the audio chain and video.currentTime and sends
 *    ratio = playbackRate * (1 - k*drift) to the worker-side software audio
 *    processor. Large discontinuities trigger a hard resync with short fades.
 *
 *  - Stream timestamps arrive from the worker already normalized to the MSE
 *    timeline (same space as video.currentTime), using the remuxer dts base.
 */

import { isIOS } from "../../lib/platform";
import { maxBufferHoleSec, type PlayerConfig } from "../config";
import Log from "../utils/logger";

const TAG = "PCMAudioPlayer";

/**
 * Page-level one-shot autoplay gate for Web Audio.
 * Set when playback has started (any codec), the click-to-resume prompt was
 * already shown, or AudioContext.resume() succeeded — suppresses re-prompting
 * on later channel switches that create a new AudioContext.
 */
let playbackUnlocked = false;

/** Call when video playback has been allowed by a user gesture or successful play(). */
export function markPlaybackUnlocked(): void {
  playbackUnlocked = true;
}

/** Max seconds of audio scheduled ahead of the AudioContext clock.
 *  Also bounds how long a ratio change takes to reach the speakers, so it is
 *  kept small (rate changes during live-sync catch-up respond within this). */
const SCHEDULE_AHEAD = 0.6;
/** Delay before the first chunk when (re)starting the scheduling chain. */
const CHAIN_RESTART_DELAY = 0.04;
/** Drift beyond this is treated as an emergency discontinuity and rebuilt from buffer. */
const HARD_RESYNC_THRESHOLD = 1.5;
/** Timeline comparisons within this are treated as identical. */
const GAP_SNAP = 0.005;
/** Fade-in length applied when the chain (re)starts, to avoid clicks. */
const FADE_SEC = 0.005;
/** Proportional gain for drift correction via stretch ratio. */
const RATIO_DRIFT_GAIN = 0.5;
/** Max stretch ratio deviation used for drift correction. WSOLA preserves
 *  pitch, so a transient 10% tempo offset is inaudible while it converges. */
const RATIO_DRIFT_MAX = 0.1;
/** Initial/large-drift mode: allow stronger WSOLA correction before falling back to hard resync. */
const SOFT_SYNC_WINDOW_SEC = 3.0;
const SOFT_SYNC_EXIT_DRIFT = 0.08;
const SOFT_SYNC_DRIFT_GAIN = 1.0;
const SOFT_SYNC_RATIO_DRIFT_MAX = 0.35;
/** EMA smoothing factor for drift measurements. */
const DRIFT_EMA_ALPHA = 0.4;
/** Control loop period (ms). */
const CONTROL_INTERVAL_MS = 250;
/** Upper bound for pending (not yet scheduled) chunks. */
const MAX_PENDING_CHUNKS = 600;
/** Control ticks between verbose drift diagnostics (~10s). */
const DRIFT_LOG_TICKS = 40;

interface AudioChunk {
  planes: Float32Array[];
  channels: number;
  sampleRate: number;
  frames: number;
  time: number; // MSE timeline (seconds)
  endTime: number;
}

interface ScheduledSpan {
  source: AudioBufferSourceNode;
  ctxStart: number;
  ctxEnd: number;
  streamStart: number;
  streamEnd: number;
}

export class PCMAudioPlayer {
  private config: PlayerConfig;
  private context: AudioContext | null = null;
  private gainNode: GainNode | null = null;
  private volume: number = 1.0;
  private muted: boolean = false;

  private videoElement: HTMLVideoElement | null = null;

  // iOS Silent Mode bypass
  private audioElement: HTMLAudioElement | null = null;
  private mediaStreamDestination: MediaStreamAudioDestinationNode | null = null;

  // Buffer management for seek support (chunk times are MSE timeline)
  private audioBuffer: AudioChunk[] = [];
  private pendingChunks: AudioChunk[] = [];

  /** Stream time of the end of all output scheduled so far. */
  private outputStreamCursor = 0;
  private currentStretchRatio = 1;

  // Output-side scheduling chain
  private nextStartTime = 0;
  private scheduledSpans: ScheduledSpan[] = [];

  // Drift control
  private driftEma = 0;
  private hasDriftEma = false;
  private softSyncUntil = 0;
  private driftLogCounter = 0;
  private controlTimer: ReturnType<typeof setInterval> | null = null;

  private isSeeking: boolean = false;
  /** Last `timeupdate` playback position, used to measure seek delta (seeking may already show the target time). */
  private lastKnownVideoTime: number = 0;
  /** Set when a large seek already cancelled the scheduling chain in `onVideoSeeking`. */
  private largeSeekCancelled: boolean = false;

  // Bound event handlers for cleanup
  private boundOnVideoSeeking: (() => void) | null = null;
  private boundOnVideoSeeked: (() => void) | null = null;
  private boundOnVideoPlay: (() => void) | null = null;
  private boundOnVideoPause: (() => void) | null = null;
  private boundOnVolumeChange: (() => void) | null = null;
  private boundOnTimeUpdate: (() => void) | null = null;
  private boundOnRateChange: (() => void) | null = null;

  /** Called when AudioContext is blocked by autoplay policy (needs user interaction). */
  onSuspended: (() => void) | null = null;
  /** Called when drift control updates the worker-side software audio stretch ratio. */
  onStretchRatioChange: ((ratio: number) => void) | null = null;

  constructor(config: PlayerConfig) {
    this.config = config;
  }

  async init(): Promise<void> {
    if (this.context) {
      return;
    }

    this.context = new AudioContext();
    this.gainNode = this.context.createGain();

    if (isIOS()) {
      try {
        this.mediaStreamDestination = this.context.createMediaStreamDestination();
        this.gainNode.connect(this.mediaStreamDestination);

        this.audioElement = document.createElement("audio");
        this.audioElement.srcObject = this.mediaStreamDestination.stream;
        this.audioElement.autoplay = true;
        this.audioElement.setAttribute("playsinline", "");
        this.audioElement.setAttribute("webkit-playsinline", "");

        Log.v(TAG, "iOS detected: using MediaStream bypass for Silent Mode");
      } catch (_e) {
        Log.w(TAG, "Failed to create MediaStream destination, falling back to default output");
        this.gainNode.connect(this.context.destination);
      }
    } else {
      this.gainNode.connect(this.context.destination);
    }

    this.updateGain();

    this.context.onstatechange = () => {
      Log.v(TAG, `AudioContext state changed to: ${this.context?.state}`);
      if (this.context?.state === "running") {
        this.resyncFromBuffer(this.videoElement?.currentTime ?? 0);
      }
    };

    Log.v(TAG, `AudioContext initialized, sampleRate: ${this.context.sampleRate}, state: ${this.context.state}`);
  }

  attachVideo(video: HTMLVideoElement): void {
    this.videoElement = video;

    // Sync initial volume state
    this.setVolume(video.volume);
    this.setMuted(video.muted);

    this.boundOnVideoSeeking = this.onVideoSeeking.bind(this);
    this.boundOnVideoSeeked = this.onVideoSeeked.bind(this);
    this.boundOnVideoPlay = () => this.play();
    this.boundOnVideoPause = () => this.pause();
    this.boundOnVolumeChange = () => {
      this.setVolume(video.volume);
      this.setMuted(video.muted);
    };
    this.boundOnTimeUpdate = () => {
      if (!video.seeking) {
        this.lastKnownVideoTime = video.currentTime;
      }
      this.controlTick();
      this.pump();
    };
    this.boundOnRateChange = () => {
      // Apply the new rate to the worker processor immediately instead of waiting
      // for drift to build through the already-scheduled pipeline. The remaining
      // mismatch (scheduled-ahead audio at the old rate) is absorbed by the
      // drift correction, so moderate rate changes (live sync 1 ↔ 1.2) cause
      // no audible interruption.
      this.controlTick();
    };

    video.addEventListener("seeking", this.boundOnVideoSeeking);
    video.addEventListener("seeked", this.boundOnVideoSeeked);
    video.addEventListener("play", this.boundOnVideoPlay);
    video.addEventListener("pause", this.boundOnVideoPause);
    video.addEventListener("volumechange", this.boundOnVolumeChange);
    video.addEventListener("timeupdate", this.boundOnTimeUpdate);
    video.addEventListener("ratechange", this.boundOnRateChange);

    this.controlTimer = setInterval(() => {
      this.controlTick();
      this.pump();
    }, CONTROL_INTERVAL_MS);
  }

  detachVideo(): void {
    if (this.controlTimer) {
      clearInterval(this.controlTimer);
      this.controlTimer = null;
    }
    if (this.videoElement) {
      if (this.boundOnVideoSeeking) this.videoElement.removeEventListener("seeking", this.boundOnVideoSeeking);
      if (this.boundOnVideoSeeked) this.videoElement.removeEventListener("seeked", this.boundOnVideoSeeked);
      if (this.boundOnVideoPlay) this.videoElement.removeEventListener("play", this.boundOnVideoPlay);
      if (this.boundOnVideoPause) this.videoElement.removeEventListener("pause", this.boundOnVideoPause);
      if (this.boundOnVolumeChange) this.videoElement.removeEventListener("volumechange", this.boundOnVolumeChange);
      if (this.boundOnTimeUpdate) this.videoElement.removeEventListener("timeupdate", this.boundOnTimeUpdate);
      if (this.boundOnRateChange) this.videoElement.removeEventListener("ratechange", this.boundOnRateChange);
    }
    this.boundOnVideoSeeking = null;
    this.boundOnVideoSeeked = null;
    this.boundOnVideoPlay = null;
    this.boundOnVideoPause = null;
    this.boundOnVolumeChange = null;
    this.boundOnTimeUpdate = null;
    this.boundOnRateChange = null;
    this.videoElement = null;
  }

  /** `streamStart`/`streamEnd` are normalized to the MSE timeline (same space as video.currentTime). */
  feed(
    planes: Float32Array[],
    channels: number,
    sampleRate: number,
    frames: number,
    streamStart: number,
    streamEnd: number,
  ): void {
    if (!this.context || !this.gainNode) {
      Log.w(TAG, "AudioContext not initialized, dropping audio");
      return;
    }

    if (frames <= 0 || channels <= 0 || planes.length !== channels) {
      return;
    }
    const chunk: AudioChunk = {
      planes,
      channels,
      sampleRate,
      frames,
      time: streamStart,
      endTime: streamEnd,
    };

    this.insertToBuffer(chunk);
    this.cleanupBuffer();

    if (!this.isSeeking && !this.videoElement?.paused) {
      this.pendingChunks.push(chunk);
      if (this.pendingChunks.length > MAX_PENDING_CHUNKS) {
        this.pendingChunks.shift();
      }
      this.pump();
    }
  }

  // ==================== Input pump ====================

  /**
   * Schedule worker-processed PCM chunks back-to-back on the AudioContext clock.
   */
  private pump(): void {
    const ctx = this.context;
    const gainNode = this.gainNode;
    if (!ctx || !gainNode || this.isSeeking || this.pendingChunks.length === 0 || this.videoElement?.paused) {
      return;
    }

    if (ctx.state === "suspended") {
      void ctx
        .resume()
        .then(() => {
          if (ctx.state === "running") {
            playbackUnlocked = true;
            this.pump();
          } else if (!playbackUnlocked) {
            this.notifyAutoplayBlocked();
          }
        })
        .catch(() => {
          if (!playbackUnlocked) {
            this.notifyAutoplayBlocked();
          }
        });
      return;
    }

    while (this.pendingChunks.length > 0) {
      // Throttle: keep at most SCHEDULE_AHEAD seconds scheduled ahead
      if (this.nextStartTime - ctx.currentTime >= SCHEDULE_AHEAD) {
        break;
      }

      const chunk = this.pendingChunks[0];
      this.pendingChunks.shift();
      this.scheduleOutput(chunk, ctx, gainNode);
    }
  }

  private notifyAutoplayBlocked(): void {
    if (playbackUnlocked) return;
    playbackUnlocked = true;
    Log.w(TAG, "AudioContext blocked by autoplay policy, waiting for user interaction");
    this.onSuspended?.();
    this.videoElement?.pause();
  }

  // ==================== Output scheduling chain ====================

  private scheduleOutput(chunk: AudioChunk, ctx: AudioContext, gainNode: GainNode): void {
    const { planes, channels, sampleRate, frames, endTime: streamEnd } = chunk;
    const ctxNow = ctx.currentTime;

    if (this.scheduledSpans.length > 0 && Math.abs(chunk.time - this.outputStreamCursor) > GAP_SNAP) {
      Log.v(
        TAG,
        `Audio stream discontinuity ${chunk.time.toFixed(3)} != ${this.outputStreamCursor.toFixed(3)}, restarting`,
      );
      this.cancelChain(true);
    }

    let chainRestart = false;
    if (this.nextStartTime < ctxNow + 0.005) {
      // Chain (re)start: if the audio about to play is ahead of the video
      // clock, delay the chain start so it lines up instead of drifting.
      this.outputStreamCursor = chunk.time;
      this.softSyncUntil = ctxNow + SOFT_SYNC_WINDOW_SEC;
      const lead = this.videoElement ? chunk.time - this.videoElement.currentTime : 0;
      this.nextStartTime = ctxNow + Math.max(CHAIN_RESTART_DELAY, Math.min(lead, 2));
      chainRestart = true;
    }

    const buffer = ctx.createBuffer(channels, frames, sampleRate);
    for (let ch = 0; ch < channels; ch++) {
      buffer.copyToChannel(planes[ch] as Float32Array<ArrayBuffer>, ch);
    }
    if (chainRestart) {
      this.applyFadeIn(buffer);
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(gainNode);
    source.start(this.nextStartTime);

    this.scheduledSpans.push({
      source,
      ctxStart: this.nextStartTime,
      ctxEnd: this.nextStartTime + buffer.duration,
      streamStart: this.outputStreamCursor,
      streamEnd,
    });
    this.nextStartTime += buffer.duration;
    this.outputStreamCursor = streamEnd;

    this.pruneSpans(ctx);
  }

  private applyFadeIn(buffer: AudioBuffer): void {
    const fadeFrames = Math.min(Math.floor(FADE_SEC * buffer.sampleRate), buffer.length);
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      const data = buffer.getChannelData(ch);
      for (let i = 0; i < fadeFrames; i++) {
        data[i] *= (i + 1) / fadeFrames;
      }
    }
  }

  private pruneSpans(ctx: AudioContext): void {
    const ctxNow = ctx.currentTime;
    while (this.scheduledSpans.length > 0 && this.scheduledSpans[0].ctxEnd < ctxNow - 0.5) {
      try {
        this.scheduledSpans[0].source.disconnect();
      } catch (_e) {}
      this.scheduledSpans.shift();
    }
  }

  /** Stream time currently being played, derived from the scheduling chain. */
  private audioStreamTimeNow(): number | null {
    const ctx = this.context;
    if (!ctx || this.scheduledSpans.length === 0) {
      return null;
    }
    const ctxNow = ctx.currentTime;
    for (const span of this.scheduledSpans) {
      if (ctxNow >= span.ctxStart && ctxNow < span.ctxEnd) {
        const f = (ctxNow - span.ctxStart) / (span.ctxEnd - span.ctxStart);
        return span.streamStart + f * (span.streamEnd - span.streamStart);
      }
    }
    return null; // before the chain starts or after it drained
  }

  private cancelChain(smooth = false): void {
    const ctx = this.context;
    if (smooth && ctx && this.gainNode && this.scheduledSpans.length > 0 && ctx.state === "running") {
      // Quick gain dip so already-playing audio doesn't click when stopped
      const now = ctx.currentTime;
      const target = this.muted ? 0 : this.volume;
      const g = this.gainNode.gain;
      g.cancelScheduledValues(now);
      g.setValueAtTime(target, now);
      g.linearRampToValueAtTime(0, now + FADE_SEC);
      g.setValueAtTime(target, now + 0.03);
      for (const span of this.scheduledSpans) {
        try {
          span.source.stop(now + FADE_SEC + 0.001);
        } catch (_e) {}
      }
    } else {
      for (const span of this.scheduledSpans) {
        try {
          span.source.stop();
          span.source.disconnect();
        } catch (_e) {}
      }
    }
    this.scheduledSpans = [];
    this.nextStartTime = 0;
  }

  // ==================== Drift control ====================

  private controlTick(): void {
    const ctx = this.context;
    const video = this.videoElement;
    if (!ctx || !video || ctx.state !== "running" || video.paused || this.isSeeking) {
      return;
    }

    const rate = Math.min(2, Math.max(0.5, video.playbackRate || 1));
    const audioTime = this.audioStreamTimeNow();
    if (audioTime === null) {
      this.updateStretchRatio(rate);
      // Chain idle: if nothing is pending but the seek buffer covers the
      // current position (e.g. after resume), rebuild from it.
      if (this.pendingChunks.length === 0 && this.scheduledSpans.length === 0 && this.audioBuffer.length > 0) {
        const target = video.currentTime;
        const idx = this.findChunkIndexByTime(target);
        if (idx >= 0 && this.audioBuffer[this.audioBuffer.length - 1].endTime > target + 0.1) {
          this.resyncFromBuffer(target);
        }
      }
      return;
    }

    const drift = audioTime - video.currentTime;
    if (this.hasDriftEma) {
      this.driftEma = this.driftEma + DRIFT_EMA_ALPHA * (drift - this.driftEma);
    } else {
      this.driftEma = drift;
      this.hasDriftEma = true;
    }

    if (Math.abs(drift) > HARD_RESYNC_THRESHOLD) {
      Log.v(TAG, `Emergency hard resync: drift=${drift.toFixed(3)}s`);
      this.resyncFromBuffer(video.currentTime);
      return;
    }

    // Rate matching: follow video.playbackRate, correct residual drift.
    // Positive drift = audio ahead → slow down (smaller ratio).
    const softSyncActive = ctx.currentTime < this.softSyncUntil || Math.abs(this.driftEma) > SOFT_SYNC_EXIT_DRIFT;
    const correctionDrift = softSyncActive ? drift : this.driftEma;
    const correctionMax = softSyncActive ? SOFT_SYNC_RATIO_DRIFT_MAX : RATIO_DRIFT_MAX;
    const correctionGain = softSyncActive ? SOFT_SYNC_DRIFT_GAIN : RATIO_DRIFT_GAIN;
    const correction = Math.min(correctionMax, Math.max(-correctionMax, correctionDrift * correctionGain));
    const ratio = Math.min(2, Math.max(0.5, rate * (1 - correction)));
    this.updateStretchRatio(ratio);

    if (++this.driftLogCounter >= DRIFT_LOG_TICKS) {
      this.driftLogCounter = 0;
      Log.v(
        TAG,
        `A/V drift=${(this.driftEma * 1000).toFixed(1)}ms, rate=${rate}, stretch ratio=${ratio.toFixed(4)}, mode=${softSyncActive ? "soft" : "steady"}`,
      );
    }
  }

  private updateStretchRatio(ratio: number): void {
    if (Math.abs(ratio - this.currentStretchRatio) < 0.0005) {
      return;
    }
    this.currentStretchRatio = ratio;
    this.onStretchRatioChange?.(ratio);
  }

  // ==================== Buffer Management ====================

  private insertToBuffer(chunk: AudioChunk): void {
    let low = 0;
    let high = this.audioBuffer.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (this.audioBuffer[mid].time < chunk.time) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }

    if (low < this.audioBuffer.length && Math.abs(this.audioBuffer[low].time - chunk.time) < 0.001) {
      this.audioBuffer[low] = chunk;
    } else {
      this.audioBuffer.splice(low, 0, chunk);
    }
  }

  /** Remove buffered audio that is too far behind the current playback position.
   *  Same strategy as MSE SourceBuffer cleanup: relative to currentTime. */
  private cleanupBuffer(): void {
    if (this.audioBuffer.length === 0 || !this.videoElement) return;

    const videoTime = this.videoElement.currentTime;

    if (videoTime - this.audioBuffer[0].time < this.config.bufferCleanupMaxBackward) return;

    const cutoff = videoTime - this.config.bufferCleanupMinBackward;
    let removeCount = 0;
    for (let i = 0; i < this.audioBuffer.length; i++) {
      if (this.audioBuffer[i].endTime < cutoff) {
        removeCount++;
      } else {
        break;
      }
    }
    if (removeCount > 0) {
      this.audioBuffer.splice(0, removeCount);
    }
  }

  private findChunkIndexByTime(targetTime: number): number {
    if (this.audioBuffer.length === 0) return -1;

    let low = 0;
    let high = this.audioBuffer.length - 1;
    while (low <= high) {
      const mid = (low + high) >>> 1;
      const chunk = this.audioBuffer[mid];
      if (targetTime >= chunk.time && targetTime < chunk.endTime) {
        return mid;
      } else if (targetTime < chunk.time) {
        high = mid - 1;
      } else {
        low = mid + 1;
      }
    }

    if (low > 0) return low - 1;
    return low < this.audioBuffer.length ? low : -1;
  }

  // ==================== Resync / Seek ====================

  /**
   * Rebuild the scheduling chain from the seek buffer at a target position
   * (used for seeks, resume after pause/suspend, and hard resyncs).
   */
  private resyncFromBuffer(targetTime: number): void {
    this.cancelChain(true);
    this.pendingChunks = [];
    this.driftEma = 0;
    this.hasDriftEma = false;

    const startIndex = this.findChunkIndexByTime(targetTime);
    if (startIndex < 0) {
      Log.v(TAG, "Resync target not in buffer, waiting for new data");
      return;
    }

    for (let i = startIndex; i < this.audioBuffer.length; i++) {
      let chunk = this.audioBuffer[i];
      if (i === startIndex && targetTime > chunk.time + GAP_SNAP) {
        // Trim the head so the chain starts exactly at the target position
        const streamDuration = chunk.endTime - chunk.time;
        if (streamDuration <= 0) {
          continue;
        }
        const cutFrames = Math.round(((targetTime - chunk.time) / streamDuration) * chunk.frames);
        if (cutFrames >= chunk.frames) {
          continue;
        }
        const frames = chunk.frames - cutFrames;
        chunk = {
          planes: chunk.planes.map((plane) => plane.subarray(cutFrames)),
          channels: chunk.channels,
          sampleRate: chunk.sampleRate,
          frames,
          time: targetTime,
          endTime: chunk.endTime,
        };
      }
      this.pendingChunks.push(chunk);
    }
    Log.v(TAG, `Resync at ${targetTime.toFixed(3)}s, refilled ${this.pendingChunks.length} chunks`);
    this.pump();
  }

  private onVideoSeeking(): void {
    this.largeSeekCancelled = false;
    const video = this.videoElement;
    if (video) {
      const delta = Math.abs(video.currentTime - this.lastKnownVideoTime);
      if (delta > maxBufferHoleSec(this.config)) {
        this.cancelChain();
        this.pendingChunks = [];
        this.largeSeekCancelled = true;
      }
    }
    this.isSeeking = true;
  }

  private onVideoSeeked(): void {
    if (!this.videoElement) return;
    const targetTime = this.videoElement.currentTime;
    const prevTime = this.lastKnownVideoTime;
    const delta = targetTime - prevTime;

    if (delta > 0 && delta <= maxBufferHoleSec(this.config)) {
      Log.v(TAG, `Small forward seek (${(delta * 1000).toFixed(0)}ms), skipping audio resync`);
      this.isSeeking = false;
      this.lastKnownVideoTime = targetTime;
      this.pump();
      return;
    }

    Log.v(TAG, `Video seeked to ${targetTime.toFixed(3)}, resyncing audio`);
    if (!this.largeSeekCancelled) {
      this.cancelChain();
      this.pendingChunks = [];
    }
    this.largeSeekCancelled = false;
    this.isSeeking = false;
    this.lastKnownVideoTime = targetTime;
    this.resyncFromBuffer(targetTime);
  }

  // ==================== Playback Control ====================

  async play(): Promise<void> {
    if (this.context?.state === "suspended") {
      try {
        await this.context.resume();
        playbackUnlocked = true;
        // onstatechange → resyncFromBuffer
      } catch (_e) {
        Log.w(TAG, "Failed to resume AudioContext on play()");
      }
    } else if (this.videoElement) {
      this.resyncFromBuffer(this.videoElement.currentTime);
    }

    if (this.audioElement) {
      try {
        await this.audioElement.play();
      } catch (_e) {
        Log.w(TAG, "Failed to play audio element");
      }
    }
  }

  pause(): void {
    this.cancelChain();
    this.pendingChunks = [];

    if (this.context?.state === "running") {
      this.context.suspend();
    }

    if (this.audioElement) {
      this.audioElement.pause();
    }
  }

  stop(): void {
    this.cancelChain();

    this.pendingChunks = [];
    this.audioBuffer = [];

    this.isSeeking = false;
    this.softSyncUntil = 0;
    this.driftEma = 0;
    this.hasDriftEma = false;
  }

  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume));
    this.updateGain();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.updateGain();
  }

  private updateGain(): void {
    if (this.gainNode && this.context) {
      const g = this.gainNode.gain;
      g.cancelScheduledValues(this.context.currentTime);
      g.value = this.muted ? 0 : this.volume;
    }
    if (this.audioElement) {
      this.audioElement.volume = this.muted ? 0 : this.volume;
    }
  }

  async destroy(): Promise<void> {
    this.stop();
    this.detachVideo();

    if (this.audioElement) {
      this.audioElement.pause();
      this.audioElement.srcObject = null;
      this.audioElement = null;
    }

    if (this.mediaStreamDestination) {
      this.mediaStreamDestination.disconnect();
      this.mediaStreamDestination = null;
    }

    if (this.gainNode) {
      this.gainNode.disconnect();
      this.gainNode = null;
    }

    if (this.context) {
      this.context.onstatechange = null;
      await this.context.close();
      this.context = null;
    }
  }
}
