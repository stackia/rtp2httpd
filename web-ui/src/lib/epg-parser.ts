import { EPGProgram } from "../types/player";

/**
 * EPG data organized by channel ID for fast lookup
 */
export type EPGData = Record<string, EPGProgram[]>;

/**
 * Parse EPG XML data and organize by channel ID
 * Supports XMLTV format
 * @param xmlText - XMLTV format XML string
 * @param validChannelIds - Optional set of valid channel IDs from M3U to filter programs
 */
export async function parseEPG(xmlText: string, validChannelIds?: Set<string>): Promise<EPGData> {
  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(xmlText, "text/xml");

  const epgData: EPGData = {};
  const programElements = xmlDoc.getElementsByTagName("programme");

  for (let i = 0; i < programElements.length; i++) {
    const prog = programElements[i];

    const channelId = prog.getAttribute("channel") || "";

    // Skip if channel is not in valid list
    if (validChannelIds && !validChannelIds.has(channelId)) {
      continue;
    }

    const start = parseXMLTVTime(prog.getAttribute("start") || "");
    const stop = parseXMLTVTime(prog.getAttribute("stop") || "");

    if (!start || !stop) continue;

    const titleElement = prog.getElementsByTagName("title")[0];
    const descElement = prog.getElementsByTagName("desc")[0];
    const iconElement = prog.getElementsByTagName("icon")[0];

    const title = titleElement?.textContent || "Unknown Program";
    const description = descElement?.textContent || undefined;
    const icon = iconElement?.getAttribute("src") || undefined;

    const program: EPGProgram = {
      id: `${channelId}-${start.getTime()}`,
      channelId,
      title,
      start,
      end: stop,
      description,
      icon,
    };

    // Initialize array for this channel if it doesn't exist
    if (!epgData[channelId]) {
      epgData[channelId] = [];
    }

    epgData[channelId].push(program);
  }

  // Assuming EPG programs are already sorted by start time in the source
  return epgData;
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
    Date.UTC(parseInt(year), parseInt(month) - 1, parseInt(day), parseInt(hour), parseInt(minute), parseInt(second)),
  );

  // Apply timezone offset if present
  if (timezone) {
    const tzHours = parseInt(timezone.slice(0, 3));
    const tzMinutes = parseInt(timezone.slice(0, 1) + timezone.slice(3, 5));
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
 * Load EPG from URL with gzip support
 * @param url - URL to fetch EPG from
 * @param validChannelIds - Optional set of valid channel IDs from M3U to filter programs
 */
export async function loadEPG(url: string, validChannelIds?: Set<string>): Promise<EPGData> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch EPG: ${response.statusText}`);
    }

    let xmlText: string;

    // Check if response is gzipped
    const contentType = response.headers.get("content-type") || "";
    const contentEncoding = response.headers.get("content-encoding") || "";

    if (url.endsWith(".gz") || contentEncoding.includes("gzip") || contentType.includes("gzip")) {
      // Handle gzipped content
      const blob = await response.blob();
      const ds = new DecompressionStream("gzip");
      const decompressedStream = blob.stream().pipeThrough(ds);
      const decompressedBlob = await new Response(decompressedStream).blob();
      xmlText = await decompressedBlob.text();
    } else {
      xmlText = await response.text();
    }

    return parseEPG(xmlText, validChannelIds);
  } catch (error) {
    console.error("Failed to load EPG:", error);
    return {};
  }
}
