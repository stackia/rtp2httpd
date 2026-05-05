export const SUPPORTED_LOCALES = ["en", "zh-Hans", "zh-Hant"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

export function normalizeLocale(locale: string | undefined): Locale | null {
  if (!locale) return null;
  const lower = locale.toLowerCase();

  if (lower.startsWith("zh")) {
    if (lower.includes("hant") || lower.includes("tw") || lower.includes("hk") || lower.includes("mo")) {
      return "zh-Hant";
    }
    return "zh-Hans";
  }

  if (lower.startsWith("en")) {
    return "en";
  }

  return null;
}

export function detectBrowserLocale(navigatorObject: Navigator | undefined): Locale {
  if (!navigatorObject) {
    return "en";
  }

  const candidates = [...(navigatorObject.languages ?? []), navigatorObject.language];

  for (const candidate of candidates) {
    const normalized = normalizeLocale(candidate);
    if (normalized) {
      return normalized;
    }
  }

  return "en";
}
