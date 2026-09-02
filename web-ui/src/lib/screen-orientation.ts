/**
 * Screen orientation helpers for the web player.
 *
 * Force-landscape is only offered on devices where rotation is meaningful
 * (phones, tablets, convertibles). Native Screen Orientation lock is preferred;
 * a CSS fallback keeps the page visually landscape when lock is unavailable.
 */

const ROTATABLE_PLATFORMS = new Set(["android", "ios", "mobile"]);
const NON_ROTATABLE_PLATFORMS = new Set(["lg-webos", "android-tv"]);

type LockableScreenOrientation = ScreenOrientation & {
  lock?: (orientation: "landscape") => Promise<void>;
};

function getLockableOrientation(): LockableScreenOrientation | undefined {
  return screen.orientation as LockableScreenOrientation | undefined;
}

export function isPortraitOrientation(): boolean {
  const type = screen.orientation?.type;
  if (typeof type === "string") {
    return type.startsWith("portrait");
  }
  return window.innerHeight > window.innerWidth;
}

/**
 * Whether the current device has a form factor where locking landscape is useful.
 * Hidden on TVs and typical mouse-only desktops; shown on phones, tablets, and
 * 2-in-1 / touch convertibles.
 */
export function canForceLandscape(): boolean {
  if (typeof window === "undefined" || typeof screen === "undefined") return false;

  const platform = document.documentElement.dataset.playerPlatform ?? "";
  if (NON_ROTATABLE_PLATFORMS.has(platform)) return false;
  if (ROTATABLE_PLATFORMS.has(platform)) return true;

  const hasTouch = navigator.maxTouchPoints > 1;
  const hasCoarsePointer = window.matchMedia("(any-pointer: coarse)").matches;
  const hasNoHover = window.matchMedia("(any-hover: none)").matches;
  return hasTouch || hasCoarsePointer || hasNoHover || isPortraitOrientation();
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

export function shouldInsetSidebarRight(forceLandscapeFallback = false): boolean {
  if (forceLandscapeFallback) return true;

  const { angle, type } = screen.orientation;
  if (!type.startsWith("landscape")) return true;

  // At 90°, the sidebar's right edge is on the device-bottom side and may
  // overlap the smaller system area. Preserve the inset at 270° and for other
  // angles, including naturally landscape devices.
  return angle !== 90;
}

/** Visual CSS width while the force-landscape fallback is rotating the page. */
export function getVisualViewportWidth(forceLandscapeFallback: boolean): number {
  return forceLandscapeFallback ? window.innerHeight : window.innerWidth;
}
