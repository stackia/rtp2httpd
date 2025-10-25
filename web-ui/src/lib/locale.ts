export type Locale = "en" | "zh-Hans" | "zh-Hant";

const SUPPORTED_LOCALES: Locale[] = ["en", "zh-Hans", "zh-Hant"];

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

export function ensureSupportedLocale(locale: string | null | undefined): Locale {
  if (locale && (SUPPORTED_LOCALES as string[]).includes(locale)) {
    return locale as Locale;
  }
  return "en";
}

export function detectInitialLocale(storageKey: string): Locale {
  if (typeof window === "undefined") {
    return "en";
  }
  const stored = window.localStorage.getItem(storageKey);
  if (stored) {
    return ensureSupportedLocale(stored);
  }
  return detectBrowserLocale(navigator);
}
