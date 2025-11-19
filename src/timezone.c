/*
 * timezone.c - Timezone handling utilities for RTSP time conversion
 */

#include "timezone.h"
#include "utils.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

/* Constants for time calculations */
#define SECONDS_PER_HOUR 3600
#define SECONDS_PER_DAY 86400
#define MAX_TIMEZONE_OFFSET_SECONDS                                            \
  (TIMEZONE_MAX_OFFSET_HOURS * SECONDS_PER_HOUR)
#define MIN_TIMEZONE_OFFSET_SECONDS                                            \
  (TIMEZONE_MIN_OFFSET_HOURS * SECONDS_PER_HOUR)

/*
 * Parse timezone information from User-Agent header
 * Supports patterns like: TZ/UTC+8, TZ/UTC-5, TZ/UTC
 * Returns 0 on success, -1 if no timezone found (defaults to UTC)
 */
int timezone_parse_from_user_agent(const char *user_agent,
                                   int *tz_offset_seconds) {
  const char *tz_marker;

  /* Validate required output parameter */
  if (!tz_offset_seconds) {
    logger(LOG_ERROR, "Timezone: NULL pointer for tz_offset_seconds");
    return -1;
  }

  /* Default to UTC */
  *tz_offset_seconds = 0;

  if (!user_agent) {
    logger(LOG_DEBUG, "Timezone: NULL User-Agent");
    return -1;
  }

  /* Look for TZ/ marker in User-Agent */
  tz_marker = strstr(user_agent, "TZ/");
  if (!tz_marker) {
    logger(LOG_DEBUG, "Timezone: No TZ marker in User-Agent");
    return -1;
  }

  tz_marker += 3; /* Skip "TZ/" */

  /* Check for UTC+offset or UTC-offset format */
  if (strncmp(tz_marker, "UTC", 3) == 0) {
    tz_marker += 3; /* Skip "UTC" */

    /* Check for offset */
    if (*tz_marker == '+' || *tz_marker == '-') {
      int sign = (*tz_marker == '+') ? 1 : -1;
      tz_marker++;

      /* Parse offset hours */
      int offset_hours = 0;
      if (sscanf(tz_marker, "%d", &offset_hours) == 1) {
        /* Validate offset range */
        if (offset_hours < 0 || offset_hours > abs(TIMEZONE_MAX_OFFSET_HOURS)) {
          logger(LOG_ERROR, "Timezone: Invalid offset hours %d (must be 0-%d)",
                 offset_hours, abs(TIMEZONE_MAX_OFFSET_HOURS));
          return -1;
        }

        *tz_offset_seconds = sign * offset_hours * SECONDS_PER_HOUR;

        /* Double-check final offset is in valid range */
        if (*tz_offset_seconds < MIN_TIMEZONE_OFFSET_SECONDS ||
            *tz_offset_seconds > MAX_TIMEZONE_OFFSET_SECONDS) {
          logger(LOG_ERROR,
                 "Timezone: Calculated offset %d seconds out of range [%d, %d]",
                 *tz_offset_seconds, MIN_TIMEZONE_OFFSET_SECONDS,
                 MAX_TIMEZONE_OFFSET_SECONDS);
          *tz_offset_seconds = 0;
          return -1;
        }

        logger(LOG_DEBUG,
               "Timezone: Parsed timezone offset: UTC%+d (%d seconds)",
               sign * offset_hours, *tz_offset_seconds);
        return 0;
      }
    } else {
      /* Just "UTC" with no offset */
      logger(LOG_DEBUG, "Timezone: Parsed timezone: UTC (0 seconds)");
      return 0;
    }
  }

  /* Failed to parse timezone */
  logger(LOG_INFO, "Timezone: Failed to parse timezone from User-Agent");
  *tz_offset_seconds = 0;
  return -1;
}

/*
 * Format time in yyyyMMddHHmmss format
 */
int timezone_format_time_yyyyMMddHHmmss(const struct tm *utc_time,
                                        char *output_time, size_t output_size) {
  /* Validate inputs */
  if (!utc_time || !output_time) {
    logger(LOG_ERROR,
           "Timezone: NULL pointer in timezone_format_time_yyyyMMddHHmmss");
    return -1;
  }

  if (output_size < 15) {
    logger(LOG_ERROR,
           "Timezone: Output buffer too small (%zu bytes, need at least 15)",
           output_size);
    return -1;
  }

  /* Format as yyyyMMddHHmmss */
  int written = snprintf(output_time, output_size, "%04d%02d%02d%02d%02d%02d",
                         utc_time->tm_year + 1900, utc_time->tm_mon + 1,
                         utc_time->tm_mday, utc_time->tm_hour, utc_time->tm_min,
                         utc_time->tm_sec);

  if (written < 0 || (size_t)written >= output_size) {
    logger(LOG_ERROR, "Timezone: Output buffer too small for formatted time");
    return -1;
  }

  return 0;
}

/*
 * Convert time string with timezone offset to UTC (preserving original format)
 * Supports: Unix timestamp, yyyyMMddHHmmss, yyyyMMddHHmmssGMT, ISO 8601 (all
 * variants)
 */
int timezone_convert_time_with_offset(const char *input_time,
                                      int tz_offset_seconds,
                                      int additional_offset_seconds,
                                      char *output_time, size_t output_size) {
  struct tm local_time;
  time_t timestamp;
  int year, month, day, hour, min, sec;
  size_t input_len;
  size_t digit_count;
  char temp_time[32];

  /* Validate inputs */
  if (!input_time || !output_time) {
    logger(LOG_ERROR,
           "Timezone: NULL pointer in timezone_convert_time_with_offset");
    return -1;
  }

  if (output_size < 64) {
    logger(LOG_ERROR,
           "Timezone: Output buffer too small (%zu bytes, need at least 64)",
           output_size);
    return -1;
  }

  /* Validate timezone offset range */
  if (tz_offset_seconds < MIN_TIMEZONE_OFFSET_SECONDS ||
      tz_offset_seconds > MAX_TIMEZONE_OFFSET_SECONDS) {
    logger(LOG_ERROR,
           "Timezone: Invalid timezone offset %d seconds (range: [%d, %d])",
           tz_offset_seconds, MIN_TIMEZONE_OFFSET_SECONDS,
           MAX_TIMEZONE_OFFSET_SECONDS);
    return -1;
  }

  input_len = strlen(input_time);
  digit_count = strspn(input_time, "0123456789");

  /* Format 1: Unix timestamp (all digits, length <= 10) */
  if (input_len <= 10 && digit_count == input_len) {
    timestamp = (time_t)atoll(input_time);
    timestamp += additional_offset_seconds;
    snprintf(output_time, output_size, "%lld", (long long)timestamp);
    logger(LOG_DEBUG, "Timezone: Unix timestamp '%s' + offset %d = '%s'",
           input_time, additional_offset_seconds, output_time);
    return 0;
  }

  /* Format 2: yyyyMMddHHmmss and yyyyMMddHHmmssGMT (14 digits, optionally
   * followed by "GMT") */
  if ((input_len == 14 && digit_count == 14) ||
      (input_len == 17 && digit_count == 14 &&
       strcmp(input_time + 14, "GMT") == 0)) {
    int has_gmt_suffix = (input_len == 17);

    /* Parse the time string (first 14 digits) */
    if (sscanf(input_time, "%4d%2d%2d%2d%2d%2d", &year, &month, &day, &hour,
               &min, &sec) != 6) {
      logger(LOG_ERROR, "Timezone: Failed to parse time string: %s",
             input_time);
      return -1;
    }

    /* Validate date/time components */
    if (year < 1900 || year > 9999) {
      logger(LOG_ERROR, "Timezone: Invalid year %d (must be 1900-9999)", year);
      return -1;
    }
    if (month < 1 || month > 12) {
      logger(LOG_ERROR, "Timezone: Invalid month %d (must be 1-12)", month);
      return -1;
    }
    if (day < 1 || day > 31) {
      logger(LOG_ERROR, "Timezone: Invalid day %d (must be 1-31)", day);
      return -1;
    }
    if (hour < 0 || hour > 23) {
      logger(LOG_ERROR, "Timezone: Invalid hour %d (must be 0-23)", hour);
      return -1;
    }
    if (min < 0 || min > 59) {
      logger(LOG_ERROR, "Timezone: Invalid minute %d (must be 0-59)", min);
      return -1;
    }
    if (sec < 0 || sec > 60) {
      logger(LOG_ERROR, "Timezone: Invalid second %d (must be 0-60)", sec);
      return -1;
    }

    /* Fill tm structure */
    memset(&local_time, 0, sizeof(local_time));
    local_time.tm_year = year - 1900;
    local_time.tm_mon = month - 1;
    local_time.tm_mday = day;
    local_time.tm_hour = hour;
    local_time.tm_min = min;
    local_time.tm_sec = sec;
    local_time.tm_isdst = 0;

    /* Convert to timestamp using UTC workaround */
    char *old_tz = NULL;
    char *current_tz = getenv("TZ");
    if (current_tz)
      old_tz = strdup(current_tz);
    setenv("TZ", "UTC", 1);
    tzset();
    timestamp = mktime(&local_time);
    if (old_tz) {
      setenv("TZ", old_tz, 1);
      free(old_tz);
    } else
      unsetenv("TZ");
    tzset();

    if (timestamp == -1) {
      logger(LOG_ERROR, "Timezone: Failed to convert time to timestamp");
      return -1;
    }

    /* Apply timezone conversion and additional offset */
    timestamp -= tz_offset_seconds;
    timestamp += additional_offset_seconds;

    /* Convert back to yyyyMMddHHmmss format */
    struct tm *utc_time = gmtime(&timestamp);
    if (!utc_time) {
      logger(LOG_ERROR, "Timezone: Failed to convert timestamp to UTC");
      return -1;
    }

    struct tm utc_time_copy = *utc_time;
    if (timezone_format_time_yyyyMMddHHmmss(&utc_time_copy, temp_time,
                                            sizeof(temp_time)) != 0) {
      return -1;
    }

    /* Add GMT suffix back if original had it */
    if (has_gmt_suffix) {
      snprintf(output_time, output_size, "%sGMT", temp_time);
      logger(LOG_DEBUG,
             "Timezone: yyyyMMddHHmmssGMT '%s' (TZ offset %d) + seek offset %d "
             "= '%s'",
             input_time, -tz_offset_seconds, additional_offset_seconds,
             output_time);
    } else {
      strncpy(output_time, temp_time, output_size - 1);
      output_time[output_size - 1] = '\0';
      logger(LOG_DEBUG,
             "Timezone: yyyyMMddHHmmss '%s' (TZ offset %d) + seek offset %d = "
             "'%s'",
             input_time, -tz_offset_seconds, additional_offset_seconds,
             output_time);
    }

    return 0;
  }

  /* Format 3: ISO 8601 (contains 'T' separator, must check after
   * yyyyMMddHHmmssGMT) */
  if (strchr(input_time, 'T') != NULL) {
    return timezone_convert_iso8601_with_offset(input_time, tz_offset_seconds,
                                                additional_offset_seconds,
                                                output_time, output_size);
  }

  /* Unknown format, use as-is */
  strncpy(output_time, input_time, output_size - 1);
  output_time[output_size - 1] = '\0';
  logger(LOG_DEBUG, "Timezone: Unknown time format '%s', using as-is",
         input_time);
  return 0;
}

/*
 * Format time as ISO 8601 string
 */
int timezone_format_time_iso8601(const struct tm *tm, int milliseconds,
                                 const char *timezone_suffix, char *output,
                                 size_t output_size) {
  int written;

  /* Validate inputs */
  if (!tm || !timezone_suffix || !output) {
    logger(LOG_ERROR, "Timezone: NULL pointer in timezone_format_time_iso8601");
    return -1;
  }

  if (output_size < 30) {
    logger(LOG_ERROR,
           "Timezone: Output buffer too small (%zu bytes, need at least 30)",
           output_size);
    return -1;
  }

  /* Validate milliseconds */
  if (milliseconds < -1 || milliseconds > 999) {
    logger(LOG_ERROR, "Timezone: Invalid milliseconds %d (must be -1 to 999)",
           milliseconds);
    return -1;
  }

  /* Format base time: YYYY-MM-DDTHH:MM:SS */
  if (milliseconds >= 0) {
    /* Include milliseconds: YYYY-MM-DDTHH:MM:SS.sss */
    written =
        snprintf(output, output_size, "%04d-%02d-%02dT%02d:%02d:%02d.%03d%s",
                 tm->tm_year + 1900, tm->tm_mon + 1, tm->tm_mday, tm->tm_hour,
                 tm->tm_min, tm->tm_sec, milliseconds, timezone_suffix);
  } else {
    /* No milliseconds: YYYY-MM-DDTHH:MM:SS */
    written = snprintf(output, output_size, "%04d-%02d-%02dT%02d:%02d:%02d%s",
                       tm->tm_year + 1900, tm->tm_mon + 1, tm->tm_mday,
                       tm->tm_hour, tm->tm_min, tm->tm_sec, timezone_suffix);
  }

  if (written < 0 || (size_t)written >= output_size) {
    logger(LOG_ERROR, "Timezone: Output buffer too small for ISO 8601 format");
    return -1;
  }

  return 0;
}

/*
 * Parse ISO 8601 time string and extract components
 */
int timezone_parse_iso8601(const char *iso_str, struct tm *tm_out,
                           int *milliseconds_out, int *has_timezone_out,
                           int *timezone_offset_out, char *timezone_suffix_out,
                           size_t suffix_size) {
  int year, month, day, hour, min, sec;
  int milliseconds = -1;
  int has_timezone = 0;
  int timezone_offset = 0;
  const char *p;
  char tz_suffix[16] = "";

  /* Validate inputs */
  if (!iso_str || !tm_out || !milliseconds_out || !has_timezone_out ||
      !timezone_offset_out || !timezone_suffix_out) {
    logger(LOG_ERROR, "Timezone: NULL pointer in timezone_parse_iso8601");
    return -1;
  }

  if (suffix_size < 7) {
    logger(LOG_ERROR,
           "Timezone: timezone_suffix_out buffer too small (%zu bytes, need at "
           "least 7)",
           suffix_size);
    return -1;
  }

  /* Check for 'T' separator */
  p = strchr(iso_str, 'T');
  if (!p) {
    logger(LOG_ERROR,
           "Timezone: Invalid ISO 8601 format, missing 'T' separator");
    return -1;
  }

  /* Parse base format: YYYY-MM-DDTHH:MM:SS */
  int parsed = sscanf(iso_str, "%4d-%2d-%2dT%2d:%2d:%2d", &year, &month, &day,
                      &hour, &min, &sec);
  if (parsed != 6) {
    logger(LOG_ERROR, "Timezone: Failed to parse ISO 8601 base format: %s",
           iso_str);
    return -1;
  }

  /* Validate date/time components */
  if (year < 1900 || year > 9999) {
    logger(LOG_ERROR, "Timezone: Invalid year %d (must be 1900-9999)", year);
    return -1;
  }
  if (month < 1 || month > 12) {
    logger(LOG_ERROR, "Timezone: Invalid month %d (must be 1-12)", month);
    return -1;
  }
  if (day < 1 || day > 31) {
    logger(LOG_ERROR, "Timezone: Invalid day %d (must be 1-31)", day);
    return -1;
  }
  if (hour < 0 || hour > 23) {
    logger(LOG_ERROR, "Timezone: Invalid hour %d (must be 0-23)", hour);
    return -1;
  }
  if (min < 0 || min > 59) {
    logger(LOG_ERROR, "Timezone: Invalid minute %d (must be 0-59)", min);
    return -1;
  }
  if (sec < 0 || sec > 60) /* Allow 60 for leap seconds */
  {
    logger(LOG_ERROR, "Timezone: Invalid second %d (must be 0-60)", sec);
    return -1;
  }

  /* Find position after seconds (YYYY-MM-DDTHH:MM:SS = 19 chars) */
  p = iso_str + 19;

  /* Check for milliseconds (.sss) */
  if (*p == '.') {
    p++; /* Skip '.' */
    int ms_value;
    int ms_digits;
    if (sscanf(p, "%3d%n", &ms_value, &ms_digits) == 1) {
      /* Handle 1, 2, or 3 digit milliseconds */
      if (ms_digits == 1)
        milliseconds = ms_value * 100;
      else if (ms_digits == 2)
        milliseconds = ms_value * 10;
      else
        milliseconds = ms_value;

      p += ms_digits;
    }
  }

  /* Check for timezone information */
  if (*p == 'Z') {
    /* UTC timezone */
    has_timezone = 1;
    timezone_offset = 0;
    strncpy(tz_suffix, "Z", sizeof(tz_suffix) - 1);
    tz_suffix[sizeof(tz_suffix) - 1] = '\0';
  } else if (*p == '+' || *p == '-') {
    /* Timezone offset: ±HH:MM */
    int tz_sign = (*p == '+') ? 1 : -1;
    int tz_hours, tz_minutes;
    char colon;

    if (sscanf(p, "%3d:%2d", &tz_hours, &tz_minutes) == 2 ||
        sscanf(p, "%3d%c%2d", &tz_hours, &colon, &tz_minutes) == 3) {
      /* Validate timezone offset */
      if (abs(tz_hours) > 14 || tz_minutes < 0 || tz_minutes > 59) {
        logger(LOG_ERROR, "Timezone: Invalid timezone offset in ISO 8601: %s",
               p);
        return -1;
      }

      has_timezone = 1;
      timezone_offset = tz_sign * (abs(tz_hours) * 3600 + tz_minutes * 60);

      /* Save original timezone suffix */
      snprintf(tz_suffix, sizeof(tz_suffix), "%c%02d:%02d", *p, abs(tz_hours),
               tz_minutes);
    } else {
      logger(LOG_ERROR, "Timezone: Failed to parse timezone offset: %s", p);
      return -1;
    }
  } else if (*p == '\0') {
    /* No timezone information */
    has_timezone = 0;
    timezone_offset = 0;
    tz_suffix[0] = '\0';
  } else {
    logger(LOG_ERROR,
           "Timezone: Invalid character after time in ISO 8601: '%c'", *p);
    return -1;
  }

  /* Fill output tm structure */
  memset(tm_out, 0, sizeof(*tm_out));
  tm_out->tm_year = year - 1900;
  tm_out->tm_mon = month - 1;
  tm_out->tm_mday = day;
  tm_out->tm_hour = hour;
  tm_out->tm_min = min;
  tm_out->tm_sec = sec;
  tm_out->tm_isdst = 0;

  /* Copy output values */
  *milliseconds_out = milliseconds;
  *has_timezone_out = has_timezone;
  *timezone_offset_out = timezone_offset;
  strncpy(timezone_suffix_out, tz_suffix, suffix_size - 1);
  timezone_suffix_out[suffix_size - 1] = '\0';

  return 0;
}

/*
 * Convert ISO 8601 time string with timezone and offset
 */
int timezone_convert_iso8601_with_offset(const char *iso_str,
                                         int external_tz_offset,
                                         int offset_seconds, char *output,
                                         size_t output_size) {
  struct tm tm;
  int milliseconds;
  int has_timezone;
  int timezone_offset;
  char timezone_suffix[16];
  time_t timestamp;
  char *old_tz = NULL;
  char *current_tz;

  /* Validate inputs */
  if (!iso_str || !output) {
    logger(LOG_ERROR,
           "Timezone: NULL pointer in timezone_convert_iso8601_with_offset");
    return -1;
  }

  if (output_size < 30) {
    logger(LOG_ERROR,
           "Timezone: Output buffer too small (%zu bytes, need at least 30)",
           output_size);
    return -1;
  }

  /* Parse ISO 8601 string */
  if (timezone_parse_iso8601(iso_str, &tm, &milliseconds, &has_timezone,
                             &timezone_offset, timezone_suffix,
                             sizeof(timezone_suffix)) != 0) {
    logger(LOG_ERROR, "Timezone: Failed to parse ISO 8601 string: %s", iso_str);
    return -1;
  }

  /* Convert tm to UTC timestamp */
  current_tz = getenv("TZ");
  if (current_tz) {
    old_tz = strdup(current_tz);
  }

  /* Temporarily set timezone to UTC */
  setenv("TZ", "UTC", 1);
  tzset();

  timestamp = mktime(&tm);

  /* Restore original timezone */
  if (old_tz) {
    setenv("TZ", old_tz, 1);
    free(old_tz);
  } else {
    unsetenv("TZ");
  }
  tzset();

  if (timestamp == -1) {
    logger(LOG_ERROR, "Timezone: Failed to convert time to timestamp");
    return -1;
  }

  /* Apply timezone conversion and offset */
  if (has_timezone) {
    /* Input has embedded timezone
     * The tm structure represents the time as parsed (without timezone)
     * We need to:
     * 1. Keep it in the same timezone (don't convert to UTC internally)
     * 2. Only apply offset_seconds
     */
    timestamp += offset_seconds;
    logger(LOG_DEBUG,
           "Timezone: ISO 8601 has embedded timezone, only applying offset %d "
           "seconds",
           offset_seconds);
  } else {
    /* No embedded timezone - apply timezone conversion then offset */
    timestamp -= external_tz_offset;
    timestamp += offset_seconds;
    if (external_tz_offset != 0) {
      logger(LOG_DEBUG,
             "Timezone: ISO 8601 no timezone, applying TZ offset %d + offset "
             "%d seconds",
             external_tz_offset, offset_seconds);
    }
  }

  /* Convert timestamp back to time structure */
  struct tm *result_time = gmtime(&timestamp);
  if (!result_time) {
    logger(LOG_ERROR, "Timezone: Failed to convert timestamp back");
    return -1;
  }

  struct tm result_copy = *result_time;

  /* Format output preserving original timezone suffix */
  return timezone_format_time_iso8601(&result_copy, milliseconds,
                                      timezone_suffix, output, output_size);
}
