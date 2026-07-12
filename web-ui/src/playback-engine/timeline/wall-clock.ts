/** Wall-clock tolerance for treating a seek target as "Go Live" (milliseconds). */
export const NEAR_LIVE_EDGE_MS = 3000;

/** Live session anchor: MSE position when the user tuned in, advanced 1:1 with wall clock. */
export interface LiveSessionAnchor {
  sessionStartMs: number;
  mseAtSessionStart: number;
}

/** Map MSE timeline seconds to wall-clock time using the stream origin (MSE t=0). */
export function mseToWallClock(mseSeconds: number, origin: Date): Date {
  return new Date(origin.getTime() + mseSeconds * 1000);
}

/** Map wall-clock time to MSE timeline seconds. */
export function wallClockToMse(wallClock: Date, origin: Date): number {
  return (wallClock.getTime() - origin.getTime()) / 1000;
}

/**
 * MSE time of the live edge assuming continuous live playback since session start
 * (ignores pauses/rewinds — the broadcast timeline keeps moving).
 */
export function liveEdgeMse(anchor: LiveSessionAnchor, nowMs = Date.now()): number {
  return anchor.mseAtSessionStart + (nowMs - anchor.sessionStartMs) / 1000;
}

/** Wall-clock time of the live edge (for EPG / progress bar). */
export function liveEdgeWallClock(anchor: LiveSessionAnchor, origin: Date, nowMs = Date.now()): Date {
  return mseToWallClock(liveEdgeMse(anchor, nowMs), origin);
}

/** Seconds the playhead lags behind the session live edge on the MSE timeline. */
export function lagBehindLiveEdge(anchor: LiveSessionAnchor, currentTime: number, nowMs = Date.now()): number {
  return liveEdgeMse(anchor, nowMs) - currentTime;
}

/** MSE seek target for Go Live: session live edge minus target latency. */
export function goLiveTargetMse(anchor: LiveSessionAnchor, targetLatencySec: number, nowMs = Date.now()): number {
  const edge = liveEdgeMse(anchor, nowMs);
  return edge - targetLatencySec;
}

/** Create anchor at the current playhead (call once when live session begins). */
export function createLiveSessionAnchor(currentTime: number, nowMs = Date.now()): LiveSessionAnchor {
  return { sessionStartMs: nowMs, mseAtSessionStart: currentTime };
}

/** Whether a wall-clock seek target is within {@link NEAR_LIVE_EDGE_MS} of the session live edge. */
export function isNearLiveWallClock(
  seekTime: Date,
  anchor: LiveSessionAnchor | null,
  origin: Date,
  nowMs = Date.now(),
): boolean {
  if (!anchor) {
    return seekTime.getTime() >= nowMs - NEAR_LIVE_EDGE_MS;
  }
  const liveWall = liveEdgeWallClock(anchor, origin, nowMs);
  return seekTime.getTime() >= liveWall.getTime() - NEAR_LIVE_EDGE_MS;
}
