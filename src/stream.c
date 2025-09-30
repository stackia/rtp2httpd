#ifdef HAVE_CONFIG_H
#include "config.h"
#endif /* HAVE_CONFIG_H */

#include <stdlib.h>
#include <signal.h>
#include <sys/select.h>
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
#include "rtsp.h"

/* Stream processing context */
typedef struct stream_context_s
{
    int client_fd;
    struct services_s *service;
    fcc_session_t fcc;
    int mcast_sock;
    uint8_t recv_buffer[STREAM_RECV_BUFFER_SIZE];
    rtsp_session_t rtsp; /* RTSP session for SERVICE_RTSP */
} stream_context_t;

/* Static cleanup context - safe since each client runs in its own process */
static struct
{
    stream_context_t *current_context; /* Current active stream context */
} cleanup_state = {0};

/*
 * Unified cleanup function
 */
static void stream_cleanup(stream_context_t *ctx, struct services_s *service)
{
    if (!ctx)
    {
        return;
    }

    /* Clear cleanup context to prevent recursive cleanup */
    cleanup_state.current_context = NULL;

    /* Clean up FCC session */
    fcc_session_cleanup(&ctx->fcc, service);

    /* Clean up RTSP session */
    rtsp_session_cleanup(&ctx->rtsp);

    /* Close multicast socket if active */
    if (ctx->mcast_sock)
    {
        close(ctx->mcast_sock);
        ctx->mcast_sock = 0;
        logger(LOG_DEBUG, "Multicast socket closed");
    }

    /* Free service structure (handles both dynamic and static services safely) */
    if (service)
    {
        free_service(service);
    }
}

/*
 * Process socket file descriptors and handle appropriate protocol stages
 */
static int stream_process_sockets(stream_context_t *ctx, fd_set *rfds)
{
    int actualr;
    struct sockaddr_in peer_addr;
    socklen_t slen = sizeof(peer_addr);

    /* Check for client disconnect */
    if (FD_ISSET(ctx->client_fd, rfds))
    {
        logger(LOG_DEBUG, "Client disconnected or sent data");
        return -1; /* Exit */
    }

    /* Process FCC socket events */
    if (ctx->fcc.fcc_sock && FD_ISSET(ctx->fcc.fcc_sock, rfds))
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

        /* Handle different types of FCC packets */
        if (peer_addr.sin_port == ctx->fcc.fcc_server->sin_port)
        {
            /* RTCP control message */
            if (ctx->recv_buffer[0] == 0x83)
            {
                int result = fcc_handle_server_response(ctx, ctx->recv_buffer, actualr, &peer_addr);
                if (result < 0)
                {
                    /* Fallback to multicast */
                    ctx->mcast_sock = join_mcast_group(ctx->service);
                    fcc_session_set_state(&ctx->fcc, FCC_STATE_MCAST_ACTIVE, "Fallback to multicast");
                }
                return result;
            }
            else if (ctx->recv_buffer[0] == 0x84)
            {
                /* Sync notification (FMT 4) */
                fcc_handle_sync_notification(ctx);
                ctx->mcast_sock = join_mcast_group(ctx->service);
                return 0;
            }
        }
        else if (peer_addr.sin_port == ctx->fcc.media_port)
        {
            /* RTP media packet from FCC unicast stream */
            return fcc_handle_unicast_media(ctx, ctx->recv_buffer, actualr);
        }
    }

    /* Process multicast socket events */
    if (ctx->mcast_sock && FD_ISSET(ctx->mcast_sock, rfds))
    {
        actualr = recv(ctx->mcast_sock, ctx->recv_buffer, sizeof(ctx->recv_buffer), 0);
        if (actualr < 0)
        {
            logger(LOG_DEBUG, "Multicast receive failed: %s", strerror(errno));
            return 0;
        }

        /* Handle non-RTP multicast data (MUDP service) */
        if (ctx->service->service_type == SERVICE_MUDP)
        {
            write_to_client(ctx->client_fd, ctx->recv_buffer, actualr);
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
    if ((ctx->rtsp.socket > 0 && FD_ISSET(ctx->rtsp.socket, rfds)) || (ctx->rtsp.rtp_socket > 0 && FD_ISSET(ctx->rtsp.rtp_socket, rfds)))
    {
        return rtsp_handle_rtp_data(&ctx->rtsp, ctx->client_fd);
    }

    /* Handle UDP RTCP socket (for future RTCP processing) */
    if (ctx->rtsp.rtcp_socket > 0 && FD_ISSET(ctx->rtsp.rtcp_socket, rfds))
    {
        /* RTCP data processing could be added here in the future */
        /* For now, just consume the data to prevent buffer overflow */
        uint8_t rtcp_buffer[RTCP_BUFFER_SIZE];
        recv(ctx->rtsp.rtcp_socket, rtcp_buffer, sizeof(rtcp_buffer), 0);
        return 0;
    }

    return 0;
}

/* Static signal handler - uses static cleanup_state */
static void stream_signal_handler(int signum)
{
    if (cleanup_state.current_context)
    {
        logger(LOG_DEBUG, "Signal %d received, performing cleanup", signum);
        stream_cleanup(cleanup_state.current_context,
                       cleanup_state.current_context->service);
    }
    if (signum)
        exit(RETVAL_CLEAN);
}

/* Static exit handler */
static void stream_exit_handler(void)
{
    stream_signal_handler(0);
}

/*
 * Main media streaming function
 */
void start_media_stream(int client, struct services_s *service)
{
    stream_context_t ctx;
    fd_set rfds;
    struct timeval timeout;
    int max_sock, r;

    /* Initialize stream context */
    memset(&ctx, 0, sizeof(ctx));
    ctx.client_fd = client;
    ctx.service = service;
    fcc_session_init(&ctx.fcc);
    rtsp_session_init(&ctx.rtsp);

    /* Set cleanup context for signal handlers */
    cleanup_state.current_context = &ctx;

    /* Register signal and exit handlers */
    atexit(stream_exit_handler);
    signal(SIGTERM, stream_signal_handler);
    signal(SIGINT, stream_signal_handler);
    signal(SIGPIPE, stream_signal_handler);

    logger(LOG_DEBUG, "Starting media stream processing for service type %d (%s)",
           service->service_type,
           service->service_type == SERVICE_MRTP ? "MRTP" : service->service_type == SERVICE_MUDP ? "MUDP"
                                                                                                  : "RTSP");

    /* Main processing loop */
    while (1)
    {
        /* Handle initial state - decide between FCC, direct multicast, or RTSP */
        if (ctx.fcc.state == FCC_STATE_INIT && ctx.rtsp.state == RTSP_STATE_INIT)
        {
            if (service->service_type == SERVICE_RTSP)
            {
                /* Initialize RTSP connection */
                logger(LOG_DEBUG, "Initializing RTSP connection");

                /* Parse RTSP URL and setup session */
                if (!service->rtsp_url)
                {
                    logger(LOG_ERROR, "RTSP URL not found in service configuration");
                    stream_cleanup(&ctx, service);
                    exit(RETVAL_RTP_FAILED);
                }

                if (rtsp_parse_server_url(&ctx.rtsp, service->rtsp_url, service->playseek_param, service->user_agent) < 0 ||
                    rtsp_connect(&ctx.rtsp) < 0 ||
                    rtsp_describe(&ctx.rtsp) < 0 ||
                    rtsp_setup(&ctx.rtsp) < 0 ||
                    rtsp_play(&ctx.rtsp) < 0)
                {
                    logger(LOG_ERROR, "RTSP initialization failed, cleaning up and exiting");
                    stream_cleanup(&ctx, service);
                    exit(RETVAL_RTP_FAILED);
                }
            }
            else if (service->service_type == SERVICE_MRTP && service->fcc_addr)
            {
                /* Try FCC fast channel change */
                if (fcc_initialize_and_request(&ctx) < 0)
                {
                    logger(LOG_ERROR, "FCC initialization failed, cleaning up and exiting");
                    stream_cleanup(&ctx, service);
                    exit(RETVAL_RTP_FAILED);
                }
            }
            else
            {
                /* Direct multicast join */
                logger(LOG_DEBUG, "Service doesn't support FCC, joining multicast directly");
                ctx.mcast_sock = join_mcast_group(service);
                fcc_session_set_state(&ctx.fcc, FCC_STATE_MCAST_ACTIVE, "Direct multicast");
            }
            continue;
        }

        /* Prepare file descriptor sets */
        FD_ZERO(&rfds);
        max_sock = client;
        FD_SET(client, &rfds); /* Detect client disconnect */

        /* Add FCC socket if active and not in pure multicast state */
        if (ctx.fcc.fcc_sock && ctx.fcc.state != FCC_STATE_MCAST_ACTIVE)
        {
            FD_SET(ctx.fcc.fcc_sock, &rfds);
            if (ctx.fcc.fcc_sock > max_sock)
            {
                max_sock = ctx.fcc.fcc_sock;
            }
        }

        /* Add multicast socket if available and needed */
        if (ctx.mcast_sock && ctx.fcc.state != FCC_STATE_REQUESTED)
        {
            FD_SET(ctx.mcast_sock, &rfds);
            if (ctx.mcast_sock > max_sock)
            {
                max_sock = ctx.mcast_sock;
            }
        }

        /* Add RTSP control socket if active */
        if (ctx.rtsp.socket > 0)
        {
            FD_SET(ctx.rtsp.socket, &rfds);
            if (ctx.rtsp.socket > max_sock)
            {
                max_sock = ctx.rtsp.socket;
            }
        }

        /* Add RTSP RTP socket if using UDP transport */
        if (ctx.rtsp.rtp_socket > 0)
        {
            FD_SET(ctx.rtsp.rtp_socket, &rfds);
            if (ctx.rtsp.rtp_socket > max_sock)
            {
                max_sock = ctx.rtsp.rtp_socket;
            }
        }

        /* Add RTSP RTCP socket if using UDP transport */
        if (ctx.rtsp.rtcp_socket > 0)
        {
            FD_SET(ctx.rtsp.rtcp_socket, &rfds);
            if (ctx.rtsp.rtcp_socket > max_sock)
            {
                max_sock = ctx.rtsp.rtcp_socket;
            }
        }

        /* Setup timeout */
        timeout.tv_sec = FCC_SELECT_TIMEOUT_SEC;
        timeout.tv_usec = 0;

        /* Wait for socket events */
        r = select(max_sock + 1, &rfds, NULL, NULL, &timeout);

        if (r < 0)
        {
            if (errno == EINTR)
            {
                continue; /* Interrupted by signal, retry */
            }
            logger(LOG_ERROR, "Select failed: %s, cleaning up and exiting", strerror(errno));
            stream_cleanup(&ctx, service);
            exit(RETVAL_SOCK_READ_FAILED);
        }

        if (r == 0)
        {
            /* Timeout - indicates no data available, possibly stream issue */
            logger(LOG_ERROR, "Stream timeout - no data received within %d seconds, cleaning up and exiting",
                   FCC_SELECT_TIMEOUT_SEC);
            stream_cleanup(&ctx, service);
            exit(RETVAL_SOCK_READ_FAILED);
        }

        /* Process socket events */
        int process_result = stream_process_sockets(&ctx, &rfds);
        if (process_result < 0)
        {
            /* Exit requested (client disconnect or fatal error) */
            break;
        }
        else if (process_result > 0)
        {
            /* State change requested - restart loop */
            continue;
        }
    }

    /* Cleanup */
    logger(LOG_DEBUG, "Stream processing ended, performing cleanup");
    stream_cleanup(&ctx, service);
}
