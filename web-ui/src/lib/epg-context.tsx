import { createContext, type ReactNode, startTransition, useCallback, useContext, useState } from "react";
import type { EPGData } from "../lib/epg-parser";

const EMPTY_EPG_DATA: EPGData = {};

const EpgDataContext = createContext<EPGData>(EMPTY_EPG_DATA);
const EpgDispatchContext = createContext<(data: EPGData) => void>(() => {});

interface EpgProviderProps {
  children: ReactNode;
}

/**
 * Keep the parsed EPG object out of PlayerPage state.
 * Updating this provider re-renders only `useEpgData()` consumers, not the video player.
 */
export function EpgProvider({ children }: EpgProviderProps) {
  const [epgData, setEpgData] = useState<EPGData>(EMPTY_EPG_DATA);
  const applyEpgData = useCallback((data: EPGData) => {
    startTransition(() => {
      setEpgData(data);
    });
  }, []);

  return (
    <EpgDispatchContext value={applyEpgData}>
      <EpgDataContext value={epgData}>{children}</EpgDataContext>
    </EpgDispatchContext>
  );
}

export function useEpgData(): EPGData {
  return useContext(EpgDataContext);
}

export function useSetEpgData(): (data: EPGData) => void {
  return useContext(EpgDispatchContext);
}
