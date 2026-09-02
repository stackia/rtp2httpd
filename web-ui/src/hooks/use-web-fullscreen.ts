import { useCallback, useEffect, useState } from "react";
import { isRotatableMobileDevice, isVisualPortrait } from "../lib/screen-orientation";

const ACTIVE_CLASS = "player-web-fullscreen-active";

function setActiveClass(active: boolean): void {
  document.documentElement.classList.toggle(ACTIVE_CLASS, active);
}

export function useWebFullscreen() {
  const [enabled, setEnabled] = useState(false);
  const [portraitRotate, setPortraitRotate] = useState(false);

  const updatePortraitRotate = useCallback(() => {
    setPortraitRotate(isRotatableMobileDevice() && isVisualPortrait());
  }, []);

  const toggleWebFullscreen = useCallback(() => {
    setEnabled((prev) => !prev);
  }, []);

  useEffect(() => {
    setActiveClass(enabled);
    if (enabled) updatePortraitRotate();
    else setPortraitRotate(false);
    return () => setActiveClass(false);
  }, [enabled, updatePortraitRotate]);

  useEffect(() => {
    if (!enabled) return;

    const handleViewportChange = () => updatePortraitRotate();
    window.addEventListener("resize", handleViewportChange);
    screen.orientation?.addEventListener("change", handleViewportChange);
    return () => {
      window.removeEventListener("resize", handleViewportChange);
      screen.orientation?.removeEventListener("change", handleViewportChange);
    };
  }, [enabled, updatePortraitRotate]);

  return {
    isWebFullscreen: enabled,
    isWebFullscreenPortrait: enabled && portraitRotate,
    toggleWebFullscreen,
  };
}
