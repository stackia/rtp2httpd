#ifndef RTP_REORDER_H
#define RTP_REORDER_H

#include "buffer_pool.h"
#include <stdint.h>

#define RTP_REORDER_WINDOW_SIZE 64
#define RTP_REORDER_WINDOW_MASK 63 /* Fast modulo: seq & MASK */

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

typedef struct rtp_reorder_s
{
  buffer_ref_t *slots[RTP_REORDER_WINDOW_SIZE];
  uint16_t base_seq;
  uint8_t initialized; /* 0=not init, 1=collecting, 2=active */
  uint8_t count;
} rtp_reorder_t;

void rtp_reorder_init(rtp_reorder_t *r);
void rtp_reorder_cleanup(rtp_reorder_t *r);

/**
 * Process RTP packet with reordering
 * @param r Reorder context
 * @param buf_ref Buffer reference (already pointing to RTP payload)
 * @param seqn RTP sequence number
 * @param conn Connection object for delivery
 * @param is_snapshot Whether in snapshot mode
 * @return Total bytes delivered, -1 on error
 */
int rtp_reorder_insert(rtp_reorder_t *r, buffer_ref_t *buf_ref, uint16_t seqn,
                       connection_t *conn, int is_snapshot);

#endif /* RTP_REORDER_H */
