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

let volumeControlSupported: boolean | null = null;

/**
 * Whether `HTMLMediaElement.volume` can actually be changed.
 *
 * iOS and iPadOS make it read-only — assignment is silently ignored, reads always
 * return 1, and no `volumechange` fires — because the volume belongs to the hardware
 * buttons there. `muted` stays settable, so muting still works. Probed rather than
 * sniffed from the user agent so desktop Safari, which does support it, is not caught.
 */
export function isVolumeControlSupported(): boolean {
  if (volumeControlSupported === null) {
    const probe = document.createElement("video");
    probe.volume = 0.5;
    volumeControlSupported = probe.volume === 0.5;
  }
  return volumeControlSupported;
}
