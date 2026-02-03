#include "stream.h"
#include "connection.h"
#include "fcc.h"
#include "multicast.h"
#include "rtp.h"
#include "rtp_fec.h"
#include "rtsp.h"
#include "service.h"
#include "snapshot.h"
#include "status.h"
#include "utils.h"
#include "worker.h"
#include <arpa/inet.h>
#include <errno.h>
#include <netdb.h>
#include <netinet/in.h>
#include <stdbool.h>
#include <stdlib.h>
#include <string.h>
#include <sys/epoll.h>
#include <sys/socket.h>
#include <unistd.h>

/*
 * Process RTP payload with reordering - either forward to client (streaming)
 * or capture I-frame (snapshot)
 * Returns: bytes forwarded (>= 0), 1 if I-frame captured for snapshot, -1 on
 * error
 */
int stream_process_rtp_payload(stream_context_t *ctx, buffer_ref_t *buf_ref) {
  uint8_t *data_ptr = (uint8_t *)buf_ref->data + buf_ref->data_offset;
  uint8_t *payload;
  int payload_len;
  uint16_t seqn;

  int pkt_type =
      rtp_get_payload(data_ptr, buf_ref->data_size, &payload, &payload_len, &seqn);

  if (pkt_type < 0)
    return 0; /* Malformed packet */

  if (pkt_type == 2) {
    /* FEC packet received on RTP socket - process it for recovery */
    if (ctx->fec.initialized) {
      fec_process_packet(&ctx->fec, payload, payload_len);
    }
    return 0;
  }

  if (pkt_type == 0) {
    /* Non-RTP packet - pass through directly (no reordering needed) */
    if (ctx->snapshot.initialized) {
      return snapshot_process_packet(&ctx->snapshot, buf_ref->data_size,
                                     data_ptr, ctx->conn);
    }
    return rtp_queue_buf_direct(ctx->conn, buf_ref);
  }

  /* pkt_type == 1: Regular RTP packet */

  /* Adjust buffer to point to payload */
  buf_ref->data_offset = payload - (uint8_t *)buf_ref->data;
  buf_ref->data_size = (size_t)payload_len;

  /* Process through reorder buffer (also serves as FEC packet store) */
  return rtp_reorder_insert(&ctx->reorder, buf_ref, seqn, ctx->conn,
                            ctx->snapshot.initialized, ctx->fec.initialized ? &ctx->fec : NULL);
}

/*
 * Handle an event-ready fd that belongs to this stream context
 * Note: Client socket events are handled by worker.c,
 * this function only handles media stream sockets (multicast, FCC, RTSP)
 */
int stream_handle_fd_event(stream_context_t *ctx, int fd, uint32_t events,
                           int64_t now) {
  /* Process FCC socket events */
  if (ctx->fcc.initialized && ctx->fcc.fcc_sock >= 0 && fd == ctx->fcc.fcc_sock) {
    return fcc_handle_socket_event(ctx, now);
  }

  /* Process multicast socket events */
  if (ctx->mcast.initialized && ctx->mcast.sock >= 0 && fd == ctx->mcast.sock) {
    return mcast_session_handle_event(&ctx->mcast, ctx, now);
  }

  /* Process FEC socket events */
  if (ctx->fec.initialized && ctx->fec.sock >= 0 && fd == ctx->fec.sock) {
    uint8_t fec_buf[BUFFER_POOL_BUFFER_SIZE];
    int fec_len = recv(ctx->fec.sock, fec_buf, sizeof(fec_buf), 0);
    if (fec_len > 0) {
      fec_process_packet(&ctx->fec, fec_buf, fec_len);
    }
    return 0;
  }

  /* Process RTSP socket events */
  if (ctx->rtsp.initialized && ctx->rtsp.socket >= 0 && fd == ctx->rtsp.socket) {
    /* Handle RTSP socket events (handshake and RTP data in PLAYING state) */
    int result = rtsp_handle_socket_event(&ctx->rtsp, events);
    if (result < 0) {
      /* -2 indicates graceful TEARDOWN completion, not an error */
      if (result == -2) {
        logger(LOG_DEBUG, "RTSP: Graceful TEARDOWN completed");
        return -1; /* Signal connection should be closed */
      }
      if (result == -3)
      {
        logger(LOG_DEBUG, "RTSP: found duration: %0.3f", ctx->rtsp.r2h_duration_value);
        return -3;
      }
      /* Real error */
      logger(LOG_ERROR, "RTSP: Socket event handling failed");
      return -1;
    }
    if (result > 0) {
      ctx->total_bytes_sent += (uint64_t)result;
    }
    return 0; /* Success - processed data, continue with other events */
  }

  /* Process RTSP RTP socket events (UDP mode) */
  if (ctx->rtsp.initialized && ctx->rtsp.rtp_socket >= 0 && fd == ctx->rtsp.rtp_socket) {
    int result = rtsp_handle_udp_rtp_data(&ctx->rtsp, ctx->conn);
    if (result < 0) {
      return -1; /* Error */
    }
    if (result > 0) {
      ctx->total_bytes_sent += (uint64_t)result;
    }
    return 0; /* Success - processed data, continue with other events */
  }

  /* Handle UDP RTCP socket (for future RTCP processing) */
  if (ctx->rtsp.initialized && ctx->rtsp.rtcp_socket >= 0 && fd == ctx->rtsp.rtcp_socket) {
    /* RTCP data processing could be added here in the future */
    /* For now, just consume the data to prevent buffer overflow */
    uint8_t rtcp_buffer[RTCP_BUFFER_SIZE];
    recv(ctx->rtsp.rtcp_socket, rtcp_buffer, sizeof(rtcp_buffer), 0);
    return 0;
  }

  /* Process HTTP proxy socket events */
  if (ctx->http_proxy.initialized && ctx->http_proxy.socket >= 0 && fd == ctx->http_proxy.socket) {
    int result = http_proxy_handle_socket_event(&ctx->http_proxy, events);
    if (result < 0) {
      logger(LOG_ERROR, "HTTP Proxy: Socket event handling failed");
      return -1;
    }
    if (result > 0) {
      ctx->total_bytes_sent += (uint64_t)result;
    }
    /* Check if transfer is complete (only process once) */
    if (ctx->http_proxy.state == HTTP_PROXY_STATE_COMPLETE &&
        ctx->conn->state != CONN_CLOSING) {
      logger(LOG_DEBUG, "HTTP Proxy: Transfer complete");
      /* Set connection to closing state - worker will close it after
       * output queue is drained. */
      ctx->conn->state = CONN_CLOSING;
      /* Trigger EPOLLOUT to flush any remaining data in the queue */
      connection_epoll_update_events(
          ctx->conn->epfd, ctx->conn->fd,
          EPOLLIN | EPOLLOUT | EPOLLRDHUP | EPOLLHUP | EPOLLERR);
    }
    return 0;
  }

  return 0;
}

/* Initialize context for unified worker epoll (non-blocking, no own loop) */
int stream_context_init_for_worker(stream_context_t *ctx, connection_t *conn,
                                   service_t *service, int epoll_fd,
                                   int status_index, int is_snapshot) {
  if (!ctx || !conn || !service)
    return -1;
  memset(ctx, 0, sizeof(*ctx));
  ctx->conn = conn;
  ctx->service = service;
  ctx->epoll_fd = epoll_fd;
  ctx->status_index = status_index;
  ctx->total_bytes_sent = 0;
  ctx->last_bytes_sent = 0;
  ctx->last_status_update = get_time_ms();

  /* Initialize media path depending on service type */
  if (service->service_type == SERVICE_HTTP) {
    /* Snapshot mode is not supported for HTTP proxy - ignore is_snapshot */
    http_proxy_session_init(&ctx->http_proxy);
    ctx->http_proxy.epoll_fd = ctx->epoll_fd;
    ctx->http_proxy.conn = conn;
    ctx->http_proxy.status_index = status_index;

    if (!service->http_url) {
      logger(LOG_ERROR, "HTTP URL not found in service configuration");
      return -1;
    }

    /* Parse URL */
    if (http_proxy_parse_url(&ctx->http_proxy, service->http_url) < 0) {
      logger(LOG_ERROR, "HTTP Proxy: Failed to parse URL");
      return -1;
    }

    /* Set HTTP method from client request */
    http_proxy_set_method(&ctx->http_proxy, conn->http_req.method);

    /* Set raw headers for full passthrough */
    http_proxy_set_raw_headers(&ctx->http_proxy, conn->http_req.raw_headers,
                               conn->http_req.raw_headers_len);

    /* Set request body for passthrough */
    if (conn->http_req.body && conn->http_req.body_len > 0) {
      http_proxy_set_request_body(&ctx->http_proxy, conn->http_req.body,
                                  conn->http_req.body_len);
    }

    /* Set request headers for base URL construction during content rewriting */
    http_proxy_set_request_headers(&ctx->http_proxy, conn->http_req.hostname,
                                   conn->http_req.x_forwarded_host,
                                   conn->http_req.x_forwarded_proto);

    /* Initiate connection */
    if (http_proxy_connect(&ctx->http_proxy) < 0) {
      logger(LOG_ERROR, "HTTP Proxy: Failed to initiate connection");
      return -1;
    }

    logger(LOG_DEBUG, "HTTP Proxy: Async connection initiated");
  } else {
    /* RTP-based services (RTSP, FCC, multicast) - snapshot mode supported */

    /* Initialize snapshot context if this is a snapshot request */
    if (is_snapshot) {
      if (snapshot_init(&ctx->snapshot) < 0) {
        logger(LOG_ERROR, "Snapshot: Failed to initialize snapshot context");
        return -1;
      }
      if (is_snapshot == 2) /* X-Request-Snapshot or Accept: image/jpeg */
      {
        ctx->snapshot.fallback_to_streaming = 1;
      }
    }

    /* Initialize RTP reorder and FEC (common to all RTP-based services) */
    if (rtp_reorder_init(&ctx->reorder, service->fec_port > 0) < 0) {
      logger(LOG_ERROR, "Failed to initialize RTP reorder buffer");
      return -1;
    }
    fec_init(&ctx->fec, service->fec_port, &ctx->reorder);

    if (service->service_type == SERVICE_RTSP) {
      /* Initialize RTSP session */
      rtsp_session_init(&ctx->rtsp);
      ctx->rtsp.status_index = status_index;
      ctx->rtsp.epoll_fd = ctx->epoll_fd;
      ctx->rtsp.conn = conn;
      if (!service->rtsp_url) {
        logger(LOG_ERROR, "RTSP URL not found in service configuration");
        return -1;
      }

      /* Parse URL and initiate connection */
      if (rtsp_parse_server_url(
              &ctx->rtsp, service->rtsp_url, service->seek_param_name,
              service->seek_param_value, service->seek_offset_seconds,
              service->user_agent, NULL, NULL) < 0) {
        logger(LOG_ERROR, "RTSP: Failed to parse URL");
        return -1;
      }

      if (rtsp_connect(&ctx->rtsp) < 0) {
        logger(LOG_ERROR, "RTSP: Failed to initiate connection");
        return -1;
      }

      /* Connection initiated - handshake will proceed asynchronously via event
       * loop */
      logger(LOG_DEBUG, "RTSP: Async connection initiated, state=%d",
             ctx->rtsp.state);
    } else {
      /* Multicast-based services (FCC or direct multicast) */
      mcast_session_init(&ctx->mcast);

      if (service->fcc_addr) {
        /* use Fast Channel Change for quick stream startup */
        fcc_session_init(&ctx->fcc);
        ctx->fcc.status_index = status_index;

        /* Use FCC type from service (already determined during parsing) */
        ctx->fcc.type = service->fcc_type;
        logger(LOG_INFO, "FCC: Using %s FCC protocol",
               ctx->fcc.type == FCC_TYPE_HUAWEI ? "Huawei"
                                                : "Telecom/ZTE/Fiberhome");

        if (fcc_initialize_and_request(ctx) < 0) {
          logger(LOG_ERROR, "FCC initialization failed");
          return -1;
        }
      } else {
        /* Direct multicast join (also joins FEC multicast if configured) */
        if (mcast_session_join(&ctx->mcast, ctx) < 0) {
          logger(LOG_ERROR, "Multicast: Failed to join group");
          return -1;
        }
        /* Update client state for direct multicast (no FCC) */
        status_update_client_state(status_index, CLIENT_STATE_FCC_MCAST_ACTIVE);
      }
    }
  }

  return 0;
}

int stream_tick(stream_context_t *ctx, int64_t now) {
  if (!ctx)
    return 0;

  /* Multicast session tick (rejoin and timeout checks) */
  if (mcast_session_tick(&ctx->mcast, ctx->service, now) < 0) {
    return -1; /* Multicast timeout */
  }

  /* FCC session tick (timeout checks) */
  fcc_session_tick(ctx, now);

  /* RTSP session tick (STUN timeout, keepalive) */
  rtsp_session_tick(&ctx->rtsp, now);

  /* Check snapshot timeout (5 seconds) */
  if (ctx->snapshot.initialized) {
    int64_t snapshot_elapsed = now - ctx->snapshot.start_time;
    if (snapshot_elapsed > SNAPSHOT_TIMEOUT_SEC * 1000) /* 5 seconds */
    {
      logger(LOG_WARN, "Snapshot: Timeout waiting for I-frame (%lld ms)",
             (long long)snapshot_elapsed);
      snapshot_fallback_to_streaming(&ctx->snapshot, ctx->conn);
    }
  }

  /* Update bandwidth calculation every second (skip for snapshot mode) */
  if (!ctx->snapshot.initialized && now - ctx->last_status_update >= 1000) {
    /* Calculate bandwidth based on bytes sent since last update */
    uint64_t bytes_diff = ctx->total_bytes_sent - ctx->last_bytes_sent;
    int64_t elapsed_ms = now - ctx->last_status_update;
    uint32_t current_bandwidth = 0;

    if (elapsed_ms > 0) {
      /* Convert to bytes per second: (bytes * 1000) / elapsed_ms */
      current_bandwidth = (uint32_t)((bytes_diff * 1000) / elapsed_ms);
    }

    /* Update bytes and bandwidth in status */
    status_update_client_bytes(ctx->status_index, ctx->total_bytes_sent,
                               current_bandwidth);

    /* Save current bytes for next calculation */
    ctx->last_bytes_sent = ctx->total_bytes_sent;
    ctx->last_status_update = now;
  }

  return 0; /* Success */
}

int stream_context_cleanup(stream_context_t *ctx) {
  if (!ctx)
    return 0;

  /* Clean up RTP reorder context */
  rtp_reorder_cleanup(&ctx->reorder);

  /* Clean up FEC context (fec_cleanup owns the socket cleanup) */
  fec_cleanup(&ctx->fec, ctx->epoll_fd);

  /* Clean up snapshot resources */
  snapshot_free(&ctx->snapshot);

  /* Clean up FCC session (always safe to cleanup immediately) */
  fcc_session_cleanup(&ctx->fcc, ctx->service, ctx->epoll_fd);

  /* Clean up RTSP session - this may initiate async TEARDOWN */
  int rtsp_async = rtsp_session_cleanup(&ctx->rtsp);

  /* Clean up HTTP proxy session (always synchronous) */
  http_proxy_session_cleanup(&ctx->http_proxy);

  /* Clean up multicast session */
  mcast_session_cleanup(&ctx->mcast, ctx->epoll_fd);

  if (rtsp_async) {
    /* RTSP async TEARDOWN initiated - defer final cleanup */
    logger(LOG_DEBUG,
           "Stream: RTSP async TEARDOWN initiated, deferring final cleanup");
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
