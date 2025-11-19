/*
 * timezone.h - Timezone handling utilities for RTSP time conversion
 *
 * This module provides timezone-aware time conversion functions for RTSP
 * playseek parameters. It supports:
 * - Parsing timezone information from User-Agent headers
 * - Converting Unix timestamps to UTC with configurable format
 * - Converting yyyyMMddHHmmss format with timezone awareness
 */

#ifndef TIMEZONE_H
#define TIMEZONE_H

#include <stddef.h>
#include <time.h>

/* Constants */
#define TIMEZONE_MAX_OFFSET_HOURS 14  /* Maximum timezone offset (UTC+14) */
#define TIMEZONE_MIN_OFFSET_HOURS -12 /* Minimum timezone offset (UTC-12) */
#define TIMEZONE_MIN_BUFFER_SIZE 17   /* Minimum buffer for yyyyMMddTHHmmssZ */
#define TIMEZONE_NAME_MAX_LEN 63      /* Maximum timezone name length */
#define TIMEZONE_FORMAT_MAX_LEN 127   /* Maximum format string length */

/*
 * Parse timezone information from User-Agent header
 *
 * Supports patterns like:
 * - TZ/UTC+8, TZ/UTC-5, TZ/UTC (numeric offsets from -12 to +14)
 *
 * Thread Safety: Thread-safe
 *
 * @param user_agent User-Agent header string (can be NULL, defaults to UTC)
 * @param tz_offset_seconds Output: timezone offset in seconds from UTC
 *                          (positive for east, negative for west)
 *                          Must not be NULL. Range: [-43200, 50400] seconds
 * @return 0 on success, -1 if no timezone found (defaults to UTC with offset=0)
 *
 * Example:
 *   int offset;
 *   if (timezone_parse_from_user_agent("MyApp/1.0 TZ/UTC+8", &offset) == 0) {
 *       printf("Offset: %d seconds (%+.1f hours)\n", offset, offset/3600.0);
 *   }
 */
int timezone_parse_from_user_agent(const char *user_agent,
                                   int *tz_offset_seconds);

/*
 * Format time in yyyyMMddHHmmss format
 *
 * Thread Safety: Thread-safe
 *
 * @param utc_time Pointer to tm structure with UTC time (must not be NULL)
 * @param output_time Output buffer for formatted time (must not be NULL)
 * @param output_size Size of output buffer (minimum 15 bytes required)
 * @return 0 on success, -1 on error (invalid input, buffer too small)
 *
 * Example:
 *   struct tm utc_time;
 *   char output[32];
 *   // ... initialize utc_time ...
 *   if (timezone_format_time_yyyyMMddHHmmss(&utc_time, output, sizeof(output))
 * == 0) { printf("Formatted: %s\n", output);  // Output: 20240101120000
 *   }
 */
int timezone_format_time_yyyyMMddHHmmss(const struct tm *utc_time,
                                        char *output_time, size_t output_size);

/*
 * Convert time string with timezone offset to UTC (preserving original format)
 *
 * Supports multiple time formats:
 * - Unix timestamp (e.g., "1696089600")
 * - yyyyMMddHHmmss (e.g., "20250930150000")
 * - yyyyMMddHHmmssGMT (e.g., "20250930150000GMT")
 * - ISO 8601 (all variants with/without timezone, with/without milliseconds)
 *
 * Format detection is automatic. Output preserves input format.
 *
 * Thread Safety: NOT thread-safe (modifies TZ environment variable for some
 * formats)
 *
 * @param input_time Input time string (must not be NULL)
 * @param tz_offset_seconds Timezone offset from User-Agent in seconds
 *                          (positive for east, negative for west)
 *                          Range: [-43200, 50400] seconds
 *                          Used only for formats without embedded timezone
 * @param additional_offset_seconds Additional offset in seconds to apply
 *                                  (can be positive or negative)
 *                                  Applied to ALL formats
 * @param output_time Output buffer (must not be NULL)
 * @param output_size Size of output buffer (minimum 64 bytes recommended)
 * @return 0 on success, -1 on error
 *
 * Examples:
 *   // Unix timestamp
 *   timezone_convert_time_with_offset("1696089600", 0, 3600, output,
 * sizeof(output));
 *   // Output: "1696093200"
 *
 *   // yyyyMMddHHmmss with timezone conversion
 *   timezone_convert_time_with_offset("20250930150000", 8*3600, 3600, output,
 * sizeof(output));
 *   // Output: "20250930080000" (15:00 UTC+8 -> 07:00 UTC + 1h)
 *
 *   // yyyyMMddHHmmssGMT with timezone conversion
 *   timezone_convert_time_with_offset("20250930150000GMT", 8*3600, 3600,
 * output, sizeof(output));
 *   // Output: "20250930080000GMT" (15:00 UTC+8 -> 07:00 UTC + 1h)
 *
 *   // ISO 8601 with Z (preserves Z suffix)
 *   timezone_convert_time_with_offset("2025-09-30T15:00:00Z", 8*3600, 3600,
 * output, sizeof(output));
 *   // Output: "2025-09-30T16:00:00Z" (tz_offset_seconds ignored)
 *
 *   // ISO 8601 with timezone (preserves timezone)
 *   timezone_convert_time_with_offset("2025-09-30T15:00:00+08:00", 0, 3600,
 * output, sizeof(output));
 *   // Output: "2025-09-30T16:00:00+08:00"
 *
 *   // ISO 8601 without timezone (no Z added to output)
 *   timezone_convert_time_with_offset("2025-09-30T15:00:00", 8*3600, 3600,
 * output, sizeof(output));
 *   // Output: "2025-09-30T08:00:00" (no Z suffix)
 */
int timezone_convert_time_with_offset(const char *input_time,
                                      int tz_offset_seconds,
                                      int additional_offset_seconds,
                                      char *output_time, size_t output_size);

/*
 * Parse ISO 8601 time string and extract components
 *
 * Supports formats:
 * - YYYY-MM-DDTHH:MM:SS (no timezone)
 * - YYYY-MM-DDTHH:MM:SSZ (UTC)
 * - YYYY-MM-DDTHH:MM:SS±HH:MM (with timezone offset)
 * - YYYY-MM-DDTHH:MM:SS.sss (with milliseconds)
 * - YYYY-MM-DDTHH:MM:SS.sssZ (milliseconds + UTC)
 * - YYYY-MM-DDTHH:MM:SS.sss±HH:MM (milliseconds + timezone)
 *
 * Thread Safety: Thread-safe
 *
 * @param iso_str Input ISO 8601 string (must not be NULL)
 * @param tm_out Output tm structure (must not be NULL)
 * @param milliseconds_out Output milliseconds (0-999), or -1 if not present
 * (must not be NULL)
 * @param has_timezone_out Output: 1 if timezone present, 0 if not (must not be
 * NULL)
 * @param timezone_offset_out Output timezone offset in seconds (must not be
 * NULL)
 * @param timezone_suffix_out Output buffer for original timezone suffix (e.g.,
 * "Z", "+08:00", "") (must not be NULL)
 * @param suffix_size Size of timezone_suffix_out buffer (minimum 7 bytes for
 * "±HH:MM")
 * @return 0 on success, -1 on error
 */
int timezone_parse_iso8601(const char *iso_str, struct tm *tm_out,
                           int *milliseconds_out, int *has_timezone_out,
                           int *timezone_offset_out, char *timezone_suffix_out,
                           size_t suffix_size);

/*
 * Format time as ISO 8601 string
 *
 * Thread Safety: Thread-safe
 *
 * @param tm Time structure (must not be NULL)
 * @param milliseconds Milliseconds (0-999), or -1 to omit milliseconds
 * @param timezone_suffix Timezone suffix to append (e.g., "", "Z", "+08:00")
 * (must not be NULL)
 * @param output Output buffer (must not be NULL)
 * @param output_size Size of output buffer (minimum 30 bytes for full format)
 * @return 0 on success, -1 on error
 */
int timezone_format_time_iso8601(const struct tm *tm, int milliseconds,
                                 const char *timezone_suffix, char *output,
                                 size_t output_size);

/*
 * Convert ISO 8601 time string with timezone and offset
 *
 * If input has embedded timezone (Z or ±HH:MM), uses that and ignores
 * external_tz_offset. If input has no timezone, uses external_tz_offset for
 * conversion. Always applies offset_seconds after any timezone conversion.
 * Output preserves original timezone format.
 *
 * Thread Safety: NOT thread-safe (modifies TZ environment variable)
 *
 * @param iso_str Input ISO 8601 string (must not be NULL)
 * @param external_tz_offset Timezone offset from User-Agent in seconds (used
 * only if no embedded timezone)
 * @param offset_seconds Additional offset to always apply in seconds
 * @param output Output buffer (must not be NULL)
 * @param output_size Size of output buffer (minimum 30 bytes)
 * @return 0 on success, -1 on error
 */
int timezone_convert_iso8601_with_offset(const char *iso_str,
                                         int external_tz_offset,
                                         int offset_seconds, char *output,
                                         size_t output_size);

#endif /* TIMEZONE_H */
