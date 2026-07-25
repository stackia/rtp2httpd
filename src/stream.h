#ifndef __STREAM_H__
#define __STREAM_H__

#include "fcc.h"
#include "http_proxy.h"
#include "multicast.h"
#include "rtp_fec.h"
#include "rtp_reorder.h"
#include "rtsp.h"
#include "service.h"
#include "snapshot.h"

/* Multicast stream timeout (seconds) - if no data received for this duration,
 * close connection */
#define MCAST_TIMEOUT_SEC 1

/* Snapshot timeout (seconds) - if no I-frame received for this duration,
 * fallback to streaming */
#define SNAPSHOT_TIMEOUT_SEC 2

#define STREAM_PLAYBACK_RANGE_SIZE 256

/* Return values of stream_handle_fd_event() / rtsp_handle_socket_event(). */
#define STREAM_EVENT_OK 0
#define STREAM_EVENT_CLOSE (-1)
#define STREAM_EVENT_DURATION_READY (-2)
#define STREAM_EVENT_METADATA_READY (-3)

/* RTSP handshake stages a metadata field can be learned from.  Used to forget
 * the right subset when a stage is retried (auth) or replayed against another
 * server (redirect). */
#define STREAM_METADATA_STAGE_DESCRIBE 0x1u
#define STREAM_METADATA_STAGE_SETUP 0x2u
#define STREAM_METADATA_STAGE_PLAY 0x4u
#define STREAM_METADATA_STAGE_ALL                                                                                      \
  (STREAM_METADATA_STAGE_DESCRIBE | STREAM_METADATA_STAGE_SETUP | STREAM_METADATA_STAGE_PLAY)

typedef enum {
  STREAM_UPSTREAM_UNKNOWN = 0,
  STREAM_UPSTREAM_RTSP,
  STREAM_UPSTREAM_MULTICAST
} stream_upstream_protocol_t;

typedef enum {
  STREAM_TRANSPORT_UNKNOWN = 0,
  STREAM_TRANSPORT_TCP_INTERLEAVED,
  STREAM_TRANSPORT_UDP
} stream_upstream_transport_t;

typedef enum {
  STREAM_PAYLOAD_UNKNOWN = 0,
  STREAM_PAYLOAD_MP2T_RTP,
  STREAM_PAYLOAD_MP2T_DIRECT
} stream_upstream_payload_t;

typedef enum { STREAM_FCC_TYPE_UNKNOWN = 0, STREAM_FCC_TYPE_TELECOM, STREAM_FCC_TYPE_HUAWEI } stream_fcc_type_t;

typedef enum {
  STREAM_FCC_STATUS_UNKNOWN = 0,
  STREAM_FCC_STATUS_ACTIVE,
  STREAM_FCC_STATUS_FALLBACK
} stream_fcc_status_t;

typedef enum {
  STREAM_MEDIA_ORIGIN_RTSP = 0,
  STREAM_MEDIA_ORIGIN_MULTICAST,
  STREAM_MEDIA_ORIGIN_FCC_UNICAST,
  STREAM_MEDIA_ORIGIN_FCC_MULTICAST
} stream_media_origin_t;

typedef struct stream_metadata_s {
  stream_upstream_protocol_t upstream_protocol;
  stream_upstream_transport_t upstream_transport;
  stream_upstream_payload_t upstream_payload;
  stream_fcc_type_t fcc_type;
  stream_fcc_status_t fcc_status;
  double playback_scale;
  double media_duration;
  char playback_range[STREAM_PLAYBACK_RANGE_SIZE];
  uint8_t playback_scale_known;
  uint8_t media_duration_known;
  uint8_t frozen;
} stream_metadata_t;

/* Stream processing context */
typedef struct stream_context_s {
  int epoll_fd;
  connection_t *conn; /* Pointer to parent connection for output buffering */
  service_t *service;
  int status_index; /* Index in status_shared->clients array for status updates
                     */

  /* Statistics tracking */
  uint64_t total_bytes_sent;
  uint64_t last_bytes_sent;   /* Bytes sent at last bandwidth calculation */
  int64_t last_status_update; /* Last status update time in milliseconds */

  /* Metadata exposed as R2H-* HTTP response headers. */
  stream_metadata_t metadata;

  /* FCC session for Fast Channel Change */
  fcc_session_t fcc;

  /* Multicast session */
  mcast_session_t mcast;

  /* RTSP session for SERVICE_RTSP */
  rtsp_session_t rtsp;

  /* HTTP proxy session for SERVICE_HTTP */
  http_proxy_session_t http_proxy;

  /* RTP reorder context */
  rtp_reorder_t reorder;

  /* FEC context for packet recovery */
  fec_context_t fec;

  /* Snapshot context */
  snapshot_context_t snapshot;
} stream_context_t;

/**
 * Initialize a stream context for integration into a worker's unified epoll
 * loop. Does not block; registers any required media sockets with the provided
 * epoll fd. Client socket is already monitored by worker.c for disconnect
 * detection.
 * @param ctx Stream context to initialize
 * @param conn Parent connection object for output buffering
 * @param service Service configuration
 * @param epoll_fd epoll file descriptor
 * @param status_id Status tracking ID
 * @param is_snapshot 1 if this is a snapshot request, 0 for normal streaming
 * @return 0 on success, -1 on error
 */
int stream_context_init_for_worker(stream_context_t *ctx, connection_t *conn, service_t *service, int epoll_fd,
                                   int status_index, int is_snapshot);

/**
 * Initialize an RTSP control-plane-only HEAD probe.  The probe performs
 * OPTIONS and DESCRIBE but never SETUP or PLAY and allocates no media sockets.
 */
int stream_context_init_rtsp_metadata_probe(stream_context_t *ctx, connection_t *conn, service_t *service,
                                            int epoll_fd);

/**
 * Handle an event-ready fd that belongs to this stream context.
 * @param ctx Stream context
 * @param fd File descriptor that has events
 * @param events Epoll event mask (EPOLLIN, EPOLLOUT, etc.)
 * @param now Current timestamp in milliseconds (from get_time_ms())
 * @return One of the STREAM_EVENT_* codes:
 *   STREAM_EVENT_OK:               continue processing
 *   STREAM_EVENT_CLOSE:            close the connection (error or graceful
 *                                  TEARDOWN complete)
 *   STREAM_EVENT_DURATION_READY:   duration query completed, send response
 *   STREAM_EVENT_METADATA_READY:   RTSP metadata probe completed, send HEAD
 *                                  response to client
 */
int stream_handle_fd_event(stream_context_t *ctx, int fd, uint32_t events, int64_t now);

/**
 * Periodic maintenance: update status, manage timers. Should be called ~1s.
 * @return 0 on success, -1 if connection should be closed (e.g., timeout)
 */
int stream_tick(stream_context_t *ctx, int64_t now);

/**
 * Cleanup all resources owned by the stream context.
 * The parent connection owns and frees the service pointer.
 * @param ctx Stream context to cleanup
 * @return 0 if cleanup completed, 1 if async TEARDOWN in progress (cleanup
 * deferred)
 */
int stream_context_cleanup(stream_context_t *ctx);

/**
 * Process RTP payload with reordering - either forward to client (streaming)
 * or capture I-frame (snapshot)
 * @param ctx Stream context
 * @param buf_ref Buffer reference
 * @return bytes forwarded (>= 0) for streaming, 1 if I-frame captured for
 * snapshot, -1 on error
 */
int stream_process_rtp_payload(stream_context_t *ctx, buffer_ref_t *buf_ref, stream_media_origin_t origin);

/** Initialize static metadata from a parsed service. */
void stream_metadata_init(stream_metadata_t *metadata, const service_t *service);

/**
 * Forget every metadata field learned from the given RTSP handshake stages, so
 * a retried or redirected request cannot report a previous server's answer.
 * @param stages Bitmask of STREAM_METADATA_STAGE_* values.
 */
void stream_metadata_forget(stream_metadata_t *metadata, unsigned stages);

/**
 * Send a successful HTTP response with any known stream metadata appended to
 * extra_headers.  extra_headers may be NULL.
 */
void stream_send_http_headers(connection_t *conn, const char *content_type, const char *extra_headers);

/**
 * Notify that the client send queue has just been drained (some buffers
 * completed sending).  If any TCP-based upstream session attached to this
 * connection is currently paused due to backpressure, this resumes it when
 * the queue has fallen below the low watermark.
 *
 * Called from connection_handle_write after a successful zerocopy_send.
 * The struct must be at least zero-initialized (the embedded stream context
 * in connection_t is via calloc); passing uninitialized stack memory is
 * unsafe — `conn` and the `*.initialized` flags are dereferenced.
 */
void stream_on_client_drain(stream_context_t *ctx);

#endif /* __STREAM_H__ */
