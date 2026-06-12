import type { PlayerConfig } from "../config";
import Log from "../utils/logger";

const TAG = "LiveSync";

/** Each live-edge underrun raises the latency floor by this much (seconds). */
const UNDERRUN_BACKOFF_STEP = 1;
/** Upper bound for the adaptive latency increase (seconds). */
const UNDERRUN_BACKOFF_MAX = 6;

/** Sets up live latency synchronization by adjusting playbackRate on timeupdate events. */
export function setupLiveSync(video: HTMLMediaElement, config: PlayerConfig): () => void {
  if (config.liveSync) {
    Log.v(
      TAG,
      "Live sync enabled, target latency:",
      config.liveSyncTargetLatency,
      "max latency:",
      config.liveSyncMaxLatency,
    );
  }

  // Adaptive backoff: every genuine live-edge underrun raises the latency we
  // are willing to tolerate, so devices with bursty data delivery (e.g. iOS
  // Safari, where fetch chunks arrive in 1-2s batches) settle at a latency
  // they can sustain instead of rebuffering in a loop. Devices that never
  // underrun keep the configured low latency.
  let extraLatency = 0;

  function onTimeUpdate(): void {
    if (!config.liveSync) return;

    const buffered = video.buffered;
    if (buffered.length === 0) return;

    const bufferedEnd = buffered.end(buffered.length - 1);
    const latency = bufferedEnd - video.currentTime;

    if (latency > config.liveSyncMaxLatency + extraLatency) {
      const targetRate = Math.min(2, Math.max(1, config.liveSyncPlaybackRate));
      if (targetRate !== video.playbackRate) {
        Log.v(TAG, `Video playback rate set to ${targetRate}`);
        video.playbackRate = targetRate;
      }
    } else if (latency <= config.liveSyncTargetLatency + extraLatency) {
      if (video.playbackRate !== 1 && video.playbackRate !== 0) {
        video.playbackRate = 1;
        Log.v(TAG, "Video playback rate reset to 1");
      }
    }
    // else: between target and max, keep current playbackRate
  }

  function onWaiting(): void {
    if (!config.liveSync) return;

    // Only count genuine live-edge underruns (playback caught up with the end
    // of the buffer), not startup waits or seeks into unbuffered regions.
    const buffered = video.buffered;
    const atLiveEdge = buffered.length > 0 && buffered.end(buffered.length - 1) - video.currentTime < 0.5;
    if (!atLiveEdge) return;

    // Reset any boost immediately: timeupdate stops firing during the stall, so
    // the regular latency check cannot run, and staying boosted would starve
    // playback again as soon as it resumes.
    if (video.playbackRate !== 1 && video.playbackRate !== 0) {
      video.playbackRate = 1;
    }

    if (extraLatency < UNDERRUN_BACKOFF_MAX) {
      extraLatency = Math.min(extraLatency + UNDERRUN_BACKOFF_STEP, UNDERRUN_BACKOFF_MAX);
    }
    Log.w(
      TAG,
      `Live-edge underrun, raising latency tolerance: target ${(config.liveSyncTargetLatency + extraLatency).toFixed(1)}s, max ${(config.liveSyncMaxLatency + extraLatency).toFixed(1)}s`,
    );
  }

  video.addEventListener("timeupdate", onTimeUpdate);
  video.addEventListener("waiting", onWaiting);

  return () => {
    Log.v(TAG, "Video playback rate reset to 1, live sync disabled");
    video.removeEventListener("timeupdate", onTimeUpdate);
    video.removeEventListener("waiting", onWaiting);
    video.playbackRate = 1;
  };
}

/**
 * Detect and fix stuck playback at startup.
 * If the video is stalled or hasn't received canplay and the currentTime is before
 * the first buffered range, seek to the start of the buffered range.
 */
export interface StallJumper {
  /** Re-run stall detection. Call whenever buffered ranges change (e.g. after a SourceBuffer append). */
  check(): void;
  destroy(): void;
}

export function setupStartupStallJumper(video: HTMLMediaElement): StallJumper {
  let canplayReceived = false;

  function onCanPlay(): void {
    canplayReceived = true;
    video.removeEventListener("canplay", onCanPlay);
  }

  function detectAndFix(isStalled?: boolean): void {
    const buffered = video.buffered;
    if (isStalled || !canplayReceived || video.readyState < 2) {
      if (buffered.length > 0 && video.currentTime < buffered.start(0)) {
        const target = buffered.start(0);
        Log.w(TAG, `Playback stuck at ${video.currentTime}, seeking to ${target}`);
        video.currentTime = target;
      }
    }
  }

  function onStalled(): void {
    detectAndFix(true);
  }

  video.addEventListener("canplay", onCanPlay);
  video.addEventListener("stalled", onStalled);

  return {
    check: () => detectAndFix(),
    destroy: () => {
      video.removeEventListener("canplay", onCanPlay);
      video.removeEventListener("stalled", onStalled);
    },
  };
}
