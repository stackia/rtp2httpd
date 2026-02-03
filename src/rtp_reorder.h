#ifndef RTP_REORDER_H
#define RTP_REORDER_H

#include "buffer_pool.h"
#include "rtp_fec.h"
#include <stdint.h>

/* Window sizes must be power of 2 for fast modulo (seq & mask) */
#define RTP_REORDER_WINDOW_SIZE_SMALL 32   /* Without FEC: minimal reordering */
#define RTP_REORDER_WINDOW_MASK_SMALL 31
#define RTP_REORDER_WINDOW_SIZE_LARGE 512  /* With FEC: >= max FEC k value (300) + margin */
#define RTP_REORDER_WINDOW_MASK_LARGE 511

/*
 * Number of packets to collect before determining base sequence.
 *
 * Some upstream multicast devices (e.g., Huawei switches) may forward
 * the first packet via software path while subsequent packets go through
 * hardware fast-path, causing the first few packets to arrive out of order.
 * By collecting initial packets before deciding the base sequence, we can
 * properly reorder them and avoid losing important data like TS PAT/PMT.
 *
 * Reference: https://support.huawei.com/enterprise/zh/doc/EDOC1100334292/9ab6bfc1
 */
#define RTP_REORDER_INIT_COLLECT 8

typedef struct stream_context_s stream_context_t;
typedef struct connection_s connection_t;

typedef struct rtp_reorder_s {
  buffer_ref_t **slots;  /* RTP payload buffers (dynamically allocated) */
  uint16_t *seq;         /* Sequence number per slot (dynamically allocated) */
  uint16_t window_size;  /* Current window size (64 or 512) */
  uint16_t window_mask;  /* Fast modulo mask (window_size - 1) */
  uint16_t base_seq;     /* Next expected sequence for delivery */
  uint16_t count;        /* Number of buffered packets */
  uint8_t initialized;   /* Flag: context has been initialized */
  uint8_t phase;         /* 0=not started, 1=collecting, 2=active */
} rtp_reorder_t;

/**
 * Initialize reorder context
 * @param r Reorder context
 * @param use_fec If true, use large window (512) for FEC; otherwise small (64)
 * @return 0 on success, -1 on memory allocation failure
 */
int rtp_reorder_init(rtp_reorder_t *r, int use_fec);
void rtp_reorder_cleanup(rtp_reorder_t *r);

/**
 * Process RTP packet with reordering
 * @param r Reorder context
 * @param buf_ref Buffer reference (already pointing to RTP payload)
 * @param seqn RTP sequence number
 * @param conn Connection object for delivery
 * @param is_snapshot Whether in snapshot mode
 * @param fec FEC context for packet recovery (may be NULL)
 * @return Total bytes delivered, -1 on error
 */
int rtp_reorder_insert(rtp_reorder_t *r, buffer_ref_t *buf_ref, uint16_t seqn,
                       connection_t *conn, int is_snapshot, fec_context_t *fec);

/**
 * Get packet by sequence number (for FEC recovery)
 * @param r Reorder context
 * @param seq Sequence number to look up
 * @return Buffer reference if found and seq matches, NULL otherwise
 */
buffer_ref_t *rtp_reorder_get(rtp_reorder_t *r, uint16_t seq);

/**
 * Release RTP buffers for a specific sequence range
 * Used by FEC to free buffers when a group expires.
 * @param r Reorder context
 * @param begin_seq First sequence number to release
 * @param end_seq Last sequence number to release (inclusive)
 */
void rtp_reorder_release_range(rtp_reorder_t *r, uint16_t begin_seq,
                               uint16_t end_seq);

#endif /* RTP_REORDER_H */
