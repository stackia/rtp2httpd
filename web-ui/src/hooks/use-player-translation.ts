import { useCallback } from "react";
import type { Locale } from "../lib/locale";
import type { TranslationKey } from "../i18n/player";
import { translate } from "../i18n/player";

export function usePlayerTranslation(locale: Locale) {
  return useCallback((key: TranslationKey) => translate(locale, key), [locale]);
}
