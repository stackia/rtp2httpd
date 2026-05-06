#include "fcc.h"
#include "buffer_pool.h"
#include "connection.h"
#include "fcc_huawei.h"
#include "fcc_telecom.h"
#include "multicast.h"
#include "poller.h"
#include "rtp.h"
#include "status.h"
#include "stream.h"
#include "utils.h"
#include "worker.h"
#include <errno.h>
#include <inttypes.h>
#include <netinet/in.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

/* Forward declarations for internal functions */
static void log_fcc_state_transition(fcc_state_t from, fcc_state_t to, const char *reason);
static int fcc_send_term_packet(fcc_session_t *fcc, service_t *service, uint16_t seqn, const char *reason);
static int fcc_send_termination_message(stream_context_t *ctx, uint16_t mcast_seqn);

static int fcc_create_configured_socket(service_t *service, const char *upstream_if, const char *label) {
  int sock = socket(AF_INET, service->fcc_addr->ai_socktype, service->fcc_addr->ai_protocol);
  if (sock < 0) {
    logger(LOG_ERROR, "FCC: Failed to create %s socket: %s", label, strerror(errno));
    return -1;
  }

  if (connection_set_nonblocking(sock) < 0) {
    logger(LOG_ERROR, "FCC: Failed to set %s socket non-blocking: %s", label, strerror(errno));
    close(sock);
    return -1;
  }

  if (set_socket_rcvbuf(sock, config.udp_rcvbuf_size) < 0) {
    logger(LOG_WARN, "FCC: Failed to set %s SO_RCVBUF to %d: %s", label, config.udp_rcvbuf_size, strerror(errno));
  }

  bind_to_upstream_interface(sock, upstream_if);

  return sock;
}

typedef int (*fcc_bind_port_fn)(int port, void *opaque);

typedef struct {
  int sock;
  struct sockaddr_in *sin;
} fcc_single_bind_attempt_t;

typedef struct {
  stream_context_t *ctx;
  const char *upstream_if;
  int media_sock;
  int signal_sock;
} fcc_double_bind_attempt_t;

static int fcc_get_bind_port_range(int paired_port_offset, int *min_port, int *max_port, int *use_ephemeral) {
  if (!min_port || !max_port || !use_ephemeral) {
    return -1;
  }

  *use_ephemeral = 0;
  if (config.fcc_listen_port_min <= 0 || config.fcc_listen_port_max <= 0) {
    if (paired_port_offset == 0) {
      *use_ephemeral = 1;
      *min_port = 0;
      *max_port = 0;
      return 0;
    }

    *min_port = 10000;
    *max_port = 65535;
  } else {
    *min_port = config.fcc_listen_port_min;
    *max_port = config.fcc_listen_port_max;
  }

  if (*max_port < *min_port) {
    int tmp = *min_port;
    *min_port = *max_port;
    *max_port = tmp;
  }

  *max_port -= paired_port_offset;

  int max_allowed = 65535 - paired_port_offset;
  if (*max_port > max_allowed) {
    *max_port = max_allowed;
  }
  if (*min_port < 1) {
    *min_port = 1;
  }

  return *max_port >= *min_port ? 0 : -1;
}

static int fcc_try_bind_port_range(int paired_port_offset, const char *label, fcc_bind_port_fn bind_port,
                                   void *opaque) {
  int min_port;
  int max_port;
  int use_ephemeral;

  if (fcc_get_bind_port_range(paired_port_offset, &min_port, &max_port, &use_ephemeral) < 0) {
    logger(LOG_ERROR, "FCC: Invalid %s port range", label);
    return -1;
  }

  if (use_ephemeral) {
    return bind_port(0, opaque);
  }

  int range = max_port - min_port + 1;
  int start_offset = (int)(get_time_ms() % range);

  for (int i = 0; i < range; i++) {
    int port = min_port + ((start_offset + i) % range);
    int r = bind_port(port, opaque);
    if (r == 0) {
      return 0;
    }
    if (r < -1) {
      return -1;
    }
  }

  logger(LOG_ERROR, "FCC: Unable to bind %s within port range %d-%d", label, min_port, max_port);
  return -1;
}

static int fcc_bind_single_socket_port(int port, void *opaque) {
  fcc_single_bind_attempt_t *attempt = (fcc_single_bind_attempt_t *)opaque;

  attempt->sin->sin_port = htons((uint16_t)port);
  if (bind(attempt->sock, (struct sockaddr *)attempt->sin, sizeof(*attempt->sin)) == 0) {
    if (port != 0) {
      logger(LOG_DEBUG, "FCC: Bound client socket to port %d", port);
    }
    return 0;
  }

  if (errno != EADDRINUSE && errno != EACCES) {
    logger(LOG_DEBUG, "FCC: Failed to bind port %d: %s", port, strerror(errno));
  }
  return -1;
}

static int fcc_register_socket(stream_context_t *ctx, int sock, const char *label) {
  if (poller_add(ctx->epoll_fd, sock, POLLER_IN) < 0) {
    logger(LOG_ERROR, "FCC: Failed to add %s socket to poller: %s", label, strerror(errno));
    return -1;
  }

  fdmap_set(sock, ctx->conn);
  logger(LOG_DEBUG, "FCC: %s socket registered with poller", label);
  return 0;
}

static int fcc_bind_double_socket_port(int media_port, void *opaque) {
  fcc_double_bind_attempt_t *attempt = (fcc_double_bind_attempt_t *)opaque;
  stream_context_t *ctx = attempt->ctx;
  fcc_session_t *fcc = &ctx->fcc;
  service_t *service = ctx->service;
  int signal_port = media_port + 1;

  if (attempt->media_sock < 0) {
    attempt->media_sock = fcc_create_configured_socket(service, attempt->upstream_if, "media");
  }
  if (attempt->media_sock < 0) {
    return -2;
  }

  struct sockaddr_in media_sin;
  memset(&media_sin, 0, sizeof(media_sin));
  media_sin.sin_family = AF_INET;
  media_sin.sin_addr.s_addr = INADDR_ANY;
  media_sin.sin_port = htons((uint16_t)media_port);

  int media_bound = bind(attempt->media_sock, (struct sockaddr *)&media_sin, sizeof(media_sin));
  int media_errno = errno;
  if (media_bound < 0) {
    if (media_errno != EADDRINUSE && media_errno != EACCES) {
      logger(LOG_DEBUG, "FCC: Failed to bind media port %d: %s", media_port, strerror(media_errno));
    }
    return -1;
  }

  if (attempt->signal_sock < 0) {
    attempt->signal_sock = fcc_create_configured_socket(service, attempt->upstream_if, "signal");
  }
  if (attempt->signal_sock < 0) {
    close(attempt->media_sock);
    attempt->media_sock = -1;
    return -2;
  }

  struct sockaddr_in signal_sin;
  memset(&signal_sin, 0, sizeof(signal_sin));
  signal_sin.sin_family = AF_INET;
  signal_sin.sin_addr.s_addr = INADDR_ANY;
  signal_sin.sin_port = htons((uint16_t)signal_port);

  int signal_bound = bind(attempt->signal_sock, (struct sockaddr *)&signal_sin, sizeof(signal_sin));
  int signal_errno = errno;
  if (signal_bound == 0) {
    fcc->media_sock = attempt->media_sock;
    fcc->fcc_sock = attempt->signal_sock;
    attempt->media_sock = -1;
    attempt->signal_sock = -1;
    fcc->fcc_server = (struct sockaddr_in *)(uintptr_t)service->fcc_addr->ai_addr;

    socklen_t media_len = sizeof(fcc->media_client);
    socklen_t signal_len = sizeof(fcc->fcc_client);
    getsockname(fcc->media_sock, (struct sockaddr *)&fcc->media_client, &media_len);
    getsockname(fcc->fcc_sock, (struct sockaddr *)&fcc->fcc_client, &signal_len);

    logger(LOG_DEBUG, "FCC: Bound media socket to port %u, signal socket to port %u", ntohs(fcc->media_client.sin_port),
           ntohs(fcc->fcc_client.sin_port));
    return 0;
  }

  if (signal_errno != EADDRINUSE && signal_errno != EACCES) {
    logger(LOG_DEBUG, "FCC: Failed to bind signal port %d: %s", signal_port, strerror(signal_errno));
  }

  close(attempt->media_sock);
  attempt->media_sock = -1;
  return -1;
}

static int fcc_initialize_double_sockets(stream_context_t *ctx, const char *upstream_if) {
  fcc_session_t *fcc = &ctx->fcc;
  fcc_double_bind_attempt_t attempt = {.ctx = ctx, .upstream_if = upstream_if, .media_sock = -1, .signal_sock = -1};

  if (fcc_try_bind_port_range(1, "media/signal socket pair", fcc_bind_double_socket_port, &attempt) < 0) {
    if (attempt.media_sock >= 0) {
      close(attempt.media_sock);
    }
    if (attempt.signal_sock >= 0) {
      close(attempt.signal_sock);
    }
    return -1;
  }

  if (fcc_register_socket(ctx, fcc->fcc_sock, "signal") < 0) {
    close(fcc->media_sock);
    close(fcc->fcc_sock);
    fcc->media_sock = -1;
    fcc->fcc_sock = -1;
    fcc->fcc_server = NULL;
    return -1;
  }

  if (fcc_register_socket(ctx, fcc->media_sock, "media") < 0) {
    worker_cleanup_socket_from_epoll(ctx->epoll_fd, fcc->fcc_sock);
    close(fcc->media_sock);
    fcc->media_sock = -1;
    fcc->fcc_sock = -1;
    fcc->fcc_server = NULL;
    return -1;
  }

  return 0;
}

ssize_t sendto_triple(int fd, const void *buf, size_t n, int flags, struct sockaddr_in *addr, socklen_t addr_len) {
  static uint8_t i;
  for (i = 0; i < 3; i++) {
    if (sendto(fd, buf, n, flags, (struct sockaddr *)addr, addr_len) < 0) {
      return -1;
    }
  }
  return n;
}

void fcc_session_cleanup(fcc_session_t *fcc, service_t *service, int epoll_fd) {
  if (!fcc || !fcc->initialized) {
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

  /* Close media socket */
  if (fcc->media_sock >= 0) {
    worker_cleanup_socket_from_epoll(epoll_fd, fcc->media_sock);
    fcc->media_sock = -1;
    logger(LOG_DEBUG, "FCC: Media socket closed");
  }

  /* Close FCC socket */
  if (fcc->fcc_sock >= 0) {
    worker_cleanup_socket_from_epoll(epoll_fd, fcc->fcc_sock);
    fcc->fcc_sock = -1;
    logger(LOG_DEBUG, "FCC: Socket closed");
  }

  /* Reset all session state to clean state */
  fcc->state = FCC_STATE_INIT;
  fcc->fcc_server = NULL; /* This was pointing to service memory, safe to NULL */
  fcc->media_port = 0;
  fcc->fcc_term_seqn = 0;
  fcc->fcc_term_sent = 0;

  /* Clear client address structure */
  memset(&fcc->fcc_client, 0, sizeof(fcc->fcc_client));
  memset(&fcc->media_client, 0, sizeof(fcc->media_client));

  /* Mark as not initialized */
  fcc->initialized = 0;
}

int fcc_session_tick(stream_context_t *ctx, int64_t now) {
  fcc_session_t *fcc = &ctx->fcc;

  if (!fcc->initialized || fcc->fcc_sock < 0) {
    return 0;
  }

  int64_t elapsed_ms = now - fcc->last_data_time;

  /* Different timeouts for different FCC states */
  if (fcc->state == FCC_STATE_REQUESTED || fcc->state == FCC_STATE_UNICAST_PENDING) {
    /* Signaling phase - waiting for server response */
    if (elapsed_ms >= FCC_TIMEOUT_SIGNALING_MS) {
      logger(LOG_WARN, "FCC: Server response timeout (%d ms), falling back to multicast", FCC_TIMEOUT_SIGNALING_MS);
      if (fcc->state == FCC_STATE_REQUESTED) {
        fcc_session_set_state(fcc, FCC_STATE_MCAST_ACTIVE, "Signaling timeout");
      } else {
        fcc_session_set_state(fcc, FCC_STATE_MCAST_ACTIVE, "First unicast packet timeout");
      }
      mcast_session_join(&ctx->mcast, ctx);
    }
  } else if (fcc->state == FCC_STATE_UNICAST_ACTIVE || fcc->state == FCC_STATE_MCAST_REQUESTED) {
    /* Already receiving unicast, check for stream interruption */
    int timeout_ms = (int)(FCC_TIMEOUT_UNICAST_SEC * 1000);

    if (elapsed_ms >= timeout_ms) {
      logger(LOG_WARN,
             "FCC: Unicast stream interrupted (%.1f seconds), falling back "
             "to multicast",
             FCC_TIMEOUT_UNICAST_SEC);
      fcc_session_set_state(fcc, FCC_STATE_MCAST_ACTIVE, "Unicast interrupted");
      mcast_session_join(&ctx->mcast, ctx);
    }

    /* Check if we've been waiting too long for sync notification */
    if (fcc->state == FCC_STATE_UNICAST_ACTIVE && fcc->unicast_start_time > 0) {
      int64_t unicast_duration_ms = now - fcc->unicast_start_time;
      int64_t sync_wait_timeout_ms = (int64_t)(FCC_TIMEOUT_SYNC_WAIT_SEC * 1000);

      if (unicast_duration_ms >= sync_wait_timeout_ms) {
        fcc_handle_sync_notification(ctx, FCC_TIMEOUT_SYNC_WAIT_SEC * 1000);
      }
    }
  }

  return 0;
}

static bool is_rtcp_packet(const uint8_t *data, size_t len) {
  if (!data || len < 8) {
    return false;
  }

  uint8_t version = (data[0] >> 6) & 0x03;
  if (version != 2) {
    return false;
  }

  uint8_t payload_type = data[1];
  if (payload_type < 200 || payload_type > 211) {
    return false;
  }

  uint16_t length_words = ((uint16_t)data[2] << 8) | data[3];
  size_t packet_len = (size_t)(length_words + 1) * 4;

  return packet_len > 0 && packet_len <= len;
}

int fcc_handle_socket_event(stream_context_t *ctx, int fd, int64_t now) {
  fcc_session_t *fcc = &ctx->fcc;
  int recv_sock = fd;

  if (recv_sock < 0) {
    return 0;
  }

  /* Drain all available packets for edge-triggered pollers (epoll EPOLLET / kqueue EV_CLEAR)
   * where the read event fires only once per data arrival. */
  for (;;) {
    struct sockaddr_in peer_addr;
    socklen_t slen = sizeof(peer_addr);

    /* Allocate a fresh buffer from pool for this receive operation */
    buffer_ref_t *recv_buf = buffer_pool_alloc();
    if (!recv_buf) {
      /* Buffer pool exhausted - drop this packet */
      logger(LOG_DEBUG, "FCC: Buffer pool exhausted, dropping packet");
      fcc->last_data_time = now;
      /* Drain the socket to prevent event loop spinning */
      uint8_t dummy[BUFFER_POOL_BUFFER_SIZE];
      recvfrom(recv_sock, dummy, sizeof(dummy), 0, NULL, NULL);
      return 0;
    }

    /* Receive directly into zero-copy buffer (true zero-copy receive) */
    int actualr = recvfrom(recv_sock, recv_buf->data, BUFFER_POOL_BUFFER_SIZE, 0, (struct sockaddr *)&peer_addr, &slen);
    if (actualr < 0) {
      buffer_ref_put(recv_buf);
      if (errno != EAGAIN)
        logger(LOG_ERROR, "FCC: Receive failed: %s", strerror(errno));
      break; /* No more data available */
    }

    /* Verify packet comes from expected FCC server */
    if (fcc->verify_server_ip && peer_addr.sin_addr.s_addr != fcc->fcc_server->sin_addr.s_addr) {
      buffer_ref_put(recv_buf);
      continue; /* Skip and read next packet */
    }

    fcc->last_data_time = now;
    recv_buf->data_size = (size_t)actualr;

    /* Handle different types of FCC packets */
    uint8_t *recv_data = (uint8_t *)recv_buf->data;
    int result = 0;
    if (is_rtcp_packet(recv_data, (size_t)actualr)) {
      /* RTCP control message from FCC server */
      int res = fcc_handle_server_response(ctx, recv_data, actualr);
      if (res == 1) {
        /* FCC redirect - retry request with new server */
        if (fcc_initialize_and_request(ctx) < 0) {
          logger(LOG_ERROR, "FCC redirect retry failed");
          buffer_ref_put(recv_buf);
          return -1;
        }
        buffer_ref_put(recv_buf);
        return 0; /* Redirect handled successfully */
      }
      result = res;
    } else {
      /* RTP media packet from FCC unicast stream */
      result = fcc_handle_unicast_media(ctx, recv_buf);
    }

    /* Release our reference to the buffer */
    buffer_ref_put(recv_buf);

    if (result != 0)
      return result;
  }

  return 0;
}

/*
 * FCC Logging Functions
 */
static void log_fcc_state_transition(fcc_state_t from, fcc_state_t to, const char *reason) {
  const char *state_names[] = {"INIT",         "REQUESTED", "UNICAST_PENDING", "UNICAST_ACTIVE", "MCAST_REQUESTED",
                               "MCAST_ACTIVE", "ERROR"};
  logger(LOG_DEBUG, "FCC State: %s -> %s (%s)", state_names[from], state_names[to], reason ? reason : "");
}

/*
 * FCC Session Management Functions
 */
void fcc_session_init(fcc_session_t *fcc) {
  memset(fcc, 0, sizeof(fcc_session_t));
  fcc->initialized = 1;
  fcc->state = FCC_STATE_INIT;
  fcc->fcc_sock = -1;
  fcc->media_sock = -1;
  fcc->status_index = -1;
  fcc->redirect_count = 0;
}

int fcc_session_set_state(fcc_session_t *fcc, fcc_state_t new_state, const char *reason) {
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

  /* Update client status immediately */
  if (new_state < ARRAY_SIZE(fcc_to_client_state)) {
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
int fcc_initialize_and_request(stream_context_t *ctx) {
  fcc_session_t *fcc = &ctx->fcc;
  service_t *service = ctx->service;
  struct sockaddr_in sin;
  socklen_t slen;
  int r;
  const char *upstream_if;

  logger(LOG_DEBUG, "FCC: Initializing FCC session and sending request");

  if (fcc->fcc_sock < 0) {
    upstream_if = get_upstream_interface_for_fcc(service->ifname, service->ifname_fcc);

    if (fcc->type == FCC_TYPE_HUAWEI) {
      if (fcc_initialize_double_sockets(ctx, upstream_if) < 0) {
        logger(LOG_ERROR, "FCC (Huawei): Cannot bind media/signal socket pair");
        return -1;
      }
    } else {
      /* Create and configure FCC socket */
      fcc->fcc_sock = fcc_create_configured_socket(service, upstream_if, "client");
      if (fcc->fcc_sock < 0) {
        return -1;
      }

      /* Bind to configured or ephemeral port */
      memset(&sin, 0, sizeof(sin));
      sin.sin_family = AF_INET;
      sin.sin_addr.s_addr = INADDR_ANY;
      fcc_single_bind_attempt_t bind_attempt = {.sock = fcc->fcc_sock, .sin = &sin};
      if (fcc_try_bind_port_range(0, "client socket", fcc_bind_single_socket_port, &bind_attempt) != 0) {
        logger(LOG_ERROR, "FCC: Cannot bind socket within configured range");
        close(fcc->fcc_sock);
        fcc->fcc_sock = -1;
        return -1;
      }

      /* Get the assigned local address */
      slen = sizeof(fcc->fcc_client);
      getsockname(fcc->fcc_sock, (struct sockaddr *)&fcc->fcc_client, &slen);

      fcc->fcc_server = (struct sockaddr_in *)(uintptr_t)service->fcc_addr->ai_addr;

      /* Register socket with poller immediately after creation */
      if (fcc_register_socket(ctx, fcc->fcc_sock, "client") < 0) {
        close(fcc->fcc_sock);
        fcc->fcc_sock = -1;
        return -1;
      }
    }
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

  fcc->last_data_time = get_time_ms();
  fcc_session_set_state(fcc, FCC_STATE_REQUESTED, "Request sent");

  return 0;
}

/*
 * FCC Protocol Stage 2: Handle server response
 * Dispatches to vendor-specific handler based on FCC type
 */
int fcc_handle_server_response(stream_context_t *ctx, uint8_t *buf, int buf_len) {
  fcc_session_t *fcc = &ctx->fcc;

  /* Dispatch to vendor-specific handler based on FCC type */
  if (fcc->type == FCC_TYPE_HUAWEI) {
    return fcc_huawei_handle_server_response(ctx, buf, buf_len);
  } else if (fcc->type == FCC_TYPE_TELECOM) {
    return fcc_telecom_handle_server_response(ctx, buf, buf_len);
  }

  return 0;
}

/*
 * FCC Protocol Stage 3: Handle synchronization notification (FMT 4)
 */
int fcc_handle_sync_notification(stream_context_t *ctx, int timeout_ms) {
  fcc_session_t *fcc = &ctx->fcc;

  // Ignore if already using mcast stream
  if (fcc->state == FCC_STATE_MCAST_REQUESTED || fcc->state == FCC_STATE_MCAST_ACTIVE)
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
                        timeout_ms ? "Sync notification timeout" : "Sync notification received");

  mcast_session_join(&ctx->mcast, ctx);

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
    fcc_session_set_state(fcc, FCC_STATE_UNICAST_ACTIVE, "First unicast packet received");
    logger(LOG_INFO, "FCC: Unicast stream started successfully");
  }

  /* Forward RTP payload to client (with reordering) */
  stream_process_rtp_payload(ctx, buf_ref);

  /* Check if we should terminate FCC based on reorder's delivered sequence.
   * base_seq - 1 is the last sequence number successfully delivered.
   * Only check when reorder is in active phase (phase == 2). */
  if (fcc->fcc_term_sent && ctx->reorder.phase == 2 && fcc->state != FCC_STATE_MCAST_ACTIVE) {
    uint16_t last_delivered = ctx->reorder.base_seq - 1;
    if ((int16_t)(last_delivered - (fcc->fcc_term_seqn - 1)) >= 0) {
      logger(LOG_INFO, "FCC: Switching to multicast stream (reached termination sequence)");
      fcc_session_set_state(fcc, FCC_STATE_MCAST_ACTIVE, "Reached termination sequence");
    }
  }

  return 0;
}

/*
 * Internal helper: Send FCC termination packet to server
 */
static int fcc_send_term_packet(fcc_session_t *fcc, service_t *service, uint16_t seqn, const char *reason) {
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
static int fcc_send_termination_message(stream_context_t *ctx, uint16_t mcast_seqn) {
  fcc_session_t *fcc = &ctx->fcc;

  if (!fcc->fcc_term_sent) {
    fcc->fcc_term_seqn = mcast_seqn;
    if (fcc_send_term_packet(fcc, ctx->service, fcc->fcc_term_seqn + 2, "normal flow") == 0) {
      fcc->fcc_term_sent = 1;
      logger(LOG_DEBUG, "FCC: Normal termination message sent, term_seqn=%u (+2)", mcast_seqn);
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

  is_rtp = rtp_get_payload(data_ptr, buf_ref->data_size, &payload, &payloadlength, &seqn);
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
      int processed_bytes = stream_process_rtp_payload(ctx, node);
      if (likely(processed_bytes > 0)) {
        flushed_bytes += (uint64_t)processed_bytes;
      }
      buffer_ref_put(node);
      node = next;
    }

    /* All buffers flushed successfully */
    fcc->pending_list_head = NULL;
    fcc->pending_list_tail = NULL;

    logger(LOG_DEBUG, "FCC: Flushed pending buffer chain, total_flushed_bytes=%" PRIu64, flushed_bytes);
  }

  /* Forward multicast data to client (true zero-copy) or capture I-frame
   * (snapshot) */
  stream_process_rtp_payload(ctx, buf_ref);

  return 0;
}
