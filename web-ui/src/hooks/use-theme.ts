import { useCallback, useEffect, useMemo, useState } from "react";
import type { ThemeMode } from "../types/ui";

function readStoredTheme(storageKey: string): ThemeMode {
  if (typeof window === "undefined") {
    return "auto";
  }
  const stored = window.localStorage.getItem(storageKey);
  return stored === "light" || stored === "dark" ? stored : "auto";
}

export function useTheme(storageKey: string) {
  const [theme, setTheme] = useState<ThemeMode>(() => readStoredTheme(storageKey));

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
    if (typeof window !== "undefined") {
      window.localStorage.setItem(storageKey, theme);
    }
  }, [theme, storageKey, applyTheme]);

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

  return useMemo(
    () => ({
      theme,
      setTheme,
    }),
    [theme],
  );
}
