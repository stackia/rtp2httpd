import type { PlayerSegment } from "@rtp2httpd/mpegts.js";
import type { Channel, M3UMetadata, Source } from "../types/player";

/**
 * Parse M3U playlist content
 * @param content - The M3U playlist content
 */
export function parseM3U(content: string): M3UMetadata {
	const lines = content.split("\n");
	const channels: Channel[] = [];
	const groups: string[] = [];
	const seenGroups = new Set<string>();
	let tvgUrl: string | undefined;
	let defaultCatchup: string | undefined;
	let defaultCatchupSource: string | undefined;

	let currentExtinf: {
		name: string;
		logo?: string;
		group: string;
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
				tvgUrl = tvgUrlMatch[1];
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

			currentExtinf = {
				name,
				logo: tvgLogoMatch?.[1],
				group,
				tvgId: tvgIdMatch?.[1],
				tvgName: tvgNameMatch?.[1],
				catchup: catchupMatch?.[1] || defaultCatchup,
				catchupSource: catchupSourceMatch?.[1] || defaultCatchupSource,
			};
			continue;
		}

		// Parse URL line
		if (
			currentExtinf &&
			(line.startsWith("http://") ||
				line.startsWith("https://") ||
				line.startsWith("rtp://") ||
				line.startsWith("rtsp://") ||
				line.startsWith("udp://"))
		) {
			// Extract optional $<label> suffix from URL (e.g., "http://...url$UHD" → label "UHD")
			const labelMatch = line.match(/\$([^$]+)$/);
			const sourceLabel = labelMatch ? labelMatch[1] : undefined;

			channels.push({
				id: `${channels.length + 1}`,
				name: currentExtinf.name,
				logo: currentExtinf.logo,
				group: currentExtinf.group,
				tvgId: currentExtinf.tvgId,
				tvgName: currentExtinf.tvgName,
				sources: [
					{ url: line, catchup: currentExtinf.catchup, catchupSource: currentExtinf.catchupSource, label: sourceLabel },
				],
			});
			currentExtinf = null;
		}
	}

	return {
		tvgUrl,
		channels: mergeChannelSources(channels),
		groups,
	};
}

/**
 * Merge channels with the same name and group into a single channel with multiple sources.
 * Channels are considered duplicates if they share the same group + name combination.
 */
function mergeChannelSources(channels: Channel[]): Channel[] {
	const mergeMap = new Map<string, Channel>();

	for (const ch of channels) {
		const key = `${ch.group}\0${ch.name}`;
		const existing = mergeMap.get(key);

		if (existing) {
			existing.sources.push(...ch.sources);
			if (!existing.logo && ch.logo) {
				existing.logo = ch.logo;
			}
		} else {
			mergeMap.set(key, { ...ch });
		}
	}

	const merged = Array.from(mergeMap.values());
	merged.forEach((ch, i) => {
		ch.id = `${i + 1}`;
	});

	return merged;
}

/**
 * Build catchup segments with playseek parameter
 * @param source - The source containing url, catchup mode, and catchupSource
 * @param startTime - Start time for playback
 * @param tailOffsetSeconds - Tail offset in seconds (0 means current time, positive values move the tail back)
 * @returns Array of media segments for catchup playback
 */
export function buildCatchupSegments(source: Source, startTime: Date, tailOffsetSeconds: number = 0): PlayerSegment[] {
	if (!source.catchupSource) {
		throw new Error("Source does not have catchup source configured");
	}

	const catchupMode = source.catchup || "default";
	const now = new Date();
	const endingFuture = new Date(now.getTime() + 8 * 60 * 60 * 1000);
	const segments: PlayerSegment[] = [];

	/**
	 * Parse long date format like yyyyMMddHHmmss
	 * Used for ${utc:yyyyMMddHHmmss}, ${utcend:yyyyMMddHHmmss} formats (with $)
	 * Also used for ${(b)yyyyMMddHHmmss} and ${(e)yyyyMMddHHmmss} formats
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
	 * Used for {utc:YmdHMS}, {utcend:YmdHMS} formats (without $)
	 * Converts Y/m/d/H/M/S to yyyy/MM/dd/HH/mm/ss and then calls parseLongDate
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
	const buildCatchupUrl = (segmentStartTime: Date, segmentEndTime: Date): string => {
		// Replace placeholders in catchup source
		let processedSource = source.catchupSource ?? "";

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
		processedSource = processedSource.replace(
			/\$\{mm\}/g,
			segmentStartTime.getUTCMinutes().toString().padStart(2, "0"),
		);
		processedSource = processedSource.replace(
			/\$\{ss\}/g,
			segmentStartTime.getUTCSeconds().toString().padStart(2, "0"),
		);

		// Handle individual component placeholders {Y}, {m}, {d}, {H}, {M}, {S}
		processedSource = processedSource.replace(/\{Y\}/g, segmentStartTime.getUTCFullYear().toString());
		processedSource = processedSource.replace(
			/\{m\}/g,
			(segmentStartTime.getUTCMonth() + 1).toString().padStart(2, "0"),
		);
		processedSource = processedSource.replace(/\{d\}/g, segmentStartTime.getUTCDate().toString().padStart(2, "0"));
		processedSource = processedSource.replace(/\{H\}/g, segmentStartTime.getUTCHours().toString().padStart(2, "0"));
		processedSource = processedSource.replace(/\{M\}/g, segmentStartTime.getUTCMinutes().toString().padStart(2, "0"));
		processedSource = processedSource.replace(/\{S\}/g, segmentStartTime.getUTCSeconds().toString().padStart(2, "0"));

		// Handle {duration} and ${duration} - Duration in seconds
		processedSource = processedSource.replace(/\$?\{duration\}/g, durationSeconds.toString());

		// Build final URL based on catchup mode
		if (catchupMode === "append") {
			// Append mode: append catchup source to original channel URL
			return source.url + processedSource;
		} else {
			// Default mode: use catchup source as complete URL
			return processedSource;
		}
	};

	// Segment duration: (now - startTime) in both seconds and milliseconds
	const segmentDurationMs = Math.min(
		Math.max(now.getTime() + tailOffsetSeconds * 1000 - startTime.getTime(), 10000), // min 10s
		5 * 60 * 60 * 1000, // max 5 hours
	);
	const segmentDurationSec = segmentDurationMs / 1000;

	// Build segments from startTime to now (catchup/replay segments)
	let currentTime = new Date(startTime.getTime());
	const splitPoint = new Date(now.getTime() + tailOffsetSeconds * 1000 - 10000);

	while (currentTime < splitPoint) {
		const segmentEndTime = new Date(Math.min(currentTime.getTime() + segmentDurationMs, splitPoint.getTime()));

		segments.push({
			duration: segmentDurationSec,
			url: buildCatchupUrl(currentTime, segmentEndTime),
		});

		currentTime = segmentEndTime;
	}

	// Build segments from splitPoint to future (half-duration live segments)
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
