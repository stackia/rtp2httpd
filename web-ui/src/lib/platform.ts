/**
 * Platform detection helpers for the web player UI.
 */

/** Match iOS/iPadOS version token in WebKit UA (survives some UA reductions). */
const IOS_CPU_OS = /CPU (?:iPhone )?OS \d+[_\d]* like Mac OS X/;

/** Third-party browsers on iOS/iPadOS (all use WebKit). */
const IOS_BROWSER = /EdgiOS|CriOS|FxiOS|OPiOS/;

/**
 * Detect iOS and iPadOS devices for player defaults and platform workarounds.
 *
 * Covers classic mobile UA, iPadOS desktop UA (Macintosh), and iOS browser
 * wrappers that may omit the device name.
 */
export function isIOS(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }

  const ua = navigator.userAgent;

  if (/iPhone|iPad|iPod/.test(ua)) {
    return true;
  }

  if (IOS_CPU_OS.test(ua)) {
    return true;
  }

  if (IOS_BROWSER.test(ua)) {
    return true;
  }

  // iPadOS 13+ "Request Desktop Website" reports as Mac with touch input.
  if (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1) {
    return true;
  }

  if (navigator.userAgentData?.platform === "iOS") {
    return true;
  }

  return false;
}
