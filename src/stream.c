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
#include "rtsp.h"

/* Maximum number of epoll events to process per iteration */
#define MAX_EPOLL_EVENTS 8

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
 * @param ctx Stream context
 * @param fd File descriptor that has an event
 * @return 0 on success (continue processing other events),
 *         -1 to exit (client disconnect or fatal error),
 *         1 for state change requiring immediate loop restart (e.g., FCC redirect)
 */
static int stream_process_socket(stream_context_t *ctx, int fd)
{
    int actualr;
    struct sockaddr_in peer_addr;
    socklen_t slen = sizeof(peer_addr);

    /* Check for client disconnect or incoming data */
    if (fd == ctx->client_fd)
    {
        char discard_buffer[1024];
        int bytes = recv(ctx->client_fd, discard_buffer, sizeof(discard_buffer), 0);

        if (bytes <= 0)
        {
            /* Client disconnected (bytes == 0) or error (bytes < 0) */
            if (bytes == 0)
            {
                logger(LOG_DEBUG, "Client disconnected gracefully");
            }
            else
            {
                logger(LOG_DEBUG, "Client socket error: %s", strerror(errno));
            }
            return -1; /* Exit and cleanup */
        }
        else
        {
            /* Client sent unexpected data (e.g., additional HTTP request, keep-alive ping)
             * This is normal for HTTP/1.1 connections - just discard the data */
            logger(LOG_DEBUG, "Client sent %d bytes of data (discarded)", bytes);
            return 0; /* Continue streaming */
        }
    }

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

        /* Handle different types of FCC packets */
        if (peer_addr.sin_port == ctx->fcc.fcc_server->sin_port)
        {
            /* RTCP control message */
            if (ctx->recv_buffer[0] == 0x83)
            {
                return fcc_handle_server_response(ctx, ctx->recv_buffer, actualr, &peer_addr);
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
    if ((ctx->rtsp.socket > 0 && fd == ctx->rtsp.socket) ||
        (ctx->rtsp.rtp_socket > 0 && fd == ctx->rtsp.rtp_socket))
    {
        int result = rtsp_handle_rtp_data(&ctx->rtsp, ctx->client_fd);
        if (result < 0)
        {
            return -1; /* Error */
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
    struct epoll_event events[MAX_EPOLL_EVENTS];
    int nfds, i;

    /* Initialize stream context */
    memset(&ctx, 0, sizeof(ctx));
    ctx.client_fd = client;
    ctx.service = service;
    fcc_session_init(&ctx.fcc);
    rtsp_session_init(&ctx.rtsp);

    /* Create epoll instance */
    ctx.epoll_fd = epoll_create1(EPOLL_CLOEXEC);
    if (ctx.epoll_fd < 0)
    {
        logger(LOG_ERROR, "Failed to create epoll instance: %s", strerror(errno));
        stream_cleanup(&ctx, service);
        exit(RETVAL_SOCK_READ_FAILED);
    }

    /* Add client socket to epoll (always monitored for disconnect detection) */
    struct epoll_event client_ev;
    client_ev.events = EPOLLIN; /* Level-triggered mode for read events */
    client_ev.data.fd = ctx.client_fd;
    if (epoll_ctl(ctx.epoll_fd, EPOLL_CTL_ADD, ctx.client_fd, &client_ev) < 0)
    {
        logger(LOG_ERROR, "Failed to add client_fd to epoll: %s", strerror(errno));
        close(ctx.epoll_fd);
        stream_cleanup(&ctx, service);
        exit(RETVAL_SOCK_READ_FAILED);
    }

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
                    close(ctx.epoll_fd);
                    stream_cleanup(&ctx, service);
                    exit(RETVAL_RTP_FAILED);
                }

                /* Set epoll_fd in RTSP session for socket registration */
                ctx.rtsp.epoll_fd = ctx.epoll_fd;

                if (rtsp_parse_server_url(&ctx.rtsp, service->rtsp_url, service->playseek_param, service->user_agent) < 0 ||
                    rtsp_connect(&ctx.rtsp) < 0 ||
                    rtsp_describe(&ctx.rtsp) < 0 ||
                    rtsp_setup(&ctx.rtsp) < 0 ||
                    rtsp_play(&ctx.rtsp) < 0)
                {
                    logger(LOG_ERROR, "RTSP initialization failed, cleaning up and exiting");
                    close(ctx.epoll_fd);
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
                    close(ctx.epoll_fd);
                    stream_cleanup(&ctx, service);
                    exit(RETVAL_RTP_FAILED);
                }
            }
            else
            {
                /* Direct multicast join */
                logger(LOG_DEBUG, "Service doesn't support FCC, joining multicast directly");
                ctx.mcast_sock = join_mcast_group(service, ctx.epoll_fd);
                fcc_session_set_state(&ctx.fcc, FCC_STATE_MCAST_ACTIVE, "Direct multicast");
            }
            continue;
        }

        /* Wait for socket events with timeout */
        nfds = epoll_wait(ctx.epoll_fd, events, MAX_EPOLL_EVENTS, FCC_SELECT_TIMEOUT_SEC * 1000);

        if (nfds < 0)
        {
            if (errno == EINTR)
            {
                continue; /* Interrupted by signal, retry */
            }
            logger(LOG_ERROR, "epoll_wait failed: %s, cleaning up and exiting", strerror(errno));
            close(ctx.epoll_fd);
            stream_cleanup(&ctx, service);
            exit(RETVAL_SOCK_READ_FAILED);
        }

        if (nfds == 0)
        {
            /* Timeout - handle based on current FCC state */
            if (ctx.fcc.state == FCC_STATE_REQUESTED ||
                ctx.fcc.state == FCC_STATE_UNICAST_ACTIVE ||
                ctx.fcc.state == FCC_STATE_MCAST_REQUESTED)
            {
                /* FCC unicast stream failed to arrive or timed out - fall back to multicast */
                logger(LOG_ERROR, "FCC timeout in state %d - no unicast data received within %d seconds, falling back to multicast",
                       ctx.fcc.state, FCC_SELECT_TIMEOUT_SEC);

                /* Transition to multicast active state */
                fcc_session_set_state(&ctx.fcc, FCC_STATE_MCAST_ACTIVE, "FCC unicast timeout - fallback to multicast");

                /* Join multicast group if not already joined */
                if (ctx.mcast_sock <= 0)
                {
                    ctx.mcast_sock = join_mcast_group(ctx.service, ctx.epoll_fd);
                }

                /* Continue processing - multicast should now provide data */
                continue;
            }
            else
            {
                /* Timeout in other states (multicast active, RTSP, etc.) is a real error */
                logger(LOG_ERROR, "Stream timeout - no data received within %d seconds, cleaning up and exiting",
                       FCC_SELECT_TIMEOUT_SEC);
                close(ctx.epoll_fd);
                stream_cleanup(&ctx, service);
                exit(RETVAL_SOCK_READ_FAILED);
            }
        }

        /* Process all ready file descriptors */
        for (i = 0; i < nfds; i++)
        {
            int process_result = stream_process_socket(&ctx, events[i].data.fd);
            if (process_result < 0)
            {
                /* Exit requested (client disconnect or fatal error) */
                close(ctx.epoll_fd);
                logger(LOG_DEBUG, "Stream processing ended, performing cleanup");
                stream_cleanup(&ctx, service);
                return;
            }
            else if (process_result == 1)
            {
                /* State change requested (e.g., FCC redirect) - restart loop immediately
                 * Note: Unprocessed events are safe to skip because we use level-triggered
                 * epoll mode - any remaining data will trigger events again on next iteration */
                break;
            }
            /* process_result == 0: continue processing remaining events */
        }
    }
}
