#include "rtp_reorder.h"
#include "connection.h"
#include "rtp.h"
#include "snapshot.h"
#include "stream.h"
#include "utils.h"
#include <string.h>

void rtp_reorder_init(rtp_reorder_t *r) { memset(r, 0, sizeof(*r)); }

void rtp_reorder_cleanup(rtp_reorder_t *r) {
  int pending = 0;
  for (int i = 0; i < RTP_REORDER_WINDOW_SIZE; i++) {
    if (r->slots[i]) {
      buffer_ref_put(r->slots[i]);
      r->slots[i] = NULL;
      pending++;
    }
  }
  if (pending > 0) {
    logger(LOG_DEBUG,
           "RTP reorder: Cleanup discarded %d pending packets (base_seq=%u)",
           pending, r->base_seq);
  }
  r->count = 0;
  r->initialized = 0;
}

/* Deliver single packet */
static int deliver_packet(buffer_ref_t *buf, connection_t *conn,
                          int is_snapshot) {
  if (is_snapshot) {
    return snapshot_process_packet(&conn->stream.snapshot, buf->data_size,
                                   (uint8_t *)buf->data + buf->data_offset,
                                   conn);
  }
  return rtp_queue_buf_direct(conn, buf);
}

/* Flush consecutive packets, stop at hole
 * log_recovery: if true, log "Recovered" message (for Phase 2 reordering) */
static int flush_consecutive(rtp_reorder_t *r, connection_t *conn,
                             int is_snapshot, int log_recovery) {
  int total_bytes = 0;
  int flushed = 0;
  uint16_t start_seq = r->base_seq;

  while (r->count > 0) {
    int slot = r->base_seq & RTP_REORDER_WINDOW_MASK;
    buffer_ref_t *buf = r->slots[slot];

    if (!buf)
      break; /* Hole, stop */

    int bytes = deliver_packet(buf, conn, is_snapshot);
    if (bytes > 0)
      total_bytes += bytes;

    buffer_ref_put(buf);
    r->slots[slot] = NULL;
    r->base_seq++;
    r->count--;
    flushed++;
  }

  if (log_recovery && flushed > 0) {
    logger(LOG_DEBUG,
           "RTP reorder: Recovered %d out-of-order packets (seq %u-%u)", flushed,
           start_seq, (uint16_t)(r->base_seq - 1));
  }

  return total_bytes;
}

/* Force flush to make room */
static int force_flush_until(rtp_reorder_t *r, uint16_t target_seq,
                             connection_t *conn, int is_snapshot) {
  int total_bytes = 0;
  int lost_count = 0;
  uint16_t start_seq = r->base_seq;

  while ((int16_t)(target_seq - r->base_seq) >= RTP_REORDER_WINDOW_SIZE) {
    int slot = r->base_seq & RTP_REORDER_WINDOW_MASK;
    buffer_ref_t *buf = r->slots[slot];

    if (buf) {
      int bytes = deliver_packet(buf, conn, is_snapshot);
      if (bytes > 0)
        total_bytes += bytes;
      buffer_ref_put(buf);
      r->slots[slot] = NULL;
      r->count--;
    } else {
      lost_count++;
    }

    r->base_seq++;
  }

  if (lost_count > 0) {
    logger(LOG_DEBUG, "RTP reorder: Packet loss at seq %u (target=%u)",
           start_seq, target_seq);
  }

  return total_bytes;
}

int rtp_reorder_insert(rtp_reorder_t *r, buffer_ref_t *buf_ref, uint16_t seqn,
                       connection_t *conn, int is_snapshot) {
  int total_bytes = 0;

  /* Phase 0: First packet - start collecting */
  if (unlikely(r->initialized == 0)) {
    r->base_seq = seqn; /* Remember first seq as reference */
    r->initialized = 1; /* Enter collecting phase */

    /* Store first packet */
    int slot = seqn & RTP_REORDER_WINDOW_MASK;
    buffer_ref_get(buf_ref);
    r->slots[slot] = buf_ref;
    r->count = 1;
    return 0;
  }

  /* Phase 1: Collecting initial packets
   * base_seq dynamically tracks the minimum sequence seen so far */
  if (unlikely(r->initialized == 1)) {
    int slot = seqn & RTP_REORDER_WINDOW_MASK;

    if (!r->slots[slot]) {
      buffer_ref_get(buf_ref);
      r->slots[slot] = buf_ref;
      r->count++;

      /* Update min_seq: if this packet is earlier than current base_seq */
      if ((int16_t)(seqn - r->base_seq) < 0) {
        r->base_seq = seqn;
      }
    }

    /* Collected enough? Start delivering from base_seq */
    if (r->count >= RTP_REORDER_INIT_COLLECT) {
      r->initialized = 2; /* Enter active phase */

      logger(LOG_DEBUG,
             "RTP reorder: Init complete, base_seq=%u (%d packets collected)",
             r->base_seq, r->count);

      /* Flush consecutive from base_seq (already the minimum)
       * Don't log "Recovered" - this is normal init, not reordering */
      total_bytes += flush_consecutive(r, conn, is_snapshot, 0);
    }
    return total_bytes;
  }

  /* Phase 2: Active reordering (initialized == 2) */
  int16_t seq_diff = (int16_t)(seqn - r->base_seq);

  /* Case 1: Expected sequence -> immediate delivery */
  if (likely(seq_diff == 0)) {
    int bytes = deliver_packet(buf_ref, conn, is_snapshot);
    if (bytes > 0)
      total_bytes = bytes;
    r->base_seq++;

    total_bytes += flush_consecutive(r, conn, is_snapshot, 1);
    return total_bytes;
  }

  /* Case 2: Late/duplicate packet -> drop */
  if (seq_diff < 0) {
    logger(LOG_DEBUG, "RTP reorder: Late packet dropped (seq=%u, base=%u)",
           seqn, r->base_seq);
    return 0;
  }

  /* Case 3: Beyond window -> force flush */
  if (seq_diff >= RTP_REORDER_WINDOW_SIZE) {
    total_bytes += force_flush_until(r, seqn, conn, is_snapshot);
  }

  /* Store in slot */
  int slot = seqn & RTP_REORDER_WINDOW_MASK;
  if (r->slots[slot]) {
    /* Slot occupied - duplicate packet, silently drop.
     * This is normal in some network environments where upstream devices
     * send redundant packets for reliability. */
    return total_bytes;
  }

  buffer_ref_get(buf_ref);
  r->slots[slot] = buf_ref;
  r->count++;

  return total_bytes;
}
