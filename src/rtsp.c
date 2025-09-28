#ifdef HAVE_CONFIG_H
#include "config.h"
#endif /* HAVE_CONFIG_H */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <unistd.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <netdb.h>
#include "rtsp.h"
#include "rtp2httpd.h"
#include "http.h"
#include "rtp.h"

/*
 * RTSP Client Implementation
 */

/* RTSP version and user agent */
#define RTSP_VERSION "RTSP/1.0"
#define USER_AGENT "rtp2httpd/" VERSION
#define MAX_REDIRECTS 5

/* Helper function prototypes */
static int rtsp_send_request(rtsp_session_t *session, const char *method, const char *extra_headers);
static int rtsp_receive_response(rtsp_session_t *session);
static int rtsp_parse_response(rtsp_session_t *session, const char *response);
static int rtsp_setup_udp_sockets(rtsp_session_t *session);
static char *rtsp_find_header(const char *response, const char *header_name);
static void rtsp_parse_transport_header(rtsp_session_t *session, const char *transport);
static int rtsp_handle_redirect(rtsp_session_t *session, const char *location);
static void rtsp_format_time_to_iso8601(const char *input_time, char *output_time, size_t output_size);

void rtsp_session_init(rtsp_session_t *session)
{
    memset(session, 0, sizeof(rtsp_session_t));
    session->state = RTSP_STATE_INIT;
    session->socket = -1;
    session->rtp_socket = -1;
    session->rtcp_socket = -1;
    session->cseq = 1;
    session->server_port = 554; /* Default RTSP port */
    session->redirect_count = 0;

    /* Initialize transport parameters - mode will be negotiated during SETUP */
    session->transport_mode = RTSP_TRANSPORT_TCP;    /* Default preference */
    session->transport_protocol = RTSP_PROTOCOL_RTP; /* Default protocol */
    session->rtp_channel = 0;
    session->rtcp_channel = 1;
    session->tcp_buffer_pos = 0;

    /* Initialize RTP packet tracking */
    session->current_seqn = 0;
    session->not_first_packet = 0;

    logger(LOG_DEBUG, "RTSP session initialized for transport negotiation (TCP buffer: %zu bytes, Response buffer: %zu bytes)",
           sizeof(session->tcp_buffer), sizeof(session->response_buffer));
}

int rtsp_parse_url(rtsp_session_t *session, const char *rtsp_url, const char *playseek_param)
{
    char url_copy[RTSP_URL_COPY_SIZE];
    char *host_start, *port_start, *path_start;

    /* Check for NULL parameters */
    if (!session || !rtsp_url)
    {
        logger(LOG_ERROR, "RTSP: Invalid parameters to rtsp_parse_url");
        return -1;
    }

    /* Copy URL to avoid modifying original */
    strncpy(url_copy, rtsp_url, sizeof(url_copy) - 1);
    url_copy[sizeof(url_copy) - 1] = '\0';

    strncpy(session->server_url, rtsp_url, sizeof(session->server_url) - 1);
    session->server_url[sizeof(session->server_url) - 1] = '\0';

    /* Parse rtsp://host:port/path?query format */
    if (strncmp(url_copy, "rtsp://", 7) != 0)
    {
        logger(LOG_ERROR, "RTSP: Invalid URL format, must start with rtsp://");
        return -1;
    }

    host_start = url_copy + 7;

    /* Check if there's anything after rtsp:// */
    if (*host_start == '\0')
    {
        logger(LOG_ERROR, "RTSP: No hostname specified in URL");
        return -1;
    }

    /* Find port separator */
    port_start = strchr(host_start, ':');
    path_start = strchr(host_start, '/');

    /* Extract hostname and port */
    if (port_start && (!path_start || port_start < path_start))
    {
        /* Port specified */
        size_t host_len = port_start - host_start;
        strncpy(session->server_host, host_start, min(host_len, sizeof(session->server_host) - 1));
        session->server_host[min(host_len, sizeof(session->server_host) - 1)] = '\0';

        /* Extract port number */
        if (path_start)
        {
            /* Port with path: extract port between : and / */
            size_t port_len = path_start - (port_start + 1);
            char port_str[RTSP_PORT_STRING_SIZE];
            strncpy(port_str, port_start + 1, min(port_len, sizeof(port_str) - 1));
            port_str[min(port_len, sizeof(port_str) - 1)] = '\0';
            session->server_port = atoi(port_str);
        }
        else
        {
            /* Port without path: use everything after : */
            session->server_port = atoi(port_start + 1);
        }
    }
    else if (path_start)
    {
        /* No port, default to 554 */
        size_t host_len = path_start - host_start;
        strncpy(session->server_host, host_start, min(host_len, sizeof(session->server_host) - 1));
        session->server_host[min(host_len, sizeof(session->server_host) - 1)] = '\0';
        session->server_port = 554;
    }
    else
    {
        /* No path, just hostname */
        strncpy(session->server_host, host_start, sizeof(session->server_host) - 1);
        session->server_host[sizeof(session->server_host) - 1] = '\0';
        session->server_port = 554;
    }

    /* Extract path and query string (playseek already removed by http.c) */
    if (path_start)
    {
        strncpy(session->server_path, path_start, sizeof(session->server_path) - 1);
        session->server_path[sizeof(session->server_path) - 1] = '\0';
    }
    else
    {
        strcpy(session->server_path, "/");
    }

    /* Handle playseek parameter for RTSP Range header */
    if (playseek_param && strlen(playseek_param) > 0)
    {
        /* Check for dash separator indicating time range */
        char *dash_pos = strchr(playseek_param, '-');
        if (dash_pos)
        {
            /* Time range format: yyyyMMddHHmmss-yyyyMMddHHmmss or yyyyMMddHHmmss- */
            char begin_str[RTSP_TIME_COMPONENT_SIZE], end_str[RTSP_TIME_COMPONENT_SIZE];
            char begin_iso[RTSP_TIME_STRING_SIZE], end_iso[RTSP_TIME_STRING_SIZE];

            /* Extract begin time */
            size_t begin_len = dash_pos - playseek_param;
            if (begin_len < sizeof(begin_str))
            {
                strncpy(begin_str, playseek_param, begin_len);
                begin_str[begin_len] = '\0';

                /* Extract end time (if present) */
                strcpy(end_str, dash_pos + 1);

                logger(LOG_DEBUG, "RTSP: Extracted time range - begin='%s', end='%s'", begin_str, end_str);

                /* Convert begin time to ISO8601 */
                rtsp_format_time_to_iso8601(begin_str, begin_iso, sizeof(begin_iso));

                if (strlen(end_str) > 0)
                {
                    /* Has end time - convert it too */
                    rtsp_format_time_to_iso8601(end_str, end_iso, sizeof(end_iso));
                    snprintf(session->playseek_range, sizeof(session->playseek_range),
                             "clock=%s-%s", begin_iso, end_iso);
                    logger(LOG_DEBUG, "RTSP: Range with end time: 'clock=%s-%s'", begin_iso, end_iso);
                }
                else
                {
                    /* No end time - open-ended range */
                    snprintf(session->playseek_range, sizeof(session->playseek_range),
                             "clock=%s-", begin_iso);
                    logger(LOG_DEBUG, "RTSP: Open-ended range: 'clock=%s-'", begin_iso);
                }
            }
        }
        else
        {
            /* Single time without dash */
            char formatted_time[RTSP_TIME_STRING_SIZE];
            logger(LOG_DEBUG, "RTSP: Single time format - length=%zu, digits_only=%s",
                   strlen(playseek_param),
                   (strspn(playseek_param, "0123456789-") == strlen(playseek_param)) ? "YES" : "NO");

            if (strlen(playseek_param) == 14 && strspn(playseek_param, "0123456789") == 14)
            {
                /* Input is in yyyyMMddHHmmss format, convert to ISO8601 */
                rtsp_format_time_to_iso8601(playseek_param, formatted_time, sizeof(formatted_time));
                snprintf(session->playseek_range, sizeof(session->playseek_range),
                         "clock=%s-", formatted_time);
                logger(LOG_DEBUG, "RTSP: Converted single time '%s' to 'clock=%s-'", playseek_param, formatted_time);
            }
            else
            {
                /* Use playseek parameter directly with clock format */
                snprintf(session->playseek_range, sizeof(session->playseek_range),
                         "clock=%s", playseek_param);
                logger(LOG_DEBUG, "RTSP: Using playseek parameter directly: 'clock=%s'", playseek_param);
            }
        }
        logger(LOG_DEBUG, "RTSP: Final playseek_range: '%s'", session->playseek_range);
    }

    logger(LOG_DEBUG, "RTSP: Parsed URL - host=%s, port=%d, path=%s",
           session->server_host, session->server_port, session->server_path);

    return 0;
}

int rtsp_connect(rtsp_session_t *session)
{
    struct sockaddr_in server_addr;
    struct hostent *he;

    /* Resolve hostname */
    he = gethostbyname(session->server_host);
    if (!he)
    {
        logger(LOG_ERROR, "RTSP: Cannot resolve hostname %s", session->server_host);
        return -1;
    }

    /* Create TCP socket */
    session->socket = socket(AF_INET, SOCK_STREAM, 0);
    if (session->socket < 0)
    {
        logger(LOG_ERROR, "RTSP: Failed to create socket: %s", strerror(errno));
        return -1;
    }

    /* Connect to server */
    memset(&server_addr, 0, sizeof(server_addr));
    server_addr.sin_family = AF_INET;
    server_addr.sin_port = htons(session->server_port);
    memcpy(&server_addr.sin_addr.s_addr, he->h_addr_list[0], he->h_length);

    if (connect(session->socket, (struct sockaddr *)&server_addr, sizeof(server_addr)) < 0)
    {
        logger(LOG_ERROR, "RTSP: Failed to connect to %s:%d: %s",
               session->server_host, session->server_port, strerror(errno));
        close(session->socket);
        session->socket = -1;
        return -1;
    }

    session->state = RTSP_STATE_CONNECTED;
    logger(LOG_DEBUG, "RTSP: Connected to %s:%d", session->server_host, session->server_port);

    return 0;
}

int rtsp_describe(rtsp_session_t *session)
{
    char extra_headers[RTSP_HEADERS_BUFFER_SIZE];
    int response_result;

    do
    {
        snprintf(extra_headers, sizeof(extra_headers),
                 "Accept: application/sdp\r\n");

        if (rtsp_send_request(session, RTSP_METHOD_DESCRIBE, extra_headers) < 0)
        {
            return -1;
        }

        response_result = rtsp_receive_response(session);
        if (response_result < 0)
        {
            return -1;
        }
        /* Continue loop if response_result == 1 (redirect) */
    } while (response_result == 1);

    session->state = RTSP_STATE_DESCRIBED;
    logger(LOG_DEBUG, "RTSP: DESCRIBE completed");
    return 0;
}

int rtsp_setup(rtsp_session_t *session)
{
    char extra_headers[RTSP_HEADERS_BUFFER_SIZE];
    char transport_list[RTSP_HEADERS_BUFFER_SIZE - 100]; /* Reserve space for other headers */
    int response_result;

    /* Setup UDP sockets for potential UDP transport */
    if (rtsp_setup_udp_sockets(session) < 0)
    {
        logger(LOG_DEBUG, "RTSP: Failed to setup UDP sockets, will only offer TCP transport");
        /* Continue with TCP-only transport */
        snprintf(transport_list, sizeof(transport_list),
                 "MP2T/RTP/TCP;unicast;interleaved=%1$d-%2$d,"
                 "MP2T/TCP;unicast;interleaved=%1$d-%2$d,"
                 "RTP/AVP/TCP;unicast;interleaved=%1$d-%2$d",
                 session->rtp_channel, session->rtcp_channel);
    }
    else
    {
        /* Build transport list with all supported modes, ordered by preference */
        snprintf(transport_list, sizeof(transport_list),
                 "MP2T/RTP/TCP;unicast;interleaved=%1$d-%2$d,"
                 "MP2T/TCP;unicast;interleaved=%1$d-%2$d,"
                 "RTP/AVP/TCP;unicast;interleaved=%1$d-%2$d,"
                 "MP2T/RTP/UDP;unicast;client_port=%3$d-%4$d,"
                 "MP2T/UDP;unicast;client_port=%3$d-%4$d,"
                 "RTP/AVP;unicast;client_port=%3$d-%4$d",
                 session->rtp_channel, session->rtcp_channel,
                 session->local_rtp_port, session->local_rtcp_port);
    }

    do
    {
        /**
         * Send all supported transport modes in order of preference.
         * Server will select the first one it supports from the list.
         */
        snprintf(extra_headers, sizeof(extra_headers),
                 "Transport: %s\r\n", transport_list);

        logger(LOG_DEBUG, "RTSP: Sending SETUP with transport options: %s", transport_list);

        if (rtsp_send_request(session, RTSP_METHOD_SETUP, extra_headers) < 0)
        {
            return -1;
        }

        response_result = rtsp_receive_response(session);
        if (response_result < 0)
        {
            return -1;
        }
        /* Continue loop if response_result == 1 (redirect) */
    } while (response_result == 1);

    /* Clean up unused UDP sockets if TCP transport was selected */
    if (session->transport_mode == RTSP_TRANSPORT_TCP)
    {
        if (session->rtp_socket >= 0)
        {
            close(session->rtp_socket);
            session->rtp_socket = -1;
        }
        if (session->rtcp_socket >= 0)
        {
            close(session->rtcp_socket);
            session->rtcp_socket = -1;
        }
        logger(LOG_DEBUG, "RTSP: Closed UDP sockets as TCP transport was selected");
    }

    session->state = RTSP_STATE_SETUP;
    logger(LOG_INFO, "RTSP: SETUP completed using %s transport",
           session->transport_mode == RTSP_TRANSPORT_TCP ? "TCP interleaved" : "UDP");
    return 0;
}

int rtsp_play(rtsp_session_t *session)
{
    char extra_headers[1024] = "";
    int response_result;

    do
    {
        /* Add session header */
        snprintf(extra_headers, sizeof(extra_headers), "Session: %s\r\n", session->session_id);

        /* Add Range header if playseek is specified */
        if (strlen(session->playseek_range) > 0)
        {
            char range_header[RTSP_HEADERS_BUFFER_SIZE];
            snprintf(range_header, sizeof(range_header), "Range: %s\r\n", session->playseek_range);
            /* Check buffer space before concatenating */
            if (strlen(extra_headers) + strlen(range_header) < sizeof(extra_headers) - 1)
            {
                strcat(extra_headers, range_header);
            }
            else
            {
                logger(LOG_ERROR, "RTSP: Headers buffer too small for Range header");
                return -1;
            }
            logger(LOG_DEBUG, "RTSP: Adding Range header: 'Range: %s'", session->playseek_range);
        }
        else
        {
            logger(LOG_DEBUG, "RTSP: No Range header - playseek_range is empty");
        }

        if (rtsp_send_request(session, RTSP_METHOD_PLAY, extra_headers) < 0)
        {
            return -1;
        }

        response_result = rtsp_receive_response(session);
        if (response_result < 0)
        {
            return -1;
        }
        /* Continue loop if response_result == 1 (redirect) */
    } while (response_result == 1);

    session->state = RTSP_STATE_PLAYING;
    logger(LOG_DEBUG, "RTSP: PLAY started");
    return 0;
}

int rtsp_handle_rtp_data(rtsp_session_t *session, int client_fd)
{
    if (session->transport_mode == RTSP_TRANSPORT_TCP)
    {
        return rtsp_handle_tcp_interleaved_data(session, client_fd);
    }
    else
    {
        return rtsp_handle_udp_rtp_data(session, client_fd);
    }
}

int rtsp_handle_tcp_interleaved_data(rtsp_session_t *session, int client_fd)
{
    int bytes_received;

    /* Read data from RTSP socket */
    bytes_received = recv(session->socket,
                          session->tcp_buffer + session->tcp_buffer_pos,
                          sizeof(session->tcp_buffer) - session->tcp_buffer_pos, 0);
    if (bytes_received <= 0)
    {
        if (bytes_received < 0)
        {
            logger(LOG_ERROR, "RTSP: TCP receive failed: %s", strerror(errno));
        }
        return bytes_received;
    }

    session->tcp_buffer_pos += bytes_received;

    /* Process interleaved data packets */
    int processed = 0;
    while (session->tcp_buffer_pos >= 4)
    {
        /* Check for interleaved data packet: $ + channel + length(2 bytes) + data */
        if (session->tcp_buffer[0] != '$')
        {
            /* Not interleaved data, might be RTSP response */
            logger(LOG_DEBUG, "RTSP: Received non-interleaved data on TCP connection");
            break;
        }

        uint8_t channel = session->tcp_buffer[1];
        uint16_t packet_length = (session->tcp_buffer[2] << 8) | session->tcp_buffer[3];

        /* Check if we have the complete packet and prevent buffer overflow */
        if (session->tcp_buffer_pos < 4 + packet_length)
        {
            break; /* Wait for more data */
        }

        /* Sanity check: prevent processing packets that are too large */
        if (packet_length > sizeof(session->tcp_buffer) - 4)
        {
            logger(LOG_ERROR, "RTSP: Received packet too large (%d bytes, max %zu), dropping",
                   packet_length, sizeof(session->tcp_buffer) - 4);
            /* Reset buffer to recover from corrupted stream */
            session->tcp_buffer_pos = 0;
            break;
        }

        /* Process RTP/RTCP packet based on channel */
        if (channel == session->rtp_channel)
        {
            /* Handle RTP data based on transport protocol */
            if (session->transport_protocol == RTSP_PROTOCOL_MP2T)
            {
                /* MP2T - write MPEG-2 TS data directly to client (no RTP unwrapping) */
                write_to_client(client_fd, &session->tcp_buffer[4], packet_length);
            }
            else
            {
                /* RTP - extract RTP payload and forward to client */
                write_rtp_payload_to_client(client_fd, packet_length, &session->tcp_buffer[4],
                                            &session->current_seqn, &session->not_first_packet);
            }
            processed += packet_length;
        }
        else if (channel == session->rtcp_channel)
        {
            /* RTCP data - could be processed for statistics but currently ignored */
        }

        /* Remove processed packet from buffer */
        int total_packet_size = 4 + packet_length;
        memmove(session->tcp_buffer, &session->tcp_buffer[total_packet_size],
                session->tcp_buffer_pos - total_packet_size);
        session->tcp_buffer_pos -= total_packet_size;
    }

    return processed;
}

int rtsp_handle_udp_rtp_data(rtsp_session_t *session, int client_fd)
{
    int bytes_received;

    bytes_received = recv(session->rtp_socket, session->rtp_buffer,
                          sizeof(session->rtp_buffer), 0);
    if (bytes_received < 0)
    {
        logger(LOG_ERROR, "RTSP: RTP receive failed: %s", strerror(errno));
        return -1;
    }

    if (bytes_received > 0)
    {
        /* Handle RTP data based on transport protocol */
        if (session->transport_protocol == RTSP_PROTOCOL_MP2T)
        {
            /* MP2T - write MPEG-2 TS data directly to client (no RTP unwrapping) */
            write_to_client(client_fd, session->rtp_buffer, bytes_received);
        }
        else
        {
            /* RTP - extract RTP payload and forward to client */
            write_rtp_payload_to_client(client_fd, bytes_received, session->rtp_buffer,
                                        &session->current_seqn, &session->not_first_packet);
        }
        return bytes_received;
    }

    return 0;
}

void rtsp_session_cleanup(rtsp_session_t *session)
{
    if (session->state == RTSP_STATE_PLAYING || session->state == RTSP_STATE_SETUP)
    {
        /* Send TEARDOWN */
        char extra_headers[RTSP_HEADERS_BUFFER_SIZE];
        snprintf(extra_headers, sizeof(extra_headers), "Session: %s\r\n", session->session_id);
        rtsp_send_request(session, RTSP_METHOD_TEARDOWN, extra_headers);
        /* Don't wait for response during cleanup */
    }

    /* Close sockets */
    if (session->socket >= 0)
    {
        close(session->socket);
        session->socket = -1;
    }
    if (session->rtp_socket >= 0)
    {
        close(session->rtp_socket);
        session->rtp_socket = -1;
    }
    if (session->rtcp_socket >= 0)
    {
        close(session->rtcp_socket);
        session->rtcp_socket = -1;
    }

    /* Reset TCP buffer position */
    session->tcp_buffer_pos = 0;

    session->state = RTSP_STATE_INIT;
    logger(LOG_DEBUG, "RTSP: Session cleaned up (%s transport mode)",
           session->transport_mode == RTSP_TRANSPORT_TCP ? "TCP" : "UDP");
}

/* Helper functions */

static int rtsp_send_request(rtsp_session_t *session, const char *method, const char *extra_headers)
{
    char request[RTSP_REQUEST_BUFFER_SIZE];
    int bytes_sent;

    /* Build RTSP request */
    snprintf(request, sizeof(request),
             "%s %s %s\r\n"
             "CSeq: %u\r\n"
             "User-Agent: %s\r\n"
             "%s"
             "\r\n",
             method, session->server_url, RTSP_VERSION,
             session->cseq++,
             USER_AGENT,
             extra_headers ? extra_headers : "");

    logger(LOG_DEBUG, "RTSP: Sending request:\n%s", request);

    bytes_sent = send(session->socket, request, strlen(request), 0);
    if (bytes_sent < 0)
    {
        logger(LOG_ERROR, "RTSP: Failed to send request: %s", strerror(errno));
        return -1;
    }

    return 0;
}

static int rtsp_receive_response(rtsp_session_t *session)
{
    int bytes_received = 0;
    int total_received = 0;
    char *end_of_headers;

    /* Receive response */
    while (total_received < (int)(sizeof(session->response_buffer) - 1))
    {
        bytes_received = recv(session->socket, session->response_buffer + total_received,
                              sizeof(session->response_buffer) - total_received - 1, 0);
        if (bytes_received <= 0)
        {
            logger(LOG_ERROR, "RTSP: Failed to receive response: %s", strerror(errno));
            return -1;
        }

        total_received += bytes_received;
        session->response_buffer[total_received] = '\0';

        /* Check if we have complete headers (\r\n\r\n) */
        end_of_headers = strstr((char *)session->response_buffer, "\r\n\r\n");
        if (end_of_headers)
        {
            break;
        }
    }

    logger(LOG_DEBUG, "RTSP: Received response:\n%s", session->response_buffer);

    return rtsp_parse_response(session, (char *)session->response_buffer);
}

static int rtsp_parse_response(rtsp_session_t *session, const char *response)
{
    char *session_header, *transport_header, *location_header;
    int status_code;

    /* Parse status line */
    if (sscanf(response, "RTSP/1.0 %d", &status_code) != 1)
    {
        logger(LOG_ERROR, "RTSP: Invalid response format");
        return -1;
    }

    /* Handle different status code ranges */
    if (status_code >= 300 && status_code < 400)
    {
        /* Redirection response */
        logger(LOG_DEBUG, "RTSP: Received redirect response %d", status_code);

        location_header = rtsp_find_header(response, "Location");
        if (!location_header)
        {
            logger(LOG_ERROR, "RTSP: Redirect response missing Location header");
            return -1;
        }

        int redirect_result = rtsp_handle_redirect(session, location_header);
        free(location_header);
        /* Note: redirect_result can be 1 (success) or -1 (failure) */
        return redirect_result;
    }
    else if (status_code != 200)
    {
        logger(LOG_ERROR, "RTSP: Server returned error code %d", status_code);
        return -1;
    }

    /* Extract Session header if present */
    session_header = rtsp_find_header(response, "Session");
    if (session_header)
    {
        char *semicolon = strchr(session_header, ';');
        if (semicolon)
            *semicolon = '\0'; /* Remove timeout info */
        strncpy(session->session_id, session_header, sizeof(session->session_id) - 1);
        session->session_id[sizeof(session->session_id) - 1] = '\0';
        free(session_header);
    }

    /* Extract Transport header if present */
    transport_header = rtsp_find_header(response, "Transport");
    if (transport_header)
    {
        rtsp_parse_transport_header(session, transport_header);
        free(transport_header);
    }

    return 0;
}

/*
 * UDP socket setup function - used for UDP transport negotiation
 * Sets up local RTP/RTCP sockets for potential UDP transport
 */
static int rtsp_setup_udp_sockets(rtsp_session_t *session)
{
    struct sockaddr_in local_addr;
    /* socklen_t addr_len; // Unused variable */
    int port_base = 10000 + (getpid() % 20000); /* Semi-random port base */

    logger(LOG_DEBUG, "RTSP: Setting up UDP sockets");

    /* Create RTP socket */
    session->rtp_socket = socket(AF_INET, SOCK_DGRAM, 0);
    if (session->rtp_socket < 0)
    {
        logger(LOG_ERROR, "RTSP: Failed to create RTP socket: %s", strerror(errno));
        return -1;
    }

    /* Bind RTP socket to even port */
    memset(&local_addr, 0, sizeof(local_addr));
    local_addr.sin_family = AF_INET;
    local_addr.sin_addr.s_addr = INADDR_ANY;

    for (int port = port_base; port < port_base + 100; port += 2)
    {
        local_addr.sin_port = htons(port);
        if (bind(session->rtp_socket, (struct sockaddr *)&local_addr, sizeof(local_addr)) == 0)
        {
            session->local_rtp_port = port;
            break;
        }
    }

    if (session->local_rtp_port == 0)
    {
        logger(LOG_ERROR, "RTSP: Failed to bind RTP socket");
        close(session->rtp_socket);
        session->rtp_socket = -1; /* Reset socket to prevent double-close */
        return -1;
    }

    /* Create RTCP socket */
    session->rtcp_socket = socket(AF_INET, SOCK_DGRAM, 0);
    if (session->rtcp_socket < 0)
    {
        logger(LOG_ERROR, "RTSP: Failed to create RTCP socket: %s", strerror(errno));
        close(session->rtp_socket);
        session->rtp_socket = -1; /* Reset socket to prevent double-close */
        return -1;
    }

    /* Bind RTCP socket to odd port */
    local_addr.sin_port = htons(session->local_rtp_port + 1);
    if (bind(session->rtcp_socket, (struct sockaddr *)&local_addr, sizeof(local_addr)) < 0)
    {
        logger(LOG_ERROR, "RTSP: Failed to bind RTCP socket: %s", strerror(errno));
        close(session->rtp_socket);
        close(session->rtcp_socket);
        session->rtp_socket = -1; /* Reset sockets to prevent double-close */
        session->rtcp_socket = -1;
        return -1;
    }

    session->local_rtcp_port = session->local_rtp_port + 1;

    logger(LOG_DEBUG, "RTSP: UDP sockets bound to ports %d (RTP) and %d (RTCP)",
           session->local_rtp_port, session->local_rtcp_port);

    return 0;
}

static char *rtsp_find_header(const char *response, const char *header_name)
{
    char *header_start, *header_end;
    char header_prefix[RTSP_HEADER_PREFIX_SIZE];
    int header_len;

    snprintf(header_prefix, sizeof(header_prefix), "%s:", header_name);
    header_start = strstr(response, header_prefix);
    if (!header_start)
        return NULL;

    header_start += strlen(header_prefix);
    while (*header_start == ' ')
        header_start++; /* Skip whitespace */

    header_end = strstr(header_start, "\r\n");
    if (!header_end)
        return NULL;

    header_len = header_end - header_start;
    char *result = malloc(header_len + 1);
    if (!result)
    {
        logger(LOG_ERROR, "RTSP: Failed to allocate memory for header");
        return NULL;
    }
    strncpy(result, header_start, header_len);
    result[header_len] = '\0';

    return result;
}

static void rtsp_parse_transport_header(rtsp_session_t *session, const char *transport)
{
    char *server_port_param;
    char *interleaved_param;
    char *client_port_param;

    logger(LOG_DEBUG, "RTSP: Parsing server transport response: %s", transport);

    /* Determine transport protocol and mode */
    if (strstr(transport, "MP2T/RTP"))
    {
        /* MP2T/RTP - MPEG-2 TS over RTP (needs RTP unwrapping) */
        session->transport_protocol = RTSP_PROTOCOL_RTP;
        logger(LOG_INFO, "RTSP: Server selected MP2T/RTP transport");
    }
    else if (strstr(transport, "MP2T"))
    {
        /* MP2T - Direct MPEG-2 TS (no RTP unwrapping) */
        session->transport_protocol = RTSP_PROTOCOL_MP2T;
        logger(LOG_INFO, "RTSP: Server selected MP2T transport");
    }
    else
    {
        /* RTP/AVP - Standard RTP (no RTP unwrapping for non-TS) */
        session->transport_protocol = RTSP_PROTOCOL_RTP;
        logger(LOG_INFO, "RTSP: Server selected RTP/AVP transport");
    }

    /* Determine transport mode: TCP or UDP */
    if (strstr(transport, "TCP") || strstr(transport, "interleaved="))
    {
        /* TCP transport mode */
        session->transport_mode = RTSP_TRANSPORT_TCP;
        logger(LOG_INFO, "RTSP: Using TCP interleaved transport");

        /* Parse interleaved channels */
        interleaved_param = strstr(transport, "interleaved=");
        if (interleaved_param)
        {
            if (sscanf(interleaved_param, "interleaved=%d-%d",
                       &session->rtp_channel, &session->rtcp_channel) == 2)
            {
                logger(LOG_DEBUG, "RTSP: Server confirmed TCP interleaved channels: %d/%d",
                       session->rtp_channel, session->rtcp_channel);
            }
        }
    }
    else
    {
        /* UDP transport mode */
        session->transport_mode = RTSP_TRANSPORT_UDP;
        logger(LOG_INFO, "RTSP: Using UDP transport");

        /* Parse server port parameters */
        server_port_param = strstr(transport, "server_port=");
        if (server_port_param)
        {
            if (sscanf(server_port_param, "server_port=%d-%d",
                       &session->server_rtp_port, &session->server_rtcp_port) != 2)
            {
                /* Try single port format */
                session->server_rtp_port = atoi(server_port_param + 12);
                session->server_rtcp_port = session->server_rtp_port + 1;
            }
            logger(LOG_DEBUG, "RTSP: Server RTP/RTCP ports: %d/%d",
                   session->server_rtp_port, session->server_rtcp_port);
        }

        /* Parse client port parameters */
        client_port_param = strstr(transport, "client_port=");
        if (client_port_param)
        {
            int client_rtp_port, client_rtcp_port;
            if (sscanf(client_port_param, "client_port=%d-%d",
                       &client_rtp_port, &client_rtcp_port) == 2)
            {
                logger(LOG_DEBUG, "RTSP: Server confirmed client ports: %d/%d",
                       client_rtp_port, client_rtcp_port);
            }
        }
    }
}

/*
 * Handle RTSP redirect response
 * Returns: 1 if redirect successful (caller should retry request)
 *          -1 if redirect failed
 */
static int rtsp_handle_redirect(rtsp_session_t *session, const char *location)
{
    logger(LOG_DEBUG, "RTSP: Handling redirect to: %s", location);

    /* Check redirect limit */
    if (session->redirect_count >= MAX_REDIRECTS)
    {
        logger(LOG_ERROR, "RTSP: Too many redirects (%d), giving up", session->redirect_count);
        return -1;
    }

    session->redirect_count++;

    /* Close current connection */
    if (session->socket >= 0)
    {
        close(session->socket);
        session->socket = -1;
    }

    /* Parse new URL and update session */
    if (rtsp_parse_url(session, location, NULL) < 0)
    {
        logger(LOG_ERROR, "RTSP: Failed to parse redirect URL");
        return -1;
    }

    /* Connect to new server */
    if (rtsp_connect(session) < 0)
    {
        logger(LOG_ERROR, "RTSP: Failed to connect to redirected server");
        return -1;
    }

    logger(LOG_INFO, "RTSP: Successfully redirected to %s:%d (redirect #%d)",
           session->server_host, session->server_port, session->redirect_count);

    /* Return 1 to indicate caller should retry the request */
    return 1;
}

/*
 * Convert time from yyyyMMddHHmmss format to yyyyMMddTHHmmssZ format
 */
static void rtsp_format_time_to_iso8601(const char *input_time, char *output_time, size_t output_size)
{
    if (!input_time || !output_time || output_size < 16)
    {
        if (output_time && output_size > 0)
        {
            output_time[0] = '\0';
        }
        return;
    }

    /* Check if input is exactly 14 digits (yyyyMMddHHmmss) */
    if (strlen(input_time) == 14 && strspn(input_time, "0123456789") == 14)
    {
        snprintf(output_time, output_size, "%.8sT%.6sZ", input_time, input_time + 8);
        logger(LOG_DEBUG, "RTSP: Formatted time '%s' to ISO8601 '%s'",
               input_time, output_time);
    }
    else
    {
        /* Input doesn't match expected format, copy as-is */
        strncpy(output_time, input_time, output_size - 1);
        output_time[output_size - 1] = '\0';
    }
}
