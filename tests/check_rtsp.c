/*
 * Unit tests for RTSP module using Check framework
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

/* Mock socket for testing */
static int mock_socket_fd[2];
static char write_buffer[8192];
static size_t write_buffer_pos = 0;

/* Mock data for testing */
static rtsp_session_t test_session;

/* Setup and teardown functions */
void setup(void)
{
    write_buffer_pos = 0;
    memset(write_buffer, 0, sizeof(write_buffer));

    /* Create a socket pair for testing */
    if (socketpair(AF_UNIX, SOCK_STREAM, 0, mock_socket_fd) == -1) {
        perror("socketpair");
        exit(1);
    }

    /* Initialize test session */
    rtsp_session_init(&test_session);
}

void teardown(void)
{
    close(mock_socket_fd[0]);
    close(mock_socket_fd[1]);

    /* Clean up test session */
    rtsp_session_cleanup(&test_session);
}

/* Test helper function to capture write output */
static void capture_write_output(int fd)
{
    char temp_buffer[1024];
    ssize_t bytes_read;

    write_buffer_pos = 0;

    /* Set socket to non-blocking for testing */
    int flags = fcntl(fd, F_GETFL, 0);
    fcntl(fd, F_SETFL, flags | O_NONBLOCK);

    /* Read all available data */
    while ((bytes_read = read(fd, temp_buffer, sizeof(temp_buffer))) > 0) {
        if (write_buffer_pos + bytes_read < sizeof(write_buffer)) {
            memcpy(write_buffer + write_buffer_pos, temp_buffer, bytes_read);
            write_buffer_pos += bytes_read;
        }
    }

    write_buffer[write_buffer_pos] = '\0';
}

/* Test cases for RTSP session initialization */
START_TEST(test_rtsp_session_init)
{
    rtsp_session_t session;
    rtsp_session_init(&session);

    ck_assert_int_eq(session.state, RTSP_STATE_INIT);
    ck_assert_int_eq(session.socket, -1);
    ck_assert_int_eq(session.rtp_socket, -1);
    ck_assert_int_eq(session.rtcp_socket, -1);
    ck_assert_int_eq(session.cseq, 1);
    ck_assert_int_eq(session.server_port, 554);
    ck_assert_int_eq(session.redirect_count, 0);
    ck_assert_int_eq(session.transport_mode, RTSP_TRANSPORT_TCP);
    ck_assert_int_eq(session.transport_protocol, RTSP_PROTOCOL_RTP);
    ck_assert_int_eq(session.rtp_channel, 0);
    ck_assert_int_eq(session.rtcp_channel, 1);
    ck_assert_int_eq(session.tcp_buffer_pos, 0);
    ck_assert_int_eq(session.current_seqn, 0);
    ck_assert_int_eq(session.not_first_packet, 0);
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

/* Test cases for RTSP state management */
START_TEST(test_rtsp_state_transitions)
{
    rtsp_session_t session;
    rtsp_session_init(&session);

    /* Initial state should be INIT */
    ck_assert_int_eq(session.state, RTSP_STATE_INIT);

    /* Simulate state transitions */
    session.state = RTSP_STATE_CONNECTED;
    ck_assert_int_eq(session.state, RTSP_STATE_CONNECTED);

    session.state = RTSP_STATE_DESCRIBED;
    ck_assert_int_eq(session.state, RTSP_STATE_DESCRIBED);

    session.state = RTSP_STATE_SETUP;
    ck_assert_int_eq(session.state, RTSP_STATE_SETUP);

    session.state = RTSP_STATE_PLAYING;
    ck_assert_int_eq(session.state, RTSP_STATE_PLAYING);
}
END_TEST

/* Test cases for transport mode configuration */
START_TEST(test_rtsp_transport_modes)
{
    rtsp_session_t session;
    rtsp_session_init(&session);

    /* Default should be TCP transport */
    ck_assert_int_eq(session.transport_mode, RTSP_TRANSPORT_TCP);
    ck_assert_int_eq(session.transport_protocol, RTSP_PROTOCOL_RTP);

    /* Test UDP transport */
    session.transport_mode = RTSP_TRANSPORT_UDP;
    ck_assert_int_eq(session.transport_mode, RTSP_TRANSPORT_UDP);

    /* Test MP2T protocol */
    session.transport_protocol = RTSP_PROTOCOL_MP2T;
    ck_assert_int_eq(session.transport_protocol, RTSP_PROTOCOL_MP2T);
}
END_TEST

/* Test cases for RTP sequence number tracking */
START_TEST(test_rtsp_rtp_sequence_tracking)
{
    rtsp_session_t session;
    rtsp_session_init(&session);

    /* Initial values */
    ck_assert_int_eq(session.current_seqn, 0);
    ck_assert_int_eq(session.not_first_packet, 0);

    /* Simulate sequence number updates */
    session.current_seqn = 1234;
    session.not_first_packet = 1;

    ck_assert_int_eq(session.current_seqn, 1234);
    ck_assert_int_eq(session.not_first_packet, 1);
}
END_TEST

/* Test cases for TCP interleaved channels */
START_TEST(test_rtsp_tcp_interleaved_channels)
{
    rtsp_session_t session;
    rtsp_session_init(&session);

    /* Default channels */
    ck_assert_int_eq(session.rtp_channel, 0);
    ck_assert_int_eq(session.rtcp_channel, 1);

    /* Test custom channels */
    session.rtp_channel = 2;
    session.rtcp_channel = 3;

    ck_assert_int_eq(session.rtp_channel, 2);
    ck_assert_int_eq(session.rtcp_channel, 3);
}
END_TEST

/* Test cases for buffer management */
START_TEST(test_rtsp_buffer_initialization)
{
    rtsp_session_t session;
    rtsp_session_init(&session);

    /* TCP buffer position should be initialized to 0 */
    ck_assert_int_eq(session.tcp_buffer_pos, 0);

    /* Test buffer position updates */
    session.tcp_buffer_pos = 100;
    ck_assert_int_eq(session.tcp_buffer_pos, 100);

    /* Reset buffer position */
    session.tcp_buffer_pos = 0;
    ck_assert_int_eq(session.tcp_buffer_pos, 0);
}
END_TEST

/* Test cases for session cleanup */
START_TEST(test_rtsp_session_cleanup)
{
    rtsp_session_t session;
    rtsp_session_init(&session);

    /* Set some values to test cleanup */
    session.state = RTSP_STATE_PLAYING;
    session.tcp_buffer_pos = 100;
    strcpy(session.session_id, "test_session");

    /* Clean up session */
    rtsp_session_cleanup(&session);

    /* Check that state is reset */
    ck_assert_int_eq(session.state, RTSP_STATE_INIT);
    ck_assert_int_eq(session.tcp_buffer_pos, 0);
    /* Socket descriptors should be -1 (already closed or never opened in test) */
    ck_assert_int_eq(session.socket, -1);
    ck_assert_int_eq(session.rtp_socket, -1);
    ck_assert_int_eq(session.rtcp_socket, -1);
}
END_TEST

/* Test cases for session ID handling */
START_TEST(test_rtsp_session_id)
{
    rtsp_session_t session;
    rtsp_session_init(&session);

    /* Initially session ID should be empty */
    ck_assert_str_eq(session.session_id, "");

    /* Set session ID */
    strcpy(session.session_id, "test_session_123");
    ck_assert_str_eq(session.session_id, "test_session_123");

    /* Test session ID length limit */
    char long_session_id[256];
    memset(long_session_id, 'A', sizeof(long_session_id) - 1);
    long_session_id[sizeof(long_session_id) - 1] = '\0';

    strncpy(session.session_id, long_session_id, sizeof(session.session_id) - 1);
    session.session_id[sizeof(session.session_id) - 1] = '\0';

    /* Should be truncated to buffer size */
    ck_assert_int_lt(strlen(session.session_id), sizeof(long_session_id));
}
END_TEST

/* Test cases for URL components */
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

/* Test cases for complex playseek scenarios */
START_TEST(test_rtsp_playseek_complex)
{
    rtsp_session_t session;
    rtsp_session_init(&session);

    const char *rtsp_url = "rtsp://192.168.1.100:554/stream";

    /* Test various playseek formats */
    const char *playseek_formats[] = {
        "20250928101100-20250928102200",  /* Range with end */
        "20250928101100-",                /* Open-ended range */
        "20250928101100",                 /* Single time */
        NULL
    };

    for (int i = 0; playseek_formats[i] != NULL; i++) {
        rtsp_session_init(&session);
        int result = rtsp_parse_url(&session, rtsp_url, playseek_formats[i]);

        ck_assert_int_eq(result, 0);
        ck_assert_str_ne(session.playseek_range, "");
        ck_assert_ptr_ne(strstr(session.playseek_range, "clock="), NULL);
    }
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

/* Test cases for edge cases in hostname parsing */
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

/* Create test suite */
Suite * rtsp_suite(void)
{
    Suite *s;
    TCase *tc_init, *tc_url_parsing, *tc_state_management, *tc_transport;
    TCase *tc_buffers, *tc_cleanup, *tc_edge_cases;

    s = suite_create("RTSP");

    /* RTSP Initialization test case */
    tc_init = tcase_create("Initialization");
    tcase_add_checked_fixture(tc_init, setup, teardown);
    tcase_add_test(tc_init, test_rtsp_session_init);
    tcase_add_test(tc_init, test_rtsp_buffer_initialization);
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

    /* RTSP State Management test case */
    tc_state_management = tcase_create("State_Management");
    tcase_add_test(tc_state_management, test_rtsp_state_transitions);
    tcase_add_test(tc_state_management, test_rtsp_session_id);
    suite_add_tcase(s, tc_state_management);

    /* RTSP Transport test case */
    tc_transport = tcase_create("Transport");
    tcase_add_test(tc_transport, test_rtsp_transport_modes);
    tcase_add_test(tc_transport, test_rtsp_rtp_sequence_tracking);
    tcase_add_test(tc_transport, test_rtsp_tcp_interleaved_channels);
    suite_add_tcase(s, tc_transport);

    /* RTSP Buffer Management test case */
    tc_buffers = tcase_create("Buffers");
    tcase_add_test(tc_buffers, test_rtsp_buffer_initialization);
    suite_add_tcase(s, tc_buffers);

    /* RTSP Cleanup test case */
    tc_cleanup = tcase_create("Cleanup");
    tcase_add_test(tc_cleanup, test_rtsp_session_cleanup);
    suite_add_tcase(s, tc_cleanup);

    /* RTSP Edge Cases test case */
    tc_edge_cases = tcase_create("Edge_Cases");
    tcase_add_test(tc_edge_cases, test_rtsp_error_conditions);
    suite_add_tcase(s, tc_edge_cases);

    return s;
}

int main(void)
{
    int number_failed;
    Suite *s;
    SRunner *sr;

    s = rtsp_suite();
    sr = srunner_create(s);

    /* Run the tests */
    srunner_run_all(sr, CK_NORMAL);
    number_failed = srunner_ntests_failed(sr);
    srunner_free(sr);

    return (number_failed == 0) ? EXIT_SUCCESS : EXIT_FAILURE;
}
