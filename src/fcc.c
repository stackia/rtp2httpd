#ifdef HAVE_CONFIG_H
#include "config.h"
#endif /* HAVE_CONFIG_H */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <unistd.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <sys/epoll.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include "fcc.h"
#include "rtp2httpd.h"
#include "service.h"
#include "multicast.h"
#include "rtp.h"
#include "http.h"
#include "stream.h"
#include "connection.h"
#include "status.h"
#include "worker.h"
#include "zerocopy.h"

/* Forward declarations for internal functions */
static uint8_t *build_fcc_request_pk(struct addrinfo *maddr, uint16_t fcc_client_nport);
static uint8_t *build_fcc_term_pk(struct addrinfo *maddr, uint16_t seqn);
static ssize_t sendto_triple(int fd, const void *buf, size_t n, int flags,
                             struct sockaddr_in *addr, socklen_t addr_len);
static void log_fcc_state_transition(fcc_state_t from, fcc_state_t to, const char *reason);
static void log_fcc_server_response(uint8_t fmt, uint8_t result_code, uint16_t signal_port, uint16_t media_port,
                                    uint32_t valid_time, uint32_t speed, uint32_t speed_after_sync);
static int fcc_send_term_packet(fcc_session_t *fcc, service_t *service,
                                uint16_t seqn, const char *reason);
static int fcc_send_termination_message(stream_context_t *ctx, uint16_t mcast_seqn);

static int fcc_bind_socket_with_range(int sock, struct sockaddr_in *sin)
{
    if (!sin)
        return -1;

    if (config.fcc_listen_port_min <= 0 || config.fcc_listen_port_max <= 0)
    {
        sin->sin_port = 0;
        return bind(sock, (struct sockaddr *)sin, sizeof(*sin));
    }

    int min_port = config.fcc_listen_port_min;
    int max_port = config.fcc_listen_port_max;
    if (max_port < min_port)
    {
        int tmp = min_port;
        min_port = max_port;
        max_port = tmp;
    }

    int range = max_port - min_port + 1;
    if (range <= 0)
        range = 1;

    int start_offset = (int)(get_time_ms() % range);

    for (int i = 0; i < range; i++)
    {
        int port = min_port + ((start_offset + i) % range);
        sin->sin_port = htons((uint16_t)port);
        if (bind(sock, (struct sockaddr *)sin, sizeof(*sin)) == 0)
        {
            logger(LOG_DEBUG, "FCC: Bound client socket to port %d", port);
            return 0;
        }

        if (errno != EADDRINUSE && errno != EACCES)
        {
            logger(LOG_DEBUG, "FCC: Failed to bind port %d: %s", port, strerror(errno));
        }
    }

    logger(LOG_ERROR, "FCC: Unable to bind socket within configured port range %d-%d",
           min_port, max_port);
    return -1;
}

static uint8_t *build_fcc_request_pk(struct addrinfo *maddr, uint16_t fcc_client_nport)
{
    struct sockaddr_in *maddr_sin = (struct sockaddr_in *)
                                        maddr->ai_addr;

    static uint8_t pk[FCC_PK_LEN_REQ];
    memset(&pk, 0, sizeof(pk));
    uint8_t *p = pk;
    *(p++) = 0x82;                              // Version 2, Padding 0, FMT 2
    *(p++) = 205;                               // Type: Generic RTP Feedback (205)
    *(uint16_t *)p = htons(sizeof(pk) / 4 - 1); // Length
    p += 2;
    p += 4;                                      // Sender SSRC
    *(uint32_t *)p = maddr_sin->sin_addr.s_addr; // Media source SSRC
    p += 4;

    // FCI
    p += 4;                            // Version 0, Reserved 3 bytes
    *(uint16_t *)p = fcc_client_nport; // FCC client port
    p += 2;
    *(uint16_t *)p = maddr_sin->sin_port; // Mcast group port
    p += 2;
    *(uint32_t *)p = maddr_sin->sin_addr.s_addr; // Mcast group IP
    p += 4;

    return pk;
}

static uint8_t *build_fcc_term_pk(struct addrinfo *maddr, uint16_t seqn)
{
    struct sockaddr_in *maddr_sin = (struct sockaddr_in *)maddr->ai_addr;

    static uint8_t pk[FCC_PK_LEN_TERM];
    memset(&pk, 0, sizeof(pk));
    uint8_t *p = pk;
    *(p++) = 0x85;                              // Version 2, Padding 0, FMT 5
    *(p++) = 205;                               // Type: Generic RTP Feedback (205)
    *(uint16_t *)p = htons(sizeof(pk) / 4 - 1); // Length
    p += 2;
    p += 4;                                      // Sender SSRC
    *(uint32_t *)p = maddr_sin->sin_addr.s_addr; // Media source SSRC
    p += 4;

    // FCI
    *(p++) = seqn ? 0 : 1;        // Stop bit, 0 = normal, 1 = force
    p++;                          // Reserved
    *(uint16_t *)p = htons(seqn); // First multicast packet sequence
    p += 2;

    return pk;
}

static ssize_t sendto_triple(int fd, const void *buf, size_t n,
                             int flags, struct sockaddr_in *addr, socklen_t addr_len)
{
    static uint8_t i;
    for (i = 0; i < 3; i++)
    {
        if (sendto(fd, buf, n, flags, (struct sockaddr *)addr, addr_len) < 0)
        {
            return -1;
        }
    }
    return n;
}

void fcc_session_cleanup(fcc_session_t *fcc, service_t *service, int epoll_fd)
{
    if (!fcc)
    {
        return;
    }

    /* Send termination message ONLY if not sent before */
    if (!fcc->fcc_term_sent && fcc->fcc_sock && fcc->fcc_server && service)
    {
        logger(LOG_DEBUG, "FCC: Sending termination packet (cleanup)");
        if (fcc_send_term_packet(fcc, service, 0, "cleanup") == 0)
        {
            fcc->fcc_term_sent = 1;
        }
    }

    /* Clean up session resources - free pending buffer chain */
    buffer_ref_t *node = fcc->pending_list_head;
    while (node)
    {
        buffer_ref_t *next = node->send_next;
        buffer_ref_put(node);
        node = next;
    }
    if (fcc->pending_list_head)
    {
        logger(LOG_DEBUG, "FCC: Multicast pending buffer chain freed");
    }
    fcc->pending_list_head = NULL;
    fcc->pending_list_tail = NULL;

    /* Close FCC socket */
    if (fcc->fcc_sock > 0)
    {
        worker_cleanup_socket_from_epoll(epoll_fd, fcc->fcc_sock);
        fcc->fcc_sock = 0;
        logger(LOG_DEBUG, "FCC: Socket closed");
    }

    /* Reset all session state to clean state */
    fcc->state = FCC_STATE_INIT;
    fcc->fcc_server = NULL; /* This was pointing to service memory, safe to NULL */
    fcc->media_port = 0;
    fcc->current_seqn = 0;
    fcc->fcc_term_seqn = 0;
    fcc->fcc_term_sent = 0;
    fcc->not_first_packet = 0;

    /* Clear client address structure */
    memset(&fcc->fcc_client, 0, sizeof(fcc->fcc_client));
}

/*
 * FCC Logging Functions
 */
static void log_fcc_state_transition(fcc_state_t from, fcc_state_t to, const char *reason)
{
    const char *state_names[] = {"INIT", "REQUESTED", "UNICAST_PENDING", "UNICAST_ACTIVE", "MCAST_REQUESTED", "MCAST_ACTIVE", "ERROR"};
    logger(LOG_DEBUG, "FCC State: %s -> %s (%s)",
           state_names[from], state_names[to], reason ? reason : "");
}

/*
 * Helper function to format bitrate with human-readable units
 */
static void format_bitrate(uint32_t bps, char *output, size_t output_size)
{
    if (bps >= 1048576) // 1024 * 1024
    {
        snprintf(output, output_size, "%.2f Mbps", bps / 1048576.0);
    }
    else if (bps >= 1024)
    {
        snprintf(output, output_size, "%.2f Kbps", bps / 1024.0);
    }
    else
    {
        snprintf(output, output_size, "%u bps", bps);
    }
}

static void log_fcc_server_response(uint8_t fmt, uint8_t result_code, uint16_t signal_port, uint16_t media_port,
                                    uint32_t valid_time, uint32_t speed, uint32_t speed_after_sync)
{
    char speed_str[32];
    char speed_after_sync_str[32];

    format_bitrate(speed, speed_str, sizeof(speed_str));
    format_bitrate(speed_after_sync, speed_after_sync_str, sizeof(speed_after_sync_str));

    logger(LOG_DEBUG, "FCC Response: FMT=%u, result=%u, signal_port=%u, media_port=%u, valid_time=%u, speed=%s, speed_after_sync=%s",
           fmt, result_code, ntohs(signal_port), ntohs(media_port), valid_time, speed_str, speed_after_sync_str);
}

/*
 * FCC Session Management Functions
 */
void fcc_session_init(fcc_session_t *fcc)
{
    memset(fcc, 0, sizeof(fcc_session_t));
    fcc->state = FCC_STATE_INIT;
    fcc->status_index = -1;
    fcc->redirect_count = 0;
}

int fcc_session_set_state(fcc_session_t *fcc, fcc_state_t new_state, const char *reason)
{
    /* State mapping lookup table */
    static const client_state_type_t fcc_to_client_state[] = {
        [FCC_STATE_INIT] = CLIENT_STATE_FCC_INIT,
        [FCC_STATE_REQUESTED] = CLIENT_STATE_FCC_REQUESTED,
        [FCC_STATE_UNICAST_PENDING] = CLIENT_STATE_FCC_UNICAST_PENDING,
        [FCC_STATE_UNICAST_ACTIVE] = CLIENT_STATE_FCC_UNICAST_ACTIVE,
        [FCC_STATE_MCAST_REQUESTED] = CLIENT_STATE_FCC_MCAST_REQUESTED,
        [FCC_STATE_MCAST_ACTIVE] = CLIENT_STATE_FCC_MCAST_ACTIVE,
        [FCC_STATE_ERROR] = CLIENT_STATE_ERROR};

    if (fcc->state == new_state)
    {
        return 0; /* No change */
    }

    log_fcc_state_transition(fcc->state, new_state, reason);
    fcc->state = new_state;

    /* Update client status immediately if status_index is valid */
    if (fcc->status_index >= 0 && new_state < ARRAY_SIZE(fcc_to_client_state))
    {
        status_update_client_state(fcc->status_index, fcc_to_client_state[new_state]);
    }

    return 1;
}

/*
 * FCC Protocol Handler Functions
 */

/*
 * FCC Protocol Stage 1: Initialize FCC socket and send request
 */
int fcc_initialize_and_request(stream_context_t *ctx)
{
    fcc_session_t *fcc = &ctx->fcc;
    service_t *service = ctx->service;
    struct sockaddr_in sin;
    socklen_t slen;
    int r;
    const struct ifreq *upstream_if;

    logger(LOG_DEBUG, "FCC: Initializing FCC session and sending request");

    if (!fcc->fcc_sock)
    {
        /* Create and configure FCC socket */
        fcc->fcc_sock = socket(AF_INET, service->fcc_addr->ai_socktype, service->fcc_addr->ai_protocol);
        if (fcc->fcc_sock < 0)
        {
            logger(LOG_ERROR, "FCC: Failed to create socket: %s", strerror(errno));
            return -1;
        }

        /* Set socket to non-blocking mode for epoll */
        if (connection_set_nonblocking(fcc->fcc_sock) < 0)
        {
            logger(LOG_ERROR, "FCC: Failed to set socket non-blocking: %s", strerror(errno));
            close(fcc->fcc_sock);
            fcc->fcc_sock = 0;
            return -1;
        }

        upstream_if = get_upstream_interface_for_fcc();
        bind_to_upstream_interface(fcc->fcc_sock, upstream_if);

        /* Bind to configured or ephemeral port */
        sin.sin_family = AF_INET;
        sin.sin_addr.s_addr = INADDR_ANY;
        if (fcc_bind_socket_with_range(fcc->fcc_sock, &sin) != 0)
        {
            logger(LOG_ERROR, "FCC: Cannot bind socket within configured range");
            return -1;
        }

        /* Get the assigned local address */
        slen = sizeof(fcc->fcc_client);
        getsockname(fcc->fcc_sock, (struct sockaddr *)&fcc->fcc_client, &slen);

        fcc->fcc_server = (struct sockaddr_in *)service->fcc_addr->ai_addr;

        /* Register socket with epoll immediately after creation */
        struct epoll_event ev;
        ev.events = EPOLLIN; /* Level-triggered mode for read events */
        ev.data.fd = fcc->fcc_sock;
        if (epoll_ctl(ctx->epoll_fd, EPOLL_CTL_ADD, fcc->fcc_sock, &ev) < 0)
        {
            logger(LOG_ERROR, "FCC: Failed to add socket to epoll: %s", strerror(errno));
            close(fcc->fcc_sock);
            fcc->fcc_sock = 0;
            return -1;
        }
        fdmap_set(fcc->fcc_sock, ctx->conn);
        logger(LOG_DEBUG, "FCC: Socket registered with epoll");
    }

    /* Send FCC request */
    r = sendto_triple(fcc->fcc_sock, build_fcc_request_pk(service->addr, fcc->fcc_client.sin_port),
                      FCC_PK_LEN_REQ, 0, fcc->fcc_server, sizeof(*fcc->fcc_server));
    if (r < 0)
    {
        logger(LOG_ERROR, "FCC: Unable to send request message: %s", strerror(errno));
        return -1;
    }

    ctx->last_fcc_data_time = get_time_ms();
    fcc_session_set_state(fcc, FCC_STATE_REQUESTED, "Request sent");
    logger(LOG_DEBUG, "FCC: Request sent to server %s:%u",
           inet_ntoa(fcc->fcc_server->sin_addr), ntohs(fcc->fcc_server->sin_port));

    return 0;
}

/*
 * FCC Protocol Stage 2: Handle server response (FMT 3)
 */
int fcc_handle_server_response(stream_context_t *ctx, uint8_t *buf, int buf_len,
                               struct sockaddr_in *peer_addr)
{
    fcc_session_t *fcc = &ctx->fcc;

    if (fcc->state != FCC_STATE_REQUESTED)
        return 0;

    if (buf[1] != 205)
    {
        logger(LOG_DEBUG, "FCC: Unrecognized payload type: %u", buf[1]);
        return 0;
    }

    if (buf[0] == 0x83)
    { /* FMT 3 - Server Response */
        uint8_t result_code = buf[12];
        uint8_t action_code = buf[13];
        uint16_t new_signal_port = *(uint16_t *)(buf + 14);
        uint16_t new_media_port = *(uint16_t *)(buf + 16);
        uint32_t new_fcc_ip = *(uint32_t *)(buf + 20);
        uint32_t valid_time = ntohl(*(uint32_t *)(buf + 24));
        uint32_t speed = ntohl(*(uint32_t *)(buf + 28));            // bitrate in bps
        uint32_t speed_after_sync = ntohl(*(uint32_t *)(buf + 32)); // bitrate in bps

        log_fcc_server_response(3, result_code, new_signal_port, new_media_port, valid_time, speed, speed_after_sync);

        if (result_code != 0)
        {
            logger(LOG_DEBUG, "FCC: Server response error code: %u, falling back to multicast", result_code);
            fcc_session_set_state(fcc, FCC_STATE_MCAST_ACTIVE, "Fallback to multicast join");
            ctx->mcast_sock = stream_join_mcast_group(ctx);
            return 0;
        }

        /* Update server endpoints if provided */
        int signal_port_changed = 0, media_port_changed = 0;

        if (new_signal_port && new_signal_port != fcc->fcc_server->sin_port)
        {
            logger(LOG_DEBUG, "FCC: Server provided new signal port: %u", ntohs(new_signal_port));
            fcc->fcc_server->sin_port = new_signal_port;
            signal_port_changed = 1;
        }

        if (new_media_port && new_media_port != fcc->media_port)
        {
            fcc->media_port = new_media_port;
            logger(LOG_DEBUG, "FCC: Server provided new media port: %u", ntohs(new_media_port));
            media_port_changed = 1;
        }

        if (new_fcc_ip && new_fcc_ip != fcc->fcc_server->sin_addr.s_addr)
        {
            fcc->fcc_server->sin_addr.s_addr = new_fcc_ip;
            logger(LOG_DEBUG, "FCC: Server provided new IP: %s", inet_ntoa(fcc->fcc_server->sin_addr));
            signal_port_changed = 1;
            media_port_changed = 1;
        }

        /* Handle different action codes */
        if (action_code == 3)
        {
            /* Redirect to new FCC server */
            fcc->redirect_count++;
            if (fcc->redirect_count > FCC_MAX_REDIRECTS)
            {
                logger(LOG_WARN, "FCC: Too many redirects (%d), falling back to multicast", fcc->redirect_count);
                fcc_session_set_state(fcc, FCC_STATE_MCAST_ACTIVE, "Too many redirects");
                ctx->mcast_sock = stream_join_mcast_group(ctx);
                return 0;
            }
            logger(LOG_INFO, "FCC: Server requests redirection to new server %s:%u (redirect #%d)",
                   inet_ntoa(fcc->fcc_server->sin_addr), ntohs(fcc->fcc_server->sin_port), fcc->redirect_count);
            fcc_session_set_state(fcc, FCC_STATE_INIT, "Server redirect");
            return 1;
        }
        else if (action_code != 2)
        {
            /* Join multicast immediately */
            logger(LOG_DEBUG, "FCC: Server requests immediate multicast join, code: %u", action_code);
            fcc_session_set_state(fcc, FCC_STATE_MCAST_ACTIVE, "Immediate multicast join");
            ctx->mcast_sock = stream_join_mcast_group(ctx);
            return 0;
        }
        else
        {
            /* Normal FCC flow - server will start unicast stream */
            if (media_port_changed && fcc->media_port)
            {
                struct sockaddr_in sintmp = *fcc->fcc_server;
                sintmp.sin_port = fcc->media_port;
                sendto_triple(fcc->fcc_sock, NULL, 0, 0, &sintmp, sizeof(sintmp));
            }
            if (signal_port_changed)
            {
                sendto_triple(fcc->fcc_sock, NULL, 0, 0, fcc->fcc_server, sizeof(*fcc->fcc_server));
            }

            /* Record start time for unicast phase (for sync wait timeout) */
            fcc->unicast_start_time = get_time_ms();
            fcc_session_set_state(fcc, FCC_STATE_UNICAST_PENDING, "Server accepted request");
            logger(LOG_DEBUG, "FCC: Server accepted request, waiting for unicast stream");
        }
    }

    return 0;
}

/*
 * FCC Protocol Stage 3: Handle synchronization notification (FMT 4)
 */
int fcc_handle_sync_notification(stream_context_t *ctx, int timeout_ms)
{
    fcc_session_t *fcc = &ctx->fcc;

    // Ignore if already using mcast stream
    if (fcc->state == FCC_STATE_MCAST_REQUESTED || fcc->state == FCC_STATE_MCAST_ACTIVE)
        return 0;

    if (timeout_ms)
    {
        logger(LOG_DEBUG, "FCC: Sync notification timeout reached (%.1f seconds) - joining multicast", timeout_ms / 1000.0);
    }
    else
    {
        logger(LOG_DEBUG, "FCC: Sync notification received - joining multicast");
    }
    fcc_session_set_state(fcc, FCC_STATE_MCAST_REQUESTED, timeout_ms ? "Sync notification timeout" : "Sync notification received");

    ctx->mcast_sock = stream_join_mcast_group(ctx);

    return 0; /* Signal to join multicast */
}

/*
 * FCC Protocol Stage 4: Handle RTP media packets from unicast stream
 */
int fcc_handle_unicast_media(stream_context_t *ctx, buffer_ref_t *buf_ref)
{
    fcc_session_t *fcc = &ctx->fcc;

    /* Drop unicast packets if we've already switched to multicast */
    if (fcc->state == FCC_STATE_MCAST_ACTIVE)
    {
        return 0;
    }

    /* Transition from PENDING to ACTIVE on first unicast packet */
    if (fcc->state == FCC_STATE_UNICAST_PENDING)
    {
        fcc_session_set_state(fcc, FCC_STATE_UNICAST_ACTIVE, "First unicast packet received");
        logger(LOG_INFO, "FCC: Unicast stream started successfully");
    }

    /* Forward RTP payload to client (true zero-copy) or capture I-frame (snapshot) */
    int processed_bytes = stream_process_rtp_payload(ctx, buf_ref, &fcc->current_seqn, &fcc->not_first_packet);
    if (processed_bytes > 0)
    {
        ctx->total_bytes_sent += (uint64_t)processed_bytes;
    }

    /* Check if we should terminate FCC based on sequence number */
    if (fcc->fcc_term_sent && fcc->current_seqn >= fcc->fcc_term_seqn - 1 && fcc->state != FCC_STATE_MCAST_ACTIVE)
    {
        logger(LOG_INFO, "FCC: Switching to multicast stream (reached termination sequence)");
        fcc_session_set_state(fcc, FCC_STATE_MCAST_ACTIVE, "Reached termination sequence");
    }

    return 0;
}

/*
 * Internal helper: Send FCC termination packet to server
 */
static int fcc_send_term_packet(fcc_session_t *fcc, service_t *service,
                                uint16_t seqn, const char *reason)
{
    int r;

    if (!fcc->fcc_sock || !fcc->fcc_server || !service)
    {
        logger(LOG_DEBUG, "FCC: Cannot send termination - missing socket/server/service");
        return -1;
    }

    r = sendto_triple(fcc->fcc_sock, build_fcc_term_pk(service->addr, seqn),
                      FCC_PK_LEN_TERM, 0, fcc->fcc_server, sizeof(*fcc->fcc_server));
    if (r < 0)
    {
        logger(LOG_ERROR, "FCC: Unable to send termination packet (%s): %s", reason, strerror(errno));
        return -1;
    }

    logger(LOG_DEBUG, "FCC: Termination packet sent (%s), seqn=%u", reason, seqn);
    return 0;
}

/*
 * FCC Protocol Stage 5: Send termination message to server (normal flow)
 */
static int fcc_send_termination_message(stream_context_t *ctx, uint16_t mcast_seqn)
{
    fcc_session_t *fcc = &ctx->fcc;

    if (!fcc->fcc_term_sent)
    {
        fcc->fcc_term_seqn = mcast_seqn;
        if (fcc_send_term_packet(fcc, ctx->service, fcc->fcc_term_seqn + 2, "normal flow") == 0)
        {
            fcc->fcc_term_sent = 1;
            logger(LOG_DEBUG, "FCC: Normal termination message sent, term_seqn=%u (+2)", mcast_seqn);
        }
        else
        {
            return -1;
        }
    }

    return 0;
}

/*
 * FCC Protocol Stage 6: Handle multicast data during transition period
 */
int fcc_handle_mcast_transition(stream_context_t *ctx, buffer_ref_t *buf_ref)
{
    fcc_session_t *fcc = &ctx->fcc;
    int payloadlength;
    uint8_t *payload;
    uint16_t seqn;
    int is_rtp;
    uint8_t *data_ptr = (uint8_t *)buf_ref->data + buf_ref->data_offset;

    is_rtp = rtp_get_payload(data_ptr, buf_ref->data_size, &payload, &payloadlength, &seqn);
    if (unlikely(is_rtp < 0))
    {
        return 0; /* Malformed packet, already logged */
    }

    /* Send termination message if not sent yet */
    if (!fcc->fcc_term_sent && fcc_send_termination_message(ctx, seqn) < 0)
    {
        return -1;
    }

    /* Keep original receive buffer alive for deferred zero-copy send */
    buffer_ref_get(buf_ref);

    buf_ref->send_next = NULL;

    /* Add to pending list */
    if (fcc->pending_list_tail)
    {
        fcc->pending_list_tail->send_next = buf_ref;
    }
    else
    {
        fcc->pending_list_head = buf_ref;
    }
    fcc->pending_list_tail = buf_ref;

    return 0;
}

/*
 * FCC Protocol Stage 8: Handle multicast data in active state
 */
int fcc_handle_mcast_active(stream_context_t *ctx, buffer_ref_t *buf_ref)
{
    fcc_session_t *fcc = &ctx->fcc;

    /* Flush pending buffer chain first if available - TRUE ZERO-COPY */
    if (unlikely(fcc->pending_list_head != NULL))
    {
        buffer_ref_t *node = fcc->pending_list_head;
        uint64_t flushed_bytes = 0;

        while (node)
        {
            /* Queue each buffer for zero-copy send */
            buffer_ref_t *next = node->send_next;
            int processed_bytes = stream_process_rtp_payload(ctx, node, &fcc->current_seqn, &fcc->not_first_packet);
            if (likely(processed_bytes > 0))
            {
                ctx->total_bytes_sent += (uint64_t)processed_bytes;
                flushed_bytes += (uint64_t)processed_bytes;
            }
            buffer_ref_put(node);
            node = next;
        }

        /* All buffers flushed successfully */
        fcc->pending_list_head = NULL;
        fcc->pending_list_tail = NULL;

        logger(LOG_DEBUG, "FCC: Flushed pending buffer chain, total_flushed_bytes=%llu", flushed_bytes);
    }

    /* Forward multicast data to client (true zero-copy) or capture I-frame (snapshot) */
    int processed_bytes = stream_process_rtp_payload(ctx, buf_ref, &fcc->current_seqn, &fcc->not_first_packet);
    if (likely(processed_bytes > 0))
    {
        ctx->total_bytes_sent += (uint64_t)processed_bytes;
    }

    return 0;
}
