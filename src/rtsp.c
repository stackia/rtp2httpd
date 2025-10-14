#ifdef HAVE_CONFIG_H
#include "config.h"
#endif /* HAVE_CONFIG_H */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <unistd.h>
#include <sys/socket.h>
#include <sys/epoll.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <netdb.h>
#include <time.h>
#include <ctype.h>
#include "rtsp.h"
#include "rtp2httpd.h"
#include "http.h"
#include "rtp.h"
#include "multicast.h"
#include "zerocopy.h"
#include "timezone.h"
#include "connection.h"
#include "stream.h"
#include "status.h"
#include "worker.h"

/*
 * RTSP Client Implementation
 */

/* RTSP version and user agent */
#define RTSP_VERSION "RTSP/1.0"
#define USER_AGENT "rtp2httpd/" VERSION
#define MAX_REDIRECTS 5

/* Helper function prototypes */
static int rtsp_prepare_request(rtsp_session_t *session, const char *method, const char *extra_headers);
static int rtsp_try_send_pending(rtsp_session_t *session);
static int rtsp_try_receive_response(rtsp_session_t *session);
static int rtsp_parse_response(rtsp_session_t *session, const char *response);
static int rtsp_setup_udp_sockets(rtsp_session_t *session);
static void rtsp_close_udp_sockets(rtsp_session_t *session, const char *reason);
static char *rtsp_find_header(const char *response, const char *header_name);
static void rtsp_parse_transport_header(rtsp_session_t *session, const char *transport);
static int rtsp_handle_redirect(rtsp_session_t *session, const char *location);
static int rtsp_convert_time_to_utc(const char *time_str, int tz_offset_seconds, char *output, size_t output_size);
static int rtsp_state_machine_advance(rtsp_session_t *session);
static int rtsp_initiate_teardown(rtsp_session_t *session);
static int rtsp_reconnect_for_teardown(rtsp_session_t *session);
static void rtsp_force_cleanup(rtsp_session_t *session);

void rtsp_session_init(rtsp_session_t *session)
{
    memset(session, 0, sizeof(rtsp_session_t));
    session->state = RTSP_STATE_INIT;
    session->socket = -1;
    session->epoll_fd = -1;
    session->status_index = -1;
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

    /* Initialize statistics */
    session->packets_dropped = 0;

    /* Initialize cleanup state */
    session->cleanup_done = 0;

    /* Initialize non-blocking I/O state */
    session->pending_request_len = 0;
    session->pending_request_sent = 0;
    session->response_buffer_pos = 0;
    session->awaiting_response = 0;

    /* Initialize teardown state */
    session->teardown_requested = 0;
    session->teardown_reconnect_done = 0;
    session->state_before_teardown = RTSP_STATE_INIT;
}

/**
 * Set RTSP session state and update client status
 */
static void rtsp_session_set_state(rtsp_session_t *session, rtsp_state_t new_state)
{
    /* State mapping lookup table - one-to-one mapping between RTSP and client states */
    static const client_state_type_t rtsp_to_client_state[] = {
        [RTSP_STATE_INIT] = CLIENT_STATE_RTSP_INIT,
        [RTSP_STATE_CONNECTING] = CLIENT_STATE_RTSP_CONNECTING,
        [RTSP_STATE_CONNECTED] = CLIENT_STATE_RTSP_CONNECTED,
        [RTSP_STATE_SENDING_DESCRIBE] = CLIENT_STATE_RTSP_SENDING_DESCRIBE,
        [RTSP_STATE_AWAITING_DESCRIBE] = CLIENT_STATE_RTSP_AWAITING_DESCRIBE,
        [RTSP_STATE_DESCRIBED] = CLIENT_STATE_RTSP_DESCRIBED,
        [RTSP_STATE_SENDING_SETUP] = CLIENT_STATE_RTSP_SENDING_SETUP,
        [RTSP_STATE_AWAITING_SETUP] = CLIENT_STATE_RTSP_AWAITING_SETUP,
        [RTSP_STATE_SETUP] = CLIENT_STATE_RTSP_SETUP,
        [RTSP_STATE_SENDING_PLAY] = CLIENT_STATE_RTSP_SENDING_PLAY,
        [RTSP_STATE_AWAITING_PLAY] = CLIENT_STATE_RTSP_AWAITING_PLAY,
        [RTSP_STATE_PLAYING] = CLIENT_STATE_RTSP_PLAYING,
        [RTSP_STATE_RECONNECTING] = CLIENT_STATE_RTSP_RECONNECTING,
        [RTSP_STATE_SENDING_TEARDOWN] = CLIENT_STATE_RTSP_SENDING_TEARDOWN,
        [RTSP_STATE_AWAITING_TEARDOWN] = CLIENT_STATE_RTSP_AWAITING_TEARDOWN,
        [RTSP_STATE_TEARDOWN_COMPLETE] = CLIENT_STATE_RTSP_TEARDOWN_COMPLETE,
        [RTSP_STATE_PAUSED] = CLIENT_STATE_RTSP_PAUSED,
        [RTSP_STATE_ERROR] = CLIENT_STATE_ERROR};

    if (session->state == new_state)
    {
        return; /* No change */
    }

    session->state = new_state;

    /* Update client status immediately if status_index is valid */
    if (session->status_index >= 0 && new_state < ARRAY_SIZE(rtsp_to_client_state))
    {
        status_update_client_state(session->status_index, rtsp_to_client_state[new_state]);
    }

    /* Auto-cleanup on ERROR state transition (if not already done) */
    if (new_state == RTSP_STATE_ERROR && !session->cleanup_done)
    {
        logger(LOG_DEBUG, "RTSP: Auto-cleanup triggered on ERROR state");
        rtsp_force_cleanup(session);
    }
}

int rtsp_parse_server_url(rtsp_session_t *session, const char *rtsp_url, const char *playseek_param, const char *user_agent)
{
    char url_copy[RTSP_URL_COPY_SIZE];
    char *host_start, *port_start, *path_start;
    int tz_offset_seconds = 0;
    char playseek_utc[256] = {0}; /* Buffer for UTC-converted playseek parameter */

    /* Check for NULL parameters */
    if (!session || !rtsp_url)
    {
        logger(LOG_ERROR, "RTSP: Invalid parameters to rtsp_parse_server_url");
        return -1;
    }

    /* Parse timezone from User-Agent if provided */
    if (user_agent)
    {
        timezone_parse_from_user_agent(user_agent, &tz_offset_seconds);
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

    /* Handle playseek parameter - convert to UTC for URL query parameter */
    if (playseek_param && strlen(playseek_param) > 0)
    {
        /* Parse playseek parameter: could be "begin-end", "begin-", or "begin" */
        char begin_str[RTSP_TIME_COMPONENT_SIZE] = {0};
        char end_str[RTSP_TIME_COMPONENT_SIZE] = {0};
        char begin_utc[RTSP_TIME_STRING_SIZE] = {0};
        char end_utc[RTSP_TIME_STRING_SIZE] = {0};
        char *dash_pos = strchr(playseek_param, '-');

        /* Extract begin and end times */
        if (dash_pos)
        {
            /* Has dash: "begin-end" or "begin-" */
            size_t begin_len = dash_pos - playseek_param;
            if (begin_len < sizeof(begin_str))
            {
                strncpy(begin_str, playseek_param, begin_len);
                begin_str[begin_len] = '\0';
                strcpy(end_str, dash_pos + 1); /* end_str may be empty */
            }
        }
        else
        {
            /* No dash: treat as "begin-" (open-ended range) */
            strncpy(begin_str, playseek_param, sizeof(begin_str) - 1);
            begin_str[sizeof(begin_str) - 1] = '\0';
            /* end_str remains empty */
        }

        logger(LOG_DEBUG, "RTSP: Parsed playseek - begin='%s', end='%s'", begin_str, end_str);

        /* Convert begin time to UTC (keep original format) */
        if (rtsp_convert_time_to_utc(begin_str, tz_offset_seconds, begin_utc, sizeof(begin_utc)) == 0)
        {
            logger(LOG_DEBUG, "RTSP: Converted begin time '%s' to UTC '%s'", begin_str, begin_utc);
        }
        else
        {
            /* Conversion failed, use original */
            strncpy(begin_utc, begin_str, sizeof(begin_utc) - 1);
            begin_utc[sizeof(begin_utc) - 1] = '\0';
        }

        /* Convert end time to UTC if present */
        if (strlen(end_str) > 0)
        {
            if (rtsp_convert_time_to_utc(end_str, tz_offset_seconds, end_utc, sizeof(end_utc)) == 0)
            {
                logger(LOG_DEBUG, "RTSP: Converted end time '%s' to UTC '%s'", end_str, end_utc);
            }
            else
            {
                /* Conversion failed, use original */
                strncpy(end_utc, end_str, sizeof(end_utc) - 1);
                end_utc[sizeof(end_utc) - 1] = '\0';
            }
            snprintf(playseek_utc, sizeof(playseek_utc), "%s-%s", begin_utc, end_utc);
        }
        else
        {
            /* Open-ended range */
            snprintf(playseek_utc, sizeof(playseek_utc), "%s-", begin_utc);
        }
        logger(LOG_DEBUG, "RTSP: UTC playseek parameter: '%s'", playseek_utc);

        /* Append playseek parameter to server_url for DESCRIBE request */
        /* Check if URL already has query parameters */
        char *query_marker = strchr(session->server_url, '?');
        size_t current_len = strlen(session->server_url);
        size_t playseek_len = strlen(playseek_utc);

        if (query_marker)
        {
            /* URL already has query parameters, append with & */
            if (current_len + 10 + playseek_len < sizeof(session->server_url))
            {
                snprintf(session->server_url + current_len,
                         sizeof(session->server_url) - current_len,
                         "&playseek=%s", playseek_utc);
            }
            else
            {
                logger(LOG_ERROR, "RTSP: URL too long to append playseek parameter");
            }
        }
        else
        {
            /* No query parameters yet, append with ? */
            if (current_len + 10 + playseek_len < sizeof(session->server_url))
            {
                snprintf(session->server_url + current_len,
                         sizeof(session->server_url) - current_len,
                         "?playseek=%s", playseek_utc);
            }
            else
            {
                logger(LOG_ERROR, "RTSP: URL too long to append playseek parameter");
            }
        }
        logger(LOG_DEBUG, "RTSP: Updated server_url with playseek: %s", session->server_url);
    }

    logger(LOG_DEBUG, "RTSP: Parsed URL - host=%s, port=%d, path=%s",
           session->server_host, session->server_port, session->server_path);

    return 0;
}

int rtsp_connect(rtsp_session_t *session)
{
    struct sockaddr_in server_addr;
    struct hostent *he;
    int connect_result;
    const struct ifreq *upstream_if;

    /* Resolve hostname */
    he = gethostbyname(session->server_host);
    if (!he)
    {
        logger(LOG_ERROR, "RTSP: Cannot resolve hostname %s: %s",
               session->server_host, hstrerror(h_errno));
        return -1;
    }

    /* Validate address list */
    if (!he->h_addr_list[0])
    {
        logger(LOG_ERROR, "RTSP: No addresses for hostname %s", session->server_host);
        return -1;
    }

    /* Create TCP socket */
    session->socket = socket(AF_INET, SOCK_STREAM, 0);
    if (session->socket < 0)
    {
        logger(LOG_ERROR, "RTSP: Failed to create socket: %s", strerror(errno));
        return -1;
    }

    /* Set socket to non-blocking mode for epoll */
    if (connection_set_nonblocking(session->socket) < 0)
    {
        logger(LOG_ERROR, "RTSP: Failed to set socket non-blocking: %s", strerror(errno));
        close(session->socket);
        session->socket = -1;
        return -1;
    }

    upstream_if = &config.upstream_interface_unicast;
    bind_to_upstream_interface(session->socket, upstream_if);

    /* Connect to server (non-blocking) */
    memset(&server_addr, 0, sizeof(server_addr));
    server_addr.sin_family = AF_INET;
    server_addr.sin_port = htons(session->server_port);
    memcpy(&server_addr.sin_addr.s_addr, he->h_addr_list[0], he->h_length);

    connect_result = connect(session->socket, (struct sockaddr *)&server_addr, sizeof(server_addr));

    /* Handle non-blocking connect result */
    if (connect_result < 0)
    {
        if (errno == EINPROGRESS || errno == EWOULDBLOCK)
        {
            /* Connection in progress - this is normal for non-blocking sockets */
            logger(LOG_DEBUG, "RTSP: Connection to %s:%d in progress (async)",
                   session->server_host, session->server_port);

            /* Register socket with epoll for EPOLLOUT to detect connection completion */
            if (session->epoll_fd >= 0)
            {
                struct epoll_event ev;
                ev.events = EPOLLOUT | EPOLLIN | EPOLLERR | EPOLLHUP; /* Wait for writable (connected) or error */
                ev.data.fd = session->socket;
                if (epoll_ctl(session->epoll_fd, EPOLL_CTL_ADD, session->socket, &ev) < 0)
                {
                    logger(LOG_ERROR, "RTSP: Failed to add socket to epoll: %s", strerror(errno));
                    close(session->socket);
                    session->socket = -1;
                    return -1;
                }
                fdmap_set(session->socket, session->conn);
                logger(LOG_DEBUG, "RTSP: Socket registered with epoll for connection completion");
            }

            /* Set state to CONNECTING - connection will complete asynchronously */
            rtsp_session_set_state(session, RTSP_STATE_CONNECTING);
            return 0; /* Success - connection in progress */
        }
        else
        {
            /* Real connection error */
            logger(LOG_ERROR, "RTSP: Failed to connect to %s:%d: %s",
                   session->server_host, session->server_port, strerror(errno));
            close(session->socket);
            session->socket = -1;
            return -1;
        }
    }

    /* Immediate connection success (rare for non-blocking, but possible for localhost) */
    logger(LOG_DEBUG, "RTSP: Connected immediately to %s:%d", session->server_host, session->server_port);

    /* Register socket with epoll for read events */
    if (session->epoll_fd >= 0)
    {
        struct epoll_event ev;
        ev.events = EPOLLIN | EPOLLHUP | EPOLLERR | EPOLLRDHUP; /* Monitor read and error events */
        ev.data.fd = session->socket;
        if (epoll_ctl(session->epoll_fd, EPOLL_CTL_ADD, session->socket, &ev) < 0)
        {
            logger(LOG_ERROR, "RTSP: Failed to add socket to epoll: %s", strerror(errno));
            close(session->socket);
            session->socket = -1;
            return -1;
        }
        fdmap_set(session->socket, session->conn);
        logger(LOG_DEBUG, "RTSP: Socket registered with epoll");
    }

    rtsp_session_set_state(session, RTSP_STATE_CONNECTED);
    return 0;
}

/**
 * Main event handler for RTSP socket - handles all async I/O
 * Called by worker when socket has EPOLLIN or EPOLLOUT events
 * @return Number of bytes forwarded to client (>0), 0 if no data forwarded, -1 on error
 */
int rtsp_handle_socket_event(rtsp_session_t *session, uint32_t events)
{
    int result;

    /* Check for connection errors or hangup */
    if (events & (EPOLLHUP | EPOLLERR | EPOLLRDHUP))
    {
        if (events & EPOLLERR)
        {
            int sock_error = 0;
            socklen_t error_len = sizeof(sock_error);
            if (getsockopt(session->socket, SOL_SOCKET, SO_ERROR, &sock_error, &error_len) == 0 && sock_error != 0)
            {
                logger(LOG_ERROR, "RTSP: Socket error: %s", strerror(sock_error));
            }
            else
            {
                logger(LOG_ERROR, "RTSP: Socket error event received");
            }
        }
        else if (events & (EPOLLHUP | EPOLLRDHUP))
        {
            logger(LOG_INFO, "RTSP: Server closed connection");
        }
        rtsp_session_set_state(session, RTSP_STATE_ERROR);
        return -1; /* Connection closed or error */
    }

    /* Handle connection completion (both initial and reconnect for TEARDOWN) */
    if (session->state == RTSP_STATE_CONNECTING || session->state == RTSP_STATE_RECONNECTING)
    {
        int sock_error = 0;
        socklen_t error_len = sizeof(sock_error);

        /* Check if connection succeeded using getsockopt */
        if (getsockopt(session->socket, SOL_SOCKET, SO_ERROR, &sock_error, &error_len) < 0)
        {
            logger(LOG_ERROR, "RTSP: getsockopt(SO_ERROR) failed: %s", strerror(errno));
            rtsp_session_set_state(session, RTSP_STATE_ERROR);
            return -1;
        }

        if (sock_error != 0)
        {
            /* Connection failed */
            logger(LOG_ERROR, "RTSP: Connection to %s:%d failed: %s",
                   session->server_host, session->server_port, strerror(sock_error));
            rtsp_session_set_state(session, RTSP_STATE_ERROR);
            return -1;
        }

        /* Connection succeeded */
        logger(LOG_INFO, "RTSP: Connected to %s:%d",
               session->server_host, session->server_port);
        logger(LOG_DEBUG, "RTSP: Connection to %s:%d completed successfully",
               session->server_host, session->server_port);

        /* Update epoll to monitor both read and write */
        if (session->epoll_fd >= 0)
        {
            struct epoll_event ev;
            ev.events = EPOLLIN | EPOLLOUT | EPOLLHUP | EPOLLERR | EPOLLRDHUP; /* Monitor I/O and errors */
            ev.data.fd = session->socket;
            if (epoll_ctl(session->epoll_fd, EPOLL_CTL_MOD, session->socket, &ev) < 0)
            {
                logger(LOG_ERROR, "RTSP: Failed to modify socket epoll events: %s", strerror(errno));
                rtsp_session_set_state(session, RTSP_STATE_ERROR);
                return -1;
            }
        }

        /* Determine next state based on whether this is initial connect or reconnect */
        if (session->state == RTSP_STATE_RECONNECTING)
        {
            /* Reconnected for TEARDOWN - keep RECONNECTING state for state machine */
            logger(LOG_INFO, "RTSP: Reconnected successfully for TEARDOWN");
        }
        else
        {
            /* Initial connection */
            rtsp_session_set_state(session, RTSP_STATE_CONNECTED);
        }

        /* Advance state machine to prepare next request (DESCRIBE or TEARDOWN) */
        result = rtsp_state_machine_advance(session);
        if (result < 0)
        {
            /* -2 indicates graceful TEARDOWN completion, not an error */
            if (result == -2)
            {
                return -2; /* Propagate graceful teardown signal */
            }
            /* Real error: set error state */
            rtsp_session_set_state(session, RTSP_STATE_ERROR);
            return -1;
        }
        /* Now pending_request is ready, will be sent when EPOLLOUT fires */
    }

    /* Handle writable socket - try to send pending data */
    if (events & EPOLLOUT)
    {
        if (session->pending_request_len > 0 && session->pending_request_sent < session->pending_request_len)
        {
            result = rtsp_try_send_pending(session);
            if (result < 0)
            {
                logger(LOG_ERROR, "RTSP: Failed to send pending request");
                rtsp_session_set_state(session, RTSP_STATE_ERROR);
                return -1;
            }

            /* If send completed, switch to waiting for response and stop monitoring EPOLLOUT */
            if (session->pending_request_sent >= session->pending_request_len)
            {
                session->awaiting_response = 1;

                /* Modify epoll to only monitor EPOLLIN to avoid busy loop */
                if (session->epoll_fd >= 0)
                {
                    struct epoll_event ev;
                    ev.events = EPOLLIN | EPOLLHUP | EPOLLERR | EPOLLRDHUP; /* Wait for response and errors */
                    ev.data.fd = session->socket;
                    if (epoll_ctl(session->epoll_fd, EPOLL_CTL_MOD, session->socket, &ev) < 0)
                    {
                        logger(LOG_ERROR, "RTSP: Failed to modify epoll events: %s", strerror(errno));
                        rtsp_session_set_state(session, RTSP_STATE_ERROR);
                        return -1;
                    }
                }
                logger(LOG_DEBUG, "RTSP: Request sent completely, waiting for response");
            }
        }
    }

    /* Handle readable socket - try to receive response */
    if (events & EPOLLIN)
    {
        if (session->state == RTSP_STATE_PLAYING)
        {
            result = rtsp_handle_rtp_data(session, session->conn);
            if (result < 0)
            {
                rtsp_session_set_state(session, RTSP_STATE_ERROR);
                return -1; /* Error */
            }
            return result; /* Return number of bytes forwarded to client */
        }
        if (session->awaiting_response)
        {
            result = rtsp_try_receive_response(session);
            if (result < 0)
            {
                logger(LOG_ERROR, "RTSP: Failed to receive response");
                rtsp_session_set_state(session, RTSP_STATE_ERROR);
                return -1;
            }

            /* Re-enable EPOLLOUT for next request */
            if (result == 1 && session->epoll_fd >= 0)
            {
                struct epoll_event ev;
                ev.events = EPOLLIN | EPOLLOUT | EPOLLHUP | EPOLLERR | EPOLLRDHUP;
                ev.data.fd = session->socket;
                if (epoll_ctl(session->epoll_fd, EPOLL_CTL_MOD, session->socket, &ev) < 0)
                {
                    logger(LOG_ERROR, "RTSP: Failed to modify epoll events: %s", strerror(errno));
                    rtsp_session_set_state(session, RTSP_STATE_ERROR);
                    return -1;
                }
            }

            /* Advance state machine to prepare next request (or enter PLAYING state) */
            result = rtsp_state_machine_advance(session);
            if (result < 0)
            {
                /* -2 indicates graceful TEARDOWN completion, not an error */
                if (result != -2)
                {
                    /* Real error: set error state */
                    rtsp_session_set_state(session, RTSP_STATE_ERROR);
                }
            }
            return result;
        }
    }

    /* Only advance state machine on initial connection or after response received */
    /* For SENDING_* states, just wait for EPOLLOUT to complete the send */
    return 0;
}

/**
 * Prepare RTSP request for sending (non-blocking)
 * Builds request and stores in pending_request buffer
 */
static int rtsp_prepare_request(rtsp_session_t *session, const char *method, const char *extra_headers)
{
    /* Build RTSP request */
    int len = snprintf(session->pending_request, sizeof(session->pending_request),
                       "%s %s %s\r\n"
                       "CSeq: %u\r\n"
                       "User-Agent: %s\r\n"
                       "%s"
                       "\r\n",
                       method, session->server_url, RTSP_VERSION,
                       session->cseq++,
                       USER_AGENT,
                       extra_headers ? extra_headers : "");

    if (len < 0 || len >= (int)sizeof(session->pending_request))
    {
        logger(LOG_ERROR, "RTSP: Request buffer overflow");
        return -1;
    }

    session->pending_request_len = (size_t)len;
    session->pending_request_sent = 0;

    logger(LOG_DEBUG, "RTSP: Prepared request:\n%s", session->pending_request);
    return 0;
}

/**
 * Try to send pending request (non-blocking)
 * Returns: 0 = complete, -1 = error, EAGAIN = would block (handled internally)
 */
static int rtsp_try_send_pending(rtsp_session_t *session)
{
    if (session->pending_request_sent >= session->pending_request_len)
    {
        return 0; /* Already sent */
    }

    ssize_t sent = send(session->socket,
                        session->pending_request + session->pending_request_sent,
                        session->pending_request_len - session->pending_request_sent,
                        MSG_DONTWAIT | MSG_NOSIGNAL);

    if (sent < 0)
    {
        if (errno == EAGAIN)
        {
            /* Would block - will retry when socket becomes writable */
            return 0;
        }
        logger(LOG_ERROR, "RTSP: Failed to send request: %s", strerror(errno));
        return -1;
    }

    session->pending_request_sent += (size_t)sent;

    if (session->pending_request_sent >= session->pending_request_len)
    {
        /* Send complete - now await response */
        logger(LOG_DEBUG, "RTSP: Request sent completely (%zu bytes)", session->pending_request_len);
        session->pending_request_len = 0;
        session->pending_request_sent = 0;
        session->awaiting_response = 1;
        session->response_buffer_pos = 0;

        /* Update state to awaiting response */
        if (session->state == RTSP_STATE_SENDING_DESCRIBE)
        {
            rtsp_session_set_state(session, RTSP_STATE_AWAITING_DESCRIBE);
        }
        else if (session->state == RTSP_STATE_SENDING_SETUP)
        {
            rtsp_session_set_state(session, RTSP_STATE_AWAITING_SETUP);
        }
        else if (session->state == RTSP_STATE_SENDING_PLAY)
        {
            rtsp_session_set_state(session, RTSP_STATE_AWAITING_PLAY);
        }
        else if (session->state == RTSP_STATE_SENDING_TEARDOWN)
        {
            rtsp_session_set_state(session, RTSP_STATE_AWAITING_TEARDOWN);
        }
    }

    return 0;
}

/**
 * Try to receive RTSP response (non-blocking)
 * Returns: 0 = incomplete/complete, -1 = error, 1 = need EPOLLOUT for next request
 */
static int rtsp_try_receive_response(rtsp_session_t *session)
{
    if (!session->awaiting_response)
    {
        return 0; /* Not waiting for response */
    }

    /* Try to receive more data */
    ssize_t received = recv(session->socket,
                            session->response_buffer + session->response_buffer_pos,
                            sizeof(session->response_buffer) - session->response_buffer_pos - 1,
                            MSG_DONTWAIT);

    if (received < 0)
    {
        if (errno == EAGAIN)
        {
            /* Would block - will retry when data arrives */
            return 0;
        }
        logger(LOG_ERROR, "RTSP: Failed to receive response: %s", strerror(errno));
        return -1;
    }

    if (received == 0)
    {
        logger(LOG_ERROR, "RTSP: Connection closed by server");
        return -1;
    }

    session->response_buffer_pos += (size_t)received;
    session->response_buffer[session->response_buffer_pos] = '\0';

    /* Complete response received */
    logger(LOG_DEBUG, "RTSP: Received complete response:\n%s", session->response_buffer);

    session->awaiting_response = 0;
    int parse_result = rtsp_parse_response(session, (char *)session->response_buffer);

    if (parse_result < 0)
    {
        return -1;
    }

    /* Handle redirect case */
    if (parse_result == 2)
    {
        /* Redirect in progress - state machine will handle it */
        session->response_buffer_pos = 0;
        return 0;
    }

    /* Check if there's data after the response headers (e.g., RTP data after PLAY response) */
    size_t extra_data_len = 0;
    char *end_of_headers = strstr((char *)session->response_buffer, "\r\n\r\n");
    if (end_of_headers)
    {
        size_t headers_len = (end_of_headers - (char *)session->response_buffer) + 4;
        if (session->response_buffer_pos > headers_len)
        {
            extra_data_len = session->response_buffer_pos - headers_len;
            logger(LOG_DEBUG, "RTSP: Found %zu bytes of data after response headers", extra_data_len);
        }
    }

    /* Advance to next state based on current state */
    if (session->state == RTSP_STATE_AWAITING_DESCRIBE)
    {
        rtsp_session_set_state(session, RTSP_STATE_DESCRIBED);
        session->response_buffer_pos = 0;
        return 1;
    }
    if (session->state == RTSP_STATE_AWAITING_SETUP)
    {
        rtsp_session_set_state(session, RTSP_STATE_SETUP);
        session->response_buffer_pos = 0;
        return 1;
    }

    if (session->state == RTSP_STATE_AWAITING_PLAY)
    {
        rtsp_session_set_state(session, RTSP_STATE_PLAYING);

        /* For TCP interleaved mode, preserve any RTP data that came after PLAY response */
        if (session->transport_mode == RTSP_TRANSPORT_TCP && extra_data_len > 0)
        {
            /* Move extra data to tcp_buffer for processing */
            if (extra_data_len <= BUFFER_POOL_BUFFER_SIZE)
            {
                memcpy(session->tcp_buffer, end_of_headers + 4, extra_data_len);
                session->tcp_buffer_pos = extra_data_len;
                logger(LOG_DEBUG, "RTSP: Preserved %zu bytes of RTP data after PLAY response", extra_data_len);
            }
            else
            {
                logger(LOG_ERROR, "RTSP: Extra data after PLAY response too large (%zu bytes), discarding", extra_data_len);
            }
        }
        session->response_buffer_pos = 0;
    }
    else if (session->state == RTSP_STATE_AWAITING_TEARDOWN)
    {
        rtsp_session_set_state(session, RTSP_STATE_TEARDOWN_COMPLETE);
        logger(LOG_INFO, "RTSP: TEARDOWN response received");
        session->response_buffer_pos = 0;
    }
    else
    {
        /* Clear response buffer for other states */
        session->response_buffer_pos = 0;
    }

    return 0;
}

/**
 * State machine advancement - initiates next action based on current state
 * Returns: 0 = continue, -1 = error
 */
static int rtsp_state_machine_advance(rtsp_session_t *session)
{
    char extra_headers[RTSP_HEADERS_BUFFER_SIZE];

    switch (session->state)
    {
    case RTSP_STATE_CONNECTED:
        /* Ready to send DESCRIBE */
        snprintf(extra_headers, sizeof(extra_headers), "Accept: application/sdp\r\n");
        if (rtsp_prepare_request(session, RTSP_METHOD_DESCRIBE, extra_headers) < 0)
        {
            logger(LOG_ERROR, "RTSP: Failed to prepare DESCRIBE request");
            return -1;
        }
        rtsp_session_set_state(session, RTSP_STATE_SENDING_DESCRIBE);
        /* Will send when socket becomes writable */
        return 0;

    case RTSP_STATE_DESCRIBED:
        /* Ready to send SETUP - first setup UDP sockets if needed */
        if (rtsp_setup_udp_sockets(session) < 0)
        {
            logger(LOG_DEBUG, "RTSP: Failed to setup UDP sockets, will only offer TCP transport");
            snprintf(extra_headers, sizeof(extra_headers),
                     "Transport: MP2T/RTP/TCP;unicast;interleaved=%d-%d,"
                     "MP2T/TCP;unicast;interleaved=%d-%d,"
                     "RTP/AVP/TCP;unicast;interleaved=%d-%d\r\n",
                     session->rtp_channel, session->rtcp_channel,
                     session->rtp_channel, session->rtcp_channel,
                     session->rtp_channel, session->rtcp_channel);
        }
        else
        {
            snprintf(extra_headers, sizeof(extra_headers),
                     "Transport: MP2T/RTP/TCP;unicast;interleaved=%d-%d,"
                     "MP2T/TCP;unicast;interleaved=%d-%d,"
                     "RTP/AVP/TCP;unicast;interleaved=%d-%d,"
                     "MP2T/RTP/UDP;unicast;client_port=%d-%d,"
                     "MP2T/UDP;unicast;client_port=%d-%d,"
                     "RTP/AVP;unicast;client_port=%d-%d\r\n",
                     session->rtp_channel, session->rtcp_channel,
                     session->rtp_channel, session->rtcp_channel,
                     session->rtp_channel, session->rtcp_channel,
                     session->local_rtp_port, session->local_rtcp_port,
                     session->local_rtp_port, session->local_rtcp_port,
                     session->local_rtp_port, session->local_rtcp_port);
            // snprintf(extra_headers, sizeof(extra_headers),
            //          "Transport: MP2T/RTP/UDP;unicast;client_port=%d-%d,"
            //          "MP2T/UDP;unicast;client_port=%d-%d,"
            //          "RTP/AVP;unicast;client_port=%d-%d\r\n",
            //          session->local_rtp_port, session->local_rtcp_port,
            //          session->local_rtp_port, session->local_rtcp_port,
            //          session->local_rtp_port, session->local_rtcp_port);
        }
        if (rtsp_prepare_request(session, RTSP_METHOD_SETUP, extra_headers) < 0)
        {
            logger(LOG_ERROR, "RTSP: Failed to prepare SETUP request");
            return -1;
        }
        rtsp_session_set_state(session, RTSP_STATE_SENDING_SETUP);
        return 0;

    case RTSP_STATE_SETUP:
        snprintf(extra_headers, sizeof(extra_headers),
                 "Session: %s\r\n", session->session_id);
        if (rtsp_prepare_request(session, RTSP_METHOD_PLAY, extra_headers) < 0)
        {
            logger(LOG_ERROR, "RTSP: Failed to prepare PLAY request");
            return -1;
        }
        rtsp_session_set_state(session, RTSP_STATE_SENDING_PLAY);
        return 0;

    case RTSP_STATE_PLAYING:
        /* Streaming active - nothing to do */
        logger(LOG_INFO, "RTSP: Stream started successfully");
        return 0;

    case RTSP_STATE_RECONNECTING:
        /* Reconnection completed, now send TEARDOWN */
        if (session->teardown_requested)
        {
            snprintf(extra_headers, sizeof(extra_headers), "Session: %s\r\n", session->session_id);
            if (rtsp_prepare_request(session, RTSP_METHOD_TEARDOWN, extra_headers) < 0)
            {
                logger(LOG_ERROR, "RTSP: Failed to prepare TEARDOWN after reconnect");
                return -1;
            }
            rtsp_session_set_state(session, RTSP_STATE_SENDING_TEARDOWN);
            logger(LOG_DEBUG, "RTSP: TEARDOWN prepared after reconnect");
            return 0;
        }
        /* Should not reach here */
        logger(LOG_ERROR, "RTSP: In RECONNECTING state but teardown not requested");
        return -1;

    case RTSP_STATE_TEARDOWN_COMPLETE:
        /* TEARDOWN response received, now force cleanup */
        logger(LOG_INFO, "RTSP: TEARDOWN complete, cleaning up");
        rtsp_force_cleanup(session);
        /* Return -2 to signal graceful teardown completion (not an error) */
        return -2;

    default:
        /* Other states don't need automatic advancement */
        return 0;
    }
}

int rtsp_handle_rtp_data(rtsp_session_t *session, struct connection_s *conn)
{
    if (session->transport_mode == RTSP_TRANSPORT_TCP)
    {
        return rtsp_handle_tcp_interleaved_data(session, conn);
    }
    else
    {
        return rtsp_handle_udp_rtp_data(session, conn);
    }
}

int rtsp_handle_tcp_interleaved_data(rtsp_session_t *session, struct connection_s *conn)
{
    int bytes_received;

    if (session->tcp_buffer_pos < BUFFER_POOL_BUFFER_SIZE)
    {
        /* Read data into local buffer (will be copied to zero-copy buffers later) */
        bytes_received = recv(session->socket,
                              session->tcp_buffer + session->tcp_buffer_pos,
                              BUFFER_POOL_BUFFER_SIZE - session->tcp_buffer_pos, 0);
        if (bytes_received < 0)
        {
            /* Check if it's a non-blocking would-block error */
            if (errno == EAGAIN)
            {
                return 0; /* No data available, not an error */
            }
            logger(LOG_ERROR, "RTSP: TCP receive failed: %s", strerror(errno));
            return -1;
        }

        session->tcp_buffer_pos += bytes_received;
    }

    /* Process interleaved data packets */
    int bytes_forwarded = 0;
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
        if (session->tcp_buffer_pos < 4 + (size_t)packet_length)
        {
            break; /* Wait for more data */
        }

        /* Sanity check: prevent processing packets that are too large */
        if (packet_length > BUFFER_POOL_BUFFER_SIZE - 4)
        {
            logger(LOG_ERROR, "RTSP: Received packet too large (%d bytes, max %zu), attempting resync",
                   packet_length, BUFFER_POOL_BUFFER_SIZE - 4);
            /* Try to find next '$' marker to resync stream */
            uint8_t *next_marker = memchr(session->tcp_buffer + 1, '$', session->tcp_buffer_pos - 1);
            if (next_marker)
            {
                size_t skip = next_marker - session->tcp_buffer;
                memmove(session->tcp_buffer, next_marker, session->tcp_buffer_pos - skip);
                session->tcp_buffer_pos -= skip;
                logger(LOG_DEBUG, "RTSP: Resynced stream, skipped %zu bytes", skip);
            }
            else
            {
                /* No marker found, reset buffer */
                session->tcp_buffer_pos = 0;
                logger(LOG_DEBUG, "RTSP: No sync marker found, buffer reset");
            }
            break;
        }

        /* Process RTP/RTCP packet based on channel */
        if (channel == session->rtp_channel)
        {
            /* Handle RTP data based on transport protocol */
            if (session->transport_protocol == RTSP_PROTOCOL_MP2T)
            {
                /* MP2T - copy to a new zero-copy buffer for queuing */
                buffer_ref_t *packet_buf = buffer_pool_alloc(packet_length);
                if (packet_buf)
                {
                    memcpy(packet_buf->data, session->tcp_buffer + 4, packet_length);
                    if (connection_queue_zerocopy(conn, packet_buf, 0, (size_t)packet_length) == 0)
                    {
                        bytes_forwarded += packet_length;
                    }
                    else
                    {
                        /* Queue full - backpressure */
                        session->packets_dropped++;
                        if (session->packets_dropped % 100 == 0)
                        {
                            logger(LOG_DEBUG, "RTSP TCP: Dropped %llu packets (queue full)",
                                   (unsigned long long)session->packets_dropped);
                        }
                    }
                    /* Release our reference - zerocopy queue now owns it */
                    buffer_ref_put(packet_buf);
                }
                else
                {
                    /* Buffer pool exhausted */
                    session->packets_dropped++;
                    logger(LOG_DEBUG, "RTSP TCP: Buffer pool exhausted, dropping packet");
                }
            }
            else
            {
                /* RTP - extract RTP payload and forward to client (or capture snapshot)
                 * stream_process_rtp_payload will allocate a new buffer for the payload */
                buffer_ref_t *packet_buf = buffer_pool_alloc(packet_length);
                if (packet_buf)
                {
                    memcpy(packet_buf->data, &session->tcp_buffer[4], packet_length);
                    int pb = stream_process_rtp_payload(&conn->stream, packet_length, packet_buf->data,
                                                        packet_buf,
                                                        &session->current_seqn, &session->not_first_packet);
                    if (pb > 0)
                        bytes_forwarded += pb;
                    /* Release our reference */
                    buffer_ref_put(packet_buf);
                }
                else
                {
                    /* Buffer pool exhausted */
                    session->packets_dropped++;
                    logger(LOG_DEBUG, "RTSP TCP: Buffer pool exhausted, dropping packet");
                }
            }
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

    return bytes_forwarded;
}

int rtsp_handle_udp_rtp_data(rtsp_session_t *session, struct connection_s *conn)
{
    int bytes_received;

    /* Allocate a fresh buffer from pool for this receive operation */
    buffer_ref_t *rtp_buf = buffer_pool_alloc(BUFFER_POOL_BUFFER_SIZE);
    if (!rtp_buf)
    {
        /* Buffer pool exhausted - drop this packet */
        logger(LOG_DEBUG, "RTSP UDP: Buffer pool exhausted, dropping packet");
        session->packets_dropped++;
        /* Drain the socket to prevent event loop spinning */
        uint8_t dummy[BUFFER_POOL_BUFFER_SIZE];
        ssize_t drained = recv(session->rtp_socket, dummy, sizeof(dummy), 0);
        if (drained < 0 && errno != EAGAIN)
        {
            logger(LOG_DEBUG, "RTSP UDP: Dummy recv failed while dropping packet: %s", strerror(errno));
        }
        return 0;
    }

    uint8_t *rtp_buffer = (uint8_t *)rtp_buf->data;

    /* Receive directly into zero-copy buffer (true zero-copy receive) */
    bytes_received = recv(session->rtp_socket, rtp_buffer,
                          BUFFER_POOL_BUFFER_SIZE, 0);
    if (bytes_received < 0)
    {
        logger(LOG_ERROR, "RTSP: RTP receive failed: %s", strerror(errno));
        buffer_ref_put(rtp_buf);
        return -1;
    }

    if (bytes_received > 0)
    {
        int bytes_written = 0;
        /* Handle RTP data based on transport protocol */
        if (session->transport_protocol == RTSP_PROTOCOL_MP2T)
        {
            /* MP2T - zero-copy send (data already in pool buffer, just queue it) */
            /* Note: zerocopy_queue_add() will automatically increment refcount */
            if (connection_queue_zerocopy(conn, rtp_buf, 0, (size_t)bytes_received) == 0)
            {
                bytes_written = bytes_received;
            }
            else
            {
                /* Queue full - backpressure */
                session->packets_dropped++;
                if (session->packets_dropped % 100 == 0)
                {
                    logger(LOG_DEBUG, "RTSP UDP: Dropped %llu packets (queue full)",
                           (unsigned long long)session->packets_dropped);
                }
                bytes_written = 0;
            }
        }
        else
        {
            /* RTP - extract RTP payload and forward to client or capture snapshot (true zero-copy) */
            int pb = stream_process_rtp_payload(&conn->stream, bytes_received, rtp_buffer,
                                                rtp_buf,
                                                &session->current_seqn, &session->not_first_packet);
            if (pb > 0)
                bytes_written = pb;
        }
        /* Release our reference to the buffer */
        buffer_ref_put(rtp_buf);
        return bytes_written;
    }

    buffer_ref_put(rtp_buf);
    return 0;
}

/**
 * Force cleanup - immediately close all sockets and reset session
 * Used when TEARDOWN cannot be sent or after TEARDOWN completes
 */
static void rtsp_force_cleanup(rtsp_session_t *session)
{
    /* Close and remove RTSP control socket from epoll */
    if (session->socket >= 0)
    {
        worker_cleanup_socket_from_epoll(session->epoll_fd, session->socket);
        session->socket = -1;
        logger(LOG_DEBUG, "RTSP: Main socket closed");
    }

    /* Close and remove UDP sockets from epoll */
    rtsp_close_udp_sockets(session, "cleanup");

    /* Reset TCP buffer position */
    session->tcp_buffer_pos = 0;

    /* Reset response buffer position */
    session->response_buffer_pos = 0;

    /* Reset pending request state */
    session->pending_request_len = 0;
    session->pending_request_sent = 0;
    session->awaiting_response = 0;

    /* Reset teardown state */
    session->teardown_requested = 0;
    session->teardown_reconnect_done = 0;
    session->state_before_teardown = RTSP_STATE_INIT;

    /* Clear session ID and server info */
    session->session_id[0] = '\0';
    session->server_url[0] = '\0';

    /* Mark cleanup as done */
    session->cleanup_done = 1;

    session->state = RTSP_STATE_INIT;
    logger(LOG_DEBUG, "RTSP: Session cleanup complete");
}

/**
 * Reconnect to server for sending TEARDOWN
 * Returns: 0 on success (reconnection initiated), -1 on failure
 */
static int rtsp_reconnect_for_teardown(rtsp_session_t *session)
{
    /* Mark that we've attempted reconnect */
    session->teardown_reconnect_done = 1;

    logger(LOG_INFO, "RTSP: Reconnecting to %s:%d to send TEARDOWN",
           session->server_host, session->server_port);

    /* Close current socket if open properly */
    if (session->socket >= 0)
    {
        worker_cleanup_socket_from_epoll(session->epoll_fd, session->socket);
        session->socket = -1;
    }

    /* Attempt to reconnect */
    if (rtsp_connect(session) < 0)
    {
        logger(LOG_ERROR, "RTSP: Failed to reconnect for TEARDOWN");
        return -1;
    }

    /* Set state to RECONNECTING */
    rtsp_session_set_state(session, RTSP_STATE_RECONNECTING);

    /* Connection is now in progress (async) or completed */
    /* State machine will handle sending TEARDOWN when connected */
    return 0;
}

/**
 * Initiate TEARDOWN sequence
 * Returns: 0 if TEARDOWN initiated, 1 if reconnect needed, -1 on error
 */
static int rtsp_initiate_teardown(rtsp_session_t *session)
{
    char extra_headers[RTSP_HEADERS_BUFFER_SIZE];

    /* Check if socket is still valid */
    if (session->socket >= 0)
    {
        int sock_error = 0;
        socklen_t error_len = sizeof(sock_error);

        if (getsockopt(session->socket, SOL_SOCKET, SO_ERROR, &sock_error, &error_len) == 0 && sock_error == 0)
        {
            /* Socket is valid, prepare and send TEARDOWN */
            snprintf(extra_headers, sizeof(extra_headers), "Session: %s\r\n", session->session_id);

            if (rtsp_prepare_request(session, RTSP_METHOD_TEARDOWN, extra_headers) < 0)
            {
                logger(LOG_ERROR, "RTSP: Failed to prepare TEARDOWN request");
                return -1;
            }

            rtsp_session_set_state(session, RTSP_STATE_SENDING_TEARDOWN);
            logger(LOG_DEBUG, "RTSP: TEARDOWN request prepared, will send asynchronously");

            if (session->epoll_fd >= 0)
            {
                struct epoll_event ev;
                ev.events = EPOLLIN | EPOLLOUT | EPOLLHUP | EPOLLERR | EPOLLRDHUP;
                ev.data.fd = session->socket;
                if (epoll_ctl(session->epoll_fd, EPOLL_CTL_MOD, session->socket, &ev) < 0)
                {
                    logger(LOG_ERROR, "RTSP: Failed to modify socket epoll events: %s", strerror(errno));
                    rtsp_session_set_state(session, RTSP_STATE_ERROR);
                    return -1;
                }
            }

            return 0; /* TEARDOWN prepared, will be sent by state machine */
        }
    }

    /* Socket is invalid or closed - need to reconnect */
    logger(LOG_DEBUG, "RTSP: Socket closed, need to reconnect for TEARDOWN");
    return 1; /* Indicate reconnect needed */
}

/**
 * Public cleanup function - initiates async TEARDOWN or forces cleanup
 * This function is called when the client disconnects
 * It will initiate TEARDOWN if in SETUP or PLAYING state
 */
int rtsp_session_cleanup(rtsp_session_t *session)
{
    /* Prevent re-entry: if cleanup already done, skip */
    if (session->cleanup_done)
    {
        logger(LOG_DEBUG, "RTSP: Cleanup already completed, skipping");
        return 0; /* Cleanup already done */
    }

    /* Prevent re-entry: if already in cleanup/teardown states, don't process again */
    if (session->state == RTSP_STATE_INIT ||
        session->state == RTSP_STATE_ERROR ||
        session->state == RTSP_STATE_SENDING_TEARDOWN ||
        session->state == RTSP_STATE_AWAITING_TEARDOWN ||
        session->state == RTSP_STATE_TEARDOWN_COMPLETE ||
        session->state == RTSP_STATE_RECONNECTING)
    {
        logger(LOG_DEBUG, "RTSP: Cleanup called in state %d, skipping (already cleaning up or done)", session->state);
        /* If already in INIT or ERROR, ensure everything is cleaned up (only once) */
        if ((session->state == RTSP_STATE_INIT || session->state == RTSP_STATE_ERROR) && !session->cleanup_done)
        {
            rtsp_force_cleanup(session);
        }
        return 0; /* No async operation */
    }

    /* Check if we need to send TEARDOWN */
    if (session->state == RTSP_STATE_PLAYING || session->state == RTSP_STATE_SETUP)
    {
        /* Mark that TEARDOWN has been requested */
        session->teardown_requested = 1;
        session->state_before_teardown = session->state;

        logger(LOG_INFO, "RTSP: Cleanup requested in state %d, initiating TEARDOWN", session->state);

        /* Try to initiate TEARDOWN */
        int result = rtsp_initiate_teardown(session);

        if (result == 0)
        {
            /* TEARDOWN prepared successfully, will be sent asynchronously */
            /* State machine will handle the rest */
            logger(LOG_DEBUG, "RTSP: TEARDOWN initiated, waiting for async completion");
            return 1; /* Async TEARDOWN in progress */
        }
        else if (result == 1)
        {
            /* Need to reconnect */
            if (!session->teardown_reconnect_done)
            {
                /* Attempt reconnect (only once) */
                if (rtsp_reconnect_for_teardown(session) == 0)
                {
                    logger(LOG_DEBUG, "RTSP: Reconnecting for TEARDOWN");
                    return 1; /* Async reconnect in progress */
                }
            }

            /* Reconnect failed or already attempted */
            logger(LOG_ERROR, "RTSP: Cannot reconnect for TEARDOWN, forcing cleanup");
        }
        else
        {
            /* Error preparing TEARDOWN */
            logger(LOG_ERROR, "RTSP: Failed to prepare TEARDOWN, forcing cleanup");
        }
    }

    /* If we reach here, either:
     * 1. Not in a state that requires TEARDOWN
     * 2. TEARDOWN preparation failed
     * 3. Reconnect failed
     * Force immediate cleanup */
    rtsp_force_cleanup(session);
    return 0; /* Cleanup completed immediately */
}

int rtsp_session_is_async_teardown(rtsp_session_t *session)
{
    /* Check if session is in async TEARDOWN states where we're waiting for response */
    return (session->teardown_requested &&
            (session->state == RTSP_STATE_SENDING_TEARDOWN ||
             session->state == RTSP_STATE_AWAITING_TEARDOWN ||
             session->state == RTSP_STATE_RECONNECTING));
}

/* Helper functions */
static int rtsp_parse_response(rtsp_session_t *session, const char *response)
{
    char *session_header = NULL;
    char *transport_header = NULL;
    char *location_header = NULL;
    int status_code;
    int result = 0;

    /* Parse status line */
    if (sscanf(response, "RTSP/1.0 %d", &status_code) != 1)
    {
        logger(LOG_ERROR, "RTSP: Invalid response format");
        result = -1;
        goto cleanup;
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
            result = -1;
            goto cleanup;
        }

        result = rtsp_handle_redirect(session, location_header);
        /* Note: result can be 1 (success), 2 (async), or -1 (failure) */
        goto cleanup;
    }
    else if (status_code != 200)
    {
        logger(LOG_ERROR, "RTSP: Server returned error code %d", status_code);
        result = -1;
        goto cleanup;
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
    }

    /* Extract Transport header if present */
    transport_header = rtsp_find_header(response, "Transport");
    if (transport_header)
    {
        rtsp_parse_transport_header(session, transport_header);
    }

    result = 0;

cleanup:
    /* Free all allocated headers */
    if (session_header)
        free(session_header);
    if (transport_header)
        free(transport_header);
    if (location_header)
        free(location_header);

    return result;
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
    const struct ifreq *upstream_if;

    logger(LOG_DEBUG, "RTSP: Setting up UDP sockets");

    upstream_if = &config.upstream_interface_unicast;

    /* Create RTP socket */
    session->rtp_socket = socket(AF_INET, SOCK_DGRAM, 0);
    if (session->rtp_socket < 0)
    {
        logger(LOG_ERROR, "RTSP: Failed to create RTP socket: %s", strerror(errno));
        return -1;
    }

    /* Set socket to non-blocking mode for epoll */
    if (connection_set_nonblocking(session->rtp_socket) < 0)
    {
        logger(LOG_ERROR, "RTSP: Failed to set RTP socket non-blocking: %s", strerror(errno));
        close(session->rtp_socket);
        session->rtp_socket = -1;
        return -1;
    }

    bind_to_upstream_interface(session->rtp_socket, upstream_if);

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

    /* Register RTP socket with epoll immediately after creation (if epoll_fd provided) */
    if (session->epoll_fd >= 0)
    {
        struct epoll_event ev;
        ev.events = EPOLLIN | EPOLLHUP | EPOLLERR; /* Monitor read and error events */
        ev.data.fd = session->rtp_socket;
        if (epoll_ctl(session->epoll_fd, EPOLL_CTL_ADD, session->rtp_socket, &ev) < 0)
        {
            logger(LOG_ERROR, "RTSP: Failed to add RTP socket to epoll: %s", strerror(errno));
            close(session->rtp_socket);
            session->rtp_socket = -1;
            return -1;
        }
        fdmap_set(session->rtp_socket, session->conn);
        logger(LOG_DEBUG, "RTSP: RTP socket registered with epoll");
    }

    /* Create RTCP socket */
    session->rtcp_socket = socket(AF_INET, SOCK_DGRAM, 0);
    if (session->rtcp_socket < 0)
    {
        logger(LOG_ERROR, "RTSP: Failed to create RTCP socket: %s", strerror(errno));
        /* Clean up RTP socket properly */
        worker_cleanup_socket_from_epoll(session->epoll_fd, session->rtp_socket);
        session->rtp_socket = -1;
        session->local_rtp_port = 0;
        return -1;
    }

    /* Set socket to non-blocking mode for epoll */
    if (connection_set_nonblocking(session->rtcp_socket) < 0)
    {
        logger(LOG_ERROR, "RTSP: Failed to set RTCP socket non-blocking: %s", strerror(errno));
        /* Clean up RTP socket (already registered) and RTCP socket (not yet registered) */
        worker_cleanup_socket_from_epoll(session->epoll_fd, session->rtp_socket);
        close(session->rtcp_socket); /* RTCP not yet in fdmap, direct close is correct */
        session->rtp_socket = -1;
        session->rtcp_socket = -1;
        session->local_rtp_port = 0;
        session->local_rtcp_port = 0;
        return -1;
    }

    bind_to_upstream_interface(session->rtcp_socket, upstream_if);

    /* Bind RTCP socket to odd port */
    local_addr.sin_port = htons(session->local_rtp_port + 1);
    if (bind(session->rtcp_socket, (struct sockaddr *)&local_addr, sizeof(local_addr)) < 0)
    {
        logger(LOG_ERROR, "RTSP: Failed to bind RTCP socket: %s", strerror(errno));
        /* Clean up RTP socket (already registered) and RTCP socket (not yet registered) */
        worker_cleanup_socket_from_epoll(session->epoll_fd, session->rtp_socket);
        close(session->rtcp_socket); /* RTCP not yet in fdmap, direct close is correct */
        session->rtp_socket = -1;
        session->rtcp_socket = -1;
        session->local_rtp_port = 0;
        session->local_rtcp_port = 0;
        return -1;
    }

    /* Register RTCP socket with epoll immediately after creation (if epoll_fd provided) */
    if (session->epoll_fd >= 0)
    {
        struct epoll_event ev;
        ev.events = EPOLLIN | EPOLLHUP | EPOLLERR; /* Monitor read and error events */
        ev.data.fd = session->rtcp_socket;
        if (epoll_ctl(session->epoll_fd, EPOLL_CTL_ADD, session->rtcp_socket, &ev) < 0)
        {
            logger(LOG_ERROR, "RTSP: Failed to add RTCP socket to epoll: %s", strerror(errno));
            /* Clean up RTP socket (already registered) and RTCP socket (not yet registered) */
            worker_cleanup_socket_from_epoll(session->epoll_fd, session->rtp_socket);
            close(session->rtcp_socket); /* RTCP not yet in fdmap, direct close is correct */
            session->rtp_socket = -1;
            session->rtcp_socket = -1;
            session->local_rtp_port = 0;
            session->local_rtcp_port = 0;
            return -1;
        }
        fdmap_set(session->rtcp_socket, session->conn);
        logger(LOG_DEBUG, "RTCP: RTCP socket registered with epoll");
    }

    session->local_rtcp_port = session->local_rtp_port + 1;

    logger(LOG_DEBUG, "RTSP: UDP sockets bound to ports %d (RTP) and %d (RTCP)",
           session->local_rtp_port, session->local_rtcp_port);

    return 0;
}

/*
 * Close UDP sockets and remove from epoll
 * Called when TCP interleaved mode is confirmed
 */
static void rtsp_close_udp_sockets(rtsp_session_t *session, const char *reason)
{
    /* Close and remove RTP socket from epoll */
    if (session->rtp_socket >= 0)
    {
        worker_cleanup_socket_from_epoll(session->epoll_fd, session->rtp_socket);
        session->rtp_socket = -1;
        logger(LOG_DEBUG, "RTSP: Closed UDP RTP socket %s", reason);
    }

    /* Close and remove RTCP socket from epoll */
    if (session->rtcp_socket >= 0)
    {
        worker_cleanup_socket_from_epoll(session->epoll_fd, session->rtcp_socket);
        session->rtcp_socket = -1;
        logger(LOG_DEBUG, "RTSP: Closed UDP RTCP socket %s", reason);
    }
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

        /* Close UDP sockets since we're using TCP interleaved mode */
        rtsp_close_udp_sockets(session, "use TCP interleaved mode");
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
 * Returns: 1 if redirect successful and connection completed (caller should retry request)
 *          2 if redirect initiated but connection in progress (caller should wait)
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

    /* Close current connection and remove from epoll properly */
    if (session->socket >= 0)
    {
        worker_cleanup_socket_from_epoll(session->epoll_fd, session->socket);
        session->socket = -1;
    }

    /* Parse new URL and update session */
    if (rtsp_parse_server_url(session, location, NULL, NULL) < 0)
    {
        logger(LOG_ERROR, "RTSP: Failed to parse redirect URL");
        return -1;
    }

    /* Connect to new server (socket will be registered with epoll using session->epoll_fd) */
    if (rtsp_connect(session) < 0)
    {
        logger(LOG_ERROR, "RTSP: Failed to connect to redirected server");
        return -1;
    }

    logger(LOG_INFO, "RTSP: Redirect to %s:%d initiated (redirect #%d)",
           session->server_host, session->server_port, session->redirect_count);

    /* Check if connection completed immediately or is in progress */
    if (session->state == RTSP_STATE_CONNECTED)
    {
        /* Immediate connection (rare) - caller can retry request */
        return 1;
    }
    else if (session->state == RTSP_STATE_CONNECTING)
    {
        /* Async connection in progress - caller should wait for completion */
        return 2;
    }
    else
    {
        logger(LOG_ERROR, "RTSP: Unexpected state after redirect connect: %d", session->state);
        return -1;
    }
}

/*
 * Helper function to convert time string to UTC (keeping original format)
 * Handles Unix timestamps (no conversion needed) and yyyyMMddHHmmss format with timezone conversion
 * Returns 0 on success, -1 on error
 */
static int rtsp_convert_time_to_utc(const char *time_str, int tz_offset_seconds, char *output, size_t output_size)
{
    size_t len;
    size_t digit_count;

    if (!time_str || !output || output_size < RTSP_TIME_STRING_SIZE)
    {
        return -1;
    }

    len = strlen(time_str);
    digit_count = strspn(time_str, "0123456789");

    /* Check if it's a Unix timestamp (all digits, length <= 10) */
    if (len <= 10 && digit_count == len)
    {
        /* Unix timestamp is already in UTC, no conversion needed */
        strncpy(output, time_str, output_size - 1);
        output[output_size - 1] = '\0';
        logger(LOG_DEBUG, "RTSP: Unix timestamp '%s' is already UTC", time_str);
        return 0;
    }

    /* Check if it's yyyyMMddHHmmss format (exactly 14 digits) */
    if (len == 14 && digit_count == 14)
    {
        /* Apply timezone conversion to UTC, keep yyyyMMddHHmmss format */
        if (timezone_convert_time_with_offset(time_str, tz_offset_seconds, output, output_size) == 0)
        {
            if (tz_offset_seconds != 0)
            {
                logger(LOG_DEBUG, "RTSP: Converted time '%s' with TZ offset %d to UTC '%s'",
                       time_str, tz_offset_seconds, output);
            }
            else
            {
                logger(LOG_DEBUG, "RTSP: Time '%s' is already in UTC", time_str);
            }
            return 0;
        }
        /* Fallback to original string */
        strncpy(output, time_str, output_size - 1);
        output[output_size - 1] = '\0';
        return -1;
    }

    /* Unknown format, use as-is */
    strncpy(output, time_str, output_size - 1);
    output[output_size - 1] = '\0';
    return 0;
}
