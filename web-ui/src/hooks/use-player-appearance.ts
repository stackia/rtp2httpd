import { useEffect, useMemo } from "react";
import { PLAYER_APPEARANCES, type PlayerAppearance } from "../types/ui";
import { usePersistedEnum } from "./use-persisted-enum";

const STORAGE_KEY = "rtp2httpd-player-appearance";

function getDefaultPlayerAppearance(): PlayerAppearance {
  if (typeof document === "undefined") return "fancy";
  return document.documentElement.dataset.performanceTier === "constrained" ? "simple" : "fancy";
}

export function usePlayerAppearance() {
  const [appearance, setAppearance] = usePersistedEnum<PlayerAppearance>(
    STORAGE_KEY,
    getDefaultPlayerAppearance(),
    PLAYER_APPEARANCES,
  );

  useEffect(() => {
    document.documentElement.classList.toggle("player-theme-simple", appearance === "simple");
  }, [appearance]);

  return useMemo(() => ({ appearance, setAppearance }), [appearance, setAppearance]);
}
