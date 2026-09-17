import { createContext, type ReactNode, useContext, useSyncExternalStore } from "react";
import type { PlaybackClock } from "./playback-clock";

const noopSubscribe = () => () => {};
const zero = () => 0;

const PlaybackClockContext = createContext<PlaybackClock | null>(null);

interface PlaybackTimeProviderProps {
  children: ReactNode;
  clock: PlaybackClock;
}

/** Publishes the player's media clock to the controls rendered beneath it. */
export function PlaybackTimeProvider({ children, clock }: PlaybackTimeProviderProps) {
  return <PlaybackClockContext value={clock}>{children}</PlaybackClockContext>;
}

/** Playback position in seconds; re-renders the caller on whole-second changes only. */
export function usePlaybackTime(): number {
  const clock = useContext(PlaybackClockContext);
  return useSyncExternalStore(
    clock?.subscribe ?? noopSubscribe,
    clock?.getSnapshot ?? zero,
    clock?.getSnapshot ?? zero,
  );
}

/**
 * The clock itself, for consumers that must not re-render at 1 Hz: the EPG timeline reads it
 * imperatively and only commits state when the value it derives (the snapped window anchor)
 * actually changes.
 */
export function usePlaybackClock(): PlaybackClock | null {
  return useContext(PlaybackClockContext);
}
