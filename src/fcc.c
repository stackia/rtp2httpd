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
#include "multicast.h"
#include "rtp.h"
#include "http.h"
#include "stream.h"

/* Forward declarations for internal functions */
static int fcc_send_term_packet(fcc_session_t *fcc, struct services_s *service,
                                uint16_t seqn, const char *reason);

uint8_t *build_fcc_request_pk(struct addrinfo *maddr, uint16_t fcc_client_nport)
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

int get_gw_ip(in_addr_t *addr)
{
    long destination, gateway;
    char buf[FCC_RESPONSE_BUFFER_SIZE];
    FILE *file;

    memset(buf, 0, sizeof(buf));

    file = fopen("/proc/net/route", "r");
    if (!file)
    {
        return -1;
    }

    while (fgets(buf, sizeof(buf), file))
    {
        if (sscanf(buf, "%*s %lx %lx", &destination, &gateway) == 2)
        {
            if (destination == 0)
            { /* default */
                *addr = gateway;
                fclose(file);
                return 0;
            }
        }
    }

    /* default route not found */
    if (file)
        fclose(file);
    return -1;
}

uint16_t nat_pmp(uint16_t nport, uint32_t lifetime)
{
    struct sockaddr_in gw_addr = {.sin_family = AF_INET, .sin_port = htons(5351)};
    uint8_t pk[12];
    uint8_t buf[FCC_PACKET_BUFFER_SIZE];
    struct timeval tv = {.tv_sec = 1, .tv_usec = 0};

    if (get_gw_ip(&gw_addr.sin_addr.s_addr) < 0)
        return 0;
    int sock = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    bind_to_upstream_interface(sock);
    setsockopt(sock, SOL_SOCKET, SO_RCVTIMEO, (const char *)&tv, sizeof tv);
    pk[0] = 0;                     // Version
    pk[1] = 1;                     // UDP
    *(uint16_t *)(pk + 2) = 0;     // Reserved
    *(uint16_t *)(pk + 4) = nport; // Private port
    *(uint16_t *)(pk + 6) = 0;     // Public port
    *(uint32_t *)(pk + 8) = htonl(lifetime);
    sendto(sock, pk, sizeof(pk), 0, (struct sockaddr *)&gw_addr, sizeof(gw_addr));
    if (recv(sock, buf, sizeof(buf), 0) > 0)
    {
        if (*(uint16_t *)(buf + 2) == 0)
        { // Result code
            close(sock);
            return *(uint16_t *)(buf + 10); // Mapped public port
        }
    }
    close(sock);
    return 0;
}

uint8_t *build_fcc_term_pk(struct addrinfo *maddr, uint16_t seqn)
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

ssize_t sendto_triple(int fd, const void *buf, size_t n,
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

void fcc_session_cleanup(fcc_session_t *fcc, struct services_s *service)
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

    /* Clean up NAT-PMP mapping if active */
    if (fcc->mapped_pub_port)
    {
        logger(LOG_DEBUG, "FCC: Cleaning up NAT-PMP mapping");
        nat_pmp(fcc->fcc_client.sin_port, 0);
        fcc->mapped_pub_port = 0;
    }

    /* Clean up session resources */
    if (fcc->mcast_pending_buf)
    {
        free(fcc->mcast_pending_buf);
        fcc->mcast_pending_buf = NULL;
        logger(LOG_DEBUG, "FCC: Multicast pending buffer freed");
    }

    /* Close FCC socket */
    if (fcc->fcc_sock > 0)
    {
        close(fcc->fcc_sock);
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
    fcc->mcast_pbuf_current = NULL; /* Already freed buffer, clear pointer */
    fcc->mcast_pbuf_len = 0;
    fcc->mcast_pbuf_last_seqn = 0;
    fcc->mcast_pbuf_full = 0;

    /* Clear client address structure */
    memset(&fcc->fcc_client, 0, sizeof(fcc->fcc_client));
}

/*
 * FCC Logging Functions
 */
void log_fcc_state_transition(fcc_state_t from, fcc_state_t to, const char *reason)
{
    const char *state_names[] = {"INIT", "REQUESTED", "UNICAST_ACTIVE", "MCAST_REQUESTED", "MCAST_ACTIVE", "ERROR"};
    logger(LOG_DEBUG, "FCC State: %s -> %s (%s)",
           state_names[from], state_names[to], reason ? reason : "");
}

void log_fcc_server_response(uint8_t fmt, uint8_t result_code, uint16_t signal_port, uint16_t media_port)
{
    logger(LOG_DEBUG, "FCC Response: FMT=%u, result=%u, signal_port=%u, media_port=%u",
           fmt, result_code, ntohs(signal_port), ntohs(media_port));
}

/*
 * FCC Session Management Functions
 */
void fcc_session_init(fcc_session_t *fcc)
{
    memset(fcc, 0, sizeof(fcc_session_t));
    fcc->state = FCC_STATE_INIT;
    logger(LOG_DEBUG, "FCC session initialized");
}

int fcc_session_set_state(fcc_session_t *fcc, fcc_state_t new_state, const char *reason)
{
    if (fcc->state == new_state)
    {
        return 0; /* No change */
    }

    log_fcc_state_transition(fcc->state, new_state, reason);
    fcc->state = new_state;
    return 1;
}

/*
 * FCC Protocol Handler Functions
 */

/*
 * FCC Protocol Stage 1: Initialize FCC socket and send request
 */
int fcc_initialize_and_request(struct stream_context_s *ctx)
{
    fcc_session_t *fcc = &ctx->fcc;
    struct services_s *service = ctx->service;
    struct sockaddr_in sin;
    socklen_t slen;
    int r;

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

        bind_to_upstream_interface(fcc->fcc_sock);

        /* Bind to any available port */
        sin.sin_family = AF_INET;
        sin.sin_addr.s_addr = INADDR_ANY;
        sin.sin_port = 0;
        r = bind(fcc->fcc_sock, (struct sockaddr *)&sin, sizeof(sin));
        if (r)
        {
            logger(LOG_ERROR, "FCC: Cannot bind socket: %s", strerror(errno));
            return -1;
        }

        /* Get the assigned local address */
        slen = sizeof(fcc->fcc_client);
        getsockname(fcc->fcc_sock, (struct sockaddr *)&fcc->fcc_client, &slen);

        /* Handle NAT traversal if needed */
        if (conf_fcc_nat_traversal == FCC_NAT_T_NAT_PMP)
        {
            fcc->mapped_pub_port = nat_pmp(fcc->fcc_client.sin_port, 86400);
            logger(LOG_DEBUG, "FCC NAT-PMP result: %u", ntohs(fcc->mapped_pub_port));
        }

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
        logger(LOG_DEBUG, "FCC: Socket registered with epoll");
    }

    /* Send FCC request */
    uint16_t port_to_use = fcc->mapped_pub_port ? fcc->mapped_pub_port : fcc->fcc_client.sin_port;
    r = sendto_triple(fcc->fcc_sock, build_fcc_request_pk(service->addr, port_to_use),
                      FCC_PK_LEN_REQ, 0, fcc->fcc_server, sizeof(*fcc->fcc_server));
    if (r < 0)
    {
        logger(LOG_ERROR, "FCC: Unable to send request message: %s", strerror(errno));
        return -1;
    }

    fcc_session_set_state(fcc, FCC_STATE_REQUESTED, "Request sent");
    logger(LOG_DEBUG, "FCC: Request sent to server %s:%u",
           inet_ntoa(fcc->fcc_server->sin_addr), ntohs(fcc->fcc_server->sin_port));

    return 0;
}

/*
 * FCC Protocol Stage 2: Handle server response (FMT 3)
 */
int fcc_handle_server_response(struct stream_context_s *ctx, uint8_t *buf, int buf_len,
                               struct sockaddr_in *peer_addr)
{
    fcc_session_t *fcc = &ctx->fcc;

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

        log_fcc_server_response(3, result_code, new_signal_port, new_media_port);

        if (result_code != 0)
        {
            logger(LOG_DEBUG, "FCC: Server response error code: %u, falling back to multicast", result_code);
            fcc_session_set_state(fcc, FCC_STATE_ERROR, "Server error response");
            return -1; /* Fallback to multicast */
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
            logger(LOG_DEBUG, "FCC: Server requests redirection to new server");
            fcc_session_set_state(fcc, FCC_STATE_INIT, "Server redirect");
            return 1;
        }
        else if (action_code != 2)
        {
            /* Join multicast immediately */
            logger(LOG_DEBUG, "FCC: Server requests immediate multicast join, code: %u", action_code);
            fcc_session_set_state(fcc, FCC_STATE_MCAST_ACTIVE, "Immediate multicast join");
            ctx->mcast_sock = join_mcast_group(ctx->service, ctx->epoll_fd);
            return 0;
        }
        else
        {
            /* Normal FCC flow - server will start unicast stream */
            /* Handle NAT punch hole if needed */
            if (conf_fcc_nat_traversal == FCC_NAT_T_PUNCHHOLE)
            {
                if (media_port_changed && fcc->media_port)
                {
                    struct sockaddr_in sintmp = *fcc->fcc_server;
                    sintmp.sin_port = fcc->media_port;
                    sendto_triple(fcc->fcc_sock, NULL, 0, 0, &sintmp, sizeof(sintmp));
                    logger(LOG_DEBUG, "FCC: NAT punch hole sent for media port %u", ntohs(fcc->media_port));
                }
                if (signal_port_changed)
                {
                    sendto_triple(fcc->fcc_sock, NULL, 0, 0, fcc->fcc_server, sizeof(*fcc->fcc_server));
                    logger(LOG_DEBUG, "FCC: NAT punch hole sent for signal port %u", ntohs(fcc->fcc_server->sin_port));
                }
            }

            fcc_session_set_state(fcc, FCC_STATE_UNICAST_ACTIVE, "Server accepted request");
            logger(LOG_DEBUG, "FCC: Server accepted request, expecting unicast stream");
        }
    }

    return 0;
}

/*
 * FCC Protocol Stage 3: Handle synchronization notification (FMT 4)
 */
int fcc_handle_sync_notification(struct stream_context_s *ctx)
{
    fcc_session_t *fcc = &ctx->fcc;

    if (fcc->state == FCC_STATE_MCAST_REQUESTED || fcc->state == FCC_STATE_MCAST_ACTIVE)
    {
        logger(LOG_DEBUG, "FCC: Ignored duplicate sync notification");
        return 0;
    }

    logger(LOG_DEBUG, "FCC: Received sync notification (FMT 4) - can join multicast now");
    fcc_session_set_state(fcc, FCC_STATE_MCAST_REQUESTED, "Sync notification received");

    ctx->mcast_sock = join_mcast_group(ctx->service, ctx->epoll_fd);

    return 0; /* Signal to join multicast */
}

/*
 * FCC Protocol Stage 4: Handle RTP media packets from unicast stream
 */
int fcc_handle_unicast_media(struct stream_context_s *ctx, uint8_t *buf, int buf_len)
{
    fcc_session_t *fcc = &ctx->fcc;

    /* Forward RTP payload to client - function will update fcc->current_seqn */
    write_rtp_payload_to_client(ctx->client_fd, buf_len, buf, &fcc->current_seqn, &fcc->not_first_packet);

    /* Check if we should terminate FCC based on sequence number */
    if (fcc->fcc_term_sent && fcc->current_seqn >= fcc->fcc_term_seqn - 1)
    {
        logger(LOG_DEBUG, "FCC: Reached termination sequence, switching to multicast");
        fcc_session_set_state(fcc, FCC_STATE_MCAST_ACTIVE, "Reached termination sequence");
    }

    return 0;
}

/*
 * Internal helper: Send FCC termination packet to server
 */
static int fcc_send_term_packet(fcc_session_t *fcc, struct services_s *service,
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
int fcc_send_termination_message(struct stream_context_s *ctx, uint16_t mcast_seqn)
{
    fcc_session_t *fcc = &ctx->fcc;

    if (!fcc->fcc_term_sent)
    {
        fcc->fcc_term_seqn = mcast_seqn;
        if (fcc_send_term_packet(fcc, ctx->service, fcc->fcc_term_seqn + 2, "normal flow") == 0)
        {
            fcc->fcc_term_sent = 1;
            logger(LOG_DEBUG, "FCC: Normal termination message sent, term_seqn=%u", fcc->fcc_term_seqn);
        }
        else
        {
            return -1;
        }
    }

    return 0;
}

/*
 * FCC Protocol Stage 6: Initialize pending buffer for smooth transition
 */
int fcc_init_pending_buffer(struct stream_context_s *ctx)
{
    fcc_session_t *fcc = &ctx->fcc;

    if (!fcc->mcast_pending_buf)
    {
        /* Calculate buffer size based on expected packet count */
        uint32_t expected_packets = max(fcc->fcc_term_seqn - fcc->current_seqn, FCC_MIN_BUFFER_PACKETS);
        fcc->mcast_pbuf_len = (expected_packets + FCC_MIN_BUFFER_PACKETS) * FCC_PENDING_BUFFER_MULTIPLIER;

        fcc->mcast_pending_buf = malloc(fcc->mcast_pbuf_len);
        if (!fcc->mcast_pending_buf)
        {
            logger(LOG_ERROR, "FCC: Failed to allocate pending buffer");
            return -1;
        }

        fcc->mcast_pbuf_current = fcc->mcast_pending_buf;
        fcc->mcast_pbuf_full = 0;

        logger(LOG_DEBUG, "FCC: Pending buffer initialized, size=%u bytes", fcc->mcast_pbuf_len);
    }

    return 0;
}

/*
 * FCC Protocol Stage 7: Handle multicast data during transition period
 */
int fcc_handle_mcast_transition(struct stream_context_s *ctx, uint8_t *buf, int buf_len)
{
    fcc_session_t *fcc = &ctx->fcc;
    uint8_t *rtp_payload;
    int payloadlength;
    uint16_t mcast_seqn;

    mcast_seqn = ntohs(*(uint16_t *)(buf + 2));
    fcc->mcast_pbuf_last_seqn = mcast_seqn;

    /* Send termination message if not sent yet */
    if (fcc_send_termination_message(ctx, mcast_seqn) < 0)
    {
        return -1;
    }

    /* Initialize pending buffer if not done yet */
    if (fcc_init_pending_buffer(ctx) < 0)
    {
        return -1;
    }

    /* Skip buffering if buffer is full */
    if (fcc->mcast_pbuf_full)
    {
        return 0;
    }

    /* Extract RTP payload */
    if (get_rtp_payload(buf, buf_len, &rtp_payload, &payloadlength) < 0)
    {
        return 0;
    }

    /* Check if we have enough space in the buffer */
    if (fcc->mcast_pbuf_current + payloadlength > fcc->mcast_pending_buf + fcc->mcast_pbuf_len)
    {
        logger(LOG_ERROR, "FCC: Multicast pending buffer full, video quality may suffer");
        fcc->mcast_pbuf_full = 1;
        return 0;
    }

    /* Copy payload to pending buffer */
    memcpy(fcc->mcast_pbuf_current, rtp_payload, payloadlength);
    fcc->mcast_pbuf_current += payloadlength;

    return 0;
}

/*
 * FCC Protocol Stage 8: Handle multicast data in active state
 */
int fcc_handle_mcast_active(struct stream_context_s *ctx, uint8_t *buf, int buf_len)
{
    fcc_session_t *fcc = &ctx->fcc;

    /* Flush pending buffer first if available */
    if (fcc->mcast_pending_buf)
    {
        size_t pending_len = fcc->mcast_pbuf_current - fcc->mcast_pending_buf;
        if (pending_len > 0)
        {
            write_to_client(ctx->client_fd, fcc->mcast_pending_buf, pending_len);
            fcc->current_seqn = fcc->mcast_pbuf_last_seqn;
            logger(LOG_DEBUG, "FCC: Flushed %zu bytes from pending buffer, last_seqn=%u",
                   pending_len, fcc->mcast_pbuf_last_seqn);
        }

        /* Free the pending buffer */
        free(fcc->mcast_pending_buf);
        fcc->mcast_pending_buf = NULL;
        fcc->mcast_pbuf_current = NULL;
    }

    /* Forward multicast data directly to client - function will update fcc->current_seqn */
    write_rtp_payload_to_client(ctx->client_fd, buf_len, buf, &fcc->current_seqn, &fcc->not_first_packet);

    return 0;
}
