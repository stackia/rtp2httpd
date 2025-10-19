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
#include "snapshot.h"
#include "status.h"
#include "worker.h"
#include "zerocopy.h"

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

        /* Reset timeout and rejoin timers when joining multicast group */
        int64_t now = get_time_ms();
        ctx->last_mcast_data_time = now;
        ctx->last_mcast_rejoin_time = now;
    }
    return sock;
}

int stream_process_rtp_payload(stream_context_t *ctx, buffer_ref_t *buf_ref_list,
                               uint16_t *last_seqn, int *not_first)
{
    /* In snapshot mode, delegate to snapshot module */
    if (ctx->snapshot.enabled)
    {
        return snapshot_process_packet(&ctx->snapshot, buf_ref_list, ctx->conn);
    }
    else
    {
        /* Normal streaming mode - forward to client */
        return rtp_queue_payload_to_client(ctx->conn, buf_ref_list, last_seqn, not_first);
    }
}

/*
 * Handle an event-ready fd that belongs to this stream context
 * Note: Client socket events are handled by worker.c,
 * this function only handles media stream sockets (multicast, FCC, RTSP)
 */
int stream_handle_fd_event(stream_context_t *ctx, int fd, uint32_t events, int64_t now)
{
    /* Process FCC socket events */
    if (ctx->fcc.fcc_sock > 0 && fd == ctx->fcc.fcc_sock)
    {
        /* Batch receive all available packets */
        buffer_ref_t *buf_list = buffer_pool_batch_recv(ctx->fcc.fcc_sock, 1, "FCC", NULL, NULL);

        /* Separate control packets from media packets */
        buffer_ref_t *media_list_head = NULL;
        buffer_ref_t *media_list_tail = NULL;
        buffer_ref_t *current = buf_list;
        int result = 0;

        while (current)
        {
            buffer_ref_t *next = current->process_next;

            /* Get peer address from buffer */
            struct sockaddr_in *peer_addr = &current->recv_info.peer_addr;

            /* Verify packet comes from expected FCC server */
            if (peer_addr->sin_addr.s_addr == ctx->fcc.fcc_server->sin_addr.s_addr)
            {
                ctx->last_fcc_data_time = now;

                /* Handle different types of FCC packets */
                uint8_t *recv_data = (uint8_t *)current->data;
                int recv_len = (int)current->data_len;

                if (peer_addr->sin_port == ctx->fcc.fcc_server->sin_port)
                {
                    /* RTCP control message - process immediately */
                    if (recv_data[0] == 0x83)
                    {
                        int res = fcc_handle_server_response(ctx, recv_data, recv_len);
                        if (res == 1)
                        {
                            /* FCC redirect - retry request with new server */
                            if (fcc_initialize_and_request(ctx) < 0)
                            {
                                logger(LOG_ERROR, "FCC redirect retry failed");
                                result = -1;
                            }
                            else
                            {
                                result = 0;
                            }
                            buffer_ref_put(current);
                            current = next;
                            break; /* Skip remaining packets */
                        }
                    }
                    else if (recv_data[0] == 0x84)
                    {
                        /* Sync notification (FMT 4) */
                        fcc_handle_sync_notification(ctx, 0);
                    }
                    /* Release control packet buffer */
                    buffer_ref_put(current);
                }
                else if (peer_addr->sin_port == ctx->fcc.media_port)
                {
                    /* RTP media packet from FCC unicast stream - add to media list */
                    if (media_list_tail)
                    {
                        media_list_tail->process_next = current;
                    }
                    else
                    {
                        media_list_head = current;
                    }
                    media_list_tail = current;
                }
                else
                {
                    /* Unknown port - release buffer */
                    buffer_ref_put(current);
                }
            }
            else
            {
                /* Not from FCC server - release buffer */
                buffer_ref_put(current);
            }

            current = next;
        }

        /* Terminate media list */
        if (media_list_tail)
        {
            media_list_tail->process_next = NULL;
        }

        /* Process all media packets in one batch */
        if (media_list_head)
        {
            ctx->total_bytes_sent += (uint64_t)fcc_handle_unicast_media(ctx, media_list_head);

            /* Release media packet buffers */
            current = media_list_head;
            while (current)
            {
                buffer_ref_t *next = current->process_next;
                buffer_ref_put(current);
                current = next;
            }
        }

        return result;
    }

    /* Process multicast socket events */
    if (ctx->mcast_sock > 0 && fd == ctx->mcast_sock)
    {
        /* Batch receive all available packets */
        buffer_ref_t *buf_list = buffer_pool_batch_recv(ctx->mcast_sock, 0, "Multicast", NULL, NULL);
        if (!buf_list)
            return 0;

        ctx->last_mcast_data_time = now;

        /* Handle multicast data based on FCC state */
        switch (ctx->fcc.state)
        {
        case FCC_STATE_MCAST_ACTIVE:
            ctx->total_bytes_sent += (uint64_t)fcc_handle_mcast_active(ctx, buf_list);
            break;

        case FCC_STATE_MCAST_REQUESTED:
            fcc_handle_mcast_transition(ctx, buf_list);
            break;

        default:
            logger(LOG_DEBUG, "Received multicast data in unexpected state: %d", ctx->fcc.state);
            break;
        }

        buffer_ref_t *current = buf_list;
        while (current)
        {
            buffer_ref_t *next = current->process_next;
            buffer_ref_put(current);
            current = next;
        }

        return 0;
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
        ctx->total_bytes_sent += (uint64_t)rtsp_handle_udp_rtp_data(&ctx->rtsp, ctx->conn);
        return 0; /* Success - processed data, continue with other events */
    }

    /* Handle UDP RTCP socket (for future RTCP processing) */
    if (ctx->rtsp.rtcp_socket > 0 && fd == ctx->rtsp.rtcp_socket)
    {
        /* RTCP data processing could be added here in the future */
        uint8_t dummy[BUFFER_POOL_BUFFER_SIZE];
        recv(ctx->rtsp.rtcp_socket, dummy, sizeof(dummy), MSG_DONTWAIT);
        return 0;
    }

    return 0;
}

/* Initialize context for unified worker epoll (non-blocking, no own loop) */
int stream_context_init_for_worker(stream_context_t *ctx, connection_t *conn, service_t *service,
                                   int epoll_fd, int status_index, int is_snapshot)
{
    if (!ctx || !conn || !service)
        return -1;
    memset(ctx, 0, sizeof(*ctx));
    ctx->conn = conn;
    ctx->service = service;
    ctx->epoll_fd = epoll_fd;
    ctx->status_index = status_index;
    fcc_session_init(&ctx->fcc);
    ctx->fcc.status_index = status_index;
    rtsp_session_init(&ctx->rtsp);
    ctx->rtsp.status_index = status_index;
    ctx->total_bytes_sent = 0;
    ctx->last_bytes_sent = 0;
    ctx->last_status_update = get_time_ms();
    ctx->last_mcast_data_time = get_time_ms();
    ctx->last_fcc_data_time = get_time_ms();
    ctx->last_mcast_rejoin_time = get_time_ms();

    /* Initialize snapshot context if this is a snapshot request */
    if (is_snapshot)
    {
        if (snapshot_init(&ctx->snapshot) < 0)
        {
            logger(LOG_ERROR, "Snapshot: Failed to initialize snapshot context");
            return -1;
        }
        if (is_snapshot == 2) /* X-Request-Snapshot or Accept: image/jpeg */
        {
            ctx->snapshot.fallback_to_streaming = 1;
        }
    }

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
        if (rtsp_parse_server_url(&ctx->rtsp, service->rtsp_url,
                                  service->playseek_param, service->user_agent,
                                  NULL, NULL) < 0)
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
    else if (service->fcc_addr)
    {
        /* use Fast Channel Change for quick stream startup */
        if (fcc_initialize_and_request(ctx) < 0)
        {
            logger(LOG_ERROR, "FCC initialization failed");
            return -1;
        }
    }
    else
    {
        /* Direct multicast join */
        /* Note: Both /rtp/ and /udp/ endpoints now use unified packet detection */
        /* Packets are automatically detected as RTP or raw UDP at receive time */
        ctx->mcast_sock = stream_join_mcast_group(ctx);
        fcc_session_set_state(&ctx->fcc, FCC_STATE_MCAST_ACTIVE, "Direct multicast");
    }

    return 0;
}

int stream_tick(stream_context_t *ctx, int64_t now)
{
    if (!ctx)
        return 0;

    /* Periodic multicast rejoin (if enabled) */
    if (config.mcast_rejoin_interval > 0 && ctx->mcast_sock > 0)
    {
        int64_t elapsed_ms = now - ctx->last_mcast_rejoin_time;
        if (elapsed_ms >= config.mcast_rejoin_interval * 1000)
        {
            logger(LOG_DEBUG, "Multicast: Periodic rejoin (interval: %d seconds)", config.mcast_rejoin_interval);

            /* Rejoin multicast group on existing socket (LEAVE + JOIN to send IGMP Report) */
            if (rejoin_mcast_group(ctx->mcast_sock, ctx->service) == 0)
            {
                ctx->last_mcast_rejoin_time = now;
            }
            else
            {
                logger(LOG_ERROR, "Multicast: Failed to rejoin group, will retry next interval");
            }
        }
    }

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
        int timeout_ms = 0;

        /* Different timeouts for different FCC states */
        if (ctx->fcc.state == FCC_STATE_REQUESTED || ctx->fcc.state == FCC_STATE_UNICAST_PENDING)
        {
            /* Signaling phase - waiting for server response */
            timeout_ms = FCC_TIMEOUT_SIGNALING_MS;

            if (elapsed_ms >= timeout_ms)
            {
                logger(LOG_WARN, "FCC: Server response timeout (%d ms), falling back to multicast",
                       FCC_TIMEOUT_SIGNALING_MS);
                if (ctx->fcc.state == FCC_STATE_REQUESTED)
                {
                    fcc_session_set_state(&ctx->fcc, FCC_STATE_MCAST_ACTIVE, "Signaling timeout");
                }
                else
                {
                    fcc_session_set_state(&ctx->fcc, FCC_STATE_MCAST_ACTIVE, "First unicast packet timeout");
                }
                ctx->mcast_sock = stream_join_mcast_group(ctx);
            }
        }
        else if (ctx->fcc.state == FCC_STATE_UNICAST_ACTIVE || ctx->fcc.state == FCC_STATE_MCAST_REQUESTED)
        {
            /* Already receiving unicast, check for stream interruption */
            timeout_ms = (int)(FCC_TIMEOUT_UNICAST_SEC * 1000);

            if (elapsed_ms >= timeout_ms)
            {
                logger(LOG_WARN, "FCC: Unicast stream interrupted (%.1f seconds), falling back to multicast",
                       FCC_TIMEOUT_UNICAST_SEC);
                fcc_session_set_state(&ctx->fcc, FCC_STATE_MCAST_ACTIVE, "Unicast interrupted");
                if (!ctx->mcast_sock)
                {
                    ctx->mcast_sock = stream_join_mcast_group(ctx);
                }
            }

            /* Check if we've been waiting too long for sync notification */
            if (ctx->fcc.state == FCC_STATE_UNICAST_ACTIVE && ctx->fcc.unicast_start_time > 0)
            {
                int64_t unicast_duration_ms = now - ctx->fcc.unicast_start_time;
                int64_t sync_wait_timeout_ms = (int64_t)(FCC_TIMEOUT_SYNC_WAIT_SEC * 1000);

                if (unicast_duration_ms >= sync_wait_timeout_ms)
                {
                    fcc_handle_sync_notification(ctx, FCC_TIMEOUT_SYNC_WAIT_SEC * 1000); /* Indicate timeout */
                }
            }
        }
    }

    /* Send periodic RTSP OPTIONS keepalive when using UDP transport */
    if (ctx->rtsp.state == RTSP_STATE_PLAYING &&
        ctx->rtsp.transport_mode == RTSP_TRANSPORT_UDP &&
        ctx->rtsp.keepalive_interval_ms > 0 &&
        ctx->rtsp.session_id[0] != '\0')
    {
        if (ctx->rtsp.last_keepalive_ms == 0)
        {
            ctx->rtsp.last_keepalive_ms = now;
        }

        int64_t keepalive_elapsed = now - ctx->rtsp.last_keepalive_ms;
        if (keepalive_elapsed >= ctx->rtsp.keepalive_interval_ms)
        {
            int ka_status = rtsp_send_keepalive(&ctx->rtsp);
            if (ka_status == 0)
            {
                ctx->rtsp.last_keepalive_ms = now;
            }
            else if (ka_status < 0)
            {
                logger(LOG_WARN, "RTSP: Failed to queue OPTIONS keepalive");
            }
        }
    }

    /* Check snapshot timeout (5 seconds) */
    if (ctx->snapshot.enabled)
    {
        int64_t snapshot_elapsed = now - ctx->snapshot.start_time;
        if (snapshot_elapsed > SNAPSHOT_TIMEOUT_SEC * 1000) /* 5 seconds */
        {
            logger(LOG_WARN, "Snapshot: Timeout waiting for I-frame (%lld ms)",
                   (long long)snapshot_elapsed);
            snapshot_fallback_to_streaming(&ctx->snapshot, ctx->conn);
        }
    }

    /* Update bandwidth calculation every second (skip for snapshot mode) */
    if (!ctx->snapshot.enabled && now - ctx->last_status_update >= 1000)
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
        status_update_client_bytes(ctx->status_index, ctx->total_bytes_sent, current_bandwidth);

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

    /* Clean up snapshot resources if in snapshot mode */
    if (ctx->snapshot.enabled)
    {
        snapshot_free(&ctx->snapshot);
    }

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
