/*
 * Mock functions for RTSP testing
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdarg.h>
#include <unistd.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <netdb.h>
#include <errno.h>
#include "rtp2httpd.h"
#include "rtsp.h"
#include "mock_rtsp.h"

/* Mock global variables */
extern struct bindaddr_s *bind_addresses;
extern struct services_s *services;
extern int client_count;
extern enum loglevel conf_verbosity;

/* Mock network functions for testing */
static int mock_socket_return = -1;
static int mock_connect_return = -1;
static int mock_send_return = -1;
static int mock_recv_return = -1;
static char mock_recv_buffer[8192];
static size_t mock_recv_buffer_size = 0;
static size_t mock_recv_buffer_pos = 0;
static char mock_send_buffer[8192];
static size_t mock_send_buffer_pos = 0;

/* Mock hostent structure for gethostbyname */
static struct hostent mock_hostent;
static struct in_addr mock_addr;
static char *mock_addr_list[2];
static char mock_hostname[256];

/* Functions to set up mock behavior */
void mock_reset_network(void)
{
    mock_socket_return = -2; /* -2 means use default behavior */
    mock_connect_return = -2;
    mock_send_return = -2;
    mock_recv_return = -2;
    mock_recv_buffer_size = 0;
    mock_recv_buffer_pos = 0;
    mock_send_buffer_pos = 0;
    memset(mock_recv_buffer, 0, sizeof(mock_recv_buffer));
    memset(mock_send_buffer, 0, sizeof(mock_send_buffer));
}

void mock_set_socket_return(int ret)
{
    mock_socket_return = ret;
}

void mock_set_connect_return(int ret)
{
    mock_connect_return = ret;
}

void mock_set_send_return(int ret)
{
    mock_send_return = ret;
}

void mock_set_recv_data(const char *data, size_t size)
{
    if (size <= sizeof(mock_recv_buffer))
    {
        memcpy(mock_recv_buffer, data, size);
        mock_recv_buffer_size = size;
        mock_recv_buffer_pos = 0;
        /* Also reset the return value to allow data reading */
        mock_recv_return = -1;
    }
}

void mock_set_recv_return(int ret)
{
    mock_recv_return = ret;
}

const char *mock_get_send_buffer(void)
{
    return mock_send_buffer;
}

void mock_setup_hostname(const char *hostname, const char *ip_addr)
{
    strncpy(mock_hostname, hostname, sizeof(mock_hostname) - 1);
    mock_hostname[sizeof(mock_hostname) - 1] = '\0';

    inet_aton(ip_addr, &mock_addr);

    mock_hostent.h_name = mock_hostname;
    mock_hostent.h_aliases = NULL;
    mock_hostent.h_addrtype = AF_INET;
    mock_hostent.h_length = sizeof(struct in_addr);
    mock_addr_list[0] = (char *)&mock_addr;
    mock_addr_list[1] = NULL;
    mock_hostent.h_addr_list = mock_addr_list;
}

/* Mock implementation of socket functions */
#ifdef MOCK_NETWORK_FUNCTIONS

int socket(int domain, int type, int protocol)
{
    (void)domain;
    (void)type;
    (void)protocol;

    /* Always return the mock value, including -1 for failure */
    if (mock_socket_return != -2)
    { /* -2 means not set */
        return mock_socket_return;
    }

    /* Default behavior: return a valid mock socket descriptor */
    return 10; /* Mock socket descriptor */
}

int connect(int sockfd, const struct sockaddr *addr, socklen_t addrlen)
{
    (void)sockfd;
    (void)addr;
    (void)addrlen;

    if (mock_connect_return != -2)
    {
        return mock_connect_return;
    }

    /* Default: simulate successful connection */
    return 0;
}

ssize_t send(int sockfd, const void *buf, size_t len, int flags)
{
    (void)sockfd;
    (void)flags;

    /* Always copy sent data to mock buffer for verification */
    if (len <= sizeof(mock_send_buffer) - mock_send_buffer_pos)
    {
        memcpy(mock_send_buffer + mock_send_buffer_pos, buf, len);
        mock_send_buffer_pos += len;
        mock_send_buffer[mock_send_buffer_pos] = '\0';
    }

    if (mock_send_return != -2)
    {
        return mock_send_return;
    }

    /* Default behavior: return the length sent */
    return len;
}

ssize_t recv(int sockfd, void *buf, size_t len, int flags)
{
    (void)sockfd;
    (void)flags;

    /* Return mock data if available */
    if (mock_recv_buffer_pos < mock_recv_buffer_size)
    {
        size_t available = mock_recv_buffer_size - mock_recv_buffer_pos;
        size_t to_copy = (len < available) ? len : available;
        memcpy(buf, mock_recv_buffer + mock_recv_buffer_pos, to_copy);
        mock_recv_buffer_pos += to_copy;
        return to_copy;
    }

    if (mock_recv_return != -2)
    {
        return mock_recv_return;
    }

    /* Default: return empty data */
    return 0;
}

struct hostent *gethostbyname(const char *name)
{
    (void)name;

    if (mock_hostent.h_name && strcmp(name, mock_hostent.h_name) == 0)
    {
        return &mock_hostent;
    }

    /* Default: return localhost */
    mock_setup_hostname("localhost", "127.0.0.1");
    return &mock_hostent;
}

#endif /* MOCK_NETWORK_FUNCTIONS */

/* Mock RTP functions for testing */
int write_to_client(int client_fd, const uint8_t *data, size_t size)
{
    (void)client_fd;
    (void)data;
    (void)size;

    /* Mock implementation - just return success */
    return size;
}

int write_rtp_payload_to_client(int client_fd, int packet_size, const uint8_t *packet_data,
                                uint16_t *current_seqn, uint16_t *not_first_packet)
{
    (void)client_fd;
    (void)packet_size;
    (void)packet_data;
    (void)current_seqn;
    (void)not_first_packet;

    /* Mock implementation - just return success */
    return packet_size;
}

/* Simplified helper functions for test setup */
void setup_mock_rtsp_response(const char *status_line, const char *headers, const char *body)
{
    char response[4096];
    int len = snprintf(response, sizeof(response),
                       "%s\r\n%s\r\n\r\n%s",
                       status_line,
                       headers ? headers : "",
                       body ? body : "");

    mock_set_recv_data(response, len);
}

/* Standard RTSP responses for common test scenarios */
void setup_mock_rtsp_describe_response(void)
{
    const char *headers = "Content-Type: application/sdp\r\nContent-Length: 120\r\nCSeq: 1";
    const char *sdp_body = "v=0\r\no=- 0 0 IN IP4 192.168.1.100\r\ns=Test Stream\r\n"
                           "c=IN IP4 192.168.1.100\r\nt=0 0\r\nm=video 0 RTP/AVP 33\r\na=control:*\r\n";
    setup_mock_rtsp_response("RTSP/1.0 200 OK", headers, sdp_body);
}

void setup_mock_rtsp_setup_response(void)
{
    const char *headers = "Transport: MP2T/RTP/TCP;unicast;interleaved=0-1\r\nSession: 12345678\r\nCSeq: 2";
    setup_mock_rtsp_response("RTSP/1.0 200 OK", headers, NULL);
}

void setup_mock_rtsp_play_response(void)
{
    const char *headers = "Session: 12345678\r\nCSeq: 3";
    setup_mock_rtsp_response("RTSP/1.0 200 OK", headers, NULL);
}

/* Simple redirect and error response helpers */
void setup_mock_rtsp_redirect_response(const char *location)
{
    char headers[512];
    snprintf(headers, sizeof(headers), "Location: %s\r\nCSeq: 1", location);
    setup_mock_rtsp_response("RTSP/1.0 302 Found", headers, NULL);
}

void setup_mock_rtsp_error_response(int error_code, const char *error_message)
{
    char status_line[128];
    snprintf(status_line, sizeof(status_line), "RTSP/1.0 %d %s", error_code, error_message);
    setup_mock_rtsp_response(status_line, "CSeq: 1", NULL);
}
