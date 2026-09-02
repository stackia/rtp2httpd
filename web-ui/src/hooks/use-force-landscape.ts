import { useCallback, useEffect, useState } from "react";
import {
  canForceLandscape,
  isVisualPortrait,
  lockScreenToLandscape,
  unlockScreenOrientation,
} from "../lib/screen-orientation";

const FALLBACK_CLASS = "player-force-landscape-fallback-active";

function setFallbackClass(active: boolean): void {
  document.documentElement.classList.toggle(FALLBACK_CLASS, active);
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

export function useForceLandscape() {
  const [supported, setSupported] = useState(() => canForceLandscape());
  const [enabled, setEnabled] = useState(false);
  const [fallbackActive, setFallbackActive] = useState(false);

  const applyLock = useCallback(async () => {
    await lockScreenToLandscape();
    // lock() can resolve without rotating the viewport (OS rotation lock,
    // missing fullscreen, or a landscape sensor type with a portrait window).
    await nextFrame();
    const needsFallback = isVisualPortrait();
    setFallbackActive(needsFallback);
    setFallbackClass(needsFallback);
  }, []);

  const releaseLock = useCallback((keepFullscreenLock: boolean) => {
    setFallbackActive(false);
    setFallbackClass(false);
    if (!keepFullscreenLock) {
      unlockScreenOrientation();
    }
  }, []);

  const toggleForceLandscape = useCallback(async () => {
    if (enabled) {
      setEnabled(false);
      releaseLock(Boolean(document.fullscreenElement));
      return;
    }

    setEnabled(true);
    await applyLock();
  }, [applyLock, enabled, releaseLock]);

  useEffect(() => {
    const updateSupport = () => setSupported(canForceLandscape());
    updateSupport();
    window.addEventListener("resize", updateSupport);
    screen.orientation?.addEventListener("change", updateSupport);
    return () => {
      window.removeEventListener("resize", updateSupport);
      screen.orientation?.removeEventListener("change", updateSupport);
    };
  }, []);

  useEffect(() => {
    if (!enabled) return;

    const handleOrientationChange = () => {
      void applyLock();
    };

    screen.orientation?.addEventListener("change", handleOrientationChange);
    window.addEventListener("resize", handleOrientationChange);
    return () => {
      screen.orientation.removeEventListener("change", handleOrientationChange);
      window.removeEventListener("resize", handleOrientationChange);
    };
  }, [applyLock, enabled]);

  useEffect(() => {
    return () => {
      setFallbackClass(false);
    };
  }, []);

  return {
    canForceLandscape: supported,
    isForceLandscape: enabled,
    isForceLandscapeFallback: fallbackActive,
    toggleForceLandscape,
    applyForceLandscapeLock: applyLock,
    releaseForceLandscapeLock: releaseLock,
  };
}
