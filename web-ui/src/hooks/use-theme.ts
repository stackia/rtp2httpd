import { useCallback, useEffect, useMemo } from "react";
import { THEME_MODES, type ThemeMode } from "../types/ui";
import { usePersistedEnum } from "./use-persisted-enum";

const DEFAULT_THEME: ThemeMode = "auto";

export function useTheme(storageKey: string) {
  const [theme, setTheme] = usePersistedEnum<ThemeMode>(storageKey, DEFAULT_THEME, THEME_MODES);

  const applyTheme = useCallback((mode: ThemeMode, systemDarkOverride?: boolean) => {
    if (typeof document === "undefined") return;

    const prefersDark =
      typeof systemDarkOverride === "boolean"
        ? systemDarkOverride
        : typeof window !== "undefined" &&
          typeof window.matchMedia === "function" &&
          window.matchMedia("(prefers-color-scheme: dark)").matches;

    const isDark = mode === "dark" || (mode === "auto" && prefersDark);
    const root = document.documentElement;

    if (isDark) {
      root.classList.add("dark");
      root.style.colorScheme = "dark";
    } else {
      root.classList.remove("dark");
      root.style.colorScheme = "light";
    }
  }, []);

  useEffect(() => {
    applyTheme(theme);
  }, [theme, applyTheme]);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }
    const media = window.matchMedia("(prefers-color-scheme: dark)");

    const handleChange = (event: MediaQueryListEvent) => {
      if (theme === "auto") {
        applyTheme("auto", event.matches);
      }
    };

    media.addEventListener("change", handleChange);
    return () => media.removeEventListener("change", handleChange);
  }, [theme, applyTheme]);

  return useMemo(() => ({ theme, setTheme }), [theme, setTheme]);
}
