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

/**
 * Devices where GPU/CPU-heavy player features should default off
 * (heat, power, or weak SoC): phones, tablets, and constrained TVs.
 *
 * Prefer Client Hints when available; fall back to UA / platform checks.
 * Layout breakpoints (e.g. width < 768) are intentionally not used.
 */
export function isPerformanceConstrainedDevice(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }

  // LG webOS smart TVs (official UA token is `Web0S`, digit zero).
  const ua = navigator.userAgent;
  if (/Web0S/i.test(ua)) {
    return true;
  }

  if (navigator.userAgentData?.mobile === true) {
    return true;
  }

  if (isIOS()) {
    return true;
  }

  // Android / HarmonyOS phones and tablets (including some that omit "Mobile").
  if (/Android|HarmonyOS|OpenHarmony/i.test(ua)) {
    return true;
  }

  // Other common phone / tablet tokens outside Android / Apple.
  if (/Mobile|Tablet|Silk|Kindle|PlayBook/i.test(ua)) {
    return true;
  }

  // Chinese in-app / OEM browsers and custom kernels that may rewrite the UA
  // enough to miss the checks above. Skip desktop ports of the same brands.
  if (/Windows NT|Win64|WOW64/i.test(ua)) {
    return false;
  }
  if (/Macintosh|Mac OS X/i.test(ua)) {
    return false;
  }
  if (/\bX11\b|\bLinux\b/i.test(ua)) {
    return false;
  }

  if (
    /MicroMessenger|MiniProgramEnv|miniProgram|MQQBrowser|QBWebView|QQTheme|\sQQ\/|UCBrowser|UCWEB|baiduboxapp|baidubrowser|SogouMobileBrowser|QihooBrowser|QHBrowser|360Browser|HuaweiBrowser|MiuiBrowser|HeyTapBrowser|VivoBrowser|AlipayClient|DingTalk|Weibo|TBS\/|XWEB/i.test(
      ua,
    )
  ) {
    return true;
  }

  return false;
}
