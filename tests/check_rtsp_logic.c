/*
 * RTSP Logic Unit Tests - Pure logic testing without mocks
 */

#include <check.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "rtsp.h"
#include "rtp2httpd.h"
#include "mock_rtsp.h"

/* Test cases for RTSP session initialization */
START_TEST(test_rtsp_session_init)
{
    rtsp_session_t session;
    rtsp_session_init(&session);

    /* Test critical initialization values */
    ck_assert_int_eq(session.state, RTSP_STATE_INIT);
    ck_assert_int_eq(session.cseq, 1);
    ck_assert_int_eq(session.server_port, 554);
    ck_assert_int_eq(session.redirect_count, 0);
    ck_assert_str_eq(session.playseek_range, "");
}
END_TEST

/* Test cases for RTSP URL parsing */
START_TEST(test_rtsp_parse_url_basic)
{
    rtsp_session_t session;
    rtsp_session_init(&session);

    const char *rtsp_url = "rtsp://192.168.1.100:554/stream";
    int result = rtsp_parse_url(&session, rtsp_url, NULL);

    ck_assert_int_eq(result, 0);
    ck_assert_str_eq(session.server_host, "192.168.1.100");
    ck_assert_int_eq(session.server_port, 554);
    ck_assert_str_eq(session.server_path, "/stream");
    ck_assert_str_eq(session.server_url, rtsp_url);
    ck_assert_str_eq(session.playseek_range, "");
}
END_TEST

START_TEST(test_rtsp_parse_url_default_port)
{
    rtsp_session_t session;
    rtsp_session_init(&session);

    const char *rtsp_url = "rtsp://192.168.1.100/stream";
    int result = rtsp_parse_url(&session, rtsp_url, NULL);

    ck_assert_int_eq(result, 0);
    ck_assert_str_eq(session.server_host, "192.168.1.100");
    ck_assert_int_eq(session.server_port, 554);
    ck_assert_str_eq(session.server_path, "/stream");
}
END_TEST

START_TEST(test_rtsp_parse_url_no_path)
{
    rtsp_session_t session;
    rtsp_session_init(&session);

    const char *rtsp_url = "rtsp://192.168.1.100:554";
    int result = rtsp_parse_url(&session, rtsp_url, NULL);

    ck_assert_int_eq(result, 0);
    ck_assert_str_eq(session.server_host, "192.168.1.100");
    ck_assert_int_eq(session.server_port, 554);
    ck_assert_str_eq(session.server_path, "/");
}
END_TEST

START_TEST(test_rtsp_parse_url_with_query)
{
    rtsp_session_t session;
    rtsp_session_init(&session);

    const char *rtsp_url = "rtsp://192.168.1.100:554/stream?auth=test&user=123";
    int result = rtsp_parse_url(&session, rtsp_url, NULL);

    ck_assert_int_eq(result, 0);
    ck_assert_str_eq(session.server_host, "192.168.1.100");
    ck_assert_int_eq(session.server_port, 554);
    ck_assert_str_eq(session.server_path, "/stream?auth=test&user=123");
}
END_TEST

START_TEST(test_rtsp_parse_url_invalid_format)
{
    rtsp_session_t session;
    rtsp_session_init(&session);

    const char *invalid_url = "http://192.168.1.100:554/stream";
    int result = rtsp_parse_url(&session, invalid_url, NULL);

    ck_assert_int_eq(result, -1);
}
END_TEST

START_TEST(test_rtsp_parse_url_with_playseek_range)
{
    rtsp_session_t session;
    rtsp_session_init(&session);

    const char *rtsp_url = "rtsp://192.168.1.100:554/stream";
    const char *playseek = "20250928101100-20250928102200";
    int result = rtsp_parse_url(&session, rtsp_url, playseek);

    ck_assert_int_eq(result, 0);
    ck_assert_str_ne(session.playseek_range, "");
    /* Should contain clock= format */
    ck_assert_ptr_ne(strstr(session.playseek_range, "clock="), NULL);
}
END_TEST

START_TEST(test_rtsp_parse_url_with_playseek_single_time)
{
    rtsp_session_t session;
    rtsp_session_init(&session);

    const char *rtsp_url = "rtsp://192.168.1.100:554/stream";
    const char *playseek = "20250928101100";
    int result = rtsp_parse_url(&session, rtsp_url, playseek);

    ck_assert_int_eq(result, 0);
    ck_assert_str_ne(session.playseek_range, "");
    /* Should contain clock= format and end with dash */
    ck_assert_ptr_ne(strstr(session.playseek_range, "clock="), NULL);
    ck_assert_ptr_ne(strstr(session.playseek_range, "-"), NULL);
}
END_TEST

START_TEST(test_rtsp_parse_url_with_playseek_open_ended)
{
    rtsp_session_t session;
    rtsp_session_init(&session);

    const char *rtsp_url = "rtsp://192.168.1.100:554/stream";
    const char *playseek = "20250928101100-";
    int result = rtsp_parse_url(&session, rtsp_url, playseek);

    ck_assert_int_eq(result, 0);
    ck_assert_str_ne(session.playseek_range, "");
    /* Should contain clock= format and end with dash */
    ck_assert_ptr_ne(strstr(session.playseek_range, "clock="), NULL);
    ck_assert_ptr_ne(strstr(session.playseek_range, "-"), NULL);
}
END_TEST

START_TEST(test_rtsp_url_components)
{
    rtsp_session_t session;
    rtsp_session_init(&session);

    const char *rtsp_url = "rtsp://example.com:8554/path/to/stream?param=value";
    int result = rtsp_parse_url(&session, rtsp_url, NULL);

    ck_assert_int_eq(result, 0);
    ck_assert_str_eq(session.server_host, "example.com");
    ck_assert_int_eq(session.server_port, 8554);
    ck_assert_str_eq(session.server_path, "/path/to/stream?param=value");
    ck_assert_str_eq(session.server_url, rtsp_url);
}
END_TEST

START_TEST(test_rtsp_playseek_complex)
{
    rtsp_session_t session;
    const char *rtsp_url = "rtsp://192.168.1.100:554/stream";

    /* Test various playseek formats */
    const char *playseek_formats[] = {
        "20250928101100-20250928102200", /* Range with end */
        "20250928101100-",               /* Open-ended range */
        "20250928101100",                /* Single time */
        NULL};

    for (int i = 0; playseek_formats[i] != NULL; i++)
    {
        rtsp_session_init(&session);
        int result = rtsp_parse_url(&session, rtsp_url, playseek_formats[i]);

        ck_assert_int_eq(result, 0);
        ck_assert_str_ne(session.playseek_range, "");
        ck_assert_ptr_ne(strstr(session.playseek_range, "clock="), NULL);
    }
}
END_TEST

START_TEST(test_rtsp_hostname_edge_cases)
{
    rtsp_session_t session;

    /* Test hostname with no port */
    rtsp_session_init(&session);
    int result = rtsp_parse_url(&session, "rtsp://example.com/stream", NULL);
    ck_assert_int_eq(result, 0);
    ck_assert_str_eq(session.server_host, "example.com");
    ck_assert_int_eq(session.server_port, 554);

    /* Test IP address */
    rtsp_session_init(&session);
    result = rtsp_parse_url(&session, "rtsp://192.168.1.1:8080/stream", NULL);
    ck_assert_int_eq(result, 0);
    ck_assert_str_eq(session.server_host, "192.168.1.1");
    ck_assert_int_eq(session.server_port, 8080);

    /* Test localhost */
    rtsp_session_init(&session);
    result = rtsp_parse_url(&session, "rtsp://localhost:1234/stream", NULL);
    ck_assert_int_eq(result, 0);
    ck_assert_str_eq(session.server_host, "localhost");
    ck_assert_int_eq(session.server_port, 1234);
}
END_TEST

/* Test cases for error conditions */
START_TEST(test_rtsp_error_conditions)
{
    rtsp_session_t session;

    /* Test NULL URL */
    rtsp_session_init(&session);
    int result = rtsp_parse_url(&session, NULL, NULL);
    ck_assert_int_eq(result, -1);

    /* Test empty URL */
    rtsp_session_init(&session);
    result = rtsp_parse_url(&session, "", NULL);
    ck_assert_int_eq(result, -1);

    /* Test invalid protocol */
    rtsp_session_init(&session);
    result = rtsp_parse_url(&session, "http://example.com/stream", NULL);
    ck_assert_int_eq(result, -1);

    /* Test malformed URL */
    rtsp_session_init(&session);
    result = rtsp_parse_url(&session, "rtsp://", NULL);
    ck_assert_int_eq(result, -1);
}
END_TEST

START_TEST(test_rtsp_session_cleanup_sends_teardown)
{
    rtsp_session_t session;
    rtsp_session_init(&session);

    mock_reset_network();

    session.state = RTSP_STATE_PLAYING;
    session.socket = -1; /* Avoid touching real descriptors */
    strcpy(session.session_id, "session-123");
    strcpy(session.server_url, "rtsp://example.com/stream");

    rtsp_session_cleanup(&session);

    const char *sent_data = mock_get_send_buffer();
    ck_assert_ptr_ne(strstr(sent_data, "TEARDOWN"), NULL);
    ck_assert_ptr_ne(strstr(sent_data, "Session: session-123"), NULL);
    ck_assert_int_eq(session.state, RTSP_STATE_INIT);
    ck_assert_int_eq(session.tcp_buffer_pos, 0);
}
END_TEST

START_TEST(test_rtsp_session_cleanup_skips_teardown_when_idle)
{
    rtsp_session_t session;
    rtsp_session_init(&session);

    mock_reset_network();

    session.state = RTSP_STATE_CONNECTED;
    strcpy(session.session_id, "session-456");

    rtsp_session_cleanup(&session);

    const char *sent_data = mock_get_send_buffer();
    ck_assert_ptr_eq(strstr(sent_data, "TEARDOWN"), NULL);
    ck_assert_int_eq(session.state, RTSP_STATE_INIT);
}
END_TEST

START_TEST(test_rtsp_session_cleanup_is_idempotent)
{
    rtsp_session_t session;
    rtsp_session_init(&session);

    mock_reset_network();

    session.state = RTSP_STATE_SETUP;
    strcpy(session.session_id, "session-789");

    rtsp_session_cleanup(&session);

    const char *first_sent = mock_get_send_buffer();
    ck_assert_ptr_ne(strstr(first_sent, "TEARDOWN"), NULL);

    mock_reset_network();
    rtsp_session_cleanup(&session);

    const char *second_sent = mock_get_send_buffer();
    ck_assert_ptr_eq(strstr(second_sent, "TEARDOWN"), NULL);
    ck_assert_int_eq(session.state, RTSP_STATE_INIT);
}
END_TEST

/* Create test suite */
Suite *rtsp_logic_suite(void)
{
    Suite *s;
    TCase *tc_init, *tc_url_parsing, *tc_edge_cases, *tc_cleanup;

    s = suite_create("RTSP_Logic");

    /* RTSP Initialization test case */
    tc_init = tcase_create("Initialization");
    tcase_add_test(tc_init, test_rtsp_session_init);
    suite_add_tcase(s, tc_init);

    /* RTSP URL Parsing test case */
    tc_url_parsing = tcase_create("URL_Parsing");
    tcase_add_test(tc_url_parsing, test_rtsp_parse_url_basic);
    tcase_add_test(tc_url_parsing, test_rtsp_parse_url_default_port);
    tcase_add_test(tc_url_parsing, test_rtsp_parse_url_no_path);
    tcase_add_test(tc_url_parsing, test_rtsp_parse_url_with_query);
    tcase_add_test(tc_url_parsing, test_rtsp_parse_url_invalid_format);
    tcase_add_test(tc_url_parsing, test_rtsp_parse_url_with_playseek_range);
    tcase_add_test(tc_url_parsing, test_rtsp_parse_url_with_playseek_single_time);
    tcase_add_test(tc_url_parsing, test_rtsp_parse_url_with_playseek_open_ended);
    tcase_add_test(tc_url_parsing, test_rtsp_url_components);
    tcase_add_test(tc_url_parsing, test_rtsp_playseek_complex);
    tcase_add_test(tc_url_parsing, test_rtsp_hostname_edge_cases);
    suite_add_tcase(s, tc_url_parsing);

    /* RTSP Edge Cases test case */
    tc_edge_cases = tcase_create("Edge_Cases");
    tcase_add_test(tc_edge_cases, test_rtsp_error_conditions);
    suite_add_tcase(s, tc_edge_cases);

    /* RTSP Cleanup behavior */
    tc_cleanup = tcase_create("Cleanup");
    tcase_add_test(tc_cleanup, test_rtsp_session_cleanup_sends_teardown);
    tcase_add_test(tc_cleanup, test_rtsp_session_cleanup_skips_teardown_when_idle);
    tcase_add_test(tc_cleanup, test_rtsp_session_cleanup_is_idempotent);
    suite_add_tcase(s, tc_cleanup);

    return s;
}

int main(void)
{
    int number_failed;
    Suite *s;
    SRunner *sr;

    s = rtsp_logic_suite();
    sr = srunner_create(s);

    /* Run the tests */
    srunner_run_all(sr, CK_NORMAL);
    number_failed = srunner_ntests_failed(sr);
    srunner_free(sr);

    return (number_failed == 0) ? EXIT_SUCCESS : EXIT_FAILURE;
}
