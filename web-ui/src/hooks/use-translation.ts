import { useCallback } from "react";
import type { Locale, TranslationKey } from "../i18n";
import { translate } from "../i18n";

export function useTranslation(locale: Locale) {
  return useCallback((key: TranslationKey) => translate(locale, key), [locale]);
}
