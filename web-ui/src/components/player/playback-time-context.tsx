import { createContext, type ReactNode, useContext, useSyncExternalStore } from "react";

/**
 * Tiny external store for the playback clock (seconds relative to stream start).
 * Keeping the 1 Hz clock out of React state means only the components that
 * actually display it (timeline, time readout) re-render on each tick.
 */
export interface PlaybackTimeStore {
  get: () => number;
  set: (time: number) => void;
  subscribe: (listener: () => void) => () => void;
}

export function createPlaybackTimeStore(): PlaybackTimeStore {
  let time = 0;
  const listeners = new Set<() => void>();
  return {
    get: () => time,
    set: (next) => {
      if (next === time) return;
      time = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

const noopSubscribe = () => () => {};
const zero = () => 0;

const PlaybackTimeContext = createContext<PlaybackTimeStore | null>(null);

interface PlaybackTimeProviderProps {
  children: ReactNode;
  store: PlaybackTimeStore;
}

export function PlaybackTimeProvider({ children, store }: PlaybackTimeProviderProps) {
  return <PlaybackTimeContext value={store}>{children}</PlaybackTimeContext>;
}

export function usePlaybackTime(): number {
  const store = useContext(PlaybackTimeContext);
  return useSyncExternalStore(store?.subscribe ?? noopSubscribe, store?.get ?? zero, store?.get ?? zero);
}
