/**
 * LocalStorage utilities for player state persistence
 */

const STORAGE_KEYS = {
  LAST_CHANNEL_ID: "rtp2httpd-player-last-channel-id",
  SIDEBAR_VISIBLE: "rtp2httpd-player-sidebar-visible",
  CATCHUP_TAIL_OFFSET: "rtp2httpd-player-catchup-tail-offset",
} as const;

/**
 * Save the last played live channel ID
 * @param channelId - The channel ID to save
 */
export function saveLastChannelId(channelId: string): void {
  try {
    localStorage.setItem(STORAGE_KEYS.LAST_CHANNEL_ID, channelId);
  } catch (error) {
    console.error("Failed to save last channel ID:", error);
  }
}

/**
 * Get the last played live channel ID
 * @returns The last channel ID or null if not found
 */
export function getLastChannelId(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEYS.LAST_CHANNEL_ID);
  } catch (error) {
    console.error("Failed to get last channel ID:", error);
    return null;
  }
}

/**
 * Save the sidebar visibility state
 * @param visible - Whether the sidebar is visible
 */
export function saveSidebarVisible(visible: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEYS.SIDEBAR_VISIBLE, JSON.stringify(visible));
  } catch (error) {
    console.error("Failed to save sidebar visibility:", error);
  }
}

/**
 * Get the sidebar visibility state
 * @returns The sidebar visibility or true (default)
 */
export function getSidebarVisible(): boolean {
  try {
    const stored = localStorage.getItem(STORAGE_KEYS.SIDEBAR_VISIBLE);
    return stored !== null ? JSON.parse(stored) : true;
  } catch (error) {
    console.error("Failed to get sidebar visibility:", error);
    return true;
  }
}

/**
 * Save the catchup tail offset (in seconds)
 * @param offset - The offset in seconds (0 means current time)
 */
export function saveCatchupTailOffset(offset: number): void {
  try {
    localStorage.setItem(STORAGE_KEYS.CATCHUP_TAIL_OFFSET, offset.toString());
  } catch (error) {
    console.error("Failed to save catchup tail offset:", error);
  }
}

/**
 * Get the catchup tail offset (in seconds)
 * @returns The offset in seconds or 0 (default)
 */
export function getCatchupTailOffset(): number {
  try {
    const stored = localStorage.getItem(STORAGE_KEYS.CATCHUP_TAIL_OFFSET);
    return stored !== null ? parseFloat(stored) : 0;
  } catch (error) {
    console.error("Failed to get catchup tail offset:", error);
    return 0;
  }
}
