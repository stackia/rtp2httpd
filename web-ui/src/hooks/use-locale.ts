import { useEffect, useState } from "react";
import { detectInitialLocale } from "../lib/locale";

export function useLocale(storageKey: string) {
  const [locale, setLocale] = useState(() => detectInitialLocale(storageKey));

  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(storageKey, locale);
    }
  }, [locale]);

  return { locale, setLocale };
}
