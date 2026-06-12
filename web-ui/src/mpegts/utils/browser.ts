const ua = self.navigator?.userAgent.toLowerCase() ?? "";

/** Safari (excluding Chrome/Chromium which also contain "safari" in UA). */
export const isSafari = ua.includes("safari") && !ua.includes("chrome") && !ua.includes("android");

/** Firefox — the only browser supporting 'audio/mp4; codecs="mp3"'. */
export const isFirefox = ua.includes("firefox");
