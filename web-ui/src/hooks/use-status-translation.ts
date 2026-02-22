import { useCallback } from "react";
import type { TranslationKey } from "../i18n/status";
import { translate } from "../i18n/status";
import type { Locale } from "../lib/locale";

export function useStatusTranslation(locale: Locale) {
	return useCallback((key: TranslationKey) => translate(locale, key), [locale]);
}
