/**
 * LocalStorage utilities for player state persistence
 */

const STORAGE_KEYS = {
  LAST_CHANNEL_ID: "rtp2httpd-player-last-channel-id",
  SIDEBAR_VISIBLE: "rtp2httpd-player-sidebar-visible",
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
