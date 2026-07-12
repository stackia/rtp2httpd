/**
 * Platform detection helpers for the web player UI.
 */

/** Detect iOS and iPadOS devices for player defaults and platform workarounds. */
export function isIOS(): boolean {
  return document.documentElement.dataset.playerPlatform === "ios";
}

/** Detect LG TV browsers that should use the platform-native media pipeline. */
export function isLGWebOS(): boolean {
  return document.documentElement.dataset.playerPlatform === "lg-webos";
}

/** Whether the current browser is a desktop-class device eligible for MSE video processing. */
export function isDesktopDevice(): boolean {
  return document.documentElement.dataset.playerPlatform === "desktop";
}
