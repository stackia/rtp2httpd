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
 *  - Rate matching instead of frame dropping: PCM passes through a WSOLA
 *    time stretcher (WASM) before scheduling. A low-frequency control loop
 *    measures drift between the audio chain and video.currentTime and sets
 *    ratio = playbackRate * (1 - k*drift), so audio genuinely follows
 *    live-sync playbackRate (pitch preserved) and small drift converges
 *    smoothly. Large discontinuities trigger a hard resync with short fades.
 *
 *  - Stream timestamps arrive from the worker already normalized to the MSE
 *    timeline (same space as video.currentTime), using the remuxer dts base.
 */

import { isIOS } from "../../lib/platform";
import type { PlayerConfig } from "../config";
import Log from "../utils/logger";
import { type Stretcher, WasmStretcher } from "./wasm-stretcher";

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
/** Schedule-ahead while the page is hidden: background timer throttling (1s on
 *  mobile, up to 1/min on Chrome) would underrun the small foreground window. */
const BACKGROUND_SCHEDULE_AHEAD = 4.0;
/** Delay before the first chunk when (re)starting the scheduling chain. */
const CHAIN_RESTART_DELAY = 0.04;
/** Drift beyond this is treated as an emergency discontinuity and rebuilt from buffer. */
const HARD_RESYNC_THRESHOLD = 1.5;
/** Input gaps/overlaps within this are absorbed silently (PTS jitter). */
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
/** Seconds of decoded PCM to keep in the pending scheduling window after a resync. */
const PENDING_REFILL_WINDOW_SEC = 2.0;
/** Control ticks between verbose drift diagnostics (~10s). */
const DRIFT_LOG_TICKS = 40;
/** RECOVERING must anchor within this window or escalate via onResyncFailed. */
const RECOVERY_TIMEOUT_MS = 4000;

/**
 * Lifecycle-driven sync state. The drift control loop and hard resync only run
 * in ACTIVE — while the page is hidden or the media pipeline is being rebuilt,
 * video.currentTime is not a trustworthy clock and correcting against it would
 * replay/skip audio (e.g. the 1.5s hard-resync loop against a frozen video
 * clock after returning from background on iOS).
 *
 *  - ACTIVE:     foreground, video clock trusted; full drift control.
 *  - BACKGROUND: page hidden; audio free-runs, no drift correction.
 *  - RECOVERING: waiting for proof that the video clock is live again (first
 *    timeupdate while visible, or seeked); then one deterministic resync.
 */
type SyncState = "active" | "background" | "recovering";

interface AudioChunk {
  samples: Float32Array;
  channels: number;
  sampleRate: number;
  time: number; // MSE timeline (seconds)
  duration: number;
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

  // Time stretcher
  private stretcher: Stretcher | null = null;
  private stretcherLoading = false;
  private stretcherFailed = false;

  // Input-side state: stream time of the next sample to feed the stretcher.
  // null = not anchored (anchors at the next chunk's time).
  private inputCursor: number | null = null;
  /** Stream time corresponding to stretcher input position 0. */
  private stretcherBase = 0;
  /** Stream time of the end of all output scheduled so far. */
  private outputStreamCursor = 0;

  // Output-side scheduling chain
  private nextStartTime = 0;
  private scheduledSpans: ScheduledSpan[] = [];

  // Drift control
  private driftEma = 0;
  private hasDriftEma = false;
  private softSyncUntil = 0;
  private driftLogCounter = 0;
  private controlTimer: ReturnType<typeof setInterval> | null = null;

  private isBuffering: boolean = false;
  private isSeeking: boolean = false;

  // Lifecycle-driven sync state (see SyncState docs)
  private syncState: SyncState = "active";
  private recoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private boundOnVisibilityChange: (() => void) | null = null;

  // Bound event handlers for cleanup
  private boundOnVideoSeeking: (() => void) | null = null;
  private boundOnVideoSeeked: (() => void) | null = null;
  private boundOnVideoPlay: (() => void) | null = null;
  private boundOnVideoPause: (() => void) | null = null;
  private boundOnVolumeChange: (() => void) | null = null;
  private boundOnTimeUpdate: (() => void) | null = null;
  private boundOnRateChange: (() => void) | null = null;
  private boundOnVideoWaiting: (() => void) | null = null;
  private boundOnVideoStalled: (() => void) | null = null;
  private boundOnVideoPlaying: (() => void) | null = null;
  private boundOnVideoCanPlay: (() => void) | null = null;

  /** Called when AudioContext is blocked by autoplay policy (needs user interaction). */
  onSuspended: (() => void) | null = null;

  /** Called when a post-background/interruption resync could not be completed
   *  (video clock never came back, or the target left the audio buffer) —
   *  the stream needs to be rebuilt by the app layer. */
  onResyncFailed: (() => void) | null = null;

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
      const state = this.context?.state as string | undefined;
      Log.v(TAG, `AudioContext state changed to: ${state}`);

      if (state === "interrupted") {
        // WebKit-only: the OS revoked the audio session (backgrounding, but
        // also e.g. an incoming call while the tab stays visible — no
        // visibilitychange in that case). Unambiguous background signal on
        // its own, independent of visibilitychange ordering.
        this.cancelChain();
        this.pendingChunks = [];
        this.inputCursor = null;
        this.resetDriftState();
        this.setSyncState("background");
        return;
      }

      if (state !== "running") {
        // "suspended": either the pre-first-activation autoplay gate or our
        // own deliberate suspend() in pause() — neither implies backgrounding,
        // so syncState is left untouched. Drop the chain so resume doesn't
        // burst out stale audio.
        this.cancelChain();
        this.pendingChunks = [];
        this.inputCursor = null;
        this.resetDriftState();
        return;
      }

      // state === "running"
      playbackUnlocked = true;
      if (this.syncState === "background") {
        // Confirmed a real background period happened (via "interrupted"
        // above, and/or visibilitychange->hidden already set this). Only
        // anchor once the page is visible too — video.currentTime is not
        // proven yet while the media pipeline may still be rebuilding.
        this.setSyncState(document.visibilityState === "hidden" ? "background" : "recovering");
        this.pump();
      } else if (this.canScheduleAudio()) {
        // First activation (autoplay gate lifting) or resume from our own
        // pause() — the video clock was never untrusted; anchor immediately,
        // same as before the sync state machine existed.
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
      // timeupdate only fires when currentTime actually advanced — while
      // visible, it is the proof that the video pipeline is alive again.
      if (this.syncState === "recovering" && document.visibilityState !== "hidden") {
        this.completeRecovery("timeupdate");
        return;
      }
      this.controlTick();
      this.pump();
    };
    this.boundOnRateChange = () => {
      // Apply the new rate to the stretcher immediately instead of waiting for
      // drift to build through the already-scheduled pipeline. The remaining
      // mismatch (scheduled-ahead audio at the old rate) is absorbed by the
      // drift correction, so moderate rate changes (live sync 1 ↔ 1.2) cause
      // no audible interruption.
      this.controlTick();
    };
    this.boundOnVideoWaiting = () => this.enterBuffering("waiting");
    this.boundOnVideoStalled = () => {
      if (video.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) {
        this.enterBuffering("stalled");
      }
    };
    this.boundOnVideoPlaying = () => this.maybeExitBuffering();
    this.boundOnVideoCanPlay = () => this.maybeExitBuffering();

    video.addEventListener("seeking", this.boundOnVideoSeeking);
    video.addEventListener("seeked", this.boundOnVideoSeeked);
    video.addEventListener("play", this.boundOnVideoPlay);
    video.addEventListener("pause", this.boundOnVideoPause);
    video.addEventListener("volumechange", this.boundOnVolumeChange);
    video.addEventListener("timeupdate", this.boundOnTimeUpdate);
    video.addEventListener("ratechange", this.boundOnRateChange);
    video.addEventListener("waiting", this.boundOnVideoWaiting);
    video.addEventListener("stalled", this.boundOnVideoStalled);
    video.addEventListener("playing", this.boundOnVideoPlaying);
    video.addEventListener("canplay", this.boundOnVideoCanPlay);

    this.boundOnVisibilityChange = this.onVisibilityChange.bind(this);
    document.addEventListener("visibilitychange", this.boundOnVisibilityChange);
    if (document.visibilityState === "hidden") {
      this.setSyncState("background");
    }

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
    if (this.recoveryTimer) {
      clearTimeout(this.recoveryTimer);
      this.recoveryTimer = null;
    }
    if (this.boundOnVisibilityChange) {
      document.removeEventListener("visibilitychange", this.boundOnVisibilityChange);
      this.boundOnVisibilityChange = null;
    }
    if (this.videoElement) {
      if (this.boundOnVideoSeeking) this.videoElement.removeEventListener("seeking", this.boundOnVideoSeeking);
      if (this.boundOnVideoSeeked) this.videoElement.removeEventListener("seeked", this.boundOnVideoSeeked);
      if (this.boundOnVideoPlay) this.videoElement.removeEventListener("play", this.boundOnVideoPlay);
      if (this.boundOnVideoPause) this.videoElement.removeEventListener("pause", this.boundOnVideoPause);
      if (this.boundOnVolumeChange) this.videoElement.removeEventListener("volumechange", this.boundOnVolumeChange);
      if (this.boundOnTimeUpdate) this.videoElement.removeEventListener("timeupdate", this.boundOnTimeUpdate);
      if (this.boundOnRateChange) this.videoElement.removeEventListener("ratechange", this.boundOnRateChange);
      if (this.boundOnVideoWaiting) this.videoElement.removeEventListener("waiting", this.boundOnVideoWaiting);
      if (this.boundOnVideoStalled) this.videoElement.removeEventListener("stalled", this.boundOnVideoStalled);
      if (this.boundOnVideoPlaying) this.videoElement.removeEventListener("playing", this.boundOnVideoPlaying);
      if (this.boundOnVideoCanPlay) this.videoElement.removeEventListener("canplay", this.boundOnVideoCanPlay);
    }
    this.boundOnVideoSeeking = null;
    this.boundOnVideoSeeked = null;
    this.boundOnVideoPlay = null;
    this.boundOnVideoPause = null;
    this.boundOnVolumeChange = null;
    this.boundOnTimeUpdate = null;
    this.boundOnRateChange = null;
    this.boundOnVideoWaiting = null;
    this.boundOnVideoStalled = null;
    this.boundOnVideoPlaying = null;
    this.boundOnVideoCanPlay = null;
    this.videoElement = null;
  }

  /** `time` is normalized to the MSE timeline (same space as video.currentTime). */
  feed(samples: Float32Array, channels: number, sampleRate: number, time: number): void {
    if (!this.context || !this.gainNode) {
      Log.w(TAG, "AudioContext not initialized, dropping audio");
      return;
    }

    const samplesPerChannel = Math.floor(samples.length / channels);
    if (samplesPerChannel === 0) {
      return;
    }
    const duration = samplesPerChannel / sampleRate;
    const chunk: AudioChunk = { samples, channels, sampleRate, time, duration, endTime: time + duration };

    this.insertToBuffer(chunk);
    this.cleanupBuffer();

    if (this.canScheduleAudio()) {
      this.pump();
    }
  }

  // ==================== Stretcher ====================

  /** Returns the stretcher if ready for this chunk's format, else kicks off (re)creation. */
  private ensureStretcher(chunk: AudioChunk): Stretcher | null {
    if (this.stretcher) {
      if (this.stretcher.sampleRate === chunk.sampleRate && this.stretcher.channels === chunk.channels) {
        return this.stretcher;
      }
      // Format change: rebuild the stretcher and re-anchor
      Log.v(TAG, `Audio format change: ${chunk.sampleRate}Hz/${chunk.channels}ch, rebuilding stretcher`);
      this.stretcher.destroy();
      this.stretcher = null;
      this.cancelChain(true);
      this.inputCursor = null;
    }

    if (this.stretcherFailed) {
      return null;
    }

    if (this.stretcherLoading) {
      return null;
    }
    this.stretcherLoading = true;

    const wasmUrl = this.config.wasmDecoders.mp2;
    const promise = wasmUrl
      ? WasmStretcher.create(wasmUrl, chunk.sampleRate, chunk.channels)
      : Promise.reject(new Error("MP2 WASM URL is not configured"));

    promise
      .then((stretcher) => {
        this.stretcherLoading = false;
        if (!this.context) {
          stretcher.destroy();
          return;
        }
        this.stretcher = stretcher;
        this.pump();
      })
      .catch((err) => {
        this.stretcherLoading = false;
        this.stretcherFailed = true;
        this.pendingChunks = [];
        Log.e(TAG, `WASM stretcher unavailable; cannot play software-decoded audio: ${err}`);
      });

    return null;
  }

  // ==================== Input pump ====================

  /**
   * Feed pending chunks through the stretcher and schedule the output
   * back-to-back on the AudioContext clock.
   */
  private pump(): void {
    const ctx = this.context;
    if (!ctx || !this.gainNode || !this.canScheduleAudio()) {
      return;
    }

    if (ctx.state !== "running") {
      // "suspended" may just be autoplay policy — try to resume. WebKit's
      // "interrupted" (iOS background) also lands here: resume() is a no-op
      // until the system ends the interruption, and nothing must be scheduled
      // on the frozen clock meanwhile.
      void ctx
        .resume()
        .then(() => {
          if ((ctx.state as string) === "running") {
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

    while (true) {
      if (this.pendingChunks.length === 0) {
        // RECOVERING with no running chain: the only refill anchor available
        // is video.currentTime, which is exactly the clock we do not trust
        // yet — hold off until completeRecovery() anchors deterministically.
        if (this.syncState === "recovering" && this.inputCursor === null) {
          break;
        }
        this.refillPendingFromBuffer(this.inputCursor ?? this.videoElement?.currentTime ?? 0);
      }
      if (this.pendingChunks.length === 0) {
        break;
      }

      // Throttle: keep at most the schedule-ahead window scheduled. Hidden
      // pages get a larger window to ride out background timer throttling.
      const scheduleAhead = this.syncState === "background" ? BACKGROUND_SCHEDULE_AHEAD : SCHEDULE_AHEAD;
      if (this.nextStartTime - ctx.currentTime >= scheduleAhead) {
        break;
      }

      const chunk = this.pendingChunks[0];
      const stretcher = this.ensureStretcher(chunk);
      if (!stretcher) {
        break; // stretcher loading; chunks stay pending
      }

      if (this.inputCursor === null) {
        this.anchor(chunk.time);
      }

      const cursor = this.inputCursor as number;
      const delta = chunk.time - cursor;

      let chunkEndTime = chunk.endTime;
      if (delta > GAP_SNAP) {
        Log.w(TAG, `Unexpected PCM pending gap ${delta.toFixed(3)}s; snapping to cursor`);
        chunkEndTime = cursor + chunk.duration;
      }

      let samples = chunk.samples;
      if (delta < -GAP_SNAP) {
        // Overlap: trim the already-covered head of this chunk
        const cutFrames = Math.round((cursor - chunk.time) * chunk.sampleRate);
        const totalFrames = Math.floor(samples.length / chunk.channels);
        if (cutFrames >= totalFrames) {
          this.pendingChunks.shift();
          continue;
        }
        samples = samples.subarray(cutFrames * chunk.channels);
      }

      this.pendingChunks.shift();
      this.feedStretcher(stretcher, samples, chunk.sampleRate);
      this.inputCursor = chunkEndTime;
    }
  }

  private notifyAutoplayBlocked(): void {
    if (playbackUnlocked) return;
    playbackUnlocked = true;
    Log.w(TAG, "AudioContext blocked by autoplay policy, waiting for user interaction");
    this.onSuspended?.();
    this.videoElement?.pause();
  }

  // ==================== Sync state machine ====================

  private setSyncState(next: SyncState): void {
    if (this.syncState === next) {
      return;
    }
    Log.v(TAG, `Sync state: ${this.syncState} -> ${next}`);
    this.syncState = next;

    if (this.recoveryTimer) {
      clearTimeout(this.recoveryTimer);
      this.recoveryTimer = null;
    }
    if (next === "recovering") {
      // Failure exit: the anchor event never arrives when the media pipeline
      // died in background (decoder rebuild failed, buffer gone). One-shot,
      // bound to this state — cleared on any transition out.
      this.recoveryTimer = setTimeout(() => {
        this.recoveryTimer = null;
        this.onRecoveryTimeout();
      }, RECOVERY_TIMEOUT_MS);
    }
  }

  private onVisibilityChange(): void {
    if (document.visibilityState === "hidden") {
      // Video decode is about to be suspended; its clock is no longer a sync
      // reference. Audio free-runs (Control Center playback keeps it alive).
      this.setSyncState("background");
    } else {
      // Pipeline rebuild starts now; wait for proof (timeupdate) before anchoring.
      this.setSyncState("recovering");
    }
  }

  /** Anchor point: video.currentTime is authoritative again. */
  private completeRecovery(reason: string): void {
    const video = this.videoElement;
    this.setSyncState("active");
    if (!video) {
      return;
    }

    // Chain survived (e.g. Android: AudioContext keeps running in background)
    // and is already close — keep it and let drift control absorb the rest,
    // instead of an audible rebuild on every tab switch.
    const audioTime = this.audioStreamTimeNow();
    if (audioTime !== null && Math.abs(audioTime - video.currentTime) < HARD_RESYNC_THRESHOLD) {
      Log.v(TAG, `Recovery (${reason}): chain intact, drift ${(audioTime - video.currentTime).toFixed(3)}s`);
      this.resetDriftState();
      this.softSyncUntil = (this.context?.currentTime ?? 0) + SOFT_SYNC_WINDOW_SEC;
      return;
    }

    Log.v(TAG, `Recovery anchor (${reason}) at ${video.currentTime.toFixed(3)}s`);
    // Re-enter soft-sync so residual drift converges fast (±35%) instead of
    // lingering at the steady-state ±10% cap for many seconds.
    this.softSyncUntil = (this.context?.currentTime ?? 0) + SOFT_SYNC_WINDOW_SEC;
    const anchored = this.resyncFromBuffer(video.currentTime);
    if (!anchored && this.audioBuffer.length > 0) {
      // Buffer exists but no longer covers the video position: the two sides
      // diverged past repair (e.g. long background stay). Rebuild the stream.
      Log.w(TAG, "Recovery target left the audio buffer; escalating");
      this.onResyncFailed?.();
    }
    // Empty buffer: stream data simply hasn't arrived yet — pump will anchor
    // on the first fed chunk; not a failure.
  }

  private onRecoveryTimeout(): void {
    const video = this.videoElement;
    // Only escalate when playback is genuinely expected to progress: a paused
    // or seeking video legitimately produces no timeupdate — keep waiting for
    // its play/seeked to anchor instead.
    if (!video || video.paused || video.seeking || this.isSeeking || document.visibilityState === "hidden") {
      return;
    }
    Log.w(TAG, `No video progress within ${RECOVERY_TIMEOUT_MS}ms of recovery; escalating`);
    this.onResyncFailed?.();
  }

  // ==================== Media readiness ====================

  private hasPlayableVideoData(): boolean {
    const video = this.videoElement;
    return (
      !!video &&
      !video.paused &&
      !video.seeking &&
      !this.isSeeking &&
      video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA
    );
  }

  private canScheduleAudio(): boolean {
    return !this.isBuffering && this.hasPlayableVideoData();
  }

  private resetDriftState(): void {
    this.driftEma = 0;
    this.hasDriftEma = false;
  }

  private enterBuffering(reason: "waiting" | "stalled"): void {
    const video = this.videoElement;
    if (!video || video.paused || video.seeking || this.isSeeking) {
      return;
    }

    if (!this.isBuffering) {
      Log.v(TAG, `Video ${reason}; pausing PCM audio scheduling`);
    }
    this.isBuffering = true;
    this.cancelChain(true);
    this.pendingChunks = [];
    this.inputCursor = null;
    this.resetDriftState();
  }

  private maybeExitBuffering(): void {
    const video = this.videoElement;
    if (!video || !this.hasPlayableVideoData()) {
      return;
    }

    if (!this.isBuffering) {
      return;
    }

    this.isBuffering = false;
    if (this.syncState !== "active") {
      // Video clock not trusted yet; the state machine anchors on its own
      // events (recovery timeupdate / background free-run via pump).
      this.pump();
      return;
    }
    Log.v(TAG, "Video playback resumed; resyncing PCM audio");
    this.resyncFromBuffer(video.currentTime);
  }

  private anchor(time: number): void {
    this.stretcher?.reset();
    // Feedforward the current playback rate immediately: waiting for the next
    // control tick would let drift build up through the scheduling pipeline
    // and re-trigger a hard resync when the video is in catch-up mode.
    const rate = Math.min(2, Math.max(0.5, this.videoElement?.playbackRate || 1));
    this.stretcher?.setRatio(rate);
    this.inputCursor = time;
    this.stretcherBase = time;
    this.outputStreamCursor = time;
    this.softSyncUntil = (this.context?.currentTime ?? 0) + SOFT_SYNC_WINDOW_SEC;
  }

  private feedStretcher(stretcher: Stretcher, samples: Float32Array, sampleRate: number): void {
    const out = stretcher.process(samples);
    if (out.length === 0) {
      return;
    }
    const streamEnd = this.stretcherBase + stretcher.position / sampleRate;
    this.scheduleOutput(out, stretcher.channels, sampleRate, streamEnd);
  }

  // ==================== Output scheduling chain ====================

  private scheduleOutput(out: Float32Array, channels: number, sampleRate: number, streamEnd: number): void {
    const ctx = this.context;
    if (!ctx || !this.gainNode) {
      return;
    }

    const frames = Math.floor(out.length / channels);
    const ctxNow = ctx.currentTime;

    let chainRestart = false;
    if (this.nextStartTime < ctxNow + 0.005) {
      // Chain (re)start: if the audio about to play is ahead of the video
      // clock, delay the chain start so it lines up instead of drifting.
      // Outside ACTIVE the video clock is not a reference — start immediately
      // and let the recovery anchor fix alignment.
      const lead =
        this.syncState === "active" && this.videoElement ? this.outputStreamCursor - this.videoElement.currentTime : 0;
      this.nextStartTime = ctxNow + Math.max(CHAIN_RESTART_DELAY, Math.min(lead, 2));
      chainRestart = true;
    }

    const buffer = ctx.createBuffer(channels, frames, sampleRate);
    for (let ch = 0; ch < channels; ch++) {
      const channelData = buffer.getChannelData(ch);
      for (let i = 0; i < frames; i++) {
        channelData[i] = out[i * channels + ch];
      }
    }
    if (chainRestart) {
      this.applyFadeIn(buffer);
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gainNode);
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

    this.pruneSpans();
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

  private pruneSpans(): void {
    const ctx = this.context;
    if (!ctx) return;
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
    if (!ctx || !video || ctx.state !== "running" || !this.stretcher) {
      return;
    }
    // Drift control and hard resync are meaningful only when the video clock
    // is trusted. BACKGROUND/RECOVERING free-run: correcting against a frozen
    // or rebuilding video clock replays audio (the "broken record" loop).
    if (this.syncState !== "active" || !this.canScheduleAudio()) {
      return;
    }

    const audioTime = this.audioStreamTimeNow();
    if (audioTime === null) {
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
    const rate = Math.min(2, Math.max(0.5, video.playbackRate || 1));
    const softSyncActive = ctx.currentTime < this.softSyncUntil || Math.abs(this.driftEma) > SOFT_SYNC_EXIT_DRIFT;
    const correctionDrift = softSyncActive ? drift : this.driftEma;
    const correctionMax = softSyncActive ? SOFT_SYNC_RATIO_DRIFT_MAX : RATIO_DRIFT_MAX;
    const correctionGain = softSyncActive ? SOFT_SYNC_DRIFT_GAIN : RATIO_DRIFT_GAIN;
    const correction = Math.min(correctionMax, Math.max(-correctionMax, correctionDrift * correctionGain));
    const ratio = Math.min(2, Math.max(0.5, rate * (1 - correction)));
    this.stretcher.setRatio(ratio);
    this.pump();

    if (++this.driftLogCounter >= DRIFT_LOG_TICKS) {
      this.driftLogCounter = 0;
      Log.v(
        TAG,
        `A/V drift=${(this.driftEma * 1000).toFixed(1)}ms, rate=${rate}, stretch ratio=${ratio.toFixed(4)}, mode=${softSyncActive ? "soft" : "steady"}`,
      );
    }
  }

  // ==================== Buffer Management ====================

  private trimChunkStart(chunk: AudioChunk, targetTime: number): AudioChunk | null {
    if (targetTime <= chunk.time + GAP_SNAP) {
      return chunk;
    }

    const cutFrames = Math.round((targetTime - chunk.time) * chunk.sampleRate);
    const totalFrames = Math.floor(chunk.samples.length / chunk.channels);
    if (cutFrames >= totalFrames) {
      return null;
    }

    const time = chunk.time + cutFrames / chunk.sampleRate;
    return {
      samples: chunk.samples.subarray(cutFrames * chunk.channels),
      channels: chunk.channels,
      sampleRate: chunk.sampleRate,
      time,
      duration: chunk.endTime - time,
      endTime: chunk.endTime,
    };
  }

  private refillPendingFromBuffer(startTime: number): void {
    if (this.pendingChunks.length >= MAX_PENDING_CHUNKS) return;

    const startIndex = this.findChunkIndexByTime(startTime);
    if (startIndex < 0) return;

    const endTime = startTime + PENDING_REFILL_WINDOW_SEC;
    for (let i = startIndex; i < this.audioBuffer.length && this.pendingChunks.length < MAX_PENDING_CHUNKS; i++) {
      const source = this.audioBuffer[i];
      if (source.endTime <= startTime + GAP_SNAP) {
        continue;
      }
      if (source.time >= endTime) {
        break;
      }

      const chunk = this.trimChunkStart(source, startTime);
      if (!chunk) {
        continue;
      }
      this.pendingChunks.push(chunk);
      startTime = chunk.endTime;
    }
  }

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

    let normalized = chunk;
    if (low > 0) {
      const prev = this.audioBuffer[low - 1];
      if (normalized.time > prev.endTime) {
        normalized = { ...normalized, time: prev.endTime, endTime: prev.endTime + normalized.duration };
      } else if (normalized.time < prev.endTime) {
        const trimmed = this.trimChunkStart(normalized, prev.endTime);
        if (!trimmed) {
          return;
        }
        normalized = trimmed;
      }
    }

    if (low < this.audioBuffer.length && Math.abs(this.audioBuffer[low].time - normalized.time) < 0.001) {
      this.audioBuffer[low] = normalized;
    } else if (low < this.audioBuffer.length && normalized.endTime > this.audioBuffer[low].time) {
      const next = this.audioBuffer[low];
      const keepFrames = Math.max(0, Math.round((next.time - normalized.time) * normalized.sampleRate));
      if (keepFrames === 0) {
        return;
      }
      const totalFrames = Math.floor(normalized.samples.length / normalized.channels);
      const frames = Math.min(keepFrames, totalFrames);
      const endTime = normalized.time + frames / normalized.sampleRate;
      this.audioBuffer.splice(low, 0, {
        samples: normalized.samples.subarray(0, frames * normalized.channels),
        channels: normalized.channels,
        sampleRate: normalized.sampleRate,
        time: normalized.time,
        duration: endTime - normalized.time,
        endTime,
      });
    } else {
      this.audioBuffer.splice(low, 0, normalized);
    }
  }

  /** Remove buffered audio that is too far behind the current playback position.
   *  Same strategy as MSE SourceBuffer cleanup: relative to currentTime.
   *  Outside ACTIVE, video.currentTime may be frozen (background free-run —
   *  exactly the case motivating this state), so it must not be the fallback
   *  reference: that would stop advancing and let the buffer grow unbounded.
   *  Prefer the live audio playhead, then the newest buffered timestamp —
   *  both keep advancing as data arrives even if every clock is stalled. */
  private cleanupBuffer(): void {
    if (this.audioBuffer.length === 0 || !this.videoElement) return;

    const referenceTime =
      this.syncState === "active"
        ? this.videoElement.currentTime
        : (this.audioStreamTimeNow() ?? this.audioBuffer[this.audioBuffer.length - 1].endTime);

    if (referenceTime - this.audioBuffer[0].time < this.config.bufferCleanupMaxBackward) return;

    const cutoff = referenceTime - this.config.bufferCleanupMinBackward;
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
   * Returns false when the target is not covered by the buffer.
   */
  private resyncFromBuffer(targetTime: number): boolean {
    this.cancelChain(true);
    this.pendingChunks = [];
    this.inputCursor = null;
    this.resetDriftState();

    const startIndex = this.findChunkIndexByTime(targetTime);
    if (startIndex < 0) {
      Log.v(TAG, "Resync target not in buffer, waiting for new data");
      return false;
    }

    this.refillPendingFromBuffer(targetTime);
    if (this.pendingChunks.length === 0) {
      // findChunkIndexByTime clamps to the nearest chunk instead of returning
      // -1 for a target before/after all buffered data (e.g. the video clock
      // moved outside the retained window during a long background stay), so
      // startIndex >= 0 above does not guarantee targetTime is covered. Treat
      // "nothing to schedule" the same as "not in buffer" so callers (notably
      // completeRecovery) escalate instead of silently leaving audio muted.
      Log.v(TAG, "Resync target not covered by buffer, waiting for new data");
      return false;
    }
    Log.v(TAG, `Resync at ${targetTime.toFixed(3)}s, refilled ${this.pendingChunks.length} chunks`);
    this.pump();
    return true;
  }

  private onVideoSeeking(): void {
    this.isBuffering = false;
    this.cancelChain();
    this.pendingChunks = [];
    this.isSeeking = true;
  }

  private onVideoSeeked(): void {
    if (!this.videoElement) return;
    const targetTime = this.videoElement.currentTime;

    Log.v(TAG, `Video seeked to ${targetTime.toFixed(3)}, resyncing audio`);
    this.isSeeking = false;
    // A completed seek makes video.currentTime authoritative in any state.
    if (this.syncState === "recovering") {
      this.setSyncState(document.visibilityState === "hidden" ? "background" : "active");
    }
    this.resyncFromBuffer(targetTime);
  }

  // ==================== Playback Control ====================

  async play(): Promise<void> {
    if (this.context && this.context.state !== "running") {
      try {
        await this.context.resume();
        playbackUnlocked = true;
        // onstatechange drives the rest (background free-run or recovery anchor)
      } catch (_e) {
        Log.w(TAG, "Failed to resume AudioContext on play()");
      }
    } else {
      const video = this.videoElement;
      if (video && this.syncState === "active" && this.canScheduleAudio()) {
        this.resyncFromBuffer(video.currentTime);
      }
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
    this.isBuffering = false;
    this.cancelChain();
    this.pendingChunks = [];
    this.inputCursor = null;

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

    this.isBuffering = false;
    this.isSeeking = false;
    this.inputCursor = null;
    this.stretcher?.reset();
    this.stretcherFailed = false;
    this.softSyncUntil = 0;
    this.resetDriftState();
    this.setSyncState(document.visibilityState === "hidden" ? "background" : "active");
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

    if (this.stretcher) {
      this.stretcher.destroy();
      this.stretcher = null;
    }

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
