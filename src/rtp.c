#ifdef HAVE_CONFIG_H
#include "config.h"
#endif /* HAVE_CONFIG_H */

#include <stdint.h>
#include <string.h>
#include <arpa/inet.h>
#include <sys/socket.h>
#include "rtp.h"
#include "rtp2httpd.h"
#include "connection.h"
#include "zerocopy.h"
#include "stream.h"

/* Forward declarations of static helper functions */
static int rtp_parse_and_cache(buffer_ref_t *buf_ref);
static inline int rtp_seqn_to_slot(uint16_t seqn, uint16_t base_seqn);
static void rtp_flush_consecutive_packets(stream_context_t *ctx);
static void rtp_slide_window(stream_context_t *ctx);
static void rtp_reorder_reset(stream_context_t *ctx, uint16_t new_seqn);

int rtp_get_payload(uint8_t *buf, int recv_len, uint8_t **payload, int *size, uint16_t *seqn)
{
  int payloadstart, payloadlength;
  uint8_t flags;

  /* Check if this is an RTP packet (version 2, minimum size 12 bytes) */
  if (likely(recv_len >= 12) && likely((buf[0] & 0xC0) == 0x80))
  {
    /* RTP packet detected - strip RTP header and return payload */

    /* Extract sequence number if requested */
    if (seqn)
    {
      *seqn = ntohs(*(uint16_t *)(buf + 2));
    }

    /* Cache first byte to reduce memory access */
    flags = buf[0];

    payloadstart = 12;                  /* basic RTP header length */
    payloadstart += (flags & 0x0F) * 4; /*CSRC headers*/

    /* Extension header is uncommon in most RTP streams */
    if (unlikely(flags & 0x10))
    { /*Extension header*/
      /* Validate extension header doesn't exceed packet bounds */
      if (unlikely(payloadstart + 4 > recv_len))
      {
        logger(LOG_DEBUG, "Malformed RTP packet: extension header truncated");
        return -1;
      }
      payloadstart += 4 + 4 * ntohs(*((uint16_t *)(buf + payloadstart + 2)));
    }

    payloadlength = recv_len - payloadstart;

    /* Padding is uncommon in most RTP streams */
    if (unlikely(flags & 0x20))
    { /*Padding*/
      payloadlength -= buf[recv_len - 1];
      /*last octet indicate padding length*/
    }

    /* Validate final payload bounds */
    if (unlikely(payloadlength <= 0) || unlikely(payloadstart + payloadlength > recv_len))
    {
      logger(LOG_DEBUG, "Malformed RTP packet: invalid payload length");
      return -1;
    }

    *payload = buf + payloadstart;
    *size = payloadlength;
    return 1; /* RTP packet */
  }
  else
  {
    /* Not an RTP packet - treat entire packet as payload */
    *payload = buf;
    *size = recv_len;
    return 0; /* Non-RTP packet */
  }
}

int rtp_queue_buf(connection_t *conn, buffer_ref_t *buf_ref, uint16_t *old_seqn, uint16_t *not_first)
{
  /* Ensure packet is parsed */
  int is_rtp = rtp_parse_and_cache(buf_ref);

  if (is_rtp < 0)
  {
    return 0; /* Malformed packet */
  }

  /* RTP packet: perform sequence number tracking */
  if (is_rtp == 1)
  {
    uint16_t seqn = buf_ref->rtp_seqn;

    /* Duplicate detection */
    if (unlikely(*not_first && seqn == *old_seqn))
    {
      logger(LOG_DEBUG, "Duplicated RTP packet (seqn %d)", seqn);
      return 0;
    }

    /* Packet loss detection */
    uint16_t expected = (*old_seqn + 1) & 0xFFFF;
    if (unlikely(*not_first && (seqn != expected)))
    {
      int gap = (int16_t)(seqn - expected);
      logger(LOG_DEBUG, "RTP packet loss - expected %d, got %d (gap: %d)",
             expected, seqn, gap);
    }

    *old_seqn = seqn;
    *not_first = 1;
  }

  /* At this point, data_offset/data_size point to the correct location:
   * - RTP packet: points to payload (adjusted by rtp_parse_and_cache)
   * - Non-RTP packet: points to original data
   */

  if (connection_queue_zerocopy(conn, buf_ref) == 0)
  {
    return buf_ref->data_size;
  }
  else
  {
    return -1; /* Queue full - backpressure */
  }
}

/* ========== RTP Reordering Implementation ========== */

/**
 * Parse RTP packet and cache the result in buffer_ref
 * @return 1=RTP packet, 0=non-RTP packet, -1=malformed
 */
static int rtp_parse_and_cache(buffer_ref_t *buf_ref)
{
  /* Check if already parsed */
  if (buf_ref->rtp_parsed)
  {
    return 1; /* Already parsed as RTP packet */
  }

  uint8_t *payload;
  int payload_len;
  uint16_t seqn;
  uint8_t *data_ptr = (uint8_t *)buf_ref->data + buf_ref->data_offset;
  size_t data_len = buf_ref->data_size;

  int is_rtp = rtp_get_payload(data_ptr, data_len, &payload, &payload_len, &seqn);

  if (is_rtp < 0)
  {
    /* Malformed packet, keep rtp_parsed=0 */
    return -1;
  }

  if (is_rtp == 1)
  {
    /* RTP packet: cache sequence number and adjust data_offset/data_size to point to payload */
    buf_ref->rtp_parsed = 1;
    buf_ref->rtp_seqn = seqn;
    buf_ref->data_offset = payload - (uint8_t *)buf_ref->data;
    buf_ref->data_size = (size_t)payload_len;
    return 1;
  }
  else
  {
    /* Non-RTP packet: keep rtp_parsed=0, data_offset/data_size unchanged */
    return 0;
  }
}

/**
 * Calculate slot index in ring buffer for a sequence number
 */
static inline int rtp_seqn_to_slot(uint16_t seqn, uint16_t base_seqn)
{
  int16_t offset = (int16_t)(seqn - base_seqn);
  if (offset < 0)
    return -1;
  if (offset >= RTP_REORDER_BUFFER_SIZE)
    return -1;
  return offset & (RTP_REORDER_BUFFER_SIZE - 1);
}

/**
 * Flush consecutive packets from reorder buffer
 */
static void rtp_flush_consecutive_packets(stream_context_t *ctx)
{
  while (1)
  {
    int slot = rtp_seqn_to_slot(ctx->reorder_expected_seqn, ctx->reorder_base_seqn);
    if (slot < 0 || slot >= RTP_REORDER_BUFFER_SIZE)
      break;

    buffer_ref_t *buf = ctx->reorder_slots[slot];
    if (buf == NULL)
      break; /* No consecutive packet available */

    /* Verify sequence number matches (safety check) */
    if (buf->rtp_seqn != ctx->reorder_expected_seqn)
    {
      logger(LOG_ERROR, "RTP: Slot seqn mismatch (expected=%u, got=%u)",
             ctx->reorder_expected_seqn, buf->rtp_seqn);
      break;
    }

    ctx->reorder_slots[slot] = NULL;

    /* Send packet (already parsed, use cached version) */
    rtp_queue_buf(ctx->conn, buf,
                  &ctx->fcc.current_seqn,
                  &ctx->fcc.not_first_packet);

    buffer_ref_put(buf);
    ctx->reorder_expected_seqn = (ctx->reorder_expected_seqn + 1) & 0xFFFF;
  }
}

/**
 * Slide reorder window and drop old packets
 */
static void rtp_slide_window(stream_context_t *ctx)
{
  for (int i = 0; i < RTP_REORDER_BUFFER_SIZE; i++)
  {
    if (ctx->reorder_slots[i])
    {
      buffer_ref_put(ctx->reorder_slots[i]);
      ctx->reorder_slots[i] = NULL;
      ctx->reorder_drops++;
    }
  }
  ctx->reorder_base_seqn = ctx->reorder_expected_seqn;
}

/**
 * Reset reorder buffer to new sequence number
 * Note: Caller should send new_seqn packet immediately after reset,
 * so we set expected to new_seqn+1
 */
static void rtp_reorder_reset(stream_context_t *ctx, uint16_t new_seqn)
{
  rtp_slide_window(ctx);
  ctx->reorder_base_seqn = new_seqn;                    /* Reset base to new starting point */
  ctx->reorder_expected_seqn = (new_seqn + 1) & 0xFFFF; /* Expect next after new_seqn */
  ctx->reorder_waiting = 0;
}

/**
 * RTP reordering and queueing with duplicate detection
 */
int rtp_reorder_and_queue(stream_context_t *ctx, buffer_ref_t *buf_ref)
{
  /* Fast path: if reordering is disabled, directly queue */
  if (!ctx->reorder_enabled)
  {
    return rtp_queue_buf(ctx->conn, buf_ref,
                         &ctx->fcc.current_seqn,
                         &ctx->fcc.not_first_packet);
  }

  /* Parse RTP packet (only once) */
  int is_rtp = rtp_parse_and_cache(buf_ref);

  if (is_rtp < 0)
  {
    return 0; /* Malformed packet, discard */
  }

  if (is_rtp == 0)
  {
    /* Non-RTP packet: send directly without reordering */
    return rtp_queue_buf(ctx->conn, buf_ref,
                         &ctx->fcc.current_seqn,
                         &ctx->fcc.not_first_packet);
  }

  /* === RTP packet reordering logic === */
  uint16_t seqn = buf_ref->rtp_seqn;

  /* First packet initialization */
  if (ctx->reorder_first_packet)
  {
    ctx->reorder_base_seqn = seqn;
    ctx->reorder_expected_seqn = (seqn + 1) & 0xFFFF;
    ctx->reorder_first_packet = 0;

    int ret = rtp_queue_buf(ctx->conn, buf_ref,
                            &ctx->fcc.current_seqn,
                            &ctx->fcc.not_first_packet);
    return ret;
  }

  /* Check for duplicate in reorder buffer */
  int slot = rtp_seqn_to_slot(seqn, ctx->reorder_base_seqn);
  if (slot >= 0 && slot < RTP_REORDER_BUFFER_SIZE &&
      ctx->reorder_slots[slot] != NULL)
  {
    if (ctx->reorder_slots[slot]->rtp_seqn == seqn)
    {
      ctx->reorder_duplicates++;
      return -1; /* Duplicate, discard */
    }
  }

  /* Determine sequence number relationship */
  int16_t delta = (int16_t)(seqn - ctx->reorder_expected_seqn);

  if (delta == 0)
  {
    /* Expected packet - send immediately */
    ctx->reorder_expected_seqn = (seqn + 1) & 0xFFFF;

    int ret = rtp_queue_buf(ctx->conn, buf_ref,
                            &ctx->fcc.current_seqn,
                            &ctx->fcc.not_first_packet);
    if (ret < 0)
      return ret;

    /* Try to flush consecutive packets from buffer */
    rtp_flush_consecutive_packets(ctx);

    /* Exit waiting state if applicable */
    if (ctx->reorder_waiting)
    {
      ctx->reorder_waiting = 0;
      ctx->reorder_recovered++;
    }

    return ret;
  }
  else if (delta > 0 && delta <= RTP_REORDER_BUFFER_SIZE / 2)
  {
    /* Small gap (1-8 packets) - likely light reordering, buffer and wait */
    ctx->reorder_out_of_order++;

    slot = rtp_seqn_to_slot(seqn, ctx->reorder_base_seqn);
    if (slot < 0 || slot >= RTP_REORDER_BUFFER_SIZE)
    {
      /* Slot out of range - expected has advanced too far from base, reset needed */
      logger(LOG_DEBUG, "RTP: Slot out of range (seqn=%u, base=%u, expected=%u), resetting",
             seqn, ctx->reorder_base_seqn, ctx->reorder_expected_seqn);
      rtp_reorder_reset(ctx, seqn); /* Use new packet's seqn as reset point */

      /* Recompute slot with new base */
      slot = rtp_seqn_to_slot(seqn, ctx->reorder_base_seqn);
      if (slot < 0 || slot >= RTP_REORDER_BUFFER_SIZE)
      {
        /* Still out of range, send immediately */
        return rtp_queue_buf(ctx->conn, buf_ref,
                             &ctx->fcc.current_seqn,
                             &ctx->fcc.not_first_packet);
      }
    }

    if (ctx->reorder_slots[slot] != NULL)
    {
      /* Slot occupied, drop old packet */
      buffer_ref_put(ctx->reorder_slots[slot]);
      ctx->reorder_drops++;
    }

    buffer_ref_get(buf_ref); /* Increment reference count */
    ctx->reorder_slots[slot] = buf_ref;

    /* Enter waiting state */
    if (!ctx->reorder_waiting)
    {
      ctx->reorder_waiting = 1;
      ctx->reorder_wait_start = get_time_ms();
    }

    return 0; /* Buffered successfully */
  }
  else if (delta > RTP_REORDER_BUFFER_SIZE / 2 && delta < RTP_REORDER_BUFFER_SIZE)
  {
    /* Medium-large gap (9-15 packets) - likely packet loss, passthrough immediately */
    logger(LOG_DEBUG, "RTP: Large gap detected (expected=%u, got=%u, gap=%d), passthrough",
           ctx->reorder_expected_seqn, seqn, (int)delta);

    /* Flush any buffered packets first to maintain some ordering */
    if (ctx->reorder_waiting)
    {
      logger(LOG_DEBUG, "RTP: Flushing buffered packets before passthrough");
      rtp_reorder_timeout_recovery(ctx);
      ctx->reorder_waiting = 0;
    }

    /* Update expected to continue from this packet */
    ctx->reorder_expected_seqn = (seqn + 1) & 0xFFFF;

    /* Send immediately without buffering */
    return rtp_queue_buf(ctx->conn, buf_ref,
                         &ctx->fcc.current_seqn,
                         &ctx->fcc.not_first_packet);
  }
  else if (delta < 0 && delta >= -(int16_t)(RTP_REORDER_BUFFER_SIZE * 4))
  {
    /* Old packet, discard as duplicate */
    ctx->reorder_duplicates++;
    return -1;
  }
  else
  {
    /* Extreme sequence jump (forward > 8 or backward > 64) - reset buffer */
    logger(LOG_DEBUG, "RTP: Large seqn jump (expected=%u, got=%u, delta=%d), resetting buffer",
           ctx->reorder_expected_seqn, seqn, (int)delta);
    rtp_reorder_reset(ctx, seqn);
    return rtp_queue_buf(ctx->conn, buf_ref,
                         &ctx->fcc.current_seqn,
                         &ctx->fcc.not_first_packet);
  }
}

/**
 * Timeout recovery: flush ALL buffered packets in sequence order
 * Called from stream_tick when reorder wait timeout expires
 *
 * Strategy: Send all buffered packets sorted by sequence number,
 * allowing video to continue with possible artifacts (better than black screen)
 */
void rtp_reorder_timeout_recovery(stream_context_t *ctx)
{
  int sent_count = 0;
  uint16_t last_seqn = 0;

  /* Slots are already ordered by sequence number (slot_index = seqn - base_seqn)
   * Just iterate through slots sequentially and send non-NULL packets */
  for (int i = 0; i < RTP_REORDER_BUFFER_SIZE; i++)
  {
    if (ctx->reorder_slots[i] != NULL)
    {
      buffer_ref_t *buf = ctx->reorder_slots[i];

      /* Verify packet is parsed */
      if (!buf->rtp_parsed)
      {
        logger(LOG_ERROR, "RTP: Unparsed packet in reorder buffer slot %d", i);
        buffer_ref_put(buf);
        ctx->reorder_slots[i] = NULL;
        continue;
      }

      /* Send packet */
      rtp_queue_buf(ctx->conn, buf, &ctx->fcc.current_seqn, &ctx->fcc.not_first_packet);
      last_seqn = buf->rtp_seqn;
      buffer_ref_put(buf);
      ctx->reorder_slots[i] = NULL;
      sent_count++;
    }
  }

  if (sent_count > 0)
  {
    /* Update expected sequence number to continue after last sent packet */
    ctx->reorder_expected_seqn = (last_seqn + 1) & 0xFFFF;
    /* Update base to match expected to prevent slot calculation issues */
    ctx->reorder_base_seqn = ctx->reorder_expected_seqn;
    logger(LOG_DEBUG, "RTP: Timeout recovery flushed %d buffered packets", sent_count);
  }
}
