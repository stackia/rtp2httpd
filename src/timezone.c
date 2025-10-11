/*
 * timezone.c - Timezone handling utilities for RTSP time conversion
 */

#ifdef HAVE_CONFIG_H
#include "config.h"
#endif /* HAVE_CONFIG_H */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <limits.h>

#include "timezone.h"
#include "rtp2httpd.h"

/* Constants for time calculations */
#define SECONDS_PER_HOUR 3600
#define SECONDS_PER_DAY 86400
#define MAX_TIMEZONE_OFFSET_SECONDS (TIMEZONE_MAX_OFFSET_HOURS * SECONDS_PER_HOUR)
#define MIN_TIMEZONE_OFFSET_SECONDS (TIMEZONE_MIN_OFFSET_HOURS * SECONDS_PER_HOUR)

/*
 * Parse timezone information from User-Agent header
 * Supports patterns like: TZ/UTC+8, TZ/UTC-5, TZ/UTC
 * Returns 0 on success, -1 if no timezone found (defaults to UTC)
 */
int timezone_parse_from_user_agent(const char *user_agent, int *tz_offset_seconds)
{
    const char *tz_marker;

    /* Validate required output parameter */
    if (!tz_offset_seconds)
    {
        logger(LOG_ERROR, "Timezone: NULL pointer for tz_offset_seconds");
        return -1;
    }

    /* Default to UTC */
    *tz_offset_seconds = 0;

    if (!user_agent)
    {
        logger(LOG_DEBUG, "Timezone: NULL User-Agent, defaulting to UTC");
        return -1;
    }

    /* Look for TZ/ marker in User-Agent */
    tz_marker = strstr(user_agent, "TZ/");
    if (!tz_marker)
    {
        logger(LOG_DEBUG, "Timezone: No TZ marker in User-Agent, defaulting to UTC");
        return -1;
    }

    tz_marker += 3; /* Skip "TZ/" */

    /* Check for UTC+offset or UTC-offset format */
    if (strncmp(tz_marker, "UTC", 3) == 0)
    {
        tz_marker += 3; /* Skip "UTC" */

        /* Check for offset */
        if (*tz_marker == '+' || *tz_marker == '-')
        {
            int sign = (*tz_marker == '+') ? 1 : -1;
            tz_marker++;

            /* Parse offset hours */
            int offset_hours = 0;
            if (sscanf(tz_marker, "%d", &offset_hours) == 1)
            {
                /* Validate offset range */
                if (offset_hours < 0 || offset_hours > abs(TIMEZONE_MAX_OFFSET_HOURS))
                {
                    logger(LOG_ERROR, "Timezone: Invalid offset hours %d (must be 0-%d), defaulting to UTC",
                           offset_hours, abs(TIMEZONE_MAX_OFFSET_HOURS));
                    return -1;
                }

                *tz_offset_seconds = sign * offset_hours * SECONDS_PER_HOUR;

                /* Double-check final offset is in valid range */
                if (*tz_offset_seconds < MIN_TIMEZONE_OFFSET_SECONDS ||
                    *tz_offset_seconds > MAX_TIMEZONE_OFFSET_SECONDS)
                {
                    logger(LOG_ERROR, "Timezone: Calculated offset %d seconds out of range [%d, %d], defaulting to UTC",
                           *tz_offset_seconds, MIN_TIMEZONE_OFFSET_SECONDS, MAX_TIMEZONE_OFFSET_SECONDS);
                    *tz_offset_seconds = 0;
                    return -1;
                }

                logger(LOG_DEBUG, "Timezone: Parsed timezone offset: UTC%+d (%d seconds)",
                       sign * offset_hours, *tz_offset_seconds);
                return 0;
            }
        }
        else
        {
            /* Just "UTC" with no offset */
            logger(LOG_DEBUG, "Timezone: Parsed timezone: UTC (0 seconds)");
            return 0;
        }
    }

    /* Failed to parse timezone */
    logger(LOG_INFO, "Timezone: Failed to parse timezone from User-Agent, defaulting to UTC");
    *tz_offset_seconds = 0;
    return -1;
}

/*
 * Format time in yyyyMMddHHmmss format
 */
int timezone_format_time_yyyyMMddHHmmss(const struct tm *utc_time,
                                        char *output_time, size_t output_size)
{
    /* Validate inputs */
    if (!utc_time || !output_time)
    {
        logger(LOG_ERROR, "Timezone: NULL pointer in timezone_format_time_yyyyMMddHHmmss");
        return -1;
    }

    if (output_size < 15)
    {
        logger(LOG_ERROR, "Timezone: Output buffer too small (%zu bytes, need at least 15)",
               output_size);
        return -1;
    }

    /* Format as yyyyMMddHHmmss */
    int written = snprintf(output_time, output_size, "%04d%02d%02d%02d%02d%02d",
                           utc_time->tm_year + 1900,
                           utc_time->tm_mon + 1,
                           utc_time->tm_mday,
                           utc_time->tm_hour,
                           utc_time->tm_min,
                           utc_time->tm_sec);

    if (written < 0 || (size_t)written >= output_size)
    {
        logger(LOG_ERROR, "Timezone: Output buffer too small for formatted time");
        return -1;
    }

    return 0;
}

/*
 * Convert time from yyyyMMddHHmmss format with timezone offset to UTC yyyyMMddHHmmss
 */
int timezone_convert_time_with_offset(const char *input_time, int tz_offset_seconds,
                                      char *output_time, size_t output_size)
{
    struct tm local_time;
    time_t timestamp;
    int year, month, day, hour, min, sec;

    /* Validate inputs */
    if (!input_time || !output_time)
    {
        logger(LOG_ERROR, "Timezone: NULL pointer in timezone_convert_time_with_offset");
        return -1;
    }

    if (output_size < 15)
    {
        logger(LOG_ERROR, "Timezone: Output buffer too small (%zu bytes, need at least 15)",
               output_size);
        return -1;
    }

    /* Validate timezone offset range */
    if (tz_offset_seconds < MIN_TIMEZONE_OFFSET_SECONDS ||
        tz_offset_seconds > MAX_TIMEZONE_OFFSET_SECONDS)
    {
        logger(LOG_ERROR, "Timezone: Invalid timezone offset %d seconds (range: [%d, %d])",
               tz_offset_seconds, MIN_TIMEZONE_OFFSET_SECONDS, MAX_TIMEZONE_OFFSET_SECONDS);
        return -1;
    }

    /* Check if input is exactly 14 digits (yyyyMMddHHmmss) */
    size_t input_len = strlen(input_time);
    if (input_len != 14)
    {
        logger(LOG_ERROR, "Timezone: Invalid time format length %zu, expected 14 (yyyyMMddHHmmss)", input_len);
        return -1;
    }

    if (strspn(input_time, "0123456789") != 14)
    {
        logger(LOG_ERROR, "Timezone: Invalid time format, expected all digits (yyyyMMddHHmmss)");
        return -1;
    }

    /* Parse the time string */
    if (sscanf(input_time, "%4d%2d%2d%2d%2d%2d",
               &year, &month, &day, &hour, &min, &sec) != 6)
    {
        logger(LOG_ERROR, "Timezone: Failed to parse time string: %s", input_time);
        return -1;
    }

    /* Validate date/time components */
    if (year < 1900 || year > 9999)
    {
        logger(LOG_ERROR, "Timezone: Invalid year %d (must be 1900-9999)", year);
        return -1;
    }
    if (month < 1 || month > 12)
    {
        logger(LOG_ERROR, "Timezone: Invalid month %d (must be 1-12)", month);
        return -1;
    }
    if (day < 1 || day > 31)
    {
        logger(LOG_ERROR, "Timezone: Invalid day %d (must be 1-31)", day);
        return -1;
    }
    if (hour < 0 || hour > 23)
    {
        logger(LOG_ERROR, "Timezone: Invalid hour %d (must be 0-23)", hour);
        return -1;
    }
    if (min < 0 || min > 59)
    {
        logger(LOG_ERROR, "Timezone: Invalid minute %d (must be 0-59)", min);
        return -1;
    }
    if (sec < 0 || sec > 60) /* Allow 60 for leap seconds */
    {
        logger(LOG_ERROR, "Timezone: Invalid second %d (must be 0-60)", sec);
        return -1;
    }

    /* Fill tm structure */
    memset(&local_time, 0, sizeof(local_time));
    local_time.tm_year = year - 1900; /* tm_year is years since 1900 */
    local_time.tm_mon = month - 1;    /* tm_mon is 0-11 */
    local_time.tm_mday = day;
    local_time.tm_hour = hour;
    local_time.tm_min = min;
    local_time.tm_sec = sec;
    local_time.tm_isdst = 0; /* No DST for this calculation */

    /* Convert to timestamp using timegm (UTC) instead of mktime (local time) */
    /* timegm is not standard, so we use a workaround */
    char *old_tz = NULL;
    char *current_tz = getenv("TZ");
    if (current_tz)
    {
        old_tz = strdup(current_tz);
    }

    /* Temporarily set timezone to UTC */
    setenv("TZ", "UTC", 1);
    tzset();

    timestamp = mktime(&local_time);

    /* Restore original timezone */
    if (old_tz)
    {
        setenv("TZ", old_tz, 1);
        free(old_tz);
    }
    else
    {
        unsetenv("TZ");
    }
    tzset();

    if (timestamp == -1)
    {
        logger(LOG_ERROR, "Timezone: Failed to convert time to timestamp");
        return -1;
    }

    /* Adjust for timezone offset to get UTC timestamp */
    /* If input is in UTC+8, we need to subtract 8 hours to get UTC */
    timestamp -= tz_offset_seconds;

    /* Convert back to UTC time string in yyyyMMddHHmmss format */
    struct tm *utc_time = gmtime(&timestamp);
    if (!utc_time)
    {
        logger(LOG_ERROR, "Timezone: Failed to convert timestamp to UTC");
        return -1;
    }

    struct tm utc_time_copy = *utc_time;
    return timezone_format_time_yyyyMMddHHmmss(&utc_time_copy, output_time, output_size);
}
