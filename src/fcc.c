#include "fcc.h"
#include "connection.h"
#include "fcc_huawei.h"
#include "fcc_telecom.h"
#include "multicast.h"
#include "rtp.h"
#include "status.h"
#include "stream.h"
#include "utils.h"
#include "worker.h"
#include <errno.h>
#include <netinet/in.h>
#include <stdio.h>
#include <string.h>
#include <sys/epoll.h>
#include <sys/socket.h>
#include <unistd.h>

/* Forward declarations for internal functions */
static void log_fcc_state_transition(fcc_state_t from, fcc_state_t to,
                                     const char *reason);
static int fcc_send_term_packet(fcc_session_t *fcc, service_t *service,
                                uint16_t seqn, const char *reason);
static int fcc_send_termination_message(stream_context_t *ctx,
                                        uint16_t mcast_seqn);

static int fcc_bind_socket_with_range(int sock, struct sockaddr_in *sin) {
  if (!sin)
    return -1;

  if (config.fcc_listen_port_min <= 0 || config.fcc_listen_port_max <= 0) {
    sin->sin_port = 0;
    return bind(sock, (struct sockaddr *)sin, sizeof(*sin));
  }

  int min_port = config.fcc_listen_port_min;
  int max_port = config.fcc_listen_port_max;
  if (max_port < min_port) {
    int tmp = min_port;
    min_port = max_port;
    max_port = tmp;
  }

  int range = max_port - min_port + 1;
  if (range <= 0)
    range = 1;

  int start_offset = (int)(get_time_ms() % range);

  for (int i = 0; i < range; i++) {
    int port = min_port + ((start_offset + i) % range);
    sin->sin_port = htons((uint16_t)port);
    if (bind(sock, (struct sockaddr *)sin, sizeof(*sin)) == 0) {
      logger(LOG_DEBUG, "FCC: Bound client socket to port %d", port);
      return 0;
    }

    if (errno != EADDRINUSE && errno != EACCES) {
      logger(LOG_DEBUG, "FCC: Failed to bind port %d: %s", port,
             strerror(errno));
    }
  }

  logger(LOG_ERROR,
         "FCC: Unable to bind socket within configured port range %d-%d",
         min_port, max_port);
  return -1;
}

ssize_t sendto_triple(int fd, const void *buf, size_t n, int flags,
                      struct sockaddr_in *addr, socklen_t addr_len) {
  static uint8_t i;
  for (i = 0; i < 3; i++) {
    if (sendto(fd, buf, n, flags, (struct sockaddr *)addr, addr_len) < 0) {
      return -1;
    }
  }
  return n;
}

void fcc_session_cleanup(fcc_session_t *fcc, service_t *service, int epoll_fd) {
  if (!fcc) {
    return;
  }

  /* Send termination message ONLY if not sent before */
  if (!fcc->fcc_term_sent && fcc->fcc_sock >= 0 && fcc->fcc_server && service) {
    logger(LOG_DEBUG, "FCC: Sending termination packet (cleanup)");
    if (fcc_send_term_packet(fcc, service, 0, "cleanup") == 0) {
      fcc->fcc_term_sent = 1;
    }
  }

  /* Clean up session resources - free pending buffer chain */
  buffer_ref_t *node = fcc->pending_list_head;
  while (node) {
    buffer_ref_t *next = node->send_next;
    buffer_ref_put(node);
    node = next;
  }
  if (fcc->pending_list_head) {
    logger(LOG_DEBUG, "FCC: Multicast pending buffer chain freed");
  }
  fcc->pending_list_head = NULL;
  fcc->pending_list_tail = NULL;

  /* Close FCC socket */
  if (fcc->fcc_sock >= 0) {
    worker_cleanup_socket_from_epoll(epoll_fd, fcc->fcc_sock);
    fcc->fcc_sock = -1;
    logger(LOG_DEBUG, "FCC: Socket closed");
  }

  /* Reset all session state to clean state */
  fcc->state = FCC_STATE_INIT;
  fcc->fcc_server =
      NULL; /* This was pointing to service memory, safe to NULL */
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
static void log_fcc_state_transition(fcc_state_t from, fcc_state_t to,
                                     const char *reason) {
  const char *state_names[] = {
      "INIT",           "REQUESTED",       "UNICAST_PENDING",
      "UNICAST_ACTIVE", "MCAST_REQUESTED", "MCAST_ACTIVE",
      "ERROR"};
  logger(LOG_DEBUG, "FCC State: %s -> %s (%s)", state_names[from],
         state_names[to], reason ? reason : "");
}

/*
 * FCC Session Management Functions
 */
void fcc_session_init(fcc_session_t *fcc) {
  memset(fcc, 0, sizeof(fcc_session_t));
  fcc->state = FCC_STATE_INIT;
  fcc->fcc_sock = -1;
  fcc->status_index = -1;
  fcc->redirect_count = 0;
}

int fcc_session_set_state(fcc_session_t *fcc, fcc_state_t new_state,
                          const char *reason) {
  /* State mapping lookup table */
  static const client_state_type_t fcc_to_client_state[] = {
      [FCC_STATE_INIT] = CLIENT_STATE_FCC_INIT,
      [FCC_STATE_REQUESTED] = CLIENT_STATE_FCC_REQUESTED,
      [FCC_STATE_UNICAST_PENDING] = CLIENT_STATE_FCC_UNICAST_PENDING,
      [FCC_STATE_UNICAST_ACTIVE] = CLIENT_STATE_FCC_UNICAST_ACTIVE,
      [FCC_STATE_MCAST_REQUESTED] = CLIENT_STATE_FCC_MCAST_REQUESTED,
      [FCC_STATE_MCAST_ACTIVE] = CLIENT_STATE_FCC_MCAST_ACTIVE,
      [FCC_STATE_ERROR] = CLIENT_STATE_ERROR};

  if (fcc->state == new_state) {
    return 0; /* No change */
  }

  log_fcc_state_transition(fcc->state, new_state, reason);
  fcc->state = new_state;

  /* Update client status immediately if status_index is valid */
  if (fcc->status_index >= 0 && new_state < ARRAY_SIZE(fcc_to_client_state)) {
    status_update_client_state(fcc->status_index,
                               fcc_to_client_state[new_state]);
  }

  return 1;
}

/*
 * FCC Protocol Handler Functions
 */

/*
 * FCC Protocol Stage 1: Initialize FCC socket and send request
 */
int fcc_initialize_and_request(stream_context_t *ctx) {
  fcc_session_t *fcc = &ctx->fcc;
  service_t *service = ctx->service;
  struct sockaddr_in sin;
  socklen_t slen;
  int r;
  const char *upstream_if;

  logger(LOG_DEBUG, "FCC: Initializing FCC session and sending request");

  if (fcc->fcc_sock < 0) {
    /* Create and configure FCC socket */
    fcc->fcc_sock = socket(AF_INET, service->fcc_addr->ai_socktype,
                           service->fcc_addr->ai_protocol);
    if (fcc->fcc_sock < 0) {
      logger(LOG_ERROR, "FCC: Failed to create socket: %s", strerror(errno));
      return -1;
    }

    /* Set socket to non-blocking mode for epoll */
    if (connection_set_nonblocking(fcc->fcc_sock) < 0) {
      logger(LOG_ERROR, "FCC: Failed to set socket non-blocking: %s",
             strerror(errno));
      close(fcc->fcc_sock);
      fcc->fcc_sock = -1;
      return -1;
    }

    /* Set receive buffer size to 512KB */
    int rcvbuf_size = UDP_RCVBUF_SIZE;
    r = setsockopt(fcc->fcc_sock, SOL_SOCKET, SO_RCVBUF, &rcvbuf_size,
                   sizeof(rcvbuf_size));
    if (r < 0) {
      logger(LOG_WARN, "FCC: Failed to set SO_RCVBUF to %d: %s", rcvbuf_size,
             strerror(errno));
    }

    upstream_if = get_upstream_interface_for_fcc();
    bind_to_upstream_interface(fcc->fcc_sock, upstream_if);

    /* Bind to configured or ephemeral port */
    sin.sin_family = AF_INET;
    sin.sin_addr.s_addr = INADDR_ANY;
    if (fcc_bind_socket_with_range(fcc->fcc_sock, &sin) != 0) {
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
    if (epoll_ctl(ctx->epoll_fd, EPOLL_CTL_ADD, fcc->fcc_sock, &ev) < 0) {
      logger(LOG_ERROR, "FCC: Failed to add socket to epoll: %s",
             strerror(errno));
      close(fcc->fcc_sock);
      fcc->fcc_sock = -1;
      return -1;
    }
    fdmap_set(fcc->fcc_sock, ctx->conn);
    logger(LOG_DEBUG, "FCC: Socket registered with epoll");
  }

  /* Send FCC request - different format for Huawei vs Telecom */
  if (fcc->type == FCC_TYPE_HUAWEI) {
    r = fcc_huawei_initialize_and_request(ctx);
  } else {
    r = fcc_telecom_initialize_and_request(ctx);
  }

  if (r < 0) {
    return -1;
  }

  ctx->last_fcc_data_time = get_time_ms();
  fcc_session_set_state(fcc, FCC_STATE_REQUESTED, "Request sent");

  return 0;
}

/*
 * FCC Protocol Stage 2: Handle server response
 * Dispatches to vendor-specific handler based on FCC type
 */
int fcc_handle_server_response(stream_context_t *ctx, uint8_t *buf,
                               int buf_len) {
  fcc_session_t *fcc = &ctx->fcc;

  /* Dispatch to vendor-specific handler based on FCC type */
  if (fcc->type == FCC_TYPE_HUAWEI) {
    return fcc_huawei_handle_server_response(ctx, buf, buf_len);
  } else if (fcc->type == FCC_TYPE_TELECOM) {
    return fcc_telecom_handle_server_response(ctx, buf);
  }

  return 0;
}

/*
 * FCC Protocol Stage 3: Handle synchronization notification (FMT 4)
 */
int fcc_handle_sync_notification(stream_context_t *ctx, int timeout_ms) {
  fcc_session_t *fcc = &ctx->fcc;

  // Ignore if already using mcast stream
  if (fcc->state == FCC_STATE_MCAST_REQUESTED ||
      fcc->state == FCC_STATE_MCAST_ACTIVE)
    return 0;

  if (timeout_ms) {
    logger(LOG_DEBUG,
           "FCC: Sync notification timeout reached (%.1f seconds) - joining "
           "multicast",
           timeout_ms / 1000.0);
  } else {
    logger(LOG_DEBUG, "FCC: Sync notification received - joining multicast");
  }
  fcc_session_set_state(fcc, FCC_STATE_MCAST_REQUESTED,
                        timeout_ms ? "Sync notification timeout"
                                   : "Sync notification received");

  stream_join_mcast_group(ctx);

  return 0; /* Signal to join multicast */
}

/*
 * FCC Protocol Stage 4: Handle RTP media packets from unicast stream
 */
int fcc_handle_unicast_media(stream_context_t *ctx, buffer_ref_t *buf_ref) {
  fcc_session_t *fcc = &ctx->fcc;

  /* Drop unicast packets if we've already switched to multicast */
  if (fcc->state == FCC_STATE_MCAST_ACTIVE) {
    return 0;
  }

  /* Transition from PENDING to ACTIVE on first unicast packet */
  if (fcc->state == FCC_STATE_UNICAST_PENDING) {
    fcc_session_set_state(fcc, FCC_STATE_UNICAST_ACTIVE,
                          "First unicast packet received");
    logger(LOG_INFO, "FCC: Unicast stream started successfully");
  }

  /* Forward RTP payload to client (true zero-copy) or capture I-frame
   * (snapshot) */
  int processed_bytes = stream_process_rtp_payload(
      ctx, buf_ref, &fcc->current_seqn, &fcc->not_first_packet);
  if (processed_bytes > 0) {
    ctx->total_bytes_sent += (uint64_t)processed_bytes;
  }

  /* Check if we should terminate FCC based on sequence number */
  if (fcc->fcc_term_sent && fcc->current_seqn >= fcc->fcc_term_seqn - 1 &&
      fcc->state != FCC_STATE_MCAST_ACTIVE) {
    logger(LOG_INFO,
           "FCC: Switching to multicast stream (reached termination sequence)");
    fcc_session_set_state(fcc, FCC_STATE_MCAST_ACTIVE,
                          "Reached termination sequence");
  }

  return 0;
}

/*
 * Internal helper: Send FCC termination packet to server
 */
static int fcc_send_term_packet(fcc_session_t *fcc, service_t *service,
                                uint16_t seqn, const char *reason) {
  if (fcc->fcc_sock < 0 || !fcc->fcc_server) {
    logger(LOG_DEBUG, "FCC: Cannot send termination - missing socket/server");
    return -1;
  }

  /* Send different termination packet based on FCC type */
  if (fcc->type == FCC_TYPE_HUAWEI) {
    return fcc_huawei_send_term_packet(fcc, service, seqn, reason);
  } else {
    return fcc_telecom_send_term_packet(fcc, service, seqn, reason);
  }
}

/*
 * FCC Protocol Stage 5: Send termination message to server (normal flow)
 */
static int fcc_send_termination_message(stream_context_t *ctx,
                                        uint16_t mcast_seqn) {
  fcc_session_t *fcc = &ctx->fcc;

  if (!fcc->fcc_term_sent) {
    fcc->fcc_term_seqn = mcast_seqn;
    if (fcc_send_term_packet(fcc, ctx->service, fcc->fcc_term_seqn + 2,
                             "normal flow") == 0) {
      fcc->fcc_term_sent = 1;
      logger(LOG_DEBUG,
             "FCC: Normal termination message sent, term_seqn=%u (+2)",
             mcast_seqn);
    } else {
      return -1;
    }
  }

  return 0;
}

/*
 * FCC Protocol Stage 6: Handle multicast data during transition period
 */
int fcc_handle_mcast_transition(stream_context_t *ctx, buffer_ref_t *buf_ref) {
  fcc_session_t *fcc = &ctx->fcc;
  int payloadlength;
  uint8_t *payload;
  uint16_t seqn = 0;
  int is_rtp;
  uint8_t *data_ptr = (uint8_t *)buf_ref->data + buf_ref->data_offset;

  is_rtp = rtp_get_payload(data_ptr, buf_ref->data_size, &payload,
                           &payloadlength, &seqn);
  if (unlikely(is_rtp < 0)) {
    return 0; /* Malformed packet, already logged */
  }

  /* Send termination message if not sent yet */
  if (!fcc->fcc_term_sent && fcc_send_termination_message(ctx, seqn) < 0) {
    return -1;
  }

  /* Keep original receive buffer alive for deferred zero-copy send */
  buffer_ref_get(buf_ref);

  buf_ref->send_next = NULL;

  /* Add to pending list */
  if (fcc->pending_list_tail) {
    fcc->pending_list_tail->send_next = buf_ref;
  } else {
    fcc->pending_list_head = buf_ref;
  }
  fcc->pending_list_tail = buf_ref;

  return 0;
}

/*
 * FCC Protocol Stage 8: Handle multicast data in active state
 */
int fcc_handle_mcast_active(stream_context_t *ctx, buffer_ref_t *buf_ref) {
  fcc_session_t *fcc = &ctx->fcc;

  /* Flush pending buffer chain first if available - TRUE ZERO-COPY */
  if (unlikely(fcc->pending_list_head != NULL)) {
    buffer_ref_t *node = fcc->pending_list_head;
    uint64_t flushed_bytes = 0;

    while (node) {
      /* Queue each buffer for zero-copy send */
      buffer_ref_t *next = node->send_next;
      int processed_bytes = stream_process_rtp_payload(
          ctx, node, &fcc->current_seqn, &fcc->not_first_packet);
      if (likely(processed_bytes > 0)) {
        ctx->total_bytes_sent += (uint64_t)processed_bytes;
        flushed_bytes += (uint64_t)processed_bytes;
      }
      buffer_ref_put(node);
      node = next;
    }

    /* All buffers flushed successfully */
    fcc->pending_list_head = NULL;
    fcc->pending_list_tail = NULL;

    logger(LOG_DEBUG,
           "FCC: Flushed pending buffer chain, total_flushed_bytes=%lu",
           flushed_bytes);
  }

  /* Forward multicast data to client (true zero-copy) or capture I-frame
   * (snapshot) */
  int processed_bytes = stream_process_rtp_payload(
      ctx, buf_ref, &fcc->current_seqn, &fcc->not_first_packet);
  if (likely(processed_bytes > 0)) {
    ctx->total_bytes_sent += (uint64_t)processed_bytes;
  }

  return 0;
}
