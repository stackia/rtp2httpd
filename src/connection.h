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

typedef enum {
  CONNECTION_BUFFER_CONTROL = 0,
  CONNECTION_BUFFER_MEDIA = 1
} connection_buffer_class_t;

#define CONNECTION_QUEUE_REPORT_INTERVAL_MS 1000

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
  uint32_t backpressure_events;
  int stream_registered;
  double queue_avg_bytes;
  int slow_active;
  int64_t slow_candidate_since;
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
connection_t *connection_create(int fd, int epfd,
                                struct sockaddr_storage *client_addr,
                                socklen_t addr_len);

/**
 * Free a connection and all associated resources
 * @param c Connection to free
 */
void connection_free(connection_t *c);

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
int connection_queue_output_and_flush(connection_t *c, const uint8_t *data,
                                      size_t len);

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
int connection_queue_file(connection_t *c, int file_fd, off_t file_offset,
                          size_t file_size);

#endif /* CONNECTION_H */
