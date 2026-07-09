export const DEFAULT_MEDIA_SEGMENT_BATCH_DURATION_MS = 250;
export const DEFAULT_MEDIA_SEGMENT_BATCH_MAX_BYTES = 512 * 1024;

export function normalizeMediaBatchLimit(value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback;
  return Number.isFinite(resolved) ? Math.max(0, resolved) : fallback;
}

interface TimedSample {
  dts: number;
}

export interface PendingMediaTrack {
  samples: unknown[];
  length: number;
}

function trackDtsSpan(track: PendingMediaTrack | null | undefined): number {
  const samples = track?.samples as TimedSample[] | undefined;
  if (!samples || samples.length < 2) {
    return 0;
  }

  const firstDts = samples[0].dts;
  const lastDts = samples[samples.length - 1].dts;
  if (!Number.isFinite(firstDts) || !Number.isFinite(lastDts)) {
    return 0;
  }
  return Math.max(0, lastDts - firstDts);
}

/**
 * Decide whether pending demuxed samples are large enough to build the next
 * fMP4 fragment. The caller handles initial low-latency fragments separately.
 */
export function isMediaBatchReady(
  audioTrack: PendingMediaTrack | null | undefined,
  videoTrack: PendingMediaTrack | null | undefined,
  targetDurationMs: number,
  maxBytes: number,
): boolean {
  const audioSampleCount = audioTrack?.samples.length ?? 0;
  const videoSampleCount = videoTrack?.samples.length ?? 0;
  if (audioSampleCount === 0 && videoSampleCount === 0) {
    return false;
  }

  if (targetDurationMs <= 0) {
    return true;
  }

  const pendingBytes = (audioTrack?.length ?? 0) + (videoTrack?.length ?? 0);
  if (maxBytes > 0 && pendingBytes >= maxBytes) {
    return true;
  }

  return trackDtsSpan(audioTrack) >= targetDurationMs || trackDtsSpan(videoTrack) >= targetDurationMs;
}
