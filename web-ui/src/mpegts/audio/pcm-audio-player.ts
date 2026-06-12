/*
 * PCM Audio Player
 *
 * Plays decoded PCM audio using Web Audio API with video synchronization support.
 *
 * All PTS values stored internally are normalized to the video timeline
 * (same space as video.currentTime), enabling correct seek across segments
 * with discontinuous raw PTS values.
 */

import type { PlayerConfig } from "../config";
import Log from "../utils/logger";

const TAG = "PCMAudioPlayer";

interface AudioChunk {
  samples: Float32Array;
  channels: number;
  sampleRate: number;
  time: number; // normalized to video timeline (seconds)
  duration: number;
  endTime: number;
}

interface ScheduledSource {
  source: AudioBufferSourceNode;
  startTime: number;
  endTime: number;
}

let suspendedNotified = false;

export class PCMAudioPlayer {
  private config: PlayerConfig;
  private context: AudioContext | null = null;
  private gainNode: GainNode | null = null;
  private pendingChunks: AudioChunk[] = [];
  private volume: number = 1.0;
  private muted: boolean = false;

  // Sync state
  private videoElement: HTMLVideoElement | null = null;
  // basePtsOffset: rawAudioPTS - videoTime, used to normalize raw PTS to video timeline
  private basePtsOffset: number = 0;
  private basePtsEstablished: boolean = false;
  private lastScheduledEndTime: number = 0;
  private lastFeedPts: number = -1; // last raw PTS from feed(), for discontinuity detection

  // iOS Silent Mode bypass
  private audioElement: HTMLAudioElement | null = null;
  private mediaStreamDestination: MediaStreamAudioDestinationNode | null = null;

  // Buffer management for seek support (all PTS values are in video timeline)
  private audioBuffer: AudioChunk[] = [];

  // Track scheduled sources for cancellation
  private scheduledSources: ScheduledSource[] = [];

  // Seek state
  private isSeeking: boolean = false;

  // Bound event handlers for cleanup
  private boundOnVideoSeeking: (() => void) | null = null;
  private boundOnVideoSeeked: (() => void) | null = null;
  private boundOnVideoPlay: (() => void) | null = null;
  private boundOnVideoPause: (() => void) | null = null;
  private boundOnVolumeChange: (() => void) | null = null;
  private boundOnTimeUpdate: (() => void) | null = null;

  /** Called when AudioContext is blocked by autoplay policy (needs user interaction). */
  onSuspended: (() => void) | null = null;

  constructor(config: PlayerConfig) {
    this.config = config;
  }

  async init(): Promise<void> {
    if (this.context) {
      return;
    }

    this.context = new AudioContext();
    this.gainNode = this.context.createGain();

    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);

    if (isIOS) {
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
        this.seekToTime(this.videoElement?.currentTime ?? 0);
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
      if (this.pendingChunks.length > 0) {
        this.scheduleChunks();
      }
    };

    video.addEventListener("seeking", this.boundOnVideoSeeking);
    video.addEventListener("seeked", this.boundOnVideoSeeked);
    video.addEventListener("play", this.boundOnVideoPlay);
    video.addEventListener("pause", this.boundOnVideoPause);
    video.addEventListener("volumechange", this.boundOnVolumeChange);
    video.addEventListener("timeupdate", this.boundOnTimeUpdate);
  }

  detachVideo(): void {
    if (this.videoElement) {
      if (this.boundOnVideoSeeking) this.videoElement.removeEventListener("seeking", this.boundOnVideoSeeking);
      if (this.boundOnVideoSeeked) this.videoElement.removeEventListener("seeked", this.boundOnVideoSeeked);
      if (this.boundOnVideoPlay) this.videoElement.removeEventListener("play", this.boundOnVideoPlay);
      if (this.boundOnVideoPause) this.videoElement.removeEventListener("pause", this.boundOnVideoPause);
      if (this.boundOnVolumeChange) this.videoElement.removeEventListener("volumechange", this.boundOnVolumeChange);
      if (this.boundOnTimeUpdate) this.videoElement.removeEventListener("timeupdate", this.boundOnTimeUpdate);
    }
    this.boundOnVideoSeeking = null;
    this.boundOnVideoSeeked = null;
    this.boundOnVideoPlay = null;
    this.boundOnVideoPause = null;
    this.boundOnVolumeChange = null;
    this.boundOnTimeUpdate = null;
    this.videoElement = null;
  }

  feed(samples: Float32Array, channels: number, sampleRate: number, rawPts: number): void {
    if (!this.context || !this.gainNode) {
      Log.w(TAG, "AudioContext not initialized, dropping audio");
      return;
    }

    // Detect PTS discontinuity (segment switch with non-continuous timestamps)
    if (this.lastFeedPts >= 0 && this.basePtsEstablished) {
      const ptsJump = Math.abs(rawPts - this.lastFeedPts);
      if (ptsJump > 1.0) {
        // Absorb the PTS jump into basePtsOffset so the normalized timeline stays continuous.
        // This maps the new frame to lastFeedPts-oldOffset (≈ previous frame's normalized time),
        // keeping audio seamless across segments. The one-frame-duration overlap is handled
        // by drift-based sync in scheduleChunks().
        this.basePtsOffset += rawPts - this.lastFeedPts;
        Log.v(
          TAG,
          `PTS discontinuity: jump=${ptsJump.toFixed(3)}s, basePtsOffset adjusted to ${this.basePtsOffset.toFixed(3)}s`,
        );
      }
    }
    this.lastFeedPts = rawPts;

    // Establish basePtsOffset if not yet done (maps raw audio PTS → video timeline)
    if (!this.basePtsEstablished && this.videoElement && this.videoElement.readyState >= 2) {
      const videoTime = this.videoElement.buffered.end(this.videoElement.buffered.length - 1);
      this.basePtsOffset = rawPts - videoTime;
      this.basePtsEstablished = true;
      Log.v(
        TAG,
        `Base PTS offset established: ${this.basePtsOffset.toFixed(3)}s ` +
          `(rawPTS=${rawPts.toFixed(3)}, videoTime=${videoTime.toFixed(3)})`,
      );
    }

    // Can't normalize PTS without basePtsOffset — drop frames until established
    if (!this.basePtsEstablished) {
      return;
    }

    // Normalize PTS to video timeline before storing
    const time = rawPts - this.basePtsOffset;
    const samplesPerChannel = Math.floor(samples.length / channels);
    const duration = samplesPerChannel / sampleRate;
    const chunk: AudioChunk = { samples, channels, sampleRate, time, duration, endTime: time + duration };

    this.insertToBuffer(chunk);
    this.cleanupBuffer();

    if (!this.isSeeking) {
      this.pendingChunks.push(chunk);
      this.scheduleChunks();
    }
  }

  /**
   * All audio scheduling goes through this single method — drift-based sync
   * is always active, whether chunks come from live feed() or buffer refill.
   * All PTS values here are in video timeline space.
   */
  private scheduleChunks(): void {
    if (!this.context || !this.gainNode || this.pendingChunks.length === 0 || this.videoElement?.paused) {
      return;
    }

    if (this.context.state === "suspended") {
      this.context.resume();
      if (!suspendedNotified) {
        suspendedNotified = true;
        Log.w(TAG, "AudioContext blocked by autoplay policy, waiting for user interaction");
        this.onSuspended?.();
        this.videoElement?.pause();
      }
      return;
    }

    const ctxTime = this.context.currentTime;
    const videoTime = this.videoElement?.currentTime ?? 0;

    while (this.pendingChunks.length > 0) {
      const chunk = this.pendingChunks[0];
      const drift = chunk.time - videoTime;
      let scheduleTime = ctxTime + drift;

      // Ensure continuity: snap small gaps to lastScheduledEndTime
      if (this.lastScheduledEndTime > 0) {
        const gap = scheduleTime - this.lastScheduledEndTime;
        if (gap < 0.005 && gap > -0.05) {
          scheduleTime = this.lastScheduledEndTime;
        } else if (gap < -0.05) {
          this.lastScheduledEndTime = 0;
        }
      }

      // Drop late chunks (> 100ms behind AudioContext clock)
      if (scheduleTime < ctxTime - 0.1) {
        this.pendingChunks.shift();
        continue;
      }

      // Defer chunks too far ahead (> 1s)
      if (scheduleTime > ctxTime + 1.0) {
        break;
      }

      this.pendingChunks.shift();
      const actualScheduleTime = Math.max(scheduleTime, ctxTime);
      const duration = this.scheduleChunk(chunk, actualScheduleTime);
      this.lastScheduledEndTime = actualScheduleTime + duration;
    }
  }

  private scheduleChunk(chunk: AudioChunk, startTime: number): number {
    if (!this.context || !this.gainNode) {
      return 0;
    }

    const { samples, channels, sampleRate } = chunk;
    const samplesPerChannel = Math.floor(samples.length / channels);

    const buffer = this.context.createBuffer(channels, samplesPerChannel, sampleRate);

    for (let ch = 0; ch < channels; ch++) {
      const channelData = buffer.getChannelData(ch);
      for (let i = 0; i < samplesPerChannel; i++) {
        channelData[i] = samples[i * channels + ch];
      }
    }

    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gainNode);
    source.start(startTime);

    const endTime = startTime + buffer.duration;
    this.scheduledSources.push({ source, startTime, endTime });
    this.cleanupCompletedSources();

    return buffer.duration;
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

  /**
   * Push all audioBuffer chunks from startIndex into pendingChunks.
   * Only references are copied (no PCM data duplication).
   * scheduleChunks() applies drift-based sync and only schedules up to 5s ahead.
   */
  private refillFromBuffer(startIndex: number): void {
    for (let i = startIndex; i < this.audioBuffer.length; i++) {
      this.pendingChunks.push(this.audioBuffer[i]);
    }
  }

  // ==================== Source Tracking ====================

  private cancelScheduledAudio(): void {
    for (const scheduled of this.scheduledSources) {
      try {
        scheduled.source.stop();
        scheduled.source.disconnect();
      } catch (_e) {}
    }
    this.scheduledSources = [];
    this.lastScheduledEndTime = 0;
  }

  private cleanupCompletedSources(): void {
    if (!this.context) return;
    const ctxTime = this.context.currentTime;
    this.scheduledSources = this.scheduledSources.filter((scheduled) => {
      if (scheduled.endTime < ctxTime - 0.1) {
        try {
          scheduled.source.disconnect();
        } catch (_e) {}
        return false;
      }
      return true;
    });
  }

  // ==================== Seek Event Handlers ====================

  private onVideoSeeking(): void {
    Log.v(TAG, "Video seeking, canceling scheduled audio");
    this.isSeeking = true;
    this.cancelScheduledAudio();
    this.pendingChunks = [];
  }

  private onVideoSeeked(): void {
    if (!this.videoElement) return;
    const targetTime = this.videoElement.currentTime;
    Log.v(TAG, `Video seeked to ${targetTime.toFixed(3)}`);
    this.isSeeking = false;
    this.seekToTime(targetTime);
  }

  /** Seek audio to a video timeline position. Buffer PTS is in video timeline, so
   *  targetTime can be used directly for buffer lookup — works across segments. */
  seekToTime(targetTime: number): void {
    this.cancelScheduledAudio();
    this.pendingChunks = [];

    const startIndex = this.findChunkIndexByTime(targetTime);
    if (startIndex >= 0) {
      Log.v(TAG, `Seek hit buffer at chunk ${startIndex}, refilling ${this.audioBuffer.length - startIndex} chunks`);
      this.refillFromBuffer(startIndex);
      this.scheduleChunks();
      return;
    }

    Log.v(TAG, "Seek target not in buffer, waiting for new data");
  }

  // ==================== Playback Control ====================

  async play(): Promise<void> {
    if (this.context?.state === "suspended") {
      try {
        await this.context.resume();
      } catch (_e) {
        Log.w(TAG, "Failed to resume AudioContext on play()");
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
    this.cancelScheduledAudio();
    this.pendingChunks = [];

    if (this.context?.state === "running") {
      this.context.suspend();
    }

    if (this.audioElement) {
      this.audioElement.pause();
    }
  }

  stop(): void {
    this.cancelScheduledAudio();

    this.pendingChunks = [];
    this.audioBuffer = [];

    this.isSeeking = false;
    this.lastScheduledEndTime = 0;

    this.basePtsEstablished = false;
    this.basePtsOffset = 0;
    this.lastFeedPts = -1;
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
    if (this.gainNode) {
      this.gainNode.gain.value = this.muted ? 0 : this.volume;
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
