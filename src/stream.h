#ifndef __STREAM_H__
#define __STREAM_H__

#include "rtp2httpd.h"
#include "fcc.h"
#include "rtsp.h"
#include "status.h"

/* Forward declaration */
struct connection_s;

/* Multicast stream timeout (seconds) - if no data received for this duration, close connection */
#define MCAST_TIMEOUT_SEC 1

/* Stream processing context */
typedef struct stream_context_s
{
  int epoll_fd;
  struct connection_s *conn; /* Pointer to parent connection for output buffering */
  service_t *service;
  fcc_session_t fcc;
  int mcast_sock;
  rtsp_session_t rtsp; /* RTSP session for SERVICE_RTSP */
  pid_t status_id;     /* Synthetic id used for status updates */

  /* Statistics tracking */
  uint64_t total_bytes_sent;
  uint64_t last_bytes_sent;   /* Bytes sent at last bandwidth calculation */
  int64_t last_status_update; /* Last status update time in milliseconds */

  /* Stream health monitoring */
  int64_t last_mcast_data_time; /* Timestamp of last received multicast data in milliseconds */
  int64_t last_fcc_data_time;   /* Timestamp of last received FCC data for timeout detection */
} stream_context_t;

/**
 * Join a multicast group and reset the timeout timer.
 * This is a wrapper around join_mcast_group() that also resets last_mcast_data_time
 * to prevent false timeout triggers. Should be used instead of join_mcast_group()
 * directly in all stream-related code.
 * @param ctx Stream context
 * @return Socket file descriptor on success, exits on failure
 */
int stream_join_mcast_group(stream_context_t *ctx);

/**
 * Initialize a stream context for integration into a worker's unified epoll loop.
 * Does not block; registers any required media sockets with the provided epoll fd.
 * Client socket is already monitored by worker.c for disconnect detection.
 * @param ctx Stream context to initialize
 * @param conn Parent connection object for output buffering
 * @param service Service configuration
 * @param epoll_fd epoll file descriptor
 * @param status_id Status tracking ID
 * @return 0 on success, -1 on error
 */
int stream_context_init_for_worker(stream_context_t *ctx, struct connection_s *conn, service_t *service,
                                   int epoll_fd, pid_t status_id);

/**
 * Handle an event-ready fd that belongs to this stream context.
 * @param ctx Stream context
 * @param fd File descriptor that has events
 * @param events Epoll event mask (EPOLLIN, EPOLLOUT, etc.)
 * Returns -1 on fatal/cleanup, 1 on state-change (e.g. restart), 0 to continue.
 */
int stream_handle_fd_event(stream_context_t *ctx, int fd, uint32_t events);

/**
 * Periodic maintenance: update status, manage timers. Should be called ~1s.
 * @return 0 on success, -1 if connection should be closed (e.g., timeout)
 */
int stream_tick(stream_context_t *ctx, int64_t now);

/**
 * Cleanup all resources owned by the stream context and free dynamic service.
 * @param ctx Stream context to cleanup
 * @return 0 if cleanup completed, 1 if async TEARDOWN in progress (cleanup deferred)
 */
int stream_context_cleanup(stream_context_t *ctx);

#endif /* __STREAM_H__ */
