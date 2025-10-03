#ifdef HAVE_CONFIG_H
#include "config.h"
#endif /* HAVE_CONFIG_H */

#include <stdlib.h>
#include <signal.h>
#include <sys/epoll.h>
#include <sys/socket.h>
#include <errno.h>
#include <string.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <unistd.h>
#include <netinet/tcp.h>
#include "stream.h"
#include "rtp2httpd.h"
#include "rtp.h"
#include "multicast.h"
#include "fcc.h"
#include "http.h"
#include "connection.h"
#include "rtsp.h"
#include "service.h"
#include "status.h"
#include "worker.h"

/*
 * Wrapper for join_mcast_group that also resets the multicast data timeout timer.
 * This ensures that every time we join/rejoin a multicast group, the timeout
 * detection starts fresh, preventing false timeout triggers.
 * This function should be used instead of join_mcast_group() directly in all
 * stream-related code to ensure proper timeout handling.
 */
int stream_join_mcast_group(stream_context_t *ctx)
{
    int sock = join_mcast_group(ctx->service);
    if (sock > 0)
    {
        /* Register socket with epoll immediately after creation */
        struct epoll_event ev;
        ev.events = EPOLLIN; /* Level-triggered mode for read events */
        ev.data.fd = sock;
        if (epoll_ctl(ctx->epoll_fd, EPOLL_CTL_ADD, sock, &ev) < 0)
        {
            logger(LOG_ERROR, "Multicast: Failed to add socket to epoll: %s", strerror(errno));
            close(sock);
            exit(RETVAL_SOCK_READ_FAILED);
        }
        fdmap_set(sock, ctx->conn);
        logger(LOG_DEBUG, "Multicast: Socket registered with epoll");

        /* Reset timeout timer when joining multicast group */
        ctx->last_mcast_data_time = get_time_ms();
    }
    return sock;
}

/*
 * Handle an event-ready fd that belongs to this stream context
 * Note: Client socket events are handled by worker.c,
 * this function only handles media stream sockets (multicast, FCC, RTSP)
 */
int stream_handle_fd_event(stream_context_t *ctx, int fd, uint32_t events)
{
    int actualr;
    struct sockaddr_in peer_addr;
    socklen_t slen = sizeof(peer_addr);

    /* Process FCC socket events */
    if (ctx->fcc.fcc_sock > 0 && fd == ctx->fcc.fcc_sock)
    {
        actualr = recvfrom(ctx->fcc.fcc_sock, ctx->recv_buffer, sizeof(ctx->recv_buffer),
                           0, (struct sockaddr *)&peer_addr, &slen);
        if (actualr < 0)
        {
            logger(LOG_ERROR, "FCC: Receive failed: %s", strerror(errno));
            return 0;
        }

        /* Verify packet comes from expected FCC server */
        if (peer_addr.sin_addr.s_addr != ctx->fcc.fcc_server->sin_addr.s_addr)
        {
            return 0;
        }

        ctx->last_fcc_data_time = get_time_ms();

        /* Handle different types of FCC packets */
        if (peer_addr.sin_port == ctx->fcc.fcc_server->sin_port)
        {
            /* RTCP control message */
            if (ctx->recv_buffer[0] == 0x83)
            {
                int res = fcc_handle_server_response(ctx, ctx->recv_buffer, actualr, &peer_addr);
                if (res == 1)
                {
                    /* FCC redirect - retry request with new server */
                    if (fcc_initialize_and_request(ctx) < 0)
                    {
                        logger(LOG_ERROR, "FCC redirect retry failed");
                        return -1;
                    }
                    return 0; /* Redirect handled successfully */
                }
                return res;
            }
            else if (ctx->recv_buffer[0] == 0x84)
            {
                /* Sync notification (FMT 4) */
                return fcc_handle_sync_notification(ctx);
            }
        }
        else if (peer_addr.sin_port == ctx->fcc.media_port)
        {
            /* RTP media packet from FCC unicast stream */
            return fcc_handle_unicast_media(ctx, ctx->recv_buffer, actualr);
        }
    }

    /* Process multicast socket events */
    if (ctx->mcast_sock > 0 && fd == ctx->mcast_sock)
    {
        actualr = recv(ctx->mcast_sock, ctx->recv_buffer, sizeof(ctx->recv_buffer), 0);
        if (actualr < 0)
        {
            logger(LOG_DEBUG, "Multicast receive failed: %s", strerror(errno));
            return 0;
        }

        /* Update last data receive timestamp for timeout detection */
        ctx->last_mcast_data_time = get_time_ms();

        /* Handle non-RTP multicast data (MUDP service) */
        if (ctx->service->service_type == SERVICE_MUDP)
        {
            /* Queue data to connection output buffer for reliable delivery */
            if (connection_queue_output(ctx->conn, ctx->recv_buffer, actualr) == 0)
            {
                ctx->total_bytes_sent += (uint64_t)actualr;
            }
            else
            {
                /* Buffer full - this indicates backpressure, data will be retried */
                logger(LOG_DEBUG, "MUDP: Output buffer full, backpressure");
            }
            return 0;
        }

        /* Handle RTP multicast data based on FCC state */
        switch (ctx->fcc.state)
        {
        case FCC_STATE_MCAST_ACTIVE:
            return fcc_handle_mcast_active(ctx, ctx->recv_buffer, actualr);

        case FCC_STATE_MCAST_REQUESTED:
            return fcc_handle_mcast_transition(ctx, ctx->recv_buffer, actualr);

        default:
            /* Shouldn't receive multicast in other states */
            logger(LOG_DEBUG, "Received multicast data in unexpected state: %d", ctx->fcc.state);
            return 0;
        }
    }

    /* Process RTSP socket events */
    if (ctx->rtsp.socket > 0 && fd == ctx->rtsp.socket)
    {
        /* Handle RTSP socket events (handshake and RTP data in PLAYING state) */
        int result = rtsp_handle_socket_event(&ctx->rtsp, events);
        if (result < 0)
        {
            /* -2 indicates graceful TEARDOWN completion, not an error */
            if (result == -2)
            {
                logger(LOG_DEBUG, "RTSP: Graceful TEARDOWN completed");
                return -1; /* Signal connection should be closed */
            }
            /* Real error */
            logger(LOG_ERROR, "RTSP: Socket event handling failed");
            return -1;
        }
        if (result > 0)
        {
            ctx->total_bytes_sent += (uint64_t)result;
        }
        return 0; /* Success - processed data, continue with other events */
    }

    /* Process RTSP RTP socket events (UDP mode) */
    if (ctx->rtsp.rtp_socket > 0 && fd == ctx->rtsp.rtp_socket)
    {
        int result = rtsp_handle_rtp_data(&ctx->rtsp, ctx->conn);
        if (result < 0)
        {
            return -1; /* Error */
        }
        if (result > 0)
        {
            ctx->total_bytes_sent += (uint64_t)result;
        }
        return 0; /* Success - processed data, continue with other events */
    }

    /* Handle UDP RTCP socket (for future RTCP processing) */
    if (ctx->rtsp.rtcp_socket > 0 && fd == ctx->rtsp.rtcp_socket)
    {
        /* RTCP data processing could be added here in the future */
        /* For now, just consume the data to prevent buffer overflow */
        uint8_t rtcp_buffer[RTCP_BUFFER_SIZE];
        recv(ctx->rtsp.rtcp_socket, rtcp_buffer, sizeof(rtcp_buffer), 0);
        return 0;
    }

    return 0;
}

/* Initialize context for unified worker epoll (non-blocking, no own loop) */
int stream_context_init_for_worker(stream_context_t *ctx, struct connection_s *conn, service_t *service,
                                   int epoll_fd, pid_t status_id)
{
    if (!ctx || !conn || !service)
        return -1;
    memset(ctx, 0, sizeof(*ctx));
    ctx->conn = conn;
    ctx->service = service;
    ctx->epoll_fd = epoll_fd;
    ctx->status_id = status_id;
    fcc_session_init(&ctx->fcc);
    ctx->fcc.status_id = status_id;
    rtsp_session_init(&ctx->rtsp);
    ctx->rtsp.status_id = status_id;
    ctx->total_bytes_sent = 0;
    ctx->last_bytes_sent = 0;
    ctx->last_status_update = get_time_ms();
    ctx->last_mcast_data_time = get_time_ms();
    ctx->last_fcc_data_time = get_time_ms();

    /* Initialize media path depending on service type */
    if (service->service_type == SERVICE_RTSP)
    {
        ctx->rtsp.epoll_fd = ctx->epoll_fd;
        ctx->rtsp.conn = conn;
        if (!service->rtsp_url)
        {
            logger(LOG_ERROR, "RTSP URL not found in service configuration");
            return -1;
        }

        /* Parse URL and initiate connection */
        if (rtsp_parse_server_url(&ctx->rtsp, service->rtsp_url, service->playseek_param, service->user_agent) < 0)
        {
            logger(LOG_ERROR, "RTSP: Failed to parse URL");
            return -1;
        }

        if (rtsp_connect(&ctx->rtsp) < 0)
        {
            logger(LOG_ERROR, "RTSP: Failed to initiate connection");
            return -1;
        }

        /* Connection initiated - handshake will proceed asynchronously via event loop */
        logger(LOG_DEBUG, "RTSP: Async connection initiated, state=%d", ctx->rtsp.state);
    }
    else if (service->service_type == SERVICE_MRTP && service->fcc_addr)
    {
        if (fcc_initialize_and_request(ctx) < 0)
        {
            logger(LOG_ERROR, "FCC initialization failed");
            return -1;
        }
    }
    else
    {
        /* Direct multicast join */
        ctx->mcast_sock = stream_join_mcast_group(ctx);
        fcc_session_set_state(&ctx->fcc, FCC_STATE_MCAST_ACTIVE, "Direct multicast");
    }

    return 0;
}

int stream_tick(stream_context_t *ctx, int64_t now)
{
    if (!ctx)
        return 0;
    /* Periodic status update */
    /* Use by-pid variant to support multi-connection-per-process */

    /* Check for multicast stream timeout */
    if (ctx->mcast_sock > 0)
    {
        int64_t elapsed_ms = now - ctx->last_mcast_data_time;
        if (elapsed_ms >= MCAST_TIMEOUT_SEC * 1000)
        {
            logger(LOG_ERROR, "Multicast: No data received for %d seconds, closing connection",
                   MCAST_TIMEOUT_SEC);
            return -1; /* Signal connection should be closed */
        }
    }

    /* Check for FCC timeouts */
    if (ctx->fcc.fcc_sock > 0)
    {
        int64_t elapsed_ms = now - ctx->last_fcc_data_time;

        if (elapsed_ms >= FCC_TIMEOUT_SEC * 1000)
        {
            /* Timeout waiting for server response after sending request */
            if (ctx->fcc.state == FCC_STATE_REQUESTED)
            {
                logger(LOG_ERROR, "FCC: Server response timeout (%d seconds), falling back to multicast",
                       FCC_TIMEOUT_SEC);
                fcc_session_set_state(&ctx->fcc, FCC_STATE_MCAST_ACTIVE, "Request timeout");
                ctx->mcast_sock = stream_join_mcast_group(ctx);
            }
            /* Timeout waiting for unicast packet after server accepts */
            else if (ctx->fcc.state == FCC_STATE_UNICAST_PENDING || ctx->fcc.state == FCC_STATE_UNICAST_ACTIVE)
            {
                logger(LOG_ERROR, "FCC: Unicast stream timeout (%d seconds), falling back to multicast",
                       FCC_TIMEOUT_SEC);
                fcc_session_set_state(&ctx->fcc, FCC_STATE_MCAST_ACTIVE, "Unicast timeout");
                ctx->mcast_sock = stream_join_mcast_group(ctx);
            }
        }
    }

    /* Update bandwidth calculation every second */
    if (now - ctx->last_status_update >= 1000)
    {
        /* Calculate bandwidth based on bytes sent since last update */
        uint64_t bytes_diff = ctx->total_bytes_sent - ctx->last_bytes_sent;
        int64_t elapsed_ms = now - ctx->last_status_update;
        uint32_t current_bandwidth = 0;

        if (elapsed_ms > 0)
        {
            /* Convert to bytes per second: (bytes * 1000) / elapsed_ms */
            current_bandwidth = (uint32_t)((bytes_diff * 1000) / elapsed_ms);
        }

        /* Update bytes and bandwidth in status */
        status_update_client_bytes(ctx->status_id, ctx->total_bytes_sent, current_bandwidth);

        /* Save current bytes for next calculation */
        ctx->last_bytes_sent = ctx->total_bytes_sent;
        ctx->last_status_update = now;
    }

    return 0; /* Success */
}

int stream_context_cleanup(stream_context_t *ctx)
{
    if (!ctx)
        return 0;

    /* Clean up FCC session (always safe to cleanup immediately) */
    fcc_session_cleanup(&ctx->fcc, ctx->service, ctx->epoll_fd);

    /* Clean up RTSP session - this may initiate async TEARDOWN */
    int rtsp_async = rtsp_session_cleanup(&ctx->rtsp);

    /* Close multicast socket if active (always safe to cleanup immediately) */
    if (ctx->mcast_sock)
    {
        worker_cleanup_socket_from_epoll(ctx->epoll_fd, ctx->mcast_sock);
        ctx->mcast_sock = 0;
        logger(LOG_DEBUG, "Multicast socket closed");
    }

    if (rtsp_async)
    {
        /* RTSP async TEARDOWN initiated - defer final cleanup */
        logger(LOG_DEBUG, "Stream: RTSP async TEARDOWN initiated, deferring final cleanup");
        /* Do NOT clear ctx->service - still needed for RTSP */
        return 1; /* Indicate async cleanup in progress */
    }

    /* NOTE: Do NOT free ctx->service here!
     * The service pointer is shared with the parent connection (c->service).
     * The connection owns the service and will free it in connection_free()
     * based on the c->service_owned flag.
     * Freeing it here would cause double-free when connection_free() is called.
     */
    ctx->service = NULL; /* Clear pointer but don't free */

    return 0; /* Cleanup completed */
}
