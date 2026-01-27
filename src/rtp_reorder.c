#include "rtp_reorder.h"
#include "connection.h"
#include "http.h"
#include "rtp.h"
#include "rtp_fec.h"
#include "snapshot.h"
#include "stream.h"
#include "utils.h"
#include <stdlib.h>
#include <string.h>

void rtp_reorder_init(rtp_reorder_t *r) { memset(r, 0, sizeof(*r)); }

void rtp_reorder_cleanup(rtp_reorder_t *r)
{
  for (int i = 0; i < RTP_REORDER_WINDOW_SIZE; i++)
  {
    if (r->slots[i])
    {
      buffer_ref_put(r->slots[i]);
      r->slots[i] = NULL;
    }
  }
  r->count = 0;
  r->initialized = 0;
}

/* Deliver single packet from buffer_ref */
static int deliver_packet(buffer_ref_t *buf, connection_t *conn,
                          int is_snapshot)
{
  if (is_snapshot)
  {
    return snapshot_process_packet(&conn->stream.snapshot, buf->data_size,
                                   (uint8_t *)buf->data + buf->data_offset,
                                   conn);
  }
  return rtp_queue_buf_direct(conn, buf);
}

/* Deliver raw packet data (used for FEC-recovered packets) */
static int deliver_raw_packet(uint8_t *data, int len, connection_t *conn,
                              int is_snapshot)
{
  if (is_snapshot)
  {
    return snapshot_process_packet(&conn->stream.snapshot, len, data, conn);
  }
  /* Send headers lazily on first data packet (same as rtp_queue_buf_direct) */
  if (!conn->headers_sent)
  {
    send_http_headers(conn, STATUS_200, "video/mp2t", NULL);
  }
  return connection_queue_output(conn, data, len) == 0 ? len : -1;
}

/* Flush consecutive packets, stop at hole
 * log_recovery: if true, log "Recovered" message (for Phase 2 reordering)
 * fec: FEC context, if non-NULL and enabled, keep buffer refs for FEC recovery */
static int flush_consecutive(rtp_reorder_t *r, connection_t *conn,
                             int is_snapshot, int log_recovery,
                             fec_context_t *fec)
{
  int total_bytes = 0;
  int flushed = 0;
  uint16_t start_seq = r->base_seq;
  int keep_for_fec = fec && fec_is_enabled(fec);

  while (r->count > 0)
  {
    int slot = r->base_seq & RTP_REORDER_WINDOW_MASK;
    buffer_ref_t *buf = r->slots[slot];

    if (!buf)
      break; /* Hole, stop */

    int bytes = deliver_packet(buf, conn, is_snapshot);
    if (bytes > 0)
      total_bytes += bytes;

    if (keep_for_fec)
    {
      /* FEC enabled: keep buffer in slot for potential FEC recovery.
       * Slot will be overwritten when ring buffer wraps around. */
    }
    else
    {
      /* FEC disabled: release buffer immediately for efficiency */
      buffer_ref_put(buf);
      r->slots[slot] = NULL;
    }
    r->base_seq++;
    r->count--;
    flushed++;
  }

  if (log_recovery && flushed > 1)
  {
    logger(LOG_DEBUG,
           "RTP reorder: Recovered %d out-of-order packets (seq %u-%u)", flushed,
           start_seq, (uint16_t)(r->base_seq - 1));
  }

  /* Release expired FEC groups when base_seq advances past their end_seq.
   * This frees both FEC parity data and RTP buffers that are no longer needed. */
  if (fec && fec->min_end_seq_valid &&
      (int16_t)(r->base_seq - fec->min_end_seq) > 0)
  {
    fec_release_expired_groups(fec, r->base_seq);
  }

  return total_bytes;
}

/* Force flush to make room */
static int force_flush_until(rtp_reorder_t *r, uint16_t target_seq,
                             connection_t *conn, int is_snapshot,
                             fec_context_t *fec)
{
  int total_bytes = 0;
  int lost_count = 0;
  uint16_t start_seq = r->base_seq;

  while ((int16_t)(target_seq - r->base_seq) >= RTP_REORDER_WINDOW_SIZE)
  {
    int slot = r->base_seq & RTP_REORDER_WINDOW_MASK;
    buffer_ref_t *buf = r->slots[slot];

    if (buf)
    {
      int bytes = deliver_packet(buf, conn, is_snapshot);
      if (bytes > 0)
        total_bytes += bytes;
      buffer_ref_put(buf);
      r->slots[slot] = NULL;
      r->count--;
    }
    else
    {
      lost_count++;
    }

    r->base_seq++;
  }

  if (lost_count > 0)
  {
    logger(LOG_DEBUG, "RTP reorder: Packet loss at seq %u (target=%u)",
           start_seq, target_seq);
    /* Update FEC statistics */
    if (fec)
    {
      fec->packets_lost += lost_count;
    }
  }

  return total_bytes;
}

int rtp_reorder_insert(rtp_reorder_t *r, buffer_ref_t *buf_ref, uint16_t seqn,
                       connection_t *conn, int is_snapshot, fec_context_t *fec)
{
  int total_bytes = 0;

  /* Phase 0: First packet - start collecting */
  if (unlikely(r->initialized == 0))
  {
    r->base_seq = seqn; /* Remember first seq as reference */
    r->initialized = 1; /* Enter collecting phase */

    /* Store first packet */
    int slot = seqn & RTP_REORDER_WINDOW_MASK;
    buffer_ref_get(buf_ref);
    r->slots[slot] = buf_ref;
    r->seq[slot] = seqn;
    r->count = 1;
    return 0;
  }

  /* Phase 1: Collecting initial packets
   * base_seq dynamically tracks the minimum sequence seen so far */
  if (unlikely(r->initialized == 1))
  {
    int slot = seqn & RTP_REORDER_WINDOW_MASK;

    if (!r->slots[slot])
    {
      buffer_ref_get(buf_ref);
      r->slots[slot] = buf_ref;
      r->seq[slot] = seqn;
      r->count++;

      /* Update min_seq: if this packet is earlier than current base_seq */
      if ((int16_t)(seqn - r->base_seq) < 0)
      {
        r->base_seq = seqn;
      }
    }

    /* Collected enough? Start delivering from base_seq */
    if (r->count >= RTP_REORDER_INIT_COLLECT)
    {
      r->initialized = 2; /* Enter active phase */

      logger(LOG_DEBUG,
             "RTP reorder: Init complete, base_seq=%u (%d packets collected)",
             r->base_seq, r->count);

      /* Flush consecutive from base_seq (already the minimum)
       * Don't log "Recovered" - this is normal init, not reordering */
      total_bytes += flush_consecutive(r, conn, is_snapshot, 0, fec);
    }
    return total_bytes;
  }

  /* Phase 2: Active reordering (initialized == 2) */
  int16_t seq_diff = (int16_t)(seqn - r->base_seq);

  /* Case 1: Expected sequence -> store and flush */
  if (likely(seq_diff == 0))
  {
    int slot = seqn & RTP_REORDER_WINDOW_MASK;
    if (r->slots[slot])
    {
      /* Old packet from ring wrap-around, release it */
      buffer_ref_put(r->slots[slot]);
    }
    buffer_ref_get(buf_ref);
    r->slots[slot] = buf_ref;
    r->seq[slot] = seqn;
    r->count++;

    /* flush_consecutive will deliver this packet and any following ones */
    return flush_consecutive(r, conn, is_snapshot, 1, fec);
  }

  /* Case 2: Late/duplicate packet -> silently drop */
  if (seq_diff < 0)
  {
    return 0;
  }

  /* Case 3: Beyond window -> force flush */
  if (seq_diff >= RTP_REORDER_WINDOW_SIZE)
  {
    total_bytes += force_flush_until(r, seqn, conn, is_snapshot, fec);
  }

  /* Store in slot */
  int slot = seqn & RTP_REORDER_WINDOW_MASK;
  if (r->slots[slot])
  {
    if (r->seq[slot] == seqn)
    {
      /* Slot occupied by same sequence - duplicate packet, silently drop.
       * This is normal in some network environments where upstream devices
       * send redundant packets for reliability. */
      return total_bytes;
    }
    /* Slot occupied by old packet from previous ring wrap-around (FEC mode).
     * Release old buffer and reuse the slot. */
    buffer_ref_put(r->slots[slot]);
    r->slots[slot] = NULL;
    /* Note: don't decrement count - the old packet was already delivered */
  }

  buffer_ref_get(buf_ref);
  r->slots[slot] = buf_ref;
  r->seq[slot] = seqn;
  r->count++;

  /* Case 4: Try FEC recovery for base_seq (hole detected)
   * Now that this packet is stored, we have more data available for recovery.
   * Try to recover the missing base_seq packet using FEC. */
  if (fec && fec_is_enabled(fec))
  {
    uint8_t *recovered_data = NULL;
    int recovered_len = 0;

    if (fec_attempt_recovery(fec, r->base_seq, &recovered_data,
                             &recovered_len) == 0)
    {
      /* Recovery succeeded! Deliver the recovered packet */
      int bytes = deliver_raw_packet(recovered_data, recovered_len, conn,
                                     is_snapshot);
      if (bytes > 0)
        total_bytes += bytes;
      free(recovered_data);

      /* Advance base_seq past the recovered packet */
      r->base_seq++;

      /* Flush consecutive packets (including the just-stored packet if now
       * consecutive) */
      total_bytes += flush_consecutive(r, conn, is_snapshot, 0, fec);
    }
  }

  return total_bytes;
}

buffer_ref_t *rtp_reorder_get(rtp_reorder_t *r, uint16_t seq)
{
  int slot = seq & RTP_REORDER_WINDOW_MASK;
  if (r->slots[slot] && r->seq[slot] == seq)
  {
    return r->slots[slot];
  }
  return NULL;
}

void rtp_reorder_release_range(rtp_reorder_t *r, uint16_t begin_seq,
                               uint16_t end_seq)
{
  for (uint16_t seq = begin_seq;; seq++)
  {
    int slot = seq & RTP_REORDER_WINDOW_MASK;
    if (r->slots[slot] && r->seq[slot] == seq)
    {
      buffer_ref_put(r->slots[slot]);
      r->slots[slot] = NULL;
    }
    if (seq == end_seq)
      break; /* Handle wrap-around */
  }
}
