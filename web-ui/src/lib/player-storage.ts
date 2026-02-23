/**
 * LocalStorage utilities for player state persistence.
 *
 * createStore<T>(key, defaultValue) returns a [get, save] tuple that handles
 * JSON serialization, error handling, and backward-compatible reads.
 */

function createStore<T>(key: string, defaultValue: T): [get: () => T, save: (value: T) => void] {
	return [
		(): T => {
			try {
				const raw = localStorage.getItem(key);
				if (raw === null) return defaultValue;
				return JSON.parse(raw) as T;
			} catch {
				return defaultValue;
			}
		},
		(value: T): void => {
			try {
				if (JSON.stringify(value) === JSON.stringify(defaultValue)) {
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
export const [getCatchupTailOffset, saveCatchupTailOffset] = createStore("rtp2httpd-player-catchup-tail-offset", 0);
export const [getForce16x9, saveForce16x9] = createStore("rtp2httpd-player-force-16-9", true);
export const [getMp2SoftDecode, saveMp2SoftDecode] = createStore(
	"rtp2httpd-player-mp2-soft-decode",
	/iPhone|iPad|iPod/.test(navigator.userAgent),
);

// Per-channel source index uses a JSON object map, so it needs custom logic
const [getSourceIndexMap, saveSourceIndexMap] = createStore<Record<string, number>>(
	"rtp2httpd-player-last-source-index",
	{},
);

export function getLastSourceIndex(channelId: string): number {
	return getSourceIndexMap()[channelId] ?? 0;
}

export function saveLastSourceIndex(channelId: string, sourceIndex: number): void {
	const map = getSourceIndexMap();
	if (sourceIndex === 0) {
		delete map[channelId];
	} else {
		map[channelId] = sourceIndex;
	}
	saveSourceIndexMap(map);
}
