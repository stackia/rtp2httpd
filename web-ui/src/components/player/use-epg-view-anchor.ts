import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/** Length of the glide that carries the EPG window to a new position. */
const GLIDE_MS = 220;

function easeOutCubic(progress: number): number {
  return 1 - (1 - progress) ** 3;
}

/**
 * Motion is skipped where animations are cut short anyway: under reduced motion and in the simple
 * theme. Read from the element's own document, which is the picture-in-picture window's while the
 * player lives there.
 */
function prefersInstantMotion(element: HTMLElement | null): boolean {
  const ownerDocument = element?.ownerDocument ?? document;
  const view = ownerDocument.defaultView ?? window;
  return (
    ownerDocument.documentElement.classList.contains("player-theme-simple") ||
    view.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
  );
}

/**
 * The anchor the EPG band is drawn at. It glides to each new `targetMs` frame by frame, starting
 * from wherever it is on screen, so a target that changes mid-glide bends the motion instead of
 * restarting it; a jump wider than `spanMs`, or unwanted motion, cuts instead. A drag `hold`s the
 * anchor, moves it with `moveTo`, and hands it back with `release`.
 *
 * `movingRef` is true while a glide or a hold is in progress, for work that should wait for the
 * window to settle.
 */
export function useEpgViewAnchor(targetMs: number, spanMs: number, elementRef: RefObject<HTMLElement | null>) {
  const [viewAnchorMs, setViewAnchorMs] = useState(targetMs);
  // Synchronous copy: a pointer-up reads the final position before React commits it.
  const viewAnchorRef = useRef(targetMs);
  const movingRef = useRef(false);
  const heldRef = useRef(false);
  const frameRef = useRef(0);

  const moveTo = useCallback((nextMs: number) => {
    viewAnchorRef.current = nextMs;
    setViewAnchorMs(nextMs);
  }, []);

  const stop = useCallback(() => {
    cancelAnimationFrame(frameRef.current);
    frameRef.current = 0;
    movingRef.current = false;
  }, []);
  useEffect(() => stop, [stop]);

  useLayoutEffect(() => {
    if (heldRef.current) return;
    stop();
    const fromMs = viewAnchorRef.current;
    if (fromMs === targetMs) return;
    if (Math.abs(targetMs - fromMs) > spanMs || prefersInstantMotion(elementRef.current)) {
      moveTo(targetMs);
      return;
    }
    const startedAt = performance.now();
    movingRef.current = true;
    const step = (now: number) => {
      const progress = (now - startedAt) / GLIDE_MS;
      if (progress >= 1) {
        stop();
        moveTo(targetMs);
        return;
      }
      moveTo(fromMs + (targetMs - fromMs) * easeOutCubic(progress));
      frameRef.current = requestAnimationFrame(step);
    };
    frameRef.current = requestAnimationFrame(step);
  }, [targetMs, spanMs, elementRef, moveTo, stop]);

  /** Stops any glide where it is and returns the anchor on screen. */
  const hold = useCallback(() => {
    stop();
    heldRef.current = true;
    movingRef.current = true;
    return viewAnchorRef.current;
  }, [stop]);

  /** Ends a hold and returns the anchor it left on screen. */
  const release = useCallback(() => {
    heldRef.current = false;
    movingRef.current = false;
    return viewAnchorRef.current;
  }, []);

  return { viewAnchorMs, movingRef, hold, moveTo, release };
}
