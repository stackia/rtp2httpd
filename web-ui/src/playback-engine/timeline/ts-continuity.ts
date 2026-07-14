const OVERLAP_SKIP_LIMIT_MS = 10_000;

type TimestampOverlapDecision = "none" | "skip" | "restart";

export function classifyTimestampOverlap(currentMs: number, previousMs: number): TimestampOverlapDecision {
  if (currentMs > previousMs) return "none";
  return previousMs - currentMs > OVERLAP_SKIP_LIMIT_MS ? "restart" : "skip";
}

interface ContinuousPcmRange {
  originalStartMs: number;
  frameCount: number;
  sampleRate: number;
  lastOriginalEndMs: number;
  lastOutputEndMs: number;
}

type ContinuousPcmMapping =
  | { action: "drop" }
  | {
      action: "emit";
      outputStartMs: number;
      trimStartFrames: number;
    };

/** Map one decoded PCM range after the first range has established both clocks. */
export function mapContinuousPcmRange(input: ContinuousPcmRange): ContinuousPcmMapping {
  const { originalStartMs, frameCount, sampleRate, lastOriginalEndMs, lastOutputEndMs } = input;
  const overlapMs = lastOriginalEndMs - originalStartMs;
  const overlapDecision = classifyTimestampOverlap(originalStartMs, lastOriginalEndMs);
  let trimStartFrames = 0;

  if (overlapDecision === "skip" && overlapMs > 0) {
    // Ceil so the first retained frame is never earlier than the source range
    // already emitted. The epsilon avoids rounding an exact frame boundary up.
    trimStartFrames = Math.min(frameCount, Math.ceil((overlapMs * sampleRate) / 1000 - 1e-9));
    if (trimStartFrames >= frameCount) return { action: "drop" };
  }

  return {
    action: "emit",
    outputStartMs: lastOutputEndMs,
    trimStartFrames,
  };
}
