#ifndef SNAPSHOT_H
#define SNAPSHOT_H

#include <stdint.h>
#include <sys/types.h>

/* Forward declarations */
typedef struct connection_s connection_t;

/**
 * Snapshot context - encapsulates all state for snapshot mode
 */
typedef struct snapshot_context_s {
  int enabled; /* 1 if this is a snapshot request, 0 for normal streaming */
  int fallback_to_streaming; /* 1 if snapshot failed and we should fallback to
                                normal streaming */
  int idr_frame_fd;          /* tmpfs mmap file descriptor for IDR frame data */
  uint8_t *idr_frame_mmap;   /* mmap'd region for IDR frame accumulation */
  size_t idr_frame_size;     /* Current size of accumulated IDR frame data */
  size_t idr_frame_capacity; /* Capacity of mmap'd buffer (2MB) */
  int idr_frame_complete;    /* 1 if complete IDR frame captured, 0 otherwise */
  int idr_frame_started;     /* 1 if IDR frame detection confirmed, 0 if still
                                probing */
  uint16_t video_pid;        /* PID of the video stream containing IDR frame */
  int64_t start_time;        /* Snapshot request start time for timeout */

  /* PAT/PMT caching - stored in first 376 bytes of idr_frame_mmap */
  int has_pat;           /* 1 if PAT packet cached in mmap[0..187] */
  int has_pmt;           /* 1 if PMT packet cached in mmap[188..375] */
  uint16_t pmt_pid;      /* PID of PMT (extracted from PAT) */
  size_t ts_header_size; /* Size of PAT+PMT headers (0, 188, or 376 bytes) */
} snapshot_context_t;

/**
 * Initialize snapshot context and allocate resources
 * @param ctx Snapshot context to initialize
 * @return 0 on success, -1 on error
 */
int snapshot_init(snapshot_context_t *ctx);

/**
 * Free snapshot context and release resources
 * @param ctx Snapshot context to free
 */
void snapshot_free(snapshot_context_t *ctx);

/**
 * Process RTP payload for snapshot mode
 * Detects and accumulates IDR frame TS packets, then converts to JPEG and sends
 * to client
 * @param ctx Snapshot context
 * @param recv_len Length of received packet
 * @param buf Buffer containing packet data
 * @param conn Connection
 * @return 0 on success, -1 on error
 */
int snapshot_process_packet(snapshot_context_t *ctx, int recv_len, uint8_t *buf,
                            connection_t *conn);

/**
 * Fallback to normal streaming mode
 * Sends normal streaming headers and frees snapshot context
 * @param ctx Snapshot context
 * @param conn Connection
 */
void snapshot_fallback_to_streaming(snapshot_context_t *ctx,
                                    connection_t *conn);

#endif /* SNAPSHOT_H */
