import { useCallback, useEffect, useState } from "react";
import {
  canForceLandscape,
  isPortraitOrientation,
  lockScreenToLandscape,
  unlockScreenOrientation,
} from "../lib/screen-orientation";

const FALLBACK_CLASS = "player-force-landscape-fallback-active";

function setFallbackClass(active: boolean): void {
  document.documentElement.classList.toggle(FALLBACK_CLASS, active);
}

export function useForceLandscape() {
  const [supported, setSupported] = useState(() => canForceLandscape());
  const [enabled, setEnabled] = useState(false);
  const [fallbackActive, setFallbackActive] = useState(false);

  const applyLock = useCallback(async () => {
    const locked = await lockScreenToLandscape();
    const needsFallback = !locked && isPortraitOrientation();
    setFallbackActive(needsFallback);
    setFallbackClass(needsFallback);
    return locked;
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
