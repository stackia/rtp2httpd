import { useSyncExternalStore } from "react";

/**
 * Page-wide wall clock with minute resolution.
 *
 * Programme boundaries in the EPG fall on whole minutes and the overlay clock shows hh:mm, so
 * every wall-clock consumer only needs to know which minute it is. One shared, minute-aligned
 * timer feeds all of them, which keeps their notion of "now" identical and leaves a single
 * timer on the page. This is deliberately separate from the media clock (video position):
 * the media clock can be paused, stalled or point into the past during catchup, so it cannot
 * stand in for real time.
 */

const MINUTE_MS = 60_000;

const listeners = new Set<() => void>();
let currentMinuteMs = floorToMinute(Date.now());
let alignTimeoutId = 0;
let intervalId = 0;

function floorToMinute(ms: number): number {
  return ms - (ms % MINUTE_MS);
}

function tick(): void {
  const next = floorToMinute(Date.now());
  if (next === currentMinuteMs) return;
  currentMinuteMs = next;
  for (const listener of listeners) listener();
}

function clearTimers(): void {
  if (alignTimeoutId) window.clearTimeout(alignTimeoutId);
  if (intervalId) window.clearInterval(intervalId);
  alignTimeoutId = 0;
  intervalId = 0;
}

/** (Re)start the schedule so the next fire lands right after the minute boundary. */
function schedule(): void {
  clearTimers();
  alignTimeoutId = window.setTimeout(
    () => {
      alignTimeoutId = 0;
      tick();
      intervalId = window.setInterval(tick, MINUTE_MS);
    },
    MINUTE_MS - (Date.now() % MINUTE_MS),
  );
}

// Timers are throttled or suspended in background tabs; catch up and re-align on return.
function handleVisibilityChange(): void {
  if (document.visibilityState !== "visible") return;
  tick();
  schedule();
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) {
    // First subscriber (e.g. a tab being revealed): make sure the value is current before it renders.
    tick();
    schedule();
    document.addEventListener("visibilitychange", handleVisibilityChange);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      clearTimers();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    }
  };
}

function getSnapshot(): number {
  return currentMinuteMs;
}

/** Current wall-clock time floored to the minute (epoch ms); re-renders on minute boundaries. */
export function useWallClockMinute(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
