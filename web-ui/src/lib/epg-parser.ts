import { XMLParser } from "fast-xml-parser";
import type { EPGProgram } from "../types/player";

/**
 * EPG data organized by channel ID or display name for fast lookup
 */
export type EPGData = Record<string, EPGProgram[]>;

const EPG_ARRAY_TAGS = new Set(["channel", "programme", "display-name", "title"]);
const EPG_KEEP_TAGS = new Set(["tv", "channel", "programme", "display-name", "title"]);

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  ignoreDeclaration: true,
  ignorePiTags: true,
  isArray: (tagName) => EPG_ARRAY_TAGS.has(tagName),
  updateTag: (tagName) => (EPG_KEEP_TAGS.has(tagName) ? tagName : false),
});

type XmlTextNode = string | { "#text"?: string };

type XmlChannel = {
  "@_id"?: string;
  "display-name"?: XmlTextNode[];
};

type XmlProgramme = {
  "@_channel"?: string;
  "@_start"?: string;
  "@_stop"?: string;
  title?: XmlTextNode[];
};

type XmlTv = {
  channel?: XmlChannel[];
  programme?: XmlProgramme[];
};

function xmlTextContent(node: XmlTextNode | undefined): string | undefined {
  if (node === undefined) {
    return undefined;
  }
  if (typeof node === "string") {
    return node || undefined;
  }
  const text = node["#text"];
  return typeof text === "string" && text ? text : undefined;
}

/**
 * Parse EPG XML data and organize by channel ID and display names.
 * Supports XMLTV format. Safe to call from a Web Worker — no DOM APIs.
 * @param xmlText - XMLTV format XML string
 * @param validChannelIds - Optional set of valid channel IDs from M3U to filter programs
 */
export function parseEPG(xmlText: string, validChannelIds?: Set<string>): EPGData {
  const parsed = xmlParser.parse(xmlText) as { tv?: XmlTv };
  const tv = parsed.tv;
  if (!tv) {
    return {};
  }

  const epgData: EPGData = {};
  const channelLookupKeys = extractChannelLookupKeys(tv.channel ?? []);
  const programElements = tv.programme ?? [];

  const getOrCreateProgramBucket = (lookupKeys: string[]): EPGProgram[] => {
    for (const key of lookupKeys) {
      const existingPrograms = epgData[key];
      if (existingPrograms) {
        for (const alias of lookupKeys) {
          epgData[alias] = existingPrograms;
        }
        return existingPrograms;
      }
    }

    const programs: EPGProgram[] = [];
    for (const key of lookupKeys) {
      epgData[key] = programs;
    }
    return programs;
  };

  for (const prog of programElements) {
    const channelId = prog["@_channel"] || "";
    if (!channelId) {
      continue;
    }
    const lookupKeys = channelLookupKeys[channelId] || [channelId];

    // Skip if channel is not in valid list
    if (validChannelIds && !lookupKeys.some((key) => validChannelIds.has(key))) {
      continue;
    }

    const start = parseXMLTVTime(prog["@_start"] || "");
    const stop = parseXMLTVTime(prog["@_stop"] || "");

    if (!start || !stop) continue;

    const program: EPGProgram = {
      id: `${channelId}-${start.getTime()}`,
      title: xmlTextContent(prog.title?.[0]),
      start,
      end: stop,
    };

    getOrCreateProgramBucket(lookupKeys).push(program);
  }

  // Sort programs by start time for each channel
  for (const programs of new Set(Object.values(epgData))) {
    programs.sort((a, b) => a.start.getTime() - b.start.getTime());
  }

  return epgData;
}

function extractChannelLookupKeys(channelElements: XmlChannel[]): Record<string, string[]> {
  const map: Record<string, string[]> = {};

  for (const channel of channelElements) {
    const id = channel["@_id"];
    if (!id) {
      continue;
    }

    const keys = [id];
    const seen = new Set(keys);
    for (const displayNameNode of channel["display-name"] ?? []) {
      const displayName = xmlTextContent(displayNameNode)?.trim();
      if (displayName && !seen.has(displayName)) {
        keys.push(displayName);
        seen.add(displayName);
      }
    }
    map[id] = keys;
  }

  return map;
}

/**
 * Parse XMLTV time format (YYYYMMDDHHmmss +ZZZZ)
 */
function parseXMLTVTime(timeStr: string): Date | null {
  if (!timeStr) return null;

  // Format: YYYYMMDDHHmmss +ZZZZ or YYYYMMDDHHmmss
  const match = timeStr.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*([+-]\d{4})?$/);
  if (!match) return null;

  const [, year, month, day, hour, minute, second, timezone] = match;

  // Create date in UTC
  const date = new Date(
    Date.UTC(
      parseInt(year, 10),
      parseInt(month, 10) - 1,
      parseInt(day, 10),
      parseInt(hour, 10),
      parseInt(minute, 10),
      parseInt(second, 10),
    ),
  );

  // Apply timezone offset if present
  if (timezone) {
    const tzHours = parseInt(timezone.slice(0, 3), 10);
    const tzMinutes = parseInt(timezone.slice(0, 1) + timezone.slice(3, 5), 10);
    date.setMinutes(date.getMinutes() - tzHours * 60 - tzMinutes);
  }

  return date;
}

/**
 * Get EPG channel ID with fallback logic
 * Tries to match in order: tvgId -> tvgName -> name
 * @param channel - Channel object with tvgId, tvgName, and name fields
 * @param epgData - EPG data to check against
 * @returns The matching channel ID from EPG data, or null if no match found
 */
export function getEPGChannelId(
  channel: { tvgId?: string; tvgName?: string; name: string },
  epgData: EPGData,
): string | null {
  // Try tvgId first
  if (channel.tvgId && epgData[channel.tvgId]) {
    return channel.tvgId;
  }

  // Try tvgName second
  if (channel.tvgName && epgData[channel.tvgName]) {
    return channel.tvgName;
  }

  // Try name last
  if (channel.name && epgData[channel.name]) {
    return channel.name;
  }

  return null;
}

/**
 * Get current program for a channel
 * Uses findLast for efficient reverse search (programs are sorted by start time)
 */
export function getCurrentProgram(channelId: string, epgData: EPGData, time: Date = new Date()): EPGProgram | null {
  const programs = epgData[channelId];
  if (!programs || programs.length === 0) {
    return null;
  }

  // Use findLast to search backwards - more likely to hit recent/current programs
  return programs.findLast((p) => p.start <= time && p.end > time) || null;
}

/**
 * Get programs for a channel within a time range
 */
export function getChannelPrograms(channelId: string, epgData: EPGData, startTime: Date, endTime: Date): EPGProgram[] {
  const programs = epgData[channelId];
  if (!programs || programs.length === 0) {
    return [];
  }

  // Programs are already sorted by start time, just filter
  return programs.filter(
    (p) =>
      (p.start >= startTime && p.start < endTime) ||
      (p.end > startTime && p.end <= endTime) ||
      (p.start <= startTime && p.end >= endTime),
  );
}

/**
 * Get all programs for a specific channel
 */
export function getAllChannelPrograms(channelId: string, epgData: EPGData): EPGProgram[] {
  return epgData[channelId] || [];
}

/**
 * Get all programs for today
 */
export function getTodayPrograms(channelId: string, epgData: EPGData): EPGProgram[] {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);

  return getChannelPrograms(channelId, epgData, startOfDay, endOfDay);
}

/**
 * Generate fallback programs for time gaps
 * Creates 2-hour blocks titled "精彩节目" for periods without real EPG data
 * @param existingPrograms - Existing programs for the channel (must be sorted by start time)
 * @param channelId - Channel ID for generating program IDs
 * @param lookbackHours - How many hours back from now to generate fallback programs (default: 48)
 * @returns Array of fallback programs that don't overlap with existing programs
 */
export function generateFallbackPrograms(
  existingPrograms: EPGProgram[],
  channelId: string,
  lookbackHours: number,
): EPGProgram[] {
  const now = new Date();
  const startTime = new Date(now.getTime() - lookbackHours * 60 * 60 * 1000);
  const fallbackPrograms: EPGProgram[] = [];

  // Generate 2-hour blocks for the entire time range
  const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
  let currentStart = new Date(startTime);

  // Round down to nearest 2-hour boundary for cleaner segments
  const hoursSinceEpoch = Math.floor(currentStart.getTime() / (60 * 60 * 1000));
  const roundedHours = Math.floor(hoursSinceEpoch / 2) * 2;
  currentStart = new Date(roundedHours * 60 * 60 * 1000);

  while (currentStart < now) {
    const currentEnd = new Date(currentStart.getTime() + TWO_HOURS_MS);

    // Check if this time slot overlaps with any existing program
    const hasOverlap = existingPrograms.some(
      (p) =>
        (p.start <= currentStart && p.end > currentStart) ||
        (p.start < currentEnd && p.end >= currentEnd) ||
        (p.start >= currentStart && p.end <= currentEnd),
    );

    if (!hasOverlap) {
      fallbackPrograms.push({
        id: `fallback-${channelId}-${currentStart.getTime()}`,
        start: currentStart,
        end: currentEnd,
      });
    }

    currentStart = currentEnd;
  }

  return fallbackPrograms;
}

/**
 * Fill gaps in EPG data with fallback programs
 * Only processes channels that have catchup support
 * @param epgData - Existing EPG data
 * @param channels - List of channels from M3U playlist
 * @param lookbackHours - How many hours back from now to generate fallback programs (default: 48)
 * @returns EPG data with gaps filled
 */
export function fillEPGGaps(
  epgData: EPGData,
  channels: {
    tvgId?: string;
    tvgName?: string;
    name: string;
    sources?: { catchup?: string; catchupSource?: string }[];
  }[],
  lookbackHours: number = 72,
): EPGData {
  const filledData = { ...epgData };

  for (const channel of channels) {
    // Only process channels with catchup support
    if (!channel.sources?.some((s) => s.catchup && s.catchupSource)) {
      continue;
    }

    // Get the EPG channel ID using fallback logic
    const epgChannelId =
      channel.tvgId && filledData[channel.tvgId]
        ? channel.tvgId
        : channel.tvgName && filledData[channel.tvgName]
          ? channel.tvgName
          : channel.name && filledData[channel.name]
            ? channel.name
            : null;

    let existingPrograms: EPGProgram[] = [];
    const targetChannelId = epgChannelId || channel.tvgId || channel.tvgName || channel.name;

    if (epgChannelId) {
      existingPrograms = filledData[epgChannelId] || [];
    }

    // Generate fallback programs for gaps
    const fallbackPrograms = generateFallbackPrograms(existingPrograms, targetChannelId, lookbackHours);

    if (fallbackPrograms.length > 0) {
      // Merge existing and fallback programs, then sort by start time
      const mergedPrograms = [...existingPrograms, ...fallbackPrograms].sort(
        (a, b) => a.start.getTime() - b.start.getTime(),
      );

      // Ensure all possible channel ID keys point to the same array
      filledData[targetChannelId] = mergedPrograms;
      if (channel.tvgId && channel.tvgId !== targetChannelId) {
        filledData[channel.tvgId] = mergedPrograms;
      }
      if (channel.tvgName && channel.tvgName !== targetChannelId) {
        filledData[channel.tvgName] = mergedPrograms;
      }
      if (channel.name !== targetChannelId) {
        filledData[channel.name] = mergedPrograms;
      }
    }
  }

  return filledData;
}
