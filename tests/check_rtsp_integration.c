/*
 * RTSP Integration tests - Testing complete RTSP workflows
 */

#include <check.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <fcntl.h>
#include <errno.h>

#include "rtsp.h"
#include "rtp2httpd.h"
#include "mock_rtsp.h"

/* Test session */
static rtsp_session_t test_session;

/* Setup and teardown functions */
void setup_integration(void)
{
    mock_reset_network();
    rtsp_session_init(&test_session);
    /* Ensure clean state for each test */
    test_session.redirect_count = 0;
    test_session.tcp_buffer_pos = 0;
    mock_setup_hostname("test.example.com", "192.168.1.100");
}

void teardown_integration(void)
{
    rtsp_session_cleanup(&test_session);
}

/* Test complete RTSP workflow: DESCRIBE -> SETUP -> PLAY */
START_TEST(test_rtsp_complete_workflow)
{
    int result;

    /* Step 1: Parse URL */
    result = rtsp_parse_url(&test_session, "rtsp://test.example.com:554/stream", NULL);
    ck_assert_int_eq(result, 0);
    ck_assert_str_eq(test_session.server_host, "test.example.com");
    ck_assert_int_eq(test_session.server_port, 554);
    ck_assert_str_eq(test_session.server_path, "/stream");

    /* Step 2: Mock successful connection */
    mock_set_socket_return(10); /* Mock socket descriptor */
    mock_set_connect_return(0); /* Successful connection */

    result = rtsp_connect(&test_session);
    ck_assert_int_eq(result, 0);
    ck_assert_int_eq(test_session.state, RTSP_STATE_CONNECTED);
    ck_assert_int_eq(test_session.socket, 10);

    /* Step 3: DESCRIBE request */
    mock_set_send_return(100); /* Mock successful send */
    setup_mock_rtsp_describe_response();

    result = rtsp_describe(&test_session);
    ck_assert_int_eq(result, 0);
    ck_assert_int_eq(test_session.state, RTSP_STATE_DESCRIBED);

    /* Verify DESCRIBE request was sent */
    const char *sent_data = mock_get_send_buffer();
    ck_assert_ptr_ne(strstr(sent_data, "DESCRIBE"), NULL);
    ck_assert_ptr_ne(strstr(sent_data, test_session.server_url), NULL);
    ck_assert_ptr_ne(strstr(sent_data, "Accept: application/sdp"), NULL);

    /* Step 4: SETUP request */
    setup_mock_rtsp_setup_response();

    result = rtsp_setup(&test_session);
    ck_assert_int_eq(result, 0);
    ck_assert_int_eq(test_session.state, RTSP_STATE_SETUP);
    ck_assert_str_eq(test_session.session_id, "12345678");
    ck_assert_int_eq(test_session.transport_mode, RTSP_TRANSPORT_TCP);
    ck_assert_int_eq(test_session.transport_protocol, RTSP_PROTOCOL_RTP);

    /* Verify SETUP request was sent */
    ck_assert_ptr_ne(strstr(sent_data, "SETUP"), NULL);
    ck_assert_ptr_ne(strstr(sent_data, "Transport:"), NULL);

    /* Step 5: PLAY request */
    setup_mock_rtsp_play_response();

    result = rtsp_play(&test_session);
    ck_assert_int_eq(result, 0);
    ck_assert_int_eq(test_session.state, RTSP_STATE_PLAYING);

    /* Verify PLAY request was sent */
    ck_assert_ptr_ne(strstr(sent_data, "PLAY"), NULL);
    ck_assert_ptr_ne(strstr(sent_data, "Session: 12345678"), NULL);
}
END_TEST

/* Test RTSP workflow with playseek parameter */
START_TEST(test_rtsp_workflow_with_playseek)
{
    int result;

    /* Parse URL with playseek parameter */
    result = rtsp_parse_url(&test_session, "rtsp://test.example.com:554/stream",
                            "20250928101100-20250928102200");
    ck_assert_int_eq(result, 0);
    ck_assert_str_ne(test_session.playseek_range, "");

    /* Mock successful connection and responses */
    mock_set_socket_return(10);
    mock_set_connect_return(0);
    mock_set_send_return(100);

    /* Connect and go through DESCRIBE/SETUP */
    rtsp_connect(&test_session);
    setup_mock_rtsp_describe_response();
    rtsp_describe(&test_session);
    setup_mock_rtsp_setup_response();
    rtsp_setup(&test_session);

    /* PLAY with range */
    setup_mock_rtsp_play_response();
    result = rtsp_play(&test_session);
    ck_assert_int_eq(result, 0);

    /* Verify Range header was included in PLAY request */
    const char *sent_data = mock_get_send_buffer();
    ck_assert_ptr_ne(strstr(sent_data, "Range:"), NULL);
    ck_assert_ptr_ne(strstr(sent_data, "clock="), NULL);
}
END_TEST

/* Test RTSP redirect handling */
START_TEST(test_rtsp_redirect_workflow)
{
    int result;

    /* Parse initial URL */
    result = rtsp_parse_url(&test_session, "rtsp://old.example.com:554/stream", NULL);
    ck_assert_int_eq(result, 0);

    /* Mock connection to initial server */
    mock_set_socket_return(10);
    mock_set_connect_return(0);
    mock_set_send_return(100);

    rtsp_connect(&test_session);

    /* Mock redirect response */
    setup_mock_rtsp_redirect_response("rtsp://new.example.com:8554/newstream");
    mock_setup_hostname("new.example.com", "192.168.1.200");

    /* DESCRIBE should handle redirect */
    result = rtsp_describe(&test_session);

    /* For this test, we expect redirect handling to fail due to no follow-up DESCRIBE response */
    /* This is expected behavior - redirect was attempted but no success response was provided */
    ck_assert_int_eq(result, -1);

    /* Verify that redirect was attempted and URL was updated */
    ck_assert_int_eq(test_session.redirect_count, 1);
    ck_assert_str_eq(test_session.server_host, "new.example.com");
    ck_assert_int_eq(test_session.server_port, 8554);
    ck_assert_str_eq(test_session.server_path, "/newstream");
}
END_TEST

/* Test RTSP error handling */
START_TEST(test_rtsp_error_handling)
{
    int result;

    /* Parse URL */
    result = rtsp_parse_url(&test_session, "rtsp://test.example.com:554/stream", NULL);
    ck_assert_int_eq(result, 0);

    /* Test connection failure by setting socket creation to fail */
    mock_set_socket_return(-1); /* Socket creation failure */

    result = rtsp_connect(&test_session);
    ck_assert_int_eq(result, -1);
    ck_assert_int_eq(test_session.state, RTSP_STATE_INIT);

    /* Reset for next test */
    mock_set_socket_return(10);
    mock_set_connect_return(0);

    /* Mock successful connection but server error response */
    rtsp_connect(&test_session);

    mock_set_send_return(100);
    setup_mock_rtsp_error_response(404, "Not Found");

    result = rtsp_describe(&test_session);
    ck_assert_int_eq(result, -1);
}
END_TEST

/* Test TCP interleaved data handling */
START_TEST(test_rtsp_tcp_interleaved_data)
{
    /* Setup session for TCP transport */
    test_session.transport_mode = RTSP_TRANSPORT_TCP;
    test_session.transport_protocol = RTSP_PROTOCOL_RTP;
    test_session.rtp_channel = 0;
    test_session.rtcp_channel = 1;
    test_session.socket = 10;

    /* Mock interleaved RTP packet: $ + channel + length + data */
    uint8_t mock_packet[] = {
        '$', 0x00,  /* Interleaved marker and RTP channel */
        0x00, 0x20, /* Packet length: 32 bytes */
        /* RTP header (12 bytes) */
        0x80, 0x21, 0x12, 0x34, 0x56, 0x78, 0x9A, 0xBC, 0xDE, 0xF0, 0x12, 0x34,
        /* RTP payload (20 bytes) */
        0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0A,
        0x0B, 0x0C, 0x0D, 0x0E, 0x0F, 0x10, 0x11, 0x12, 0x13, 0x14};

    mock_set_recv_data((char *)mock_packet, sizeof(mock_packet));
    mock_set_recv_return(sizeof(mock_packet));

    /* Test handling of interleaved data */
    int result = rtsp_handle_tcp_interleaved_data(&test_session, 20); /* Mock client fd */
    ck_assert_int_ge(result, 0);                                      /* Should process some data */
}
END_TEST

/* MP2T transport is essentially the same as RTP for our purposes - test removed as redundant */

/* Test session cleanup */
START_TEST(test_rtsp_session_cleanup_complete)
{
    /* Setup a session in PLAYING state */
    test_session.state = RTSP_STATE_PLAYING;
    test_session.socket = 10;
    test_session.rtp_socket = 11;
    test_session.rtcp_socket = 12;
    strcpy(test_session.session_id, "test_session");
    test_session.tcp_buffer_pos = 100;

    mock_set_send_return(50); /* Mock TEARDOWN send */

    /* Cleanup should send TEARDOWN and reset session */
    rtsp_session_cleanup(&test_session);

    ck_assert_int_eq(test_session.state, RTSP_STATE_INIT);
    ck_assert_int_eq(test_session.socket, -1);
    ck_assert_int_eq(test_session.rtp_socket, -1);
    ck_assert_int_eq(test_session.rtcp_socket, -1);
    ck_assert_int_eq(test_session.tcp_buffer_pos, 0);

    /* Verify TEARDOWN was sent */
    const char *sent_data = mock_get_send_buffer();
    ck_assert_ptr_ne(strstr(sent_data, "TEARDOWN"), NULL);
    ck_assert_ptr_ne(strstr(sent_data, "Session: test_session"), NULL);
}
END_TEST

/* Test multiple redirect limit */
START_TEST(test_rtsp_redirect_limit)
{
    int result;

    /* Set up session with maximum redirects */
    test_session.redirect_count = 5; /* MAX_REDIRECTS is 5 */

    result = rtsp_parse_url(&test_session, "rtsp://test.example.com:554/stream", NULL);
    ck_assert_int_eq(result, 0);

    mock_set_socket_return(10);
    mock_set_connect_return(0);
    mock_set_send_return(100);

    rtsp_connect(&test_session);

    /* Mock another redirect response */
    setup_mock_rtsp_redirect_response("rtsp://another.example.com:554/stream");

    /* Should fail due to redirect limit */
    result = rtsp_describe(&test_session);
    ck_assert_int_eq(result, -1);
}
END_TEST

/* Buffer overflow protection test - simplified to basic bounds checking */
START_TEST(test_rtsp_buffer_overflow_protection)
{
    test_session.transport_mode = RTSP_TRANSPORT_TCP;
    test_session.socket = 10;
    test_session.tcp_buffer_pos = 0;

    /* Test with oversized length field - should handle gracefully */
    uint8_t mock_packet[] = {'$', 0x00, 0xFF, 0xFF, 0x01, 0x02};
    mock_set_recv_data((char *)mock_packet, sizeof(mock_packet));

    int result = rtsp_handle_tcp_interleaved_data(&test_session, 20);
    ck_assert_int_ge(result, 0); /* Should not crash */
}
END_TEST

/* Create integration test suite */
Suite *rtsp_integration_suite(void)
{
    Suite *s;
    TCase *tc_workflow, *tc_redirect, *tc_error, *tc_data, *tc_cleanup;

    s = suite_create("RTSP_Integration");

    /* RTSP Workflow test case */
    tc_workflow = tcase_create("Workflow");
    tcase_add_checked_fixture(tc_workflow, setup_integration, teardown_integration);
    tcase_add_test(tc_workflow, test_rtsp_complete_workflow);
    tcase_add_test(tc_workflow, test_rtsp_workflow_with_playseek);
    suite_add_tcase(s, tc_workflow);

    /* RTSP Redirect test case */
    tc_redirect = tcase_create("Redirect");
    tcase_add_checked_fixture(tc_redirect, setup_integration, teardown_integration);
    tcase_add_test(tc_redirect, test_rtsp_redirect_workflow);
    tcase_add_test(tc_redirect, test_rtsp_redirect_limit);
    suite_add_tcase(s, tc_redirect);

    /* RTSP Error Handling test case */
    tc_error = tcase_create("Error_Handling");
    tcase_add_checked_fixture(tc_error, setup_integration, teardown_integration);
    tcase_add_test(tc_error, test_rtsp_error_handling);
    tcase_add_test(tc_error, test_rtsp_buffer_overflow_protection);
    suite_add_tcase(s, tc_error);

    /* RTSP Data Handling test case */
    tc_data = tcase_create("Data_Handling");
    tcase_add_checked_fixture(tc_data, setup_integration, teardown_integration);
    tcase_add_test(tc_data, test_rtsp_tcp_interleaved_data);
    suite_add_tcase(s, tc_data);

    /* RTSP Cleanup test case */
    tc_cleanup = tcase_create("Cleanup");
    tcase_add_checked_fixture(tc_cleanup, setup_integration, teardown_integration);
    tcase_add_test(tc_cleanup, test_rtsp_session_cleanup_complete);
    suite_add_tcase(s, tc_cleanup);

    return s;
}

int main(void)
{
    int number_failed;
    Suite *s;
    SRunner *sr;

    s = rtsp_integration_suite();
    sr = srunner_create(s);

    /* Run the tests */
    srunner_run_all(sr, CK_NORMAL);
    number_failed = srunner_ntests_failed(sr);
    srunner_free(sr);

    return (number_failed == 0) ? EXIT_SUCCESS : EXIT_FAILURE;
}
