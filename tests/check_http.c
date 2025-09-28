/*
 * Unit tests for HTTP module using Check framework
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

#include "http.h"
#include "rtp2httpd.h"

/* Mock socket for testing */
static int mock_socket_fd[2];
static char write_buffer[4096];
static size_t write_buffer_pos = 0;

/* Setup and teardown functions */
void setup(void)
{
    write_buffer_pos = 0;
    memset(write_buffer, 0, sizeof(write_buffer));

    /* Create a socket pair for testing */
    if (socketpair(AF_UNIX, SOCK_STREAM, 0, mock_socket_fd) == -1)
    {
        perror("socketpair");
        exit(1);
    }
}

void teardown(void)
{
    close(mock_socket_fd[0]);
    close(mock_socket_fd[1]);
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
    while ((bytes_read = read(fd, temp_buffer, sizeof(temp_buffer))) > 0)
    {
        if (write_buffer_pos + bytes_read < sizeof(write_buffer))
        {
            memcpy(write_buffer + write_buffer_pos, temp_buffer, bytes_read);
            write_buffer_pos += bytes_read;
        }
    }

    write_buffer[write_buffer_pos] = '\0';
}

/* Test cases for HTTP status codes and content types */
START_TEST(test_send_http_headers_200_ok)
{
    /* This test would need to be adapted based on the actual implementation */
    /* For now, we'll test basic functionality */

    /* Mock the write function behavior */
    send_http_headers(mock_socket_fd[1], STATUS_200, CONTENT_HTML);

    capture_write_output(mock_socket_fd[0]);

    /* Check that the output contains expected HTTP response parts */
    ck_assert_msg(strstr(write_buffer, "200 OK") != NULL,
                  "Response should contain '200 OK'");
    ck_assert_msg(strstr(write_buffer, "text/html") != NULL,
                  "Response should contain 'text/html' content type");
}
END_TEST

/* Combined test for various HTTP status codes */
START_TEST(test_send_http_headers_status_codes)
{
    /* Test 404 */
    send_http_headers(mock_socket_fd[1], STATUS_404, CONTENT_HTML);
    capture_write_output(mock_socket_fd[0]);
    ck_assert_msg(strstr(write_buffer, "404 Not Found") != NULL, "Should contain 404 status");

    /* Reset for next test */
    setup();

    /* Test 400 */
    send_http_headers(mock_socket_fd[1], STATUS_400, CONTENT_HTML);
    capture_write_output(mock_socket_fd[0]);
    ck_assert_msg(strstr(write_buffer, "400 Bad Request") != NULL, "Should contain 400 status");

    /* Reset for next test */
    setup();

    /* Test content type */
    send_http_headers(mock_socket_fd[1], STATUS_200, CONTENT_OSTREAM);
    capture_write_output(mock_socket_fd[0]);
    ck_assert_msg(strstr(write_buffer, "application/octet-stream") != NULL, "Should contain correct content type");
}
END_TEST

START_TEST(test_send_http_headers_different_content_types)
{
    send_http_headers(mock_socket_fd[1], STATUS_200, CONTENT_MPEGV);

    capture_write_output(mock_socket_fd[0]);

    ck_assert_msg(strstr(write_buffer, "video/mpeg") != NULL,
                  "Response should contain 'video/mpeg' content type");
}
END_TEST

START_TEST(test_send_http_headers_400_bad_request)
{
    send_http_headers(mock_socket_fd[1], STATUS_400, CONTENT_HTML);

    capture_write_output(mock_socket_fd[0]);

    ck_assert_msg(strstr(write_buffer, "400 Bad Request") != NULL,
                  "Response should contain '400 Bad Request'");
}
END_TEST

START_TEST(test_send_http_headers_501_not_implemented)
{
    send_http_headers(mock_socket_fd[1], STATUS_501, CONTENT_HTML);

    capture_write_output(mock_socket_fd[0]);

    ck_assert_msg(strstr(write_buffer, "501 Not Implemented") != NULL,
                  "Response should contain '501 Not Implemented'");
}
END_TEST

START_TEST(test_send_http_headers_503_service_unavailable)
{
    send_http_headers(mock_socket_fd[1], STATUS_503, CONTENT_HTML);

    capture_write_output(mock_socket_fd[0]);

    ck_assert_msg(strstr(write_buffer, "503 Service Unavailable") != NULL,
                  "Response should contain '503 Service Unavailable'");
}
END_TEST

START_TEST(test_send_http_headers_content_types)
{
    /* Test different content types */

    /* Test octet-stream */
    send_http_headers(mock_socket_fd[1], STATUS_200, CONTENT_OSTREAM);
    capture_write_output(mock_socket_fd[0]);
    ck_assert_msg(strstr(write_buffer, "application/octet-stream") != NULL,
                  "Response should contain 'application/octet-stream'");

    /* Reset buffer */
    setup();

    /* Test HTML with UTF-8 */
    send_http_headers(mock_socket_fd[1], STATUS_200, CONTENT_HTMLUTF);
    capture_write_output(mock_socket_fd[0]);
    ck_assert_msg(strstr(write_buffer, "text/html; charset=utf-8") != NULL,
                  "Response should contain 'text/html; charset=utf-8'");

    /* Reset buffer */
    setup();

    /* Test audio MPEG */
    send_http_headers(mock_socket_fd[1], STATUS_200, CONTENT_MPEGA);
    capture_write_output(mock_socket_fd[0]);
    ck_assert_msg(strstr(write_buffer, "audio/mpeg") != NULL,
                  "Response should contain 'audio/mpeg'");
}
END_TEST

START_TEST(test_send_http_headers_server_header)
{
    send_http_headers(mock_socket_fd[1], STATUS_200, CONTENT_HTML);

    capture_write_output(mock_socket_fd[0]);

    /* Check for server header */
    ck_assert_msg(strstr(write_buffer, "Server:") != NULL,
                  "Response should contain Server header");
}
END_TEST

START_TEST(test_write_to_client_basic)
{
    const char test_data[] = "Hello, World!";
    write_to_client(mock_socket_fd[1], (uint8_t *)test_data, strlen(test_data));

    capture_write_output(mock_socket_fd[0]);

    ck_assert_str_eq(write_buffer, test_data);
}
END_TEST

START_TEST(test_write_to_client_empty_buffer)
{
    const char test_data[] = "";
    write_to_client(mock_socket_fd[1], (uint8_t *)test_data, strlen(test_data));

    capture_write_output(mock_socket_fd[0]);

    ck_assert_str_eq(write_buffer, test_data);
}
END_TEST

START_TEST(test_write_to_client_large_buffer)
{
    char test_data[4096];
    memset(test_data, 'A', sizeof(test_data) - 1);
    test_data[sizeof(test_data) - 1] = '\0';

    write_to_client(mock_socket_fd[1], (uint8_t *)test_data, strlen(test_data));

    capture_write_output(mock_socket_fd[0]);

    ck_assert_int_eq(strlen(write_buffer), strlen(test_data));
}
END_TEST

/* Test cases for URL parsing */

/* Basic IPv4 address tests */
START_TEST(test_parse_udpxy_url_ipv4_with_port)
{
    char test_url[] = "/rtp/224.1.1.1:5004";
    struct services_s *result = parse_udpxy_url(test_url);

    ck_assert_ptr_ne(result, NULL);
    ck_assert_int_eq(result->service_type, SERVICE_MRTP);
    ck_assert_ptr_ne(result->addr, NULL);
    ck_assert_str_eq(result->msrc, "");
    ck_assert_ptr_eq(result->msrc_addr, NULL);
    ck_assert_ptr_eq(result->fcc_addr, NULL);
}
END_TEST

START_TEST(test_parse_udpxy_url_ipv4_no_port)
{
    char test_url[] = "/rtp/224.1.1.1";
    struct services_s *result = parse_udpxy_url(test_url);

    ck_assert_ptr_ne(result, NULL);
    ck_assert_int_eq(result->service_type, SERVICE_MRTP);
    ck_assert_ptr_ne(result->addr, NULL);
    /* Default port should be set to 1234 */
}
END_TEST

START_TEST(test_parse_udpxy_url_udp_service_type)
{
    char test_url[] = "/udp/224.1.1.1:5004";
    struct services_s *result = parse_udpxy_url(test_url);

    ck_assert_ptr_ne(result, NULL);
    ck_assert_int_eq(result->service_type, SERVICE_MUDP);
    ck_assert_ptr_ne(result->addr, NULL);
}
END_TEST

/* IPv6 address tests */
START_TEST(test_parse_udpxy_url_ipv6_with_port)
{
    char test_url[] = "/rtp/[ff05::1]:5004";
    struct services_s *result = parse_udpxy_url(test_url);

    ck_assert_ptr_ne(result, NULL);
    ck_assert_int_eq(result->service_type, SERVICE_MRTP);
    ck_assert_ptr_ne(result->addr, NULL);
}
END_TEST

START_TEST(test_parse_udpxy_url_ipv6_no_port)
{
    char test_url[] = "/rtp/[ff05::1]";
    struct services_s *result = parse_udpxy_url(test_url);

    ck_assert_ptr_ne(result, NULL);
    ck_assert_int_eq(result->service_type, SERVICE_MRTP);
    ck_assert_ptr_ne(result->addr, NULL);
}
END_TEST

/* Source address tests */
START_TEST(test_parse_udpxy_url_source_ipv4)
{
    char test_url[] = "/rtp/192.168.1.100@224.1.1.1:5004";
    struct services_s *result = parse_udpxy_url(test_url);

    ck_assert_ptr_ne(result, NULL);
    ck_assert_int_eq(result->service_type, SERVICE_MRTP);
    ck_assert_ptr_ne(result->addr, NULL);
    ck_assert_ptr_ne(result->msrc_addr, NULL);
    ck_assert_str_eq(result->msrc, "192.168.1.100");
}
END_TEST

START_TEST(test_parse_udpxy_url_source_ipv4_with_port)
{
    char test_url[] = "/rtp/192.168.1.100:5000@224.1.1.1:5004";
    struct services_s *result = parse_udpxy_url(test_url);

    ck_assert_ptr_ne(result, NULL);
    ck_assert_int_eq(result->service_type, SERVICE_MRTP);
    ck_assert_ptr_ne(result->addr, NULL);
    ck_assert_ptr_ne(result->msrc_addr, NULL);
    ck_assert_str_eq(result->msrc, "192.168.1.100:5000");
}
END_TEST

START_TEST(test_parse_udpxy_url_source_ipv6)
{
    char test_url[] = "/rtp/[2001:db8::1]@[ff05::1]:5004";
    struct services_s *result = parse_udpxy_url(test_url);

    ck_assert_ptr_ne(result, NULL);
    ck_assert_int_eq(result->service_type, SERVICE_MRTP);
    ck_assert_ptr_ne(result->addr, NULL);
    ck_assert_ptr_ne(result->msrc_addr, NULL);
    /* The actual implementation stores IPv6 addresses without brackets in msrc */
    ck_assert_str_eq(result->msrc, "2001:db8::1");
}
END_TEST

/* FCC parameter tests */
START_TEST(test_parse_udpxy_url_with_fcc)
{
    char test_url[] = "/rtp/224.1.1.1:5004?fcc=192.168.1.1:8080";
    struct services_s *result = parse_udpxy_url(test_url);

    ck_assert_ptr_ne(result, NULL);
    ck_assert_int_eq(result->service_type, SERVICE_MRTP);
    ck_assert_ptr_ne(result->addr, NULL);
    ck_assert_ptr_ne(result->fcc_addr, NULL);
}
END_TEST

START_TEST(test_parse_udpxy_url_with_fcc_ipv6)
{
    char test_url[] = "/rtp/224.1.1.1:5004?fcc=[2001:db8::1]:8080";
    struct services_s *result = parse_udpxy_url(test_url);

    ck_assert_ptr_ne(result, NULL);
    ck_assert_int_eq(result->service_type, SERVICE_MRTP);
    ck_assert_ptr_ne(result->addr, NULL);
    ck_assert_ptr_ne(result->fcc_addr, NULL);
}
END_TEST

/* Simplified URL encoding test - covers basic functionality */
START_TEST(test_parse_udpxy_url_encoded)
{
    char test_url[] = "/rtp/224.1.1.1%3A5004"; /* : is encoded as %3A */
    struct services_s *result = parse_udpxy_url(test_url);

    ck_assert_ptr_ne(result, NULL);
    ck_assert_int_eq(result->service_type, SERVICE_MRTP);
    ck_assert_ptr_ne(result->addr, NULL);
}
END_TEST

START_TEST(test_parse_udpxy_url_encoded_ipv6)
{
    char test_url[] = "/rtp/%5Bff05%3A%3A1%5D%3A5004"; /* [ff05::1]:5004 encoded */
    struct services_s *result = parse_udpxy_url(test_url);

    ck_assert_ptr_ne(result, NULL);
    ck_assert_int_eq(result->service_type, SERVICE_MRTP);
    ck_assert_ptr_ne(result->addr, NULL);
}
END_TEST

START_TEST(test_parse_udpxy_url_complex_encoded)
{
    char test_url[] = "/rtp/192.168.1.100%3A22%40224.1.1.1%3A5004?fcc=192.168.1.1%3A8080";
    /* 192.168.1.100:22@224.1.1.1:5004?fcc=192.168.1.1:8080 */
    struct services_s *result = parse_udpxy_url(test_url);

    ck_assert_ptr_ne(result, NULL);
    ck_assert_ptr_ne(result->msrc_addr, NULL);
    ck_assert_ptr_ne(result->fcc_addr, NULL);
}
END_TEST

/* RTSP URL Parsing tests */
START_TEST(test_parse_udpxy_url_rtsp_basic)
{
    char test_url[] = "/rtsp/192.168.1.100:554/path/to/stream";
    struct services_s *result = parse_udpxy_url(test_url);

    ck_assert_ptr_ne(result, NULL);
    ck_assert_int_eq(result->service_type, SERVICE_RTSP);
    ck_assert_ptr_ne(result->rtsp_url, NULL);
    ck_assert_str_eq(result->rtsp_url, "rtsp://192.168.1.100:554/path/to/stream");
    ck_assert_ptr_eq(result->playseek_param, NULL);
}
END_TEST

START_TEST(test_parse_udpxy_url_rtsp_with_query)
{
    char test_url[] = "/rtsp/10.255.75.73:554/008/ch24042317213873123947?AuthInfo=test&citycode=089801&usercode=1165898692";
    struct services_s *result = parse_udpxy_url(test_url);

    ck_assert_ptr_ne(result, NULL);
    ck_assert_int_eq(result->service_type, SERVICE_RTSP);
    ck_assert_ptr_ne(result->rtsp_url, NULL);
    ck_assert_str_eq(result->rtsp_url, "rtsp://10.255.75.73:554/008/ch24042317213873123947?AuthInfo=test&citycode=089801&usercode=1165898692");
    ck_assert_ptr_eq(result->playseek_param, NULL);
}
END_TEST

START_TEST(test_parse_udpxy_url_rtsp_with_playseek_first)
{
    char test_url[] = "/rtsp/10.255.75.73:554/008/stream?playseek=20250928170305-20250928170709&AuthInfo=test&usercode=123";
    struct services_s *result = parse_udpxy_url(test_url);

    ck_assert_ptr_ne(result, NULL);
    ck_assert_int_eq(result->service_type, SERVICE_RTSP);
    ck_assert_ptr_ne(result->rtsp_url, NULL);
    ck_assert_ptr_ne(result->playseek_param, NULL);

    /* playseek should be removed from RTSP URL */
    ck_assert_str_eq(result->rtsp_url, "rtsp://10.255.75.73:554/008/stream?AuthInfo=test&usercode=123");
    ck_assert_str_eq(result->playseek_param, "20250928170305-20250928170709");
}
END_TEST

START_TEST(test_parse_udpxy_url_rtsp_with_playseek_middle)
{
    char test_url[] = "/rtsp/10.255.75.73:554/008/stream?AuthInfo=test&playseek=20250928170305-20250928170709&usercode=123";
    struct services_s *result = parse_udpxy_url(test_url);

    ck_assert_ptr_ne(result, NULL);
    ck_assert_int_eq(result->service_type, SERVICE_RTSP);
    ck_assert_ptr_ne(result->rtsp_url, NULL);
    ck_assert_ptr_ne(result->playseek_param, NULL);

    /* playseek should be removed from RTSP URL */
    ck_assert_str_eq(result->rtsp_url, "rtsp://10.255.75.73:554/008/stream?AuthInfo=test&usercode=123");
    ck_assert_str_eq(result->playseek_param, "20250928170305-20250928170709");
}
END_TEST

START_TEST(test_parse_udpxy_url_rtsp_with_playseek_last)
{
    char test_url[] = "/rtsp/10.255.75.73:554/008/stream?AuthInfo=test&usercode=123&playseek=20250928170305-20250928170709";
    struct services_s *result = parse_udpxy_url(test_url);

    ck_assert_ptr_ne(result, NULL);
    ck_assert_int_eq(result->service_type, SERVICE_RTSP);
    ck_assert_ptr_ne(result->rtsp_url, NULL);
    ck_assert_ptr_ne(result->playseek_param, NULL);

    /* playseek should be removed from RTSP URL */
    ck_assert_str_eq(result->rtsp_url, "rtsp://10.255.75.73:554/008/stream?AuthInfo=test&usercode=123");
    ck_assert_str_eq(result->playseek_param, "20250928170305-20250928170709");
}
END_TEST

START_TEST(test_parse_udpxy_url_rtsp_playseek_only)
{
    char test_url[] = "/rtsp/10.255.75.73:554/008/stream?playseek=20250928170305-20250928170709";
    struct services_s *result = parse_udpxy_url(test_url);

    ck_assert_ptr_ne(result, NULL);
    ck_assert_int_eq(result->service_type, SERVICE_RTSP);
    ck_assert_ptr_ne(result->rtsp_url, NULL);
    ck_assert_ptr_ne(result->playseek_param, NULL);

    /* Query string should be completely removed when only playseek exists */
    ck_assert_str_eq(result->rtsp_url, "rtsp://10.255.75.73:554/008/stream");
    ck_assert_str_eq(result->playseek_param, "20250928170305-20250928170709");
}
END_TEST

START_TEST(test_parse_udpxy_url_rtsp_playseek_url_encoded)
{
    char test_url[] = "/rtsp/10.255.75.73:554/stream?AuthInfo=test%2Bdata&playseek=20250928170305%2D20250928170709&usercode=123";
    struct services_s *result = parse_udpxy_url(test_url);

    ck_assert_ptr_ne(result, NULL);
    ck_assert_int_eq(result->service_type, SERVICE_RTSP);
    ck_assert_ptr_ne(result->rtsp_url, NULL);
    ck_assert_ptr_ne(result->playseek_param, NULL);

    /* playseek should be URL decoded */
    ck_assert_str_eq(result->playseek_param, "20250928170305-20250928170709");
    /* RTSP URL should retain other encoded parameters */
    ck_assert_str_eq(result->rtsp_url, "rtsp://10.255.75.73:554/stream?AuthInfo=test%2Bdata&usercode=123");
}
END_TEST

START_TEST(test_parse_udpxy_url_rtsp_complex_real_world)
{
    char test_url[] = "/rtsp/10.255.75.73:554/008/ch24042317213873123947?AuthInfo=B0SOzn1w9QuGG8d8hIK2JGrl%2BESNqqgvBRWhlkhkUPqwPmKrzpzdqenh%2Fe%2BUQrbfm4%2FH652egSkFrnF76lHETw%3D%3D&citycode=089801&usercode=1165898692&Playtype=1&bp=0&BreakPoint=0&programid=ch00000000000000001131&contentid=ch00000000000000001131&videoid=ch12032909385864266262&recommendtype=0&userid=1165898692&boid=001&stbid=00100599050108602000CC242E987266&terminalflag=1&profilecode=&usersessionid=1124198467&playseek=20250928170305-20250928170709";
    struct services_s *result = parse_udpxy_url(test_url);

    ck_assert_ptr_ne(result, NULL);
    ck_assert_int_eq(result->service_type, SERVICE_RTSP);
    ck_assert_ptr_ne(result->rtsp_url, NULL);
    ck_assert_ptr_ne(result->playseek_param, NULL);

    ck_assert_str_eq(result->playseek_param, "20250928170305-20250928170709");
    /* Should not contain playseek parameter */
    ck_assert_ptr_eq(strstr(result->rtsp_url, "playseek="), NULL);
    /* Should contain all other parameters */
    ck_assert_ptr_ne(strstr(result->rtsp_url, "AuthInfo="), NULL);
    ck_assert_ptr_ne(strstr(result->rtsp_url, "citycode=089801"), NULL);
    ck_assert_ptr_ne(strstr(result->rtsp_url, "usersessionid=1124198467"), NULL);
}
END_TEST

START_TEST(test_parse_udpxy_url_rtsp_no_path)
{
    char test_url[] = "/rtsp/10.255.75.73:554";
    struct services_s *result = parse_udpxy_url(test_url);

    ck_assert_ptr_ne(result, NULL);
    ck_assert_int_eq(result->service_type, SERVICE_RTSP);
    ck_assert_ptr_ne(result->rtsp_url, NULL);
    ck_assert_str_eq(result->rtsp_url, "rtsp://10.255.75.73:554");
    ck_assert_ptr_eq(result->playseek_param, NULL);
}
END_TEST

START_TEST(test_parse_udpxy_url_rtsp_default_port)
{
    char test_url[] = "/rtsp/10.255.75.73/stream";
    struct services_s *result = parse_udpxy_url(test_url);

    ck_assert_ptr_ne(result, NULL);
    ck_assert_int_eq(result->service_type, SERVICE_RTSP);
    ck_assert_ptr_ne(result->rtsp_url, NULL);
    ck_assert_str_eq(result->rtsp_url, "rtsp://10.255.75.73/stream");
    ck_assert_ptr_eq(result->playseek_param, NULL);
}
END_TEST

/* RTSP Error handling tests */
START_TEST(test_parse_udpxy_url_rtsp_null_input)
{
    struct services_s *result = parse_udpxy_url(NULL);
    ck_assert_ptr_eq(result, NULL);
}
END_TEST

START_TEST(test_parse_udpxy_url_rtsp_empty_after_prefix)
{
    char test_url[] = "/rtsp/";
    struct services_s *result = parse_udpxy_url(test_url);
    ck_assert_ptr_eq(result, NULL);
}
END_TEST

START_TEST(test_parse_udpxy_url_rtsp_too_long)
{
    char test_url[1100]; /* Longer than buffer size */
    strcpy(test_url, "/rtsp/");
    /* Fill with 'A's to make it too long */
    memset(test_url + 6, 'A', sizeof(test_url) - 7);
    test_url[sizeof(test_url) - 1] = '\0';

    struct services_s *result = parse_udpxy_url(test_url);
    ck_assert_ptr_eq(result, NULL);
}
END_TEST

START_TEST(test_parse_udpxy_url_rtsp_malformed_playseek)
{
    char test_url[] = "/rtsp/10.255.75.73:554/stream?playseek=";
    struct services_s *result = parse_udpxy_url(test_url);

    ck_assert_ptr_ne(result, NULL);
    ck_assert_int_eq(result->service_type, SERVICE_RTSP);
    ck_assert_ptr_ne(result->rtsp_url, NULL);
    /* Empty playseek parameter should be handled gracefully */
    ck_assert_ptr_ne(result->playseek_param, NULL);
    ck_assert_str_eq(result->playseek_param, "");
}
END_TEST

START_TEST(test_parse_udpxy_url_rtsp_invalid_hex_encoding)
{
    char test_url[] = "/rtsp/10.255.75.73:554/stream?playseek=test%GG&other=123";
    struct services_s *result = parse_udpxy_url(test_url);

    ck_assert_ptr_ne(result, NULL);
    ck_assert_int_eq(result->service_type, SERVICE_RTSP);
    ck_assert_ptr_ne(result->rtsp_url, NULL);
    /* Invalid hex encoding should be left as-is */
    ck_assert_ptr_ne(result->playseek_param, NULL);
    ck_assert_str_eq(result->playseek_param, "test%GG");
}
END_TEST

/* Edge cases and error tests */
START_TEST(test_parse_udpxy_url_null_input)
{
    struct services_s *result = parse_udpxy_url(NULL);
    ck_assert_ptr_eq(result, NULL);
}
END_TEST

START_TEST(test_parse_udpxy_url_empty_string)
{
    char test_url[] = "";
    struct services_s *result = parse_udpxy_url(test_url);
    ck_assert_ptr_eq(result, NULL);
}
END_TEST

START_TEST(test_parse_udpxy_url_invalid_prefix)
{
    char test_url[] = "/invalid/224.1.1.1:5004";
    struct services_s *result = parse_udpxy_url(test_url);
    ck_assert_ptr_eq(result, NULL);
}
END_TEST

START_TEST(test_parse_udpxy_url_missing_address)
{
    char test_url[] = "/rtp/";
    struct services_s *result = parse_udpxy_url(test_url);
    ck_assert_ptr_eq(result, NULL);
}
END_TEST

START_TEST(test_parse_udpxy_url_invalid_ipv6_brackets)
{
    char test_url[] = "/rtp/[ff05::1:5004"; /* Missing closing bracket */
    struct services_s *result = parse_udpxy_url(test_url);
    ck_assert_ptr_eq(result, NULL);
}
END_TEST

START_TEST(test_parse_udpxy_url_invalid_encoding)
{
    char test_url[] = "/rtp/224.1.1.1%3"; /* Invalid hex encoding */
    struct services_s *result = parse_udpxy_url(test_url);
    ck_assert_ptr_eq(result, NULL);
}
END_TEST

START_TEST(test_parse_udpxy_url_too_long)
{
    char test_url[2048];
    memset(test_url, 'A', sizeof(test_url) - 1);
    test_url[sizeof(test_url) - 1] = '\0';
    strcpy(test_url, "/rtp/");

    struct services_s *result = parse_udpxy_url(test_url);
    ck_assert_ptr_eq(result, NULL);
}
END_TEST

START_TEST(test_parse_udpxy_url_malformed_source)
{
    char test_url[] = "/rtp/@224.1.1.1:5004"; /* Empty source */
    struct services_s *result = parse_udpxy_url(test_url);
    ck_assert_ptr_eq(result, NULL);
}
END_TEST

START_TEST(test_parse_udpxy_url_malformed_multicast)
{
    char test_url[] = "/rtp/192.168.1.1@"; /* Empty multicast */
    struct services_s *result = parse_udpxy_url(test_url);
    ck_assert_ptr_eq(result, NULL);
}
END_TEST

START_TEST(test_parse_udpxy_url_invalid_fcc_format)
{
    char test_url[] = "/rtp/224.1.1.1:5004?fcc="; /* Empty FCC value */
    struct services_s *result = parse_udpxy_url(test_url);
    /* Empty FCC parameter causes parsing failure */
    ck_assert_ptr_eq(result, NULL);
}
END_TEST

START_TEST(test_parse_udpxy_url_unresolvable_multicast)
{
    char test_url[] = "/rtp/not-a-real-hostname.invalid:5004";
    struct services_s *result = parse_udpxy_url(test_url);
    ck_assert_ptr_eq(result, NULL);
}
END_TEST

START_TEST(test_parse_udpxy_url_unresolvable_source)
{
    char test_url[] = "/rtp/invalid-source.invalid@224.1.1.1:5004";
    struct services_s *result = parse_udpxy_url(test_url);
    ck_assert_ptr_eq(result, NULL);
}
END_TEST

START_TEST(test_parse_udpxy_url_unresolvable_fcc)
{
    char test_url[] = "/rtp/224.1.1.1:5004?fcc=invalid-fcc.invalid";
    struct services_s *result = parse_udpxy_url(test_url);
    ck_assert_ptr_eq(result, NULL);
}
END_TEST

START_TEST(test_free_service_static_service)
{
    struct services_s *service = parse_udpxy_url("/rtp/224.1.1.1:5004");
    ck_assert_ptr_ne(service, NULL);
    ck_assert_ptr_ne(service->msrc, NULL);

    free_service(service);

    ck_assert_ptr_eq(service->msrc, NULL);

    struct services_s *service_again = parse_udpxy_url("/rtp/224.1.1.1:5004");
    ck_assert_ptr_eq(service_again, service);
}
END_TEST

START_TEST(test_free_service_rtsp_service)
{
    struct services_s *service = parse_udpxy_url("/rtsp/example.com:554/stream");
    ck_assert_ptr_ne(service, NULL);
    ck_assert_int_eq(service->service_type, SERVICE_RTSP);

    char *first_rtsp_url = strdup(service->rtsp_url);
    ck_assert_ptr_ne(first_rtsp_url, NULL);

    free_service(service);

    struct services_s *service_again = parse_udpxy_url("/rtsp/example.com:554/stream");
    ck_assert_ptr_ne(service_again, NULL);
    ck_assert_int_eq(service_again->service_type, SERVICE_RTSP);
    ck_assert_ptr_ne(service_again, service);
    ck_assert_str_eq(service_again->rtsp_url, first_rtsp_url);

    free(first_rtsp_url);
    free_service(service_again);
}
END_TEST

/* Hostname resolution tests */
START_TEST(test_parse_udpxy_url_hostname)
{
    char test_url[] = "/rtp/localhost:5004";
    struct services_s *result = parse_udpxy_url(test_url);

    /* This test may fail if localhost is not resolvable */
    if (result != NULL)
    {
        ck_assert_int_eq(result->service_type, SERVICE_MRTP);
        ck_assert_ptr_ne(result->addr, NULL);
    }
}
END_TEST

/* Create test suite */
Suite *http_suite(void)
{
    Suite *s;
    TCase *tc_headers, *tc_url_parsing_basic, *tc_url_parsing_ipv6, *tc_url_parsing_source;
    TCase *tc_url_parsing_fcc, *tc_url_parsing_encoding, *tc_url_parsing_edge_cases;
    TCase *tc_memory_management;
    TCase *tc_rtsp_parsing_basic, *tc_rtsp_parsing_playseek, *tc_rtsp_parsing_edge_cases;

    s = suite_create("HTTP");

    /* HTTP Headers test case */
    tc_headers = tcase_create("Headers");
    tcase_add_checked_fixture(tc_headers, setup, teardown);
    tcase_add_test(tc_headers, test_send_http_headers_200_ok);
    tcase_add_test(tc_headers, test_send_http_headers_status_codes);
    tcase_add_test(tc_headers, test_send_http_headers_content_types);
    tcase_add_test(tc_headers, test_send_http_headers_server_header);
    tcase_add_test(tc_headers, test_write_to_client_basic);
    tcase_add_test(tc_headers, test_write_to_client_empty_buffer);
    tcase_add_test(tc_headers, test_write_to_client_large_buffer);
    suite_add_tcase(s, tc_headers);

    /* Basic URL Parsing tests */
    tc_url_parsing_basic = tcase_create("URL_Parsing_Basic");
    tcase_add_test(tc_url_parsing_basic, test_parse_udpxy_url_ipv4_with_port);
    tcase_add_test(tc_url_parsing_basic, test_parse_udpxy_url_ipv4_no_port);
    tcase_add_test(tc_url_parsing_basic, test_parse_udpxy_url_udp_service_type);
    tcase_add_test(tc_url_parsing_basic, test_parse_udpxy_url_hostname);
    suite_add_tcase(s, tc_url_parsing_basic);

    /* IPv6 URL Parsing tests */
    tc_url_parsing_ipv6 = tcase_create("URL_Parsing_IPv6");
    tcase_add_test(tc_url_parsing_ipv6, test_parse_udpxy_url_ipv6_with_port);
    tcase_add_test(tc_url_parsing_ipv6, test_parse_udpxy_url_ipv6_no_port);
    suite_add_tcase(s, tc_url_parsing_ipv6);

    /* Source address URL Parsing tests */
    tc_url_parsing_source = tcase_create("URL_Parsing_Source");
    tcase_add_test(tc_url_parsing_source, test_parse_udpxy_url_source_ipv4);
    tcase_add_test(tc_url_parsing_source, test_parse_udpxy_url_source_ipv4_with_port);
    tcase_add_test(tc_url_parsing_source, test_parse_udpxy_url_source_ipv6);
    suite_add_tcase(s, tc_url_parsing_source);

    /* FCC parameter URL Parsing tests */
    tc_url_parsing_fcc = tcase_create("URL_Parsing_FCC");
    tcase_add_test(tc_url_parsing_fcc, test_parse_udpxy_url_with_fcc);
    tcase_add_test(tc_url_parsing_fcc, test_parse_udpxy_url_with_fcc_ipv6);
    tcase_add_test(tc_url_parsing_fcc, test_parse_udpxy_url_invalid_fcc_format);
    suite_add_tcase(s, tc_url_parsing_fcc);

    /* URL encoding tests */
    tc_url_parsing_encoding = tcase_create("URL_Parsing_Encoding");
    tcase_add_test(tc_url_parsing_encoding, test_parse_udpxy_url_encoded);
    suite_add_tcase(s, tc_url_parsing_encoding);

    /* Edge cases and error handling tests */
    tc_url_parsing_edge_cases = tcase_create("URL_Parsing_Edge_Cases");
    tcase_add_test(tc_url_parsing_edge_cases, test_parse_udpxy_url_null_input);
    tcase_add_test(tc_url_parsing_edge_cases, test_parse_udpxy_url_empty_string);
    tcase_add_test(tc_url_parsing_edge_cases, test_parse_udpxy_url_invalid_prefix);
    tcase_add_test(tc_url_parsing_edge_cases, test_parse_udpxy_url_missing_address);
    tcase_add_test(tc_url_parsing_edge_cases, test_parse_udpxy_url_invalid_ipv6_brackets);
    tcase_add_test(tc_url_parsing_edge_cases, test_parse_udpxy_url_invalid_encoding);
    tcase_add_test(tc_url_parsing_edge_cases, test_parse_udpxy_url_too_long);
    tcase_add_test(tc_url_parsing_edge_cases, test_parse_udpxy_url_malformed_source);
    tcase_add_test(tc_url_parsing_edge_cases, test_parse_udpxy_url_malformed_multicast);
    tcase_add_test(tc_url_parsing_edge_cases, test_parse_udpxy_url_unresolvable_multicast);
    tcase_add_test(tc_url_parsing_edge_cases, test_parse_udpxy_url_unresolvable_source);
    tcase_add_test(tc_url_parsing_edge_cases, test_parse_udpxy_url_unresolvable_fcc);
    suite_add_tcase(s, tc_url_parsing_edge_cases);

    /* Memory management tests */
    tc_memory_management = tcase_create("Memory_Management");
    tcase_add_test(tc_memory_management, test_free_service_static_service);
    tcase_add_test(tc_memory_management, test_free_service_rtsp_service);
    suite_add_tcase(s, tc_memory_management);

    /* RTSP Basic URL Parsing tests */
    tc_rtsp_parsing_basic = tcase_create("RTSP_Parsing_Basic");
    tcase_add_test(tc_rtsp_parsing_basic, test_parse_udpxy_url_rtsp_basic);
    tcase_add_test(tc_rtsp_parsing_basic, test_parse_udpxy_url_rtsp_with_query);
    tcase_add_test(tc_rtsp_parsing_basic, test_parse_udpxy_url_rtsp_no_path);
    tcase_add_test(tc_rtsp_parsing_basic, test_parse_udpxy_url_rtsp_default_port);
    suite_add_tcase(s, tc_rtsp_parsing_basic);

    /* RTSP Playseek Parameter tests */
    tc_rtsp_parsing_playseek = tcase_create("RTSP_Parsing_Playseek");
    tcase_add_test(tc_rtsp_parsing_playseek, test_parse_udpxy_url_rtsp_with_playseek_first);
    tcase_add_test(tc_rtsp_parsing_playseek, test_parse_udpxy_url_rtsp_with_playseek_middle);
    tcase_add_test(tc_rtsp_parsing_playseek, test_parse_udpxy_url_rtsp_with_playseek_last);
    tcase_add_test(tc_rtsp_parsing_playseek, test_parse_udpxy_url_rtsp_playseek_only);
    tcase_add_test(tc_rtsp_parsing_playseek, test_parse_udpxy_url_rtsp_playseek_url_encoded);
    tcase_add_test(tc_rtsp_parsing_playseek, test_parse_udpxy_url_rtsp_complex_real_world);
    suite_add_tcase(s, tc_rtsp_parsing_playseek);

    /* RTSP Edge cases and error handling tests */
    tc_rtsp_parsing_edge_cases = tcase_create("RTSP_Parsing_Edge_Cases");
    tcase_add_test(tc_rtsp_parsing_edge_cases, test_parse_udpxy_url_rtsp_null_input);
    tcase_add_test(tc_rtsp_parsing_edge_cases, test_parse_udpxy_url_rtsp_empty_after_prefix);
    tcase_add_test(tc_rtsp_parsing_edge_cases, test_parse_udpxy_url_rtsp_too_long);
    tcase_add_test(tc_rtsp_parsing_edge_cases, test_parse_udpxy_url_rtsp_malformed_playseek);
    tcase_add_test(tc_rtsp_parsing_edge_cases, test_parse_udpxy_url_rtsp_invalid_hex_encoding);
    suite_add_tcase(s, tc_rtsp_parsing_edge_cases);

    return s;
}

int main(void)
{
    int number_failed;
    Suite *s;
    SRunner *sr;

    s = http_suite();
    sr = srunner_create(s);

    /* Run the tests */
    srunner_run_all(sr, CK_NORMAL);
    number_failed = srunner_ntests_failed(sr);
    srunner_free(sr);

    return (number_failed == 0) ? EXIT_SUCCESS : EXIT_FAILURE;
}
