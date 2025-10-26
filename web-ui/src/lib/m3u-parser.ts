import mpegts from "mpegts.js";
import { M3UMetadata, Channel } from "../types/player";

/**
 * Normalize URL by replacing protocol, hostname and port with current window.location if it matches the server address
 * @param url - The URL to normalize
 * @param serverAddress - The server address (hostname or IP, without port)
 * @returns Normalized URL (with replaced protocol/hostname/port if matches server, otherwise unchanged)
 */
function normalizeUrl(url: string, serverAddress?: string): string {
  if (!serverAddress) {
    return url;
  }

  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname;
    const protocol = urlObj.protocol;

    // Only process http/https URLs
    if (protocol !== "http:" && protocol !== "https:") {
      return url;
    }

    // Check if hostname matches server address (ignore port)
    // Server address from X-Server-Address header does not include port
    if (hostname === serverAddress || hostname === window.location.hostname) {
      // Replace protocol, hostname and port with current window.location
      urlObj.protocol = window.location.protocol;
      urlObj.hostname = window.location.hostname;
      urlObj.port = window.location.port;
      return urlObj.toString();
    }
  } catch (e) {
    // If URL parsing fails, return as-is
    console.warn("Failed to parse URL:", url, e);
  }

  return url;
}

/**
 * Parse M3U playlist content
 * @param content - The M3U playlist content
 * @param serverAddress - Optional server address from X-Server-Address header
 */
export function parseM3U(content: string, serverAddress?: string): M3UMetadata {
  const lines = content.split("\n");
  const channels: Channel[] = [];
  const groups: string[] = [];
  const seenGroups = new Set<string>();
  let tvgUrl: string | undefined;
  let defaultCatchup: string | undefined;
  let defaultCatchupSource: string | undefined;

  let currentChannel: Omit<Channel, "url"> | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Skip empty lines
    if (!line) continue;

    // Parse #EXTM3U header
    if (line.startsWith("#EXTM3U")) {
      const tvgUrlMatch = line.match(/x-tvg-url="([^"]+)"/);
      if (tvgUrlMatch) {
        tvgUrl = normalizeUrl(tvgUrlMatch[1], serverAddress);
      }
      const catchupMatch = line.match(/catchup="([^"]+)"/);
      if (catchupMatch) {
        defaultCatchup = catchupMatch[1];
      }
      const catchupSourceMatch = line.match(/catchup-source="([^"]+)"/);
      if (catchupSourceMatch) {
        defaultCatchupSource = catchupSourceMatch[1];
      }
      continue;
    }

    // Parse #EXTINF line
    if (line.startsWith("#EXTINF:")) {
      // Extract attributes
      const tvgIdMatch = line.match(/tvg-id="([^"]+)"/);
      const tvgNameMatch = line.match(/tvg-name="([^"]+)"/);
      const tvgLogoMatch = line.match(/tvg-logo="([^"]+)"/);
      const groupTitleMatch = line.match(/group-title="([^"]+)"/);
      const catchupMatch = line.match(/catchup="([^"]+)"/);
      const catchupSourceMatch = line.match(/catchup-source="([^"]+)"/);

      // Extract channel name (after last comma)
      const nameMatch = line.match(/,(.+)$/);
      const name = nameMatch ? nameMatch[1].trim() : "Unknown";

      const group = groupTitleMatch?.[1] || "";

      // Collect group in order if not seen before
      if (group && !seenGroups.has(group)) {
        groups.push(group);
        seenGroups.add(group);
      }

      // Normalize catchup source URL if present
      const rawCatchupSource = catchupSourceMatch?.[1] || defaultCatchupSource;
      const normalizedCatchupSource = rawCatchupSource ? normalizeUrl(rawCatchupSource, serverAddress) : undefined;

      currentChannel = {
        id: `${channels.length + 1}`,
        name,
        logo: tvgLogoMatch?.[1],
        group,
        tvgId: tvgIdMatch?.[1],
        tvgName: tvgNameMatch?.[1],
        catchup: catchupMatch?.[1] || defaultCatchup,
        catchupSource: normalizedCatchupSource,
      };
      continue;
    }

    // Parse URL line
    if (
      currentChannel &&
      (line.startsWith("http://") ||
        line.startsWith("https://") ||
        line.startsWith("rtp://") ||
        line.startsWith("rtsp://") ||
        line.startsWith("udp://"))
    ) {
      // Normalize URL: replace hostname/port with current window.location if it matches server address
      const normalizedUrl = normalizeUrl(line, serverAddress);

      channels.push({
        ...currentChannel,
        url: normalizedUrl,
      });
      currentChannel = null;
    }
  }

  return {
    tvgUrl,
    channels,
    groups,
  };
}

/**
 * Build catchup segments with playseek parameter
 * @param channel - The channel object containing catchup configuration
 * @param startTime - Start time for playback
 * @returns Array of media segments for catchup playback
 */
export function buildCatchupSegments(channel: Channel, startTime: Date): mpegts.MediaSegment[] {
  if (!channel.catchupSource) {
    throw new Error("Channel does not have catchup source configured");
  }

  const catchupMode = channel.catchup || "default";
  const now = new Date();
  const endingFuture = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const segments: mpegts.MediaSegment[] = [];

  // Segment duration: (now - startTime) in both seconds and milliseconds
  const segmentDurationMs = now.getTime() - startTime.getTime();
  const segmentDurationSec = segmentDurationMs / 1000;

  /**
   * Parse long date format like yyyyMMddHHmmss
   * Used for ${(b)yyyyMMddHHmmss} and ${(e)yyyyMMddHHmmss} formats
   */
  const parseLongDate = (date: Date, format: string, useUTC: boolean = false): string => {
    const year = (useUTC ? date.getUTCFullYear() : date.getFullYear()).toString();
    const month = (useUTC ? date.getUTCMonth() + 1 : date.getMonth() + 1).toString().padStart(2, "0");
    const day = (useUTC ? date.getUTCDate() : date.getDate()).toString().padStart(2, "0");
    const hours = (useUTC ? date.getUTCHours() : date.getHours()).toString().padStart(2, "0");
    const minutes = (useUTC ? date.getUTCMinutes() : date.getMinutes()).toString().padStart(2, "0");
    const seconds = (useUTC ? date.getUTCSeconds() : date.getSeconds()).toString().padStart(2, "0");

    return format
      .replace(/yyyy/g, year)
      .replace(/MM/g, month)
      .replace(/dd/g, day)
      .replace(/HH/g, hours)
      .replace(/mm/g, minutes)
      .replace(/ss/g, seconds);
  };

  /**
   * Parse short date format like YmdHMS
   * Used for {utc:YmdHMS} and {utcend:YmdHMS} formats
   * Converts Y/m/d/H/M/S to yyyy/MM/dd/HH/mm/ss and then calls parseLongDateFormat
   */
  const parseShortDate = (date: Date, format: string, useUTC: boolean = false): string => {
    // Use __month__ to avoid conflicts during replacement
    const convertedFormat = format
      .replace(/Y/g, "yyyy")
      .replace(/m/g, "__month__")
      .replace(/d/g, "dd")
      .replace(/H/g, "HH")
      .replace(/M/g, "mm")
      .replace(/S/g, "ss")
      .replace(/__month__/g, "MM");
    return parseLongDate(date, convertedFormat, useUTC);
  };

  /**
   * Build a single catchup URL for a time range
   */
  const buildCatchupUrl = (segmentStartTime: Date, segmentEndTime: Date): string => {
    // Replace placeholders in catchup source
    let processedSource = channel.catchupSource!;

    // Handle ${(b)yyyyMMddHHmmss} and ${(e)yyyyMMddHHmmss} - local time with custom format
    processedSource = processedSource.replace(/\$\{(\([be]\))([^}]+)\}/g, (_match, timeType, format) => {
      const date = timeType === "(b)" ? segmentStartTime : segmentEndTime;
      if (!date) return "";
      if (format === "timestamp") {
        return Math.floor(date.getTime() / 1000).toString();
      }
      return parseLongDate(date, format, false);
    });

    // Handle {utc:...} - UTC time with custom format (Y=yyyy, m=MM, d=dd, H=HH, M=mm, s=ss)
    processedSource = processedSource.replace(/\{utc:([^}]+)\}/g, (_match, format) => {
      return parseShortDate(segmentStartTime, format, true);
    });

    // Handle {utcend:...} - UTC end time with custom format (Y=yyyy, m=MM, d=dd, H=HH, M=mm, s=ss)
    processedSource = processedSource.replace(/\{utcend:([^}]+)\}/g, (_match, format) => {
      return parseShortDate(segmentEndTime, format, true);
    });

    // Handle {utc} - ISO8601 format UTC
    processedSource = processedSource.replace(/\{utc\}/g, segmentStartTime.toISOString());

    // Handle {utcend} - ISO8601 format UTC
    processedSource = processedSource.replace(/\{utcend\}/g, segmentEndTime.toISOString());

    // Build final URL based on catchup mode
    if (catchupMode === "append") {
      // Append mode: append catchup source to original channel URL
      return channel.url + processedSource;
    } else {
      // Default mode: use catchup source as complete URL
      return processedSource;
    }
  };

  // Build segments from startTime to now (catchup/replay segments)
  let currentTime = new Date(startTime.getTime());
  const splitPoint = new Date(now.getTime() - 10000);

  while (currentTime < splitPoint) {
    const segmentEndTime = new Date(Math.min(currentTime.getTime() + segmentDurationMs, splitPoint.getTime()));

    segments.push({
      duration: segmentDurationSec,
      url: buildCatchupUrl(currentTime, segmentEndTime),
    });

    currentTime = segmentEndTime;
  }

  // Build segments from splitPoint to future (half-duration live segments)
  currentTime = new Date(splitPoint.getTime());

  while (currentTime < endingFuture) {
    const segmentEndTime = new Date(Math.min(currentTime.getTime() + segmentDurationMs / 2, endingFuture.getTime()));

    segments.push({
      duration: segmentDurationSec / 2,
      url: buildCatchupUrl(currentTime, segmentEndTime),
    });

    currentTime = segmentEndTime;
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
