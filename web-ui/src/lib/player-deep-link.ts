import type { Channel } from "../types/player";

function readHashToken(): string {
  const raw = window.location.hash.startsWith("#") ? window.location.hash.slice(1) : window.location.hash;
  if (!raw) {
    return "";
  }
  try {
    return decodeURIComponent(raw).trim();
  } catch {
    return raw.trim();
  }
}

function findChannelById(channels: Channel[], channelId: string): Channel | undefined {
  return channels.find((channel) => channel.id === channelId);
}

function findChannelByName(channels: Channel[], channelName: string): Channel | undefined {
  const normalized = channelName.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  return channels.find((channel) => channel.name.trim().toLowerCase() === normalized);
}

/**
 * Resolve the deep-link target channel from the page URL hash.
 *
 * Supports `/player#<token>` where token is either:
 * - a channel id (1-based list position shown in the channel list), or
 * - a channel name (trimmed, case-insensitive)
 *
 * Id match wins when the token matches both an id and a name. Returns
 * `undefined` when the token is absent or does not match any channel.
 */
export function findDeepLinkChannel(channels: Channel[]): Channel | undefined {
  const token = readHashToken();
  if (!token) {
    return undefined;
  }
  return findChannelById(channels, token) ?? findChannelByName(channels, token);
}

function channelNameIsAmbiguous(channel: Channel, channels: Channel[]): boolean {
  const name = channel.name.trim();
  if (!name) {
    return true;
  }

  const nameKey = name.toLowerCase();
  let sameNameCount = 0;
  for (const other of channels) {
    if (other.name.trim().toLowerCase() === nameKey) {
      sameNameCount++;
      if (sameNameCount > 1) {
        return true;
      }
    }
  }

  // `#5` is always parsed as channel id 5, so a unique name that equals some
  // channel id would round-trip to the wrong channel if written as a name.
  return channels.some((other) => other.id === name);
}

/** Hash token to write for `channel`: name by default, id when the name would be ambiguous. */
export function channelDeepLinkToken(channel: Channel, channels: Channel[]): string {
  if (channelNameIsAmbiguous(channel, channels)) {
    return channel.id;
  }
  return channel.name.trim();
}

/**
 * Keep the address bar in sync with the currently playing channel by rewriting
 * the URL to `#<name>`, or `#<id>` when the name is ambiguous.
 *
 * Other query params (notably `r2h-token`) are preserved. Uses an absolute URL
 * so the `<base href>` injected by the server does not affect where
 * `replaceState` writes.
 */
export function syncChannelDeepLink(channel: Channel, channels: Channel[]): void {
  try {
    const url = new URL(window.location.href);
    const token = channelDeepLinkToken(channel, channels);
    const nextUrl = `${url.origin}${url.pathname}${url.search}#${encodeURIComponent(token)}`;
    if (nextUrl === window.location.href) {
      return;
    }
    window.history.replaceState(window.history.state, "", nextUrl);
  } catch {
    // A hardened browser may reject URL/history writes; playback must not break.
  }
}
