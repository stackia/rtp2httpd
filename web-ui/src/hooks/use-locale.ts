import { useMemo } from "react";
import { detectBrowserLocale, type Locale, SUPPORTED_LOCALES } from "../lib/locale";
import { usePersistedEnum } from "./use-persisted-enum";

export function useLocale(storageKey: string) {
  const browserLocale = useMemo(
    () => detectBrowserLocale(typeof navigator === "undefined" ? undefined : navigator),
    [],
  );
  const [locale, setLocale] = usePersistedEnum<Locale>(storageKey, browserLocale, SUPPORTED_LOCALES);
  return { locale, setLocale };
}
