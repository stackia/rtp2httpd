import { useEffect, useState } from "react";
import { isRotatableMobileDevice, isVisualPortrait } from "../lib/screen-orientation";

/**
 * Phones/tablets in a landscape chrome: either the viewport is already landscape,
 * or theater mode has CSS-rotated a portrait viewport into a landscape player.
 * Player controls stay on the compact (non-md) size in both cases.
 */
export function useMobileLandscapeChrome(theaterMode = false): boolean {
  const [compact, setCompact] = useState(() => {
    if (typeof window === "undefined") return false;
    return isRotatableMobileDevice() && (!isVisualPortrait() || theaterMode);
  });

  useEffect(() => {
    const update = () => {
      if (!isRotatableMobileDevice()) {
        setCompact(false);
        return;
      }
      setCompact(!isVisualPortrait() || theaterMode);
    };

    update();
    window.addEventListener("resize", update);
    window.visualViewport?.addEventListener("resize", update);
    screen.orientation?.addEventListener("change", update);
    return () => {
      window.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("resize", update);
      screen.orientation?.removeEventListener("change", update);
    };
  }, [theaterMode]);

  return compact;
}
