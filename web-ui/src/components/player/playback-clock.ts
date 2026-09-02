/**
 * The media clock of the player: the playback position in seconds relative to the start of
 * the current stream (MSE timeline). It is fed by the active playback backend's `time-update`
 * events (browser `timeupdate`, ~4 Hz while playing) and publishes a snapshot that only
 * changes when the position crosses a whole second, so UI bound to it re-renders at most 1 Hz.
 *
 * This is distinct from wall-clock time: during catchup the position maps to a moment in the
 * past, and while paused or stalled it does not advance at all.
 */
export interface PlaybackClock {
  /** Latest raw position, updated on every backend tick. For imperative reads (seek math). */
  get(): number;
  /** Position as of the last whole-second change; what subscribers observe. */
  getSnapshot(): number;
  /** Notified when the snapshot changes (second boundary or reset). */
  subscribe(listener: () => void): () => void;
  /** Feed a raw backend position. */
  update(time: number): void;
  /** A new stream is starting (channel/source switch, seek): position goes back to 0. */
  reset(): void;
}

export function createPlaybackClock(): PlaybackClock {
  let time = 0;
  let snapshot = 0;
  let snapshotSecond = 0;
  const listeners = new Set<() => void>();

  const publish = (next: number) => {
    snapshot = next;
    snapshotSecond = Math.floor(next);
    for (const listener of listeners) listener();
  };

  return {
    get: () => time,
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    update: (next) => {
      time = next;
      if (Math.floor(next) === snapshotSecond) return;
      publish(next);
    },
    reset: () => {
      time = 0;
      if (snapshot === 0) return;
      publish(0);
    },
  };
}
