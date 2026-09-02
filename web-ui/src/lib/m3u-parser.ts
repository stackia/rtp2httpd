import type { PlayerSegment } from "../playback-engine";
import type { Channel, M3UMetadata, Source } from "../types/player";
import { buildCatchupUrl } from "./catchup-url";
import { type CatchupProgramBound, clampCatchupStartTime, planCatchupSegmentWindows } from "./catchup-windows";
import { toPlaylistRelativePath } from "./url";

export { buildCatchupUrl } from "./catchup-url";
export { CATCHUP_MIN_DURATION_MS, clampCatchupStartTime } from "./catchup-windows";

/**
 * Parse M3U playlist content
 * @param content - The M3U playlist content
 */
export function parseM3U(content: string): M3UMetadata {
  const lines = content.split("\n");
  const channels: Channel[] = [];
  const playlistGroups: string[] = [];
  const seenGroups = new Set<string>();
  let tvgUrl: string | undefined;
  let defaultCatchup: string | undefined;
  let defaultCatchupSource: string | undefined;

  let currentExtinf: {
    name: string;
    logo?: string;
    groups: string[];
    tvgId?: string;
    tvgName?: string;
    catchup?: string;
    catchupSource?: string;
  } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Skip empty lines
    if (!line) continue;

    // Parse #EXTM3U header
    if (line.startsWith("#EXTM3U")) {
      const tvgUrlMatch = line.match(/x-tvg-url="([^"]+)"/);
      if (tvgUrlMatch) {
        tvgUrl = toPlaylistRelativePath(tvgUrlMatch[1]);
      }
      const catchupMatch = line.match(/catchup="([^"]+)"/);
      if (catchupMatch) {
        defaultCatchup = catchupMatch[1];
      }
      const catchupSourceMatch = line.match(/catchup-source="([^"]+)"/);
      if (catchupSourceMatch) {
        defaultCatchupSource = toPlaylistRelativePath(catchupSourceMatch[1]);
      }
      continue;
    }

    // Parse #EXTINF line
    if (line.startsWith("#EXTINF:")) {
      // Extract attributes
      const tvgIdMatch = line.match(/tvg-id="([^"]+)"/);
      const tvgNameMatch = line.match(/tvg-name="([^"]+)"/);
      const tvgLogoMatch = line.match(/tvg-logo="([^"]+)"/);
      const catchupMatch = line.match(/catchup="([^"]+)"/);
      const catchupSourceMatch = line.match(/catchup-source="([^"]+)"/);

      // Extract channel name (after last comma)
      const nameMatch = line.match(/,(.+)$/);
      const name = nameMatch ? nameMatch[1].trim() : "Unknown";

      const groups = parseGroupTitles(line);

      // Collect group in order if not seen before
      for (const group of groups) {
        if (!seenGroups.has(group)) {
          playlistGroups.push(group);
          seenGroups.add(group);
        }
      }

      currentExtinf = {
        name,
        logo: tvgLogoMatch?.[1],
        groups,
        tvgId: tvgIdMatch?.[1],
        tvgName: tvgNameMatch?.[1],
        catchup: catchupMatch?.[1] || defaultCatchup,
        catchupSource: resolveCatchupSource(catchupSourceMatch?.[1] || defaultCatchupSource),
      };
      continue;
    }

    // Parse URL line
    if (currentExtinf && isPlaylistUrl(line)) {
      // Extract optional $<label> suffix from URL (e.g., "http://...url$UHD" → label "UHD")
      const labelMatch = line.match(/\$([^$]+)$/);
      const sourceLabel = labelMatch ? labelMatch[1] : undefined;
      const urlWithoutLabel = labelMatch ? line.slice(0, line.lastIndexOf("$")) : line;
      const resolvedUrl =
        toPlaylistRelativePath(urlWithoutLabel) + (labelMatch ? line.slice(line.lastIndexOf("$")) : "");

      channels.push({
        id: `${channels.length + 1}`,
        name: currentExtinf.name,
        logo: currentExtinf.logo,
        groups: currentExtinf.groups,
        tvgId: currentExtinf.tvgId,
        tvgName: currentExtinf.tvgName,
        sources: [
          {
            url: resolvedUrl,
            catchup: currentExtinf.catchup,
            catchupSource: currentExtinf.catchupSource,
            label: sourceLabel,
          },
        ],
      });
      currentExtinf = null;
    }
  }

  return {
    tvgUrl,
    channels: mergeChannelSources(channels),
    groups: playlistGroups,
  };
}

function isPlaylistUrl(line: string): boolean {
  return line.startsWith("/") || line.startsWith("http://") || line.startsWith("https://");
}

function resolveCatchupSource(value: string | undefined): string | undefined {
  if (!value) {
    return value;
  }
  return toPlaylistRelativePath(value);
}

function parseGroupTitles(line: string): string[] {
  const seenGroups = new Set<string>();
  const groups: string[] = [];

  for (const match of line.matchAll(/group-title="([^"]+)"/g)) {
    const groupTitles = match[1].split(";");
    for (const groupTitle of groupTitles) {
      const group = groupTitle.trim();
      if (group && !seenGroups.has(group)) {
        groups.push(group);
        seenGroups.add(group);
      }
    }
  }

  return groups;
}

/**
 * Merge channels with the same name and groups into a single channel with multiple sources.
 * Channels are considered duplicates if they share the same group list + name combination.
 */
function mergeChannelSources(channels: Channel[]): Channel[] {
  const mergeMap = new Map<string, Channel>();

  for (const ch of channels) {
    const key = `${ch.groups.join("\0")}\0${ch.name}`;
    const existing = mergeMap.get(key);

    if (existing) {
      existing.sources.push(...ch.sources);
      if (!existing.logo && ch.logo) {
        existing.logo = ch.logo;
      }
    } else {
      mergeMap.set(key, { ...ch, groups: [...ch.groups] });
    }
  }

  const merged = Array.from(mergeMap.values());
  merged.forEach((ch, i) => {
    ch.id = `${i + 1}`;
  });

  return merged;
}

const CATCHUP_SEGMENT_OVERLAP_MS = 1_000;

export interface CatchupSegmentOptions {
  overlapMs?: number;
  /** EPG programmes for the channel; windows split on their start/end times when present. */
  programs?: readonly CatchupProgramBound[];
  /** Override wall clock (tests). */
  now?: Date;
}

/**
 * Build catchup segments with playseek parameter
 * @param source - The source containing url, catchup mode, and catchupSource
 * @param startTime - Start time for playback
 * @returns Array of media segments for catchup playback
 */
export function buildCatchupSegments(
  source: Source,
  startTimeArg: Date,
  options: CatchupSegmentOptions = {},
): PlayerSegment[] {
  if (!source.catchupSource) {
    throw new Error("Source does not have catchup source configured");
  }

  const now = options.now ?? new Date();
  const startTime = clampCatchupStartTime(startTimeArg, now);
  const segments: PlayerSegment[] = [];
  const overlapMs = Math.max(0, options.overlapMs ?? CATCHUP_SEGMENT_OVERLAP_MS);

  const buildOverlappedSegmentUrl = (segmentStartTime: Date, segmentEndTime: Date): string => {
    const requestStartTime =
      segments.length === 0
        ? segmentStartTime
        : new Date(Math.max(startTime.getTime(), segmentStartTime.getTime() - overlapMs));
    return buildCatchupUrl(source, requestStartTime, segmentEndTime, now);
  };

  for (const timeWindow of planCatchupSegmentWindows(startTimeArg, now, options.programs)) {
    segments.push({
      duration: (timeWindow.end.getTime() - timeWindow.start.getTime()) / 1000,
      url: buildOverlappedSegmentUrl(timeWindow.start, timeWindow.end),
    });
  }

  return segments;
}

/**
 * Calculate playseek time offset from current time
 * Used for live stream rewinding
 */
export function calculatePlayseekOffset(secondsFromNow: number): Date {
  const now = new Date();
  return new Date(now.getTime() - secondsFromNow * 1000);
}
