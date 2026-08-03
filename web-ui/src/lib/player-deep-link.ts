import type { Channel } from "../types/player";

export const CHANNEL_ID_PARAM = "channel_id";
export const CHANNEL_NAME_PARAM = "channel_name";

/**
 * Resolve the deep-link target channel from the page URL query params.
 *
 * Supports:
 * - `channel_id`: exact match against the channel's 1-based list position id
 * - `channel_name`: trimmed, case-insensitive match against the channel name
 *
 * `channel_id` wins when both params are present. Returns `undefined` when the
 * params are absent or do not match any channel.
 */
export function findDeepLinkChannel(channels: Channel[]): Channel | undefined {
  const searchParams = new URLSearchParams(window.location.search);

  const channelId = searchParams.get(CHANNEL_ID_PARAM);
  if (channelId) {
    const channelById = channels.find((channel) => channel.id === channelId);
    if (channelById) {
      return channelById;
    }
  }

  const channelName = searchParams.get(CHANNEL_NAME_PARAM)?.trim().toLowerCase();
  if (channelName) {
    const channelByName = channels.find((channel) => channel.name.trim().toLowerCase() === channelName);
    if (channelByName) {
      return channelByName;
    }
  }

  return undefined;
}

/**
 * Keep the address bar in sync with the currently playing channel by
 * rewriting the URL to `?channel_name=<name>`.
 *
 * The `channel_id` param is dropped so a stale positional id cannot win over
 * the channel name on a later reload. All other params (notably `r2h-token`)
 * are preserved. Uses an absolute URL so the `<base href>` injected by the
 * server does not affect where `replaceState` writes.
 */
export function syncChannelDeepLink(channelName: string): void {
  try {
    const url = new URL(window.location.href);
    url.searchParams.delete(CHANNEL_ID_PARAM);
    url.searchParams.set(CHANNEL_NAME_PARAM, channelName);

    const nextUrl = url.toString();
    if (nextUrl === window.location.href) {
      return;
    }
    window.history.replaceState(window.history.state, "", nextUrl);
  } catch {
    // A hardened browser may reject URL/history writes; playback must not break.
  }
}
