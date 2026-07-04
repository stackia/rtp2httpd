/**
 * LocalStorage utilities for player state persistence.
 *
 * createStore<T>(key, defaultValue) returns a [get, save] tuple that handles
 * JSON serialization, error handling, and backward-compatible reads.
 */

function cloneDefaultValue<T>(value: T): T {
  if (value === null || typeof value !== "object") {
    return value;
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

function createStore<T>(key: string, defaultValue: T): [get: () => T, save: (value: T) => void] {
  const defaultSnapshot = JSON.stringify(defaultValue);

  return [
    (): T => {
      try {
        const raw = localStorage.getItem(key);
        if (raw === null) return cloneDefaultValue(defaultValue);
        return JSON.parse(raw) as T;
      } catch {
        return cloneDefaultValue(defaultValue);
      }
    },
    (value: T): void => {
      try {
        if (JSON.stringify(value) === defaultSnapshot) {
          localStorage.removeItem(key);
        } else {
          localStorage.setItem(key, JSON.stringify(value));
        }
      } catch {}
    },
  ];
}

export const [getLastChannelId, saveLastChannelId] = createStore<string | null>(
  "rtp2httpd-player-last-channel-id",
  null,
);
export const [getSidebarVisible, saveSidebarVisible] = createStore("rtp2httpd-player-sidebar-visible", true);
export const [getSeamlessSwitch, saveSeamlessSwitch] = createStore("rtp2httpd-player-seamless-switch", true);
export const [getAutoDeinterlace, saveAutoDeinterlace] = createStore("rtp2httpd-player-auto-deinterlace", true);
export const [getVolume, saveVolume] = createStore("rtp2httpd-player-volume", 1);
export const [getMuted, saveMuted] = createStore("rtp2httpd-player-muted", false);

// Per-channel source index uses a JSON object map, so it needs custom logic
const [getSourceIndexMap, saveSourceIndexMap] = createStore<Record<string, number>>(
  "rtp2httpd-player-last-source-index",
  {},
);

export function getLastSourceIndex(channelId: string): number {
  return getSourceIndexMap()[channelId] ?? 0;
}

export function saveLastSourceIndex(channelId: string, sourceIndex: number): void {
  const map = { ...getSourceIndexMap() };
  if (sourceIndex === 0) {
    delete map[channelId];
  } else {
    map[channelId] = sourceIndex;
  }
  saveSourceIndexMap(map);
}
