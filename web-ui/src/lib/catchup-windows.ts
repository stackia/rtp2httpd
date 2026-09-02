/** Minimum catchup window (ms). Shorter playseek ranges can fail on some servers. */
export const CATCHUP_MIN_DURATION_MS = 30_000;

/** End recorded-style replay chunks this far before local `now` to tolerate upstream clock skew. */
export const CATCHUP_LIVE_SPLIT_OFFSET_MS = 10_000;

/** How far past `now` to pre-build catchup URLs so playback can continue without going live. */
export const CATCHUP_FUTURE_HORIZON_MS = 8 * 60 * 60 * 1000;

/** Safety cap for a single playseek window (also the no-EPG fallback chunk size). */
export const CATCHUP_MAX_SEGMENT_MS = 5 * 60 * 60 * 1000;

export interface CatchupProgramBound {
  start: Date;
  end: Date;
}

export interface CatchupTimeWindow {
  start: Date;
  end: Date;
}

/** Clamp catchup start so the window back to `now` is at least {@link CATCHUP_MIN_DURATION_MS}. */
export function clampCatchupStartTime(seekTime: Date, now = new Date()): Date {
  const minStartMs = now.getTime() - CATCHUP_MIN_DURATION_MS;
  return new Date(Math.min(seekTime.getTime(), minStartMs));
}

function addBoundary(boundaries: Set<number>, timeMs: number, rangeStartMs: number, rangeEndMs: number): void {
  if (timeMs > rangeStartMs && timeMs < rangeEndMs) {
    boundaries.add(timeMs);
  }
}

/**
 * Plan consecutive catchup playseek windows from `startTimeArg` through an 8-hour future horizon.
 *
 * When `programs` are provided, windows split on EPG start/end times (and still at the live
 * edge). Near-live requests keep a single past window of at least {@link CATCHUP_MIN_DURATION_MS}
 * so short playseek ranges do not fail. Without EPG data the previous duration-based chunking
 * is used: up to 5 hours before the live edge, half that after it.
 */
export function planCatchupSegmentWindows(
  startTimeArg: Date,
  now: Date,
  programs?: readonly CatchupProgramBound[],
): CatchupTimeWindow[] {
  const startTime = clampCatchupStartTime(startTimeArg, now);
  const startMs = startTime.getTime();
  const nowMs = now.getTime();
  const splitPointMs = nowMs - CATCHUP_LIVE_SPLIT_OFFSET_MS;
  const endingFutureMs = nowMs + CATCHUP_FUTURE_HORIZON_MS;

  if (endingFutureMs <= startMs) {
    return [];
  }

  const boundaries = new Set<number>([startMs, endingFutureMs]);
  addBoundary(boundaries, splitPointMs, startMs, endingFutureMs);

  const hasEpgSplits = Boolean(programs && programs.length > 0);
  const pastWindowMs = Math.max(0, splitPointMs - startMs);
  const nearLiveCatchup = pastWindowMs <= CATCHUP_MIN_DURATION_MS;
  // Near-live: keep one min-duration past window and only split on EPG after `now`.
  const epgSplitAfterMs = nearLiveCatchup ? nowMs : startMs;

  if (programs && programs.length > 0) {
    for (const program of programs) {
      const programStartMs = program.start.getTime();
      const programEndMs = program.end.getTime();
      if (!Number.isFinite(programStartMs) || !Number.isFinite(programEndMs) || programEndMs <= programStartMs) {
        continue;
      }
      if (programEndMs <= startMs || programStartMs >= endingFutureMs) {
        continue;
      }
      addBoundary(boundaries, programStartMs, epgSplitAfterMs, endingFutureMs);
      addBoundary(boundaries, programEndMs, epgSplitAfterMs, endingFutureMs);
    }
  }

  const times = [...boundaries].sort((a, b) => a - b);
  const fallbackDurationMs = Math.min(Math.max(nowMs - startMs, CATCHUP_MIN_DURATION_MS), CATCHUP_MAX_SEGMENT_MS);
  const pastCapMs = hasEpgSplits ? CATCHUP_MAX_SEGMENT_MS : fallbackDurationMs;
  const futureCapMs = hasEpgSplits ? CATCHUP_MAX_SEGMENT_MS : fallbackDurationMs / 2;

  const windows: CatchupTimeWindow[] = [];
  for (let i = 0; i < times.length - 1; i++) {
    const rangeStartMs = times[i];
    const rangeEndMs = times[i + 1];
    if (rangeEndMs <= rangeStartMs) {
      continue;
    }

    const capMs = rangeStartMs >= splitPointMs ? futureCapMs : pastCapMs;
    let cursorMs = rangeStartMs;
    while (cursorMs < rangeEndMs) {
      const nextMs = Math.min(cursorMs + capMs, rangeEndMs);
      if (nextMs > cursorMs) {
        windows.push({ start: new Date(cursorMs), end: new Date(nextMs) });
      }
      cursorMs = nextMs;
    }
  }

  return windows;
}
