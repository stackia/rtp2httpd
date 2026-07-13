import { createContext, type ReactNode, useContext } from "react";

const PlaybackTimeContext = createContext(0);

interface PlaybackTimeProviderProps {
  children: ReactNode;
  value: number;
}

export function PlaybackTimeProvider({ children, value }: PlaybackTimeProviderProps) {
  return <PlaybackTimeContext value={value}>{children}</PlaybackTimeContext>;
}

export function usePlaybackTime() {
  return useContext(PlaybackTimeContext);
}
