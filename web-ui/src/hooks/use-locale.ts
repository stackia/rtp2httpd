import { useEffect, useState } from "react";
import { detectBrowserLocale, detectInitialLocale } from "../lib/locale";

export function useLocale(storageKey: string) {
	const [locale, setLocale] = useState(() => detectInitialLocale(storageKey));

	useEffect(() => {
		if (typeof window !== "undefined") {
			if (locale === detectBrowserLocale(navigator)) {
				window.localStorage.removeItem(storageKey);
			} else {
				window.localStorage.setItem(storageKey, locale);
			}
		}
	}, [locale, storageKey]);

	return { locale, setLocale };
}
