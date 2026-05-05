import { type Dispatch, type SetStateAction, useEffect, useState } from "react";

export function usePersistedEnum<T extends string>(
  storageKey: string,
  defaultValue: T,
  validValues: readonly T[],
): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    if (typeof window === "undefined") return defaultValue;
    const stored = window.localStorage.getItem(storageKey);
    return stored !== null && (validValues as readonly string[]).includes(stored) ? (stored as T) : defaultValue;
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    const current = window.localStorage.getItem(storageKey);
    if (value === defaultValue) {
      if (current !== null) window.localStorage.removeItem(storageKey);
    } else if (current !== value) {
      window.localStorage.setItem(storageKey, value);
    }
  }, [value, storageKey, defaultValue]);

  return [value, setValue];
}
