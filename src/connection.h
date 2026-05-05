#ifndef CONNECTION_H
#define CONNECTION_H

#include "http.h"
#include "service.h"
#include "stream.h"
#include "zerocopy.h"
#include <stdint.h>
#include <sys/types.h>

/* Per-connection HTTP state (unified event-driven within each worker) */
typedef enum {
  CONN_READ_REQ_LINE = 0,
  CONN_READ_HEADERS,
  CONN_ROUTE,
  CONN_SSE,
  CONN_STREAMING,
  CONN_CLOSING
} conn_state_t;

#define INBUF_SIZE 8192

typedef enum { CONNECTION_BUFFER_CONTROL = 0, CONNECTION_BUFFER_MEDIA = 1 } connection_buffer_class_t;

typedef struct connection_s {
  int fd;
  int epfd;
  conn_state_t state;
  /* input parsing */
  char inbuf[INBUF_SIZE];
  int in_len;
  /* zero-copy send queue - all output goes through this */
  zerocopy_queue_t zc_queue;
  int zerocopy_enabled; /* Whether SO_ZEROCOPY is enabled on this socket */
  connection_buffer_class_t buffer_class;
  /* HTTP request parser */
  http_request_t http_req;
  int headers_sent; /* Track whether HTTP response headers have been sent */
  /* service/stream */
  service_t *service;
  stream_context_t stream;
  int streaming;
  /* SSE */
  int64_t next_sse_ts; /* Next SSE heartbeat time in milliseconds */
  int sse_sent_initial;
  int sse_last_write_index;
  int sse_last_log_count;
  /* status tracking */
  int status_index; /* Index in status_shared->clients array, -1 if not
                       registered */
  /* client address for status tracking (only used for streaming clients) */
  struct sockaddr_storage client_addr;
  socklen_t client_addr_len;
  /* linkage */
  struct connection_s *next;
  struct connection_s *write_queue_next;
  int write_queue_pending;

  /* Backpressure and monitoring */
  size_t queue_limit_bytes;
  size_t queue_bytes_highwater;
  size_t queue_buffers_highwater;
  uint64_t dropped_packets;
  uint64_t dropped_bytes;
  /* Number of times an upstream TCP session attached to this connection paused
   * its reads due to client-side backpressure (HWM crossed).  Pure pause
   * counter — has no relation to dropped_packets.  UDP paths never increment
   * this since they don't pause; their congestion shows up in dropped_packets. */
  uint32_t backpressure_events;
  int stream_registered;
  double queue_avg_bytes;
  int slow_active;
  int64_t slow_candidate_since;
  /* Set when any TCP upstream session attached to this connection has paused
   * its reads due to client-side backpressure.  Lets the per-write notify
   * fast-path skip cheaply when no upstream is paused (the common case). */
  int any_upstream_paused;
  /* r2h-token Set-Cookie flag: set cookie when token was provided via URL
     query */
  int should_set_r2h_cookie;
} connection_t;

typedef enum {
  CONNECTION_WRITE_IDLE = 0,
  CONNECTION_WRITE_PENDING,
  CONNECTION_WRITE_BLOCKED,
  CONNECTION_WRITE_CLOSED
} connection_write_status_t;

/**
 * Create a new connection structure
 * @param fd Client socket file descriptor
 * @param epfd epoll file descriptor
 * @param client_addr Client address structure (for status tracking)
 * @param addr_len Address structure length
 * @return Pointer to new connection or NULL on failure
 */
connection_t *connection_create(int fd, int epfd, struct sockaddr_storage *client_addr, socklen_t addr_len);

/**
 * Cleanup a connection and all associated resources
 * @param c Connection to cleanup
 */
void connection_cleanup(connection_t *c);

/**
 * Handle read event on client connection
 * @param c Connection
 */
void connection_handle_read(connection_t *c);

/**
 * Handle write event on client connection
 * @param c Connection
 */
connection_write_status_t connection_handle_write(connection_t *c);

/**
 * Route HTTP request and start appropriate handler
 * @param c Connection
 * @return 0 on success, -1 on error
 */
int connection_route_and_start(connection_t *c);

/**
 * Set socket to non-blocking mode
 * @param fd File descriptor
 * @return 0 on success, -1 on error
 */
int connection_set_nonblocking(int fd);

/**
 * Set TCP_NODELAY on socket
 * @param fd File descriptor
 * @return 0 on success, -1 on error
 */
int connection_set_tcp_nodelay(int fd);

/**
 * Update epoll events for a file descriptor
 * @param epfd epoll file descriptor
 * @param fd File descriptor to update
 * @param events New event mask
 */
void connection_epoll_update_events(int epfd, int fd, uint32_t events);

/**
 * Queue data to connection output buffer for reliable delivery
 * Data will be sent via connection_handle_write() with proper flow control
 * @param c Connection
 * @param data Data to send
 * @param len Length of data
 * @return 0 on success, -1 if buffer full
 */
int connection_queue_output(connection_t *c, const uint8_t *data, size_t len);

/**
 * Queue data to connection output buffer and flush immediately
 * Data will be sent via connection_handle_write() with proper flow control
 * Set connection state to CONN_CLOSING after queueing
 * @param c Connection
 * @param data Data to send
 * @param len Length of data
 * @return 0 on success, -1 if buffer full
 */
int connection_queue_output_and_flush(connection_t *c, const uint8_t *data, size_t len);

/**
 * Queue data for zero-copy send (no memcpy)
 * Takes ownership of the buffer via reference counting
 * @param c Connection
 * @param buf_ref Buffer reference (must not be NULL)
 * @return 0 on success, -1 if queue full or invalid parameters
 */
int connection_queue_zerocopy(connection_t *c, buffer_ref_t *buf_ref);

/**
 * Queue a file descriptor for zero-copy send using sendfile()
 * Takes ownership of the file descriptor (will close it when done)
 * @param c Connection
 * @param file_fd File descriptor to send (must be seekable)
 * @param file_offset Starting offset in file
 * @param file_size Number of bytes to send from file
 * @return 0 on success, -1 on error
 */
int connection_queue_file(connection_t *c, int file_fd, off_t file_offset, size_t file_size);

/* Slot-equivalent bytes currently queued (each pending buffer counts as a full
 * BUFFER_POOL_BUFFER_SIZE slot, matching the unit used by queue_limit_bytes). */
static inline size_t connection_queue_bytes(const connection_t *c) {
  return c->zc_queue.num_queued * BUFFER_POOL_BUFFER_SIZE;
}

/* Record one upstream-pause edge.  Called by per-transport pause helpers
 * (http_proxy_pause_upstream, rtsp_pause_upstream) on the 0->1 transition. */
static inline void connection_record_pause(connection_t *c) {
  if (c)
    c->backpressure_events++;
}

/**
 * Returns true when the client send queue has reached the HWM and upstream
 * reads should be paused.  Refreshes c->queue_limit_bytes from current pool
 * state when the queue rises above the absolute-minimum-limit fast-path
 * threshold, so the decision uses fresh inputs (active stream count, pool
 * utilization) rather than whatever was cached at the last enqueue.
 */
int connection_should_pause_upstream(connection_t *c);

/**
 * Returns true when the client send queue has fallen back below the LWM and
 * paused upstream reads should be resumed.  Refreshes c->queue_limit_bytes
 * before deciding for the same reason as the pause helper.
 */
int connection_can_resume_upstream(connection_t *c);

/**
 * Recompute the connection-level `any_upstream_paused` bit by inspecting all
 * attached upstream sessions.  Call after any individual upstream session
 * toggles its own `upstream_paused` flag so the cheap per-write fast path in
 * stream_on_client_drain() stays accurate.
 */
void connection_recompute_any_upstream_paused(connection_t *c);

/**
 * Mark the connection for orderly shutdown after upstream EOF/error: switch
 * to CONN_CLOSING and re-arm the full event mask so the worker keeps draining
 * any queued bytes to the client before tearing down.  No-op if the
 * connection is already CONN_CLOSING.
 */
void connection_begin_drain_close(connection_t *c);

#endif /* CONNECTION_H */
