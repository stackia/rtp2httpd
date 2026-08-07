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

/**
 * Whether `HTMLMediaElement.volume` actually affects playback.
 *
 * iOS and iPadOS ignore volume writes because the level belongs to the hardware buttons;
 * `muted` stays settable, so muting still works. Feature-detecting this does not work:
 * assigning to a detached element's `volume` reads the value back unchanged, so a probe
 * reports support that playback then does not honour. Hence the UA check, reusing the
 * platform tag that `player.html` sets — it also covers iOS-wrapped browsers (CriOS,
 * FxiOS, ...) and iPadOS reporting itself as MacIntel.
 */
export function isVolumeControlSupported(): boolean {
  return !isIOS();
}
