import { useSyncExternalStore } from "react";

/**
 * Page-wide wall clock with second resolution.
 *
 * The companion of {@link useWallClockMinute}: programme boundaries and the overlay clock need
 * minute precision, but the EPG timeline's "now" line and its current-time label move every
 * second. Both hooks share the same shape — one timer per resolution for the whole page, and a
 * catch-up tick when a throttled background tab becomes visible again.
 */

const SECOND_MS = 1000;

const listeners = new Set<() => void>();
let currentSecondMs = floorToSecond(Date.now());
let alignTimeoutId = 0;
let intervalId = 0;

function floorToSecond(ms: number): number {
  return ms - (ms % SECOND_MS);
}

function tick(): void {
  const next = floorToSecond(Date.now());
  if (next === currentSecondMs) return;
  currentSecondMs = next;
  for (const listener of listeners) listener();
}

function clearTimers(): void {
  if (alignTimeoutId) window.clearTimeout(alignTimeoutId);
  if (intervalId) window.clearInterval(intervalId);
  alignTimeoutId = 0;
  intervalId = 0;
}

/** (Re)start the schedule so the next fire lands right after the second boundary. */
function schedule(): void {
  clearTimers();
  alignTimeoutId = window.setTimeout(
    () => {
      alignTimeoutId = 0;
      tick();
      intervalId = window.setInterval(tick, SECOND_MS);
    },
    SECOND_MS - (Date.now() % SECOND_MS),
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
  return currentSecondMs;
}

/** Current wall-clock time floored to the second (epoch ms); re-renders on second boundaries. */
export function useWallClockSecond(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
