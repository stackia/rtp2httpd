import { useCallback } from "react";
import type { TranslationKey } from "../i18n/player";
import { translate } from "../i18n/player";
import type { Locale } from "../lib/locale";

export function usePlayerTranslation(locale: Locale) {
	return useCallback((key: TranslationKey) => translate(locale, key), [locale]);
}
