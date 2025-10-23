#ifndef __STREAM_H__
#define __STREAM_H__

#include "rtp2httpd.h"
#include "fcc.h"
#include "rtsp.h"
#include "status.h"
#include "snapshot.h"

/* Multicast stream timeout (seconds) - if no data received for this duration, close connection */
#define MCAST_TIMEOUT_SEC 1

/* Snapshot timeout (seconds) - if no I-frame received for this duration, fallback to streaming */
#define SNAPSHOT_TIMEOUT_SEC 2

/* RTP reordering buffer configuration */
#define RTP_REORDER_BUFFER_SIZE 16  /* Must be power of 2 for efficient modulo */
#define RTP_REORDER_TIMEOUT_MS 30   /* Timeout for waiting out-of-order packets */

/* Stream processing context */
typedef struct stream_context_s
{
  int epoll_fd;
  connection_t *conn; /* Pointer to parent connection for output buffering */
  service_t *service;
  fcc_session_t fcc;
  int mcast_sock;
  rtsp_session_t rtsp; /* RTSP session for SERVICE_RTSP */
  int status_index;    /* Index in status_shared->clients array for status updates */

  /* Statistics tracking */
  uint64_t total_bytes_sent;
  uint64_t last_bytes_sent;   /* Bytes sent at last bandwidth calculation */
  int64_t last_status_update; /* Last status update time in milliseconds */

  /* Stream health monitoring */
  int64_t last_mcast_data_time;   /* Timestamp of last received multicast data in milliseconds */
  int64_t last_fcc_data_time;     /* Timestamp of last received FCC data for timeout detection */
  int64_t last_mcast_rejoin_time; /* Timestamp of last multicast rejoin for periodic refresh */

  /* Snapshot context */
  snapshot_context_t snapshot;

  /* RTP reordering control */
  uint8_t reorder_enabled; /* 0=disabled (e.g. RTSP TCP), 1=enabled */

  /* RTP reordering buffer - ring buffer indexed by sequence number offset */
  buffer_ref_t *reorder_slots[RTP_REORDER_BUFFER_SIZE];
  uint16_t reorder_expected_seqn; /* Next expected sequence number */
  uint16_t reorder_base_seqn;     /* Base sequence number for slot calculation */
  uint8_t reorder_first_packet;   /* 1=haven't received first packet yet */
  uint8_t reorder_waiting;        /* 0=normal sending, 1=waiting for missing packet */
  int64_t reorder_wait_start;     /* Timestamp when waiting started (ms) */

  /* RTP reordering statistics */
  uint64_t reorder_drops;        /* Packets dropped due to buffer full */
  uint64_t reorder_duplicates;   /* Duplicate packets detected */
  uint64_t reorder_out_of_order; /* Out-of-order packets received */
  uint64_t reorder_recovered;    /* Successfully reordered packets */
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
 * @param is_snapshot 1 if this is a snapshot request, 0 for normal streaming
 * @return 0 on success, -1 on error
 */
int stream_context_init_for_worker(stream_context_t *ctx, connection_t *conn, service_t *service,
                                   int epoll_fd, int status_index, int is_snapshot);

/**
 * Handle an event-ready fd that belongs to this stream context.
 * @param ctx Stream context
 * @param fd File descriptor that has events
 * @param events Epoll event mask (EPOLLIN, EPOLLOUT, etc.)
 * @param now Current timestamp in milliseconds (from get_time_ms())
 * Returns -1 on fatal/cleanup, 1 on state-change (e.g. restart), 0 to continue.
 */
int stream_handle_fd_event(stream_context_t *ctx, int fd, uint32_t events, int64_t now);

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

/**
 * Process RTP payload - either forward to client (streaming) or capture I-frame (snapshot)
 * This function should be used instead of rtp_queue_buf() for stream contexts
 * @param ctx Stream context
 * @param buf_ref Buffer reference
 * @param old_seqn Pointer to previous sequence number
 * @param not_first Pointer to first packet flag
 * @return bytes forwarded (>= 0) for streaming, 1 if I-frame captured for snapshot, -1 on error
 */
int stream_process_rtp_payload(stream_context_t *ctx, buffer_ref_t *buf_ref, uint16_t *old_seqn, uint16_t *not_first);

#endif /* __STREAM_H__ */
