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

const FILENAME_FORBIDDEN_CHARS = new Set(["\\", "/", ":", "*", "?", '"', "<", ">", "|"]);
const MEDIA_DOWNLOAD_FILENAME_MAX = 180;

function replaceForbiddenFilenameChars(name: string): string {
  let result = "";
  for (const ch of name) {
    const code = ch.charCodeAt(0);
    result += code < 32 || code === 127 || FILENAME_FORBIDDEN_CHARS.has(ch) ? "_" : ch;
  }
  return result;
}

function pad2(value: number): string {
  return value.toString().padStart(2, "0");
}

/** Local `yyyyMMdd-HHmmss` for download names that match the on-screen EPG clock. */
export function formatMediaDownloadTimestamp(date: Date): string {
  return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}-${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`;
}

export function sanitizeMediaDownloadFilename(name: string): string {
  let sanitized = replaceForbiddenFilenameChars(name).replace(/\s+/g, " ").trim();
  sanitized = sanitized.replace(/_+/g, "_").replace(/[.\s_]+$/g, "");
  if (!sanitized) sanitized = "download";
  if (sanitized.length > MEDIA_DOWNLOAD_FILENAME_MAX - 3) {
    sanitized = sanitized.slice(0, MEDIA_DOWNLOAD_FILENAME_MAX - 3).replace(/[.\s_]+$/g, "") || "download";
  }
  if (!sanitized.toLowerCase().endsWith(".ts")) sanitized += ".ts";
  return sanitized;
}

export function buildMediaDownloadFilename(options: {
  channelName: string;
  sourceLabel?: string;
  programTitle?: string;
  start?: Date;
  end?: Date;
}): string {
  const parts = [options.channelName, options.sourceLabel, options.programTitle].filter((part): part is string =>
    Boolean(part?.trim()),
  );
  if (options.start && options.end) {
    parts.push(`${formatMediaDownloadTimestamp(options.start)}_${formatMediaDownloadTimestamp(options.end)}`);
  }
  return sanitizeMediaDownloadFilename(parts.join("_"));
}

function appendQueryParam(url: string, key: string, value: string): string {
  const hashIndex = url.indexOf("#");
  const hash = hashIndex === -1 ? "" : url.slice(hashIndex);
  const withoutHash = hashIndex === -1 ? url : url.slice(0, hashIndex);
  const encodedKey = `${encodeURIComponent(key)}=`;
  if (withoutHash.includes(`?${encodedKey}`) || withoutHash.includes(`&${encodedKey}`)) return url;
  const separator = withoutHash.includes("?") ? "&" : "?";
  return `${withoutHash}${separator}${encodedKey}${encodeURIComponent(value)}${hash}`;
}

function withDownloadFilename(url: string, filename: string): string {
  return appendQueryParam(url, "r2h-filename", filename);
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
  return withDownloadFilename(
    toAbsoluteMediaUrl(source.url),
    buildMediaDownloadFilename({ channelName: channel.name, sourceLabel: source.label }),
  );
}

export function getProgramMediaUrl(
  channel: Channel,
  program: CatchupProgramBound & { title?: string },
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
    return withDownloadFilename(
      toAbsoluteMediaUrl(buildCatchupUrl(sourceForCopy, start, end, now)),
      buildMediaDownloadFilename({
        channelName: channel.name,
        sourceLabel: catchupSource.label,
        programTitle: program.title,
        start,
        end,
      }),
    );
  }
  if (program.start.getTime() <= now.getTime() && program.end.getTime() > now.getTime()) {
    const source = pickChannelSource(channel, preferredIndex);
    if (!source?.url) return null;
    return withDownloadFilename(
      toAbsoluteMediaUrl(source.url),
      buildMediaDownloadFilename({
        channelName: channel.name,
        sourceLabel: source.label,
        programTitle: program.title,
        start: program.start,
        end: program.end,
      }),
    );
  }
  return null;
}

export function isMiddleMouseButton(event: { button: number }): boolean {
  return event.button === 1;
}
