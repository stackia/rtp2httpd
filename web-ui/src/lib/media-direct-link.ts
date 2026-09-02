import type { Channel, Source } from "../types/player";
import { buildCatchupUrl } from "./catchup-url";
import { CATCHUP_MIN_DURATION_MS, type CatchupProgramBound } from "./catchup-windows";
import { getLastSourceIndex } from "./player-storage";

/**
 * Strip a `$label` suffix the same way the server does for request paths.
 * `${...}` placeholders are left intact.
 *
 * Labels sit at the end of an M3U URL, or at the end of the path after
 * catchup="append" concatenates a query. Do not treat `$HD?playseek=…` as one
 * label — that would drop the time range.
 */
export function stripPlaylistUrlLabel(url: string): string {
  for (let i = url.length - 1; i >= 0; i--) {
    if (url[i] !== "$") continue;
    if (i === url.length - 1) continue;
    if (url[i + 1] === "{") continue;

    let labelEnd = i + 1;
    while (
      labelEnd < url.length &&
      url[labelEnd] !== "?" &&
      url[labelEnd] !== "#" &&
      url[labelEnd] !== "&" &&
      url[labelEnd] !== "/"
    ) {
      labelEnd++;
    }
    if (labelEnd < url.length && url[labelEnd] === "/") continue;
    if (labelEnd === i + 1) continue;
    return url.slice(0, i) + url.slice(labelEnd);
  }
  return url;
}

function readPageR2hToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const fromQuery = new URL(window.location.href).searchParams.get("r2h-token");
    if (fromQuery) return fromQuery;
  } catch {
    // Ignore malformed locations and fall through to the cookie.
  }
  const match = document.cookie.match(/(?:^|;\s*)r2h-token=([^;]*)/);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

function withPageAuthToken(url: string): string {
  const token = readPageR2hToken();
  if (!token) return url;
  try {
    const parsed = new URL(url);
    if (!parsed.searchParams.has("r2h-token")) {
      parsed.searchParams.set("r2h-token", token);
    }
    return parsed.href;
  } catch {
    return url;
  }
}

export function toAbsoluteMediaUrl(
  url: string,
  baseHref = typeof document === "undefined" ? undefined : document.baseURI,
): string {
  const stripped = stripPlaylistUrlLabel(url);
  let absolute = stripped;
  try {
    absolute = baseHref ? new URL(stripped, baseHref).href : stripped;
  } catch {
    absolute = stripped;
  }
  return withPageAuthToken(absolute);
}

export function pickChannelSource(channel: Channel, preferredIndex?: number): Source | undefined {
  const index = preferredIndex ?? getLastSourceIndex(channel.id);
  return channel.sources[index] ?? channel.sources[0];
}

export function pickCatchupSource(channel: Channel, preferredIndex?: number): Source | undefined {
  const preferred = pickChannelSource(channel, preferredIndex);
  if (preferred?.catchup && preferred.catchupSource) return preferred;
  return channel.sources.find((source) => Boolean(source.catchup && source.catchupSource));
}

export function getChannelLiveMediaUrl(channel: Channel, preferredIndex?: number): string | null {
  const source = pickChannelSource(channel, preferredIndex);
  if (!source?.url) return null;
  return toAbsoluteMediaUrl(source.url);
}

export function getProgramMediaUrl(
  channel: Channel,
  program: CatchupProgramBound,
  preferredIndex?: number,
  now = new Date(),
): string | null {
  const catchupSource = pickCatchupSource(channel, preferredIndex);
  if (catchupSource) {
    const start = program.start;
    const end = new Date(Math.max(program.end.getTime(), start.getTime() + CATCHUP_MIN_DURATION_MS));
    // Strip `$label` from the live URL before append-mode concatenation so the
    // playseek suffix is not glued onto `$HD`.
    const sourceForCopy: Source = {
      ...catchupSource,
      url: stripPlaylistUrlLabel(catchupSource.url),
    };
    return toAbsoluteMediaUrl(buildCatchupUrl(sourceForCopy, start, end, now));
  }
  if (program.start.getTime() <= now.getTime() && program.end.getTime() > now.getTime()) {
    return getChannelLiveMediaUrl(channel, preferredIndex);
  }
  return null;
}

export function isMiddleMouseButton(event: { button: number }): boolean {
  return event.button === 1;
}
