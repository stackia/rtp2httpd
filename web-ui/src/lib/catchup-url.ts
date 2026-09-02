import type { Source } from "../types/player";

/**
 * Parse long date format like yyyyMMddHHmmss.
 * Used for ${utc:yyyyMMddHHmmss}, ${(b)yyyyMMddHHmmss}, and similar $ placeholders.
 */
function parseLongDate(date: Date, format: string, useUTC = false): string {
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
}

/**
 * Parse short date format like YmdHMS.
 * Used for {utc:YmdHMS} and similar placeholders without `$`.
 */
function parseShortDate(date: Date, format: string, useUTC = false): string {
  const convertedFormat = format
    .replace(/Y/g, "yyyy")
    .replace(/m/g, "__month__")
    .replace(/d/g, "dd")
    .replace(/H/g, "HH")
    .replace(/M/g, "mm")
    .replace(/S/g, "ss")
    .replace(/__month__/g, "MM");
  return parseLongDate(date, convertedFormat, useUTC);
}

/**
 * Build a single catchup URL for a time range.
 *
 * Supported formats:
 *
 * Format with ${} (uses long format for custom formatters):
 *   ${utc} - Start time in ISO8601 format
 *   ${utc:yyyyMMddHHmmss} - Start time in UTC with long format
 *   ${utcend} - End time in ISO8601 format
 *   ${utcend:yyyyMMddHHmmss} - End time in UTC with long format
 *   ${start} - Same as ${utc}
 *   ${start:yyyyMMddHHmmss} - Same as ${utc:yyyyMMddHHmmss}
 *   ${end} - Same as ${utcend}
 *   ${end:yyyyMMddHHmmss} - Same as ${utcend:yyyyMMddHHmmss}
 *   ${lutc} - Current time in UTC ISO8601 format
 *   ${lutc:yyyyMMddHHmmss} - Current time in UTC with long format
 *   ${now} - Same as ${lutc}
 *   ${now:yyyyMMddHHmmss} - Same as ${lutc:yyyyMMddHHmmss}
 *   ${timestamp} - Current unix timestamp (seconds)
 *   ${timestamp:yyyyMMddHHmmss} - Same as ${lutc:yyyyMMddHHmmss}
 *   ${(b)yyyyMMddHHmmss} - Start time in local time with long format
 *   ${(e)yyyyMMddHHmmss} - End time in local time with long format
 *   ${(b)yyyyMMdd|UTC} - Start time in UTC with long format (|UTC suffix)
 *   ${(e)yyyyMMdd|UTC} - End time in UTC with long format (|UTC suffix)
 *   ${(b)timestamp} - Start time unix timestamp (seconds)
 *   ${(e)timestamp} - End time unix timestamp (seconds)
 *   ${yyyy} - 4-digit year (YYYY) of start time in local time
 *   ${MM} - Month (01-12) of start time in local time
 *   ${dd} - Day (01-31) of start time in local time
 *   ${HH} - Hour (00-23) of start time in local time
 *   ${mm} - Minute (00-59) of start time in local time
 *   ${ss} - Second (00-59) of start time in local time
 *
 * Format with {} (uses short format for custom formatters):
 *   {utc} - Start time in ISO8601 format (same as ${utc})
 *   {utc:YmdHMS} - Start time in UTC with short format
 *   {utcend} - End time in ISO8601 format (same as ${utcend})
 *   {utcend:YmdHMS} - End time in UTC with short format
 *   {start} - Same as {utc}
 *   {start:YmdHMS} - Same as {utc:YmdHMS}
 *   {end} - Same as {utcend}
 *   {end:YmdHMS} - Same as {utcend:YmdHMS}
 *   {lutc} - Current time in UTC ISO8601 format (same as ${lutc})
 *   {lutc:YmdHMS} - Current time in UTC with short format
 *   {now} - Same as {lutc}
 *   {now:YmdHMS} - Same as {lutc:YmdHMS}
 *   {timestamp} - Current unix timestamp (seconds) (same as ${timestamp})
 *   {timestamp:YmdHMS} - Same as {lutc:YmdHMS}
 *   {(b)YmdHMS} - Start time in local time with short format
 *   {(e)YmdHMS} - End time in local time with short format
 *   {(b)YmdHMS|UTC} - Start time in UTC with short format (|UTC suffix)
 *   {(e)YmdHMS|UTC} - End time in UTC with short format (|UTC suffix)
 *   {(b)timestamp} - Start time unix timestamp (seconds)
 *   {(e)timestamp} - End time unix timestamp (seconds)
 *   {Y} - 4-digit year (YYYY) of start time in local time
 *   {m} - Month (01-12) of start time in local time
 *   {d} - Day (01-31) of start time in local time
 *   {H} - Hour (00-23) of start time in local time
 *   {M} - Minute (00-59) of start time in local time
 *   {S} - Second (00-59) of start time in local time
 *
 * Special:
 *   {duration} or ${duration} - Duration in seconds (segmentEndTime - segmentStartTime)
 */
export function buildCatchupUrl(
  source: Source,
  segmentStartTime: Date,
  segmentEndTime: Date,
  now = new Date(),
): string {
  if (!source.catchupSource) {
    throw new Error("Source does not have catchup source configured");
  }

  const catchupMode = source.catchup || "default";
  let processedSource = source.catchupSource;

  const durationSeconds = Math.floor((segmentEndTime.getTime() - segmentStartTime.getTime()) / 1000);
  const currentTimestamp = Math.floor(now.getTime() / 1000);

  // Handle ${(b)format} and ${(e)format} - local time with long format
  // Supports |UTC suffix to force UTC output, e.g. ${(b)yyyyMMdd|UTC}
  processedSource = processedSource.replace(/\$\{(\([be]\))([^}]+)\}/g, (_match, timeType, format) => {
    const date = timeType === "(b)" ? segmentStartTime : segmentEndTime;
    const useUTC = format.endsWith("|UTC");
    const cleanFormat = useUTC ? format.slice(0, -4) : format;
    if (cleanFormat === "timestamp") {
      return Math.floor(date.getTime() / 1000).toString();
    }
    return parseLongDate(date, cleanFormat, useUTC);
  });

  // Handle ${(b)} and ${(e)} - local time ISO8601
  processedSource = processedSource.replace(/\$\{(\([be]\))\}/g, (_match, timeType) => {
    const date = timeType === "(b)" ? segmentStartTime : segmentEndTime;
    return date.toISOString();
  });

  // Handle {(b)format} and {(e)format} - local time with short format
  // Supports |UTC suffix to force UTC output, e.g. {(b)YmdHMS|UTC}
  processedSource = processedSource.replace(/\{(\([be]\))([^}]+)\}/g, (_match, timeType, format) => {
    const date = timeType === "(b)" ? segmentStartTime : segmentEndTime;
    const useUTC = format.endsWith("|UTC");
    const cleanFormat = useUTC ? format.slice(0, -4) : format;
    if (cleanFormat === "timestamp") {
      return Math.floor(date.getTime() / 1000).toString();
    }
    return parseShortDate(date, cleanFormat, useUTC);
  });

  // Handle {(b)} and {(e)} - local time ISO8601
  processedSource = processedSource.replace(/\{(\([be]\))\}/g, (_match, timeType) => {
    const date = timeType === "(b)" ? segmentStartTime : segmentEndTime;
    return date.toISOString();
  });

  // Handle ${keyword:format} - long format ($ variant)
  processedSource = processedSource.replace(
    /\$\{(utc|utcend|start|end|lutc|now|timestamp):([^}]+)\}/g,
    (_match, keyword, format) => {
      let date: Date;
      switch (keyword) {
        case "utc":
        case "start":
          date = segmentStartTime;
          break;
        case "utcend":
        case "end":
          date = segmentEndTime;
          break;
        case "lutc":
        case "now":
        case "timestamp":
          date = now;
          break;
        default:
          return "";
      }
      return parseLongDate(date, format, true);
    },
  );

  // Handle ${keyword} - ISO8601 or timestamp ($ variant)
  processedSource = processedSource.replace(/\$\{(utc|utcend|start|end|lutc|now|timestamp)\}/g, (_match, keyword) => {
    switch (keyword) {
      case "utc":
      case "start":
        return segmentStartTime.toISOString();
      case "utcend":
      case "end":
        return segmentEndTime.toISOString();
      case "lutc":
      case "now":
        return now.toISOString();
      case "timestamp":
        return currentTimestamp.toString();
      default:
        return "";
    }
  });

  // Handle {keyword:format} - short format (no $ variant)
  processedSource = processedSource.replace(
    /\{(utc|utcend|start|end|lutc|now|timestamp):([^}]+)\}/g,
    (_match, keyword, format) => {
      let date: Date;
      switch (keyword) {
        case "utc":
        case "start":
          date = segmentStartTime;
          break;
        case "utcend":
        case "end":
          date = segmentEndTime;
          break;
        case "lutc":
        case "now":
        case "timestamp":
          date = now;
          break;
        default:
          return "";
      }
      return parseShortDate(date, format, true);
    },
  );

  // Handle {keyword} - ISO8601 or timestamp (no $ variant)
  processedSource = processedSource.replace(/\{(utc|utcend|start|end|lutc|now|timestamp)\}/g, (_match, keyword) => {
    switch (keyword) {
      case "utc":
      case "start":
        return segmentStartTime.toISOString();
      case "utcend":
      case "end":
        return segmentEndTime.toISOString();
      case "lutc":
      case "now":
        return now.toISOString();
      case "timestamp":
        return currentTimestamp.toString();
      default:
        return "";
    }
  });

  // Handle individual component placeholders ${yyyy}, ${MM}, ${dd}, ${HH}, ${mm}, ${ss}
  processedSource = processedSource.replace(/\$\{yyyy\}/g, segmentStartTime.getUTCFullYear().toString());
  processedSource = processedSource.replace(
    /\$\{MM\}/g,
    (segmentStartTime.getUTCMonth() + 1).toString().padStart(2, "0"),
  );
  processedSource = processedSource.replace(/\$\{dd\}/g, segmentStartTime.getUTCDate().toString().padStart(2, "0"));
  processedSource = processedSource.replace(/\$\{HH\}/g, segmentStartTime.getUTCHours().toString().padStart(2, "0"));
  processedSource = processedSource.replace(/\$\{mm\}/g, segmentStartTime.getUTCMinutes().toString().padStart(2, "0"));
  processedSource = processedSource.replace(/\$\{ss\}/g, segmentStartTime.getUTCSeconds().toString().padStart(2, "0"));

  // Handle individual component placeholders {Y}, {m}, {d}, {H}, {M}, {S}
  processedSource = processedSource.replace(/\{Y\}/g, segmentStartTime.getUTCFullYear().toString());
  processedSource = processedSource.replace(/\{m\}/g, (segmentStartTime.getUTCMonth() + 1).toString().padStart(2, "0"));
  processedSource = processedSource.replace(/\{d\}/g, segmentStartTime.getUTCDate().toString().padStart(2, "0"));
  processedSource = processedSource.replace(/\{H\}/g, segmentStartTime.getUTCHours().toString().padStart(2, "0"));
  processedSource = processedSource.replace(/\{M\}/g, segmentStartTime.getUTCMinutes().toString().padStart(2, "0"));
  processedSource = processedSource.replace(/\{S\}/g, segmentStartTime.getUTCSeconds().toString().padStart(2, "0"));

  // Handle {duration} and ${duration} - Duration in seconds
  processedSource = processedSource.replace(/\$?\{duration\}/g, durationSeconds.toString());

  if (catchupMode === "append") {
    return source.url + processedSource;
  }
  return processedSource;
}
