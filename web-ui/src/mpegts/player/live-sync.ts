import type { PlayerConfig } from "../config";
import Log from "../utils/logger";

const TAG = "LiveSync";

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

  function onTimeUpdate(): void {
    if (!config.liveSync) return;

    const buffered = video.buffered;
    if (buffered.length === 0) return;

    const bufferedEnd = buffered.end(buffered.length - 1);
    const latency = bufferedEnd - video.currentTime;

    if (latency > config.liveSyncMaxLatency) {
      const targetRate = Math.min(2, Math.max(1, config.liveSyncPlaybackRate));
      if (targetRate !== video.playbackRate) {
        Log.v(TAG, `Video playback rate set to ${targetRate}`);
        video.playbackRate = Math.min(2, Math.max(1, config.liveSyncPlaybackRate));
      }
    } else if (latency <= config.liveSyncTargetLatency) {
      if (video.playbackRate !== 1 && video.playbackRate !== 0) {
        video.playbackRate = 1;
        Log.v(TAG, "Video playback rate reset to 1");
      }
    }
    // else: between target and max, keep current playbackRate
  }

  video.addEventListener("timeupdate", onTimeUpdate);

  return () => {
    Log.v(TAG, "Video playback rate reset to 1, live sync disabled");
    video.removeEventListener("timeupdate", onTimeUpdate);
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
