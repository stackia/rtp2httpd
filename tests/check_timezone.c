/*
 * check_timezone.c - Unit tests for timezone handling functions
 */

#include <check.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <stdarg.h>

#include "../src/timezone.h"
#include "../src/rtp2httpd.h"

/* Mock logger function for tests */
int logger(enum loglevel level, const char *format, ...)
{
    (void)level;
    (void)format;
    return 0;
}

/* Test fixture setup/teardown */
void setup(void)
{
    /* No initialization needed */
}

void teardown(void)
{
    /* Cleanup if needed */
}

/* ========== Tests for timezone_parse_from_user_agent ========== */

START_TEST(test_parse_timezone_utc_plus_offset)
{
    int tz_offset;
    int result;

    /* Test UTC+8 */
    result = timezone_parse_from_user_agent("MyApp/1.0 TZ/UTC+8", &tz_offset);
    ck_assert_int_eq(result, 0);
    ck_assert_int_eq(tz_offset, 8 * 3600);

    /* Test UTC+5 */
    result = timezone_parse_from_user_agent("MyApp/1.0 TZ/UTC+5", &tz_offset);
    ck_assert_int_eq(result, 0);
    ck_assert_int_eq(tz_offset, 5 * 3600);

    /* Test UTC+0 */
    result = timezone_parse_from_user_agent("MyApp/1.0 TZ/UTC+0", &tz_offset);
    ck_assert_int_eq(result, 0);
    ck_assert_int_eq(tz_offset, 0);
}
END_TEST

START_TEST(test_parse_timezone_utc_minus_offset)
{
    int tz_offset;
    int result;

    /* Test UTC-5 */
    result = timezone_parse_from_user_agent("MyApp/1.0 TZ/UTC-5", &tz_offset);
    ck_assert_int_eq(result, 0);
    ck_assert_int_eq(tz_offset, -5 * 3600);

    /* Test UTC-8 */
    result = timezone_parse_from_user_agent("MyApp/1.0 TZ/UTC-8", &tz_offset);
    ck_assert_int_eq(result, 0);
    ck_assert_int_eq(tz_offset, -8 * 3600);
}
END_TEST

START_TEST(test_parse_timezone_utc_no_offset)
{
    int tz_offset;
    int result;

    /* Test plain UTC */
    result = timezone_parse_from_user_agent("MyApp/1.0 TZ/UTC", &tz_offset);
    ck_assert_int_eq(result, 0);
    ck_assert_int_eq(tz_offset, 0);
}
END_TEST

START_TEST(test_parse_timezone_no_marker)
{
    int tz_offset;
    int result;

    /* Test User-Agent without TZ marker */
    result = timezone_parse_from_user_agent("MyApp/1.0", &tz_offset);
    ck_assert_int_eq(result, -1);
    ck_assert_int_eq(tz_offset, 0); /* Should default to UTC */
}
END_TEST

START_TEST(test_parse_timezone_null_input)
{
    int tz_offset = 999;
    int result;

    /* Test NULL user_agent */
    result = timezone_parse_from_user_agent(NULL, &tz_offset);
    ck_assert_int_eq(result, -1);
    ck_assert_int_eq(tz_offset, 0);
}
END_TEST

/* ========== Tests for timezone_format_time ========== */

START_TEST(test_format_time_default_format)
{
    struct tm test_time;
    char output[32];
    int result;

    /* Create test time: 2025-09-30 07:01:00 UTC */
    memset(&test_time, 0, sizeof(test_time));
    test_time.tm_year = 2025 - 1900;
    test_time.tm_mon = 9 - 1;
    test_time.tm_mday = 30;
    test_time.tm_hour = 7;
    test_time.tm_min = 1;
    test_time.tm_sec = 0;

    /* Test with default format (NULL) */
    result = timezone_format_time(&test_time, NULL, output, sizeof(output));
    ck_assert_int_eq(result, 0);
    ck_assert_str_eq(output, "20250930T070100Z");
}
END_TEST

START_TEST(test_format_time_custom_format)
{
    struct tm test_time;
    char output[32];
    int result;

    /* Create test time: 2025-09-30 07:01:00 UTC */
    memset(&test_time, 0, sizeof(test_time));
    test_time.tm_year = 2025 - 1900;
    test_time.tm_mon = 9 - 1;
    test_time.tm_mday = 30;
    test_time.tm_hour = 7;
    test_time.tm_min = 1;
    test_time.tm_sec = 0;

    /* Test with custom format */
    result = timezone_format_time(&test_time, "yyyy-MM-dd HH:mm:ss", output, sizeof(output));
    ck_assert_int_eq(result, 0);
    ck_assert_str_eq(output, "2025-09-30 07:01:00");
}
END_TEST

START_TEST(test_format_time_null_input)
{
    char output[32];
    int result;

    /* Test with NULL tm structure */
    result = timezone_format_time(NULL, NULL, output, sizeof(output));
    ck_assert_int_eq(result, -1);
}
END_TEST

/* ========== Tests for timezone_convert_unix_timestamp_to_utc ========== */

START_TEST(test_convert_unix_timestamp)
{
    char output[32];
    int result;
    time_t timestamp;

    /* Test timestamp: 1727679660 = 2024-09-30 07:01:00 UTC */
    timestamp = 1727679660;

    result = timezone_convert_unix_timestamp_to_utc(timestamp, NULL, output, sizeof(output));
    ck_assert_int_eq(result, 0);
    ck_assert_str_eq(output, "20240930T070100Z");
}
END_TEST

START_TEST(test_convert_unix_timestamp_custom_format)
{
    char output[32];
    int result;
    time_t timestamp;

    /* Test timestamp: 1727679660 = 2024-09-30 07:01:00 UTC */
    timestamp = 1727679660;

    result = timezone_convert_unix_timestamp_to_utc(timestamp, "yyyy-MM-dd HH:mm:ss", output, sizeof(output));
    ck_assert_int_eq(result, 0);
    ck_assert_str_eq(output, "2024-09-30 07:01:00");
}
END_TEST

/* ========== Tests for timezone_convert_time_with_offset ========== */

START_TEST(test_convert_time_with_utc_plus_8)
{
    char output[32];
    int result;

    /* Input: 20250930150000 in UTC+8 */
    /* Expected: 20250930070000Z in UTC (subtract 8 hours) */
    result = timezone_convert_time_with_offset("20250930150000", 8 * 3600, NULL, output, sizeof(output));
    ck_assert_int_eq(result, 0);
    ck_assert_str_eq(output, "20250930T070000Z");
}
END_TEST

START_TEST(test_convert_time_with_utc_minus_5)
{
    char output[32];
    int result;

    /* Input: 20250930070000 in UTC-5 */
    /* Expected: 20250930120000Z in UTC (add 5 hours) */
    result = timezone_convert_time_with_offset("20250930070000", -5 * 3600, NULL, output, sizeof(output));
    ck_assert_int_eq(result, 0);
    ck_assert_str_eq(output, "20250930T120000Z");
}
END_TEST

START_TEST(test_convert_time_with_zero_offset)
{
    char output[32];
    int result;

    /* Input: 20250930070000 in UTC */
    /* Expected: 20250930070000Z in UTC (no change) */
    result = timezone_convert_time_with_offset("20250930070000", 0, NULL, output, sizeof(output));
    ck_assert_int_eq(result, 0);
    ck_assert_str_eq(output, "20250930T070000Z");
}
END_TEST

START_TEST(test_convert_time_invalid_format)
{
    char output[32];
    int result;

    /* Test with invalid format (too short) */
    result = timezone_convert_time_with_offset("2025093007", 0, NULL, output, sizeof(output));
    ck_assert_int_eq(result, -1);

    /* Test with invalid format (non-numeric) */
    result = timezone_convert_time_with_offset("2025093007ABCD", 0, NULL, output, sizeof(output));
    ck_assert_int_eq(result, -1);
}
END_TEST

/* ========== Additional Error Handling Tests ========== */

START_TEST(test_parse_timezone_invalid_offset)
{
    int tz_offset;
    int result;

    /* Test offset beyond valid range (UTC+15) */
    result = timezone_parse_from_user_agent("MyApp/1.0 TZ/UTC+15", &tz_offset);
    ck_assert_int_eq(result, -1);
    ck_assert_int_eq(tz_offset, 0); /* Should default to UTC */

    /* Test offset beyond valid range (UTC-13) */
    result = timezone_parse_from_user_agent("MyApp/1.0 TZ/UTC-13", &tz_offset);
    ck_assert_int_eq(result, -1);
    ck_assert_int_eq(tz_offset, 0);
}
END_TEST

START_TEST(test_convert_time_invalid_date_components)
{
    char output[32];
    int result;
    int tz_offset = 0;

    /* Test invalid month (13) */
    result = timezone_convert_time_with_offset("20251330150000", tz_offset, NULL, output, sizeof(output));
    ck_assert_int_eq(result, -1);

    /* Test invalid day (32) */
    result = timezone_convert_time_with_offset("20250932150000", tz_offset, NULL, output, sizeof(output));
    ck_assert_int_eq(result, -1);

    /* Test invalid hour (24) */
    result = timezone_convert_time_with_offset("20250930240000", tz_offset, NULL, output, sizeof(output));
    ck_assert_int_eq(result, -1);

    /* Test invalid minute (60) */
    result = timezone_convert_time_with_offset("20250930156000", tz_offset, NULL, output, sizeof(output));
    ck_assert_int_eq(result, -1);

    /* Test invalid second (61) */
    result = timezone_convert_time_with_offset("20250930155961", tz_offset, NULL, output, sizeof(output));
    ck_assert_int_eq(result, -1);
}
END_TEST

START_TEST(test_convert_time_buffer_too_small)
{
    char output[10]; /* Too small */
    int result;
    int tz_offset = 0;

    result = timezone_convert_time_with_offset("20250930150000", tz_offset, NULL, output, sizeof(output));
    ck_assert_int_eq(result, -1);
}
END_TEST

START_TEST(test_convert_time_invalid_offset_range)
{
    char output[32];
    int result;
    int tz_offset = 100 * 3600; /* Way beyond valid range */

    result = timezone_convert_time_with_offset("20250930150000", tz_offset, NULL, output, sizeof(output));
    ck_assert_int_eq(result, -1);
}
END_TEST

START_TEST(test_format_time_null_inputs)
{
    char output[32];
    struct tm test_time;
    int result;

    memset(&test_time, 0, sizeof(test_time));
    test_time.tm_year = 125; /* 2025 */
    test_time.tm_mon = 8;    /* September */
    test_time.tm_mday = 30;

    /* Test NULL utc_time */
    result = timezone_format_time(NULL, NULL, output, sizeof(output));
    ck_assert_int_eq(result, -1);

    /* Test NULL output_time */
    result = timezone_format_time(&test_time, NULL, NULL, sizeof(output));
    ck_assert_int_eq(result, -1);
}
END_TEST

START_TEST(test_format_time_buffer_too_small)
{
    char output[10]; /* Too small */
    struct tm test_time;
    int result;

    memset(&test_time, 0, sizeof(test_time));
    test_time.tm_year = 125;
    test_time.tm_mon = 8;
    test_time.tm_mday = 30;

    result = timezone_format_time(&test_time, NULL, output, sizeof(output));
    ck_assert_int_eq(result, -1);
}
END_TEST

START_TEST(test_unix_timestamp_negative)
{
    char output[32];
    int result;
    time_t timestamp = -1; /* Invalid negative timestamp */

    result = timezone_convert_unix_timestamp_to_utc(timestamp, NULL, output, sizeof(output));
    ck_assert_int_eq(result, -1);
}
END_TEST

START_TEST(test_unix_timestamp_null_output)
{
    int result;
    time_t timestamp = 1727679660;

    result = timezone_convert_unix_timestamp_to_utc(timestamp, NULL, NULL, 32);
    ck_assert_int_eq(result, -1);
}
END_TEST

/* ========== Test Suite Setup ========== */

Suite *timezone_suite(void)
{
    Suite *s;
    TCase *tc_parse, *tc_format, *tc_convert_unix, *tc_convert_time, *tc_error_handling;

    s = suite_create("Timezone");

    /* Test case for timezone parsing */
    tc_parse = tcase_create("Parse");
    tcase_add_checked_fixture(tc_parse, setup, teardown);
    tcase_add_test(tc_parse, test_parse_timezone_utc_plus_offset);
    tcase_add_test(tc_parse, test_parse_timezone_utc_minus_offset);
    tcase_add_test(tc_parse, test_parse_timezone_utc_no_offset);
    tcase_add_test(tc_parse, test_parse_timezone_no_marker);
    tcase_add_test(tc_parse, test_parse_timezone_null_input);
    suite_add_tcase(s, tc_parse);

    /* Test case for time formatting */
    tc_format = tcase_create("Format");
    tcase_add_checked_fixture(tc_format, setup, teardown);
    tcase_add_test(tc_format, test_format_time_default_format);
    tcase_add_test(tc_format, test_format_time_custom_format);
    tcase_add_test(tc_format, test_format_time_null_input);
    suite_add_tcase(s, tc_format);

    /* Test case for Unix timestamp conversion */
    tc_convert_unix = tcase_create("ConvertUnix");
    tcase_add_checked_fixture(tc_convert_unix, setup, teardown);
    tcase_add_test(tc_convert_unix, test_convert_unix_timestamp);
    tcase_add_test(tc_convert_unix, test_convert_unix_timestamp_custom_format);
    suite_add_tcase(s, tc_convert_unix);

    /* Test case for time conversion with offset */
    tc_convert_time = tcase_create("ConvertTime");
    tcase_add_checked_fixture(tc_convert_time, setup, teardown);
    tcase_add_test(tc_convert_time, test_convert_time_with_utc_plus_8);
    tcase_add_test(tc_convert_time, test_convert_time_with_utc_minus_5);
    tcase_add_test(tc_convert_time, test_convert_time_with_zero_offset);
    tcase_add_test(tc_convert_time, test_convert_time_invalid_format);
    suite_add_tcase(s, tc_convert_time);

    /* Test case for error handling */
    tc_error_handling = tcase_create("ErrorHandling");
    tcase_add_checked_fixture(tc_error_handling, setup, teardown);
    tcase_add_test(tc_error_handling, test_parse_timezone_invalid_offset);
    tcase_add_test(tc_error_handling, test_convert_time_invalid_date_components);
    tcase_add_test(tc_error_handling, test_convert_time_buffer_too_small);
    tcase_add_test(tc_error_handling, test_convert_time_invalid_offset_range);
    tcase_add_test(tc_error_handling, test_format_time_null_inputs);
    tcase_add_test(tc_error_handling, test_format_time_buffer_too_small);
    tcase_add_test(tc_error_handling, test_unix_timestamp_negative);
    tcase_add_test(tc_error_handling, test_unix_timestamp_null_output);
    suite_add_tcase(s, tc_error_handling);

    return s;
}

int main(void)
{
    int number_failed;
    Suite *s;
    SRunner *sr;

    s = timezone_suite();
    sr = srunner_create(s);

    srunner_run_all(sr, CK_NORMAL);
    number_failed = srunner_ntests_failed(sr);
    srunner_free(sr);

    return (number_failed == 0) ? EXIT_SUCCESS : EXIT_FAILURE;
}
