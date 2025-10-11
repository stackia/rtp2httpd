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

#include <time.h>
#include <stddef.h>

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
int timezone_parse_from_user_agent(const char *user_agent, int *tz_offset_seconds);

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
 *   if (timezone_format_time_yyyyMMddHHmmss(&utc_time, output, sizeof(output)) == 0) {
 *       printf("Formatted: %s\n", output);  // Output: 20240101120000
 *   }
 */
int timezone_format_time_yyyyMMddHHmmss(const struct tm *utc_time,
                                        char *output_time, size_t output_size);

/*
 * Convert time from yyyyMMddHHmmss format with timezone offset to UTC yyyyMMddHHmmss
 *
 * Validates date/time components (month 1-12, day 1-31, hour 0-23, etc.)
 *
 * Thread Safety: NOT thread-safe (modifies TZ environment variable)
 *
 * @param input_time Input time string in yyyyMMddHHmmss format (exactly 14 digits)
 *                   Must be a valid date/time (e.g., no Feb 30, no month 13)
 * @param tz_offset_seconds Timezone offset in seconds from UTC
 *                          (positive for east, negative for west)
 *                          Range: [-43200, 50400] seconds
 * @param output_time Output buffer for UTC time in yyyyMMddHHmmss format (must not be NULL)
 * @param output_size Size of output buffer (minimum 15 bytes required)
 * @return 0 on success, -1 on error (invalid format, invalid date/time, buffer too small)
 *
 * Example:
 *   char output[32];
 *   int offset = 8 * 3600;  // UTC+8
 *   if (timezone_convert_time_with_offset("20250930150000", offset, output, sizeof(output)) == 0) {
 *       printf("UTC time: %s\n", output);  // Prints: 20250930070000
 *   }
 */
int timezone_convert_time_with_offset(const char *input_time, int tz_offset_seconds,
                                      char *output_time, size_t output_size);

#endif /* TIMEZONE_H */
