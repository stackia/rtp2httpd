/**
 * Screen orientation helpers for the web player.
 */

type LockableScreenOrientation = ScreenOrientation & {
  lock?: (orientation: "landscape") => Promise<void>;
};

function getLockableOrientation(): LockableScreenOrientation | undefined {
  return screen.orientation as LockableScreenOrientation | undefined;
}

function viewportSize(): { width: number; height: number } {
  const viewport = window.visualViewport;
  return {
    width: viewport?.width ?? window.innerWidth,
    height: viewport?.height ?? window.innerHeight,
  };
}

/** Whether the visible viewport is currently taller than it is wide. */
export function isVisualPortrait(): boolean {
  const { width, height } = viewportSize();
  return height >= width;
}

const ROTATABLE_PLATFORMS = new Set(["android", "ios", "mobile"]);
const NON_ROTATABLE_PLATFORMS = new Set(["lg-webos", "android-tv"]);

/** Phones, tablets, and convertibles where rotating the player into landscape is useful. */
export function isRotatableMobileDevice(): boolean {
  if (typeof window === "undefined" || typeof screen === "undefined") return false;

  const platform = document.documentElement.dataset.playerPlatform ?? "";
  if (NON_ROTATABLE_PLATFORMS.has(platform)) return false;
  if (ROTATABLE_PLATFORMS.has(platform)) return true;

  const hasTouch = navigator.maxTouchPoints > 1;
  const hasCoarsePointer = window.matchMedia("(any-pointer: coarse)").matches;
  const hasNoHover = window.matchMedia("(any-hover: none)").matches;
  return hasTouch || hasCoarsePointer || hasNoHover;
}

export async function lockScreenToLandscape(): Promise<boolean> {
  const orientation = getLockableOrientation();
  if (!orientation?.lock) return false;

  try {
    await orientation.lock("landscape");
    return true;
  } catch {
    return false;
  }
}

export function unlockScreenOrientation(): void {
  try {
    screen.orientation?.unlock();
  } catch {
    // The orientation may already have been unlocked when fullscreen ended.
  }
}

export function shouldInsetSidebarRight(): boolean {
  const { angle, type } = screen.orientation;
  if (!type.startsWith("landscape")) return true;

  // At 90°, the sidebar's right edge is on the device-bottom side and may
  // overlap the smaller system area. Preserve the inset at 270° and for other
  // angles, including naturally landscape devices.
  return angle !== 90;
}
