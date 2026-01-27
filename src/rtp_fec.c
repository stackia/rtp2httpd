/**
 * RTP Forward Error Correction (FEC) Module
 *
 * Handles FEC packet reception, group management, and packet recovery
 * for RTP streams that use Reed-Solomon FEC on a separate multicast port.
 */

#include "rtp_fec.h"

#include <arpa/inet.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include "buffer_pool.h"
#include "rtp_reorder.h"
#include "utils.h"
#include "worker.h"

/* FEC payload types */
#define FEC_PAYLOAD_TYPE_1 127
#define FEC_PAYLOAD_TYPE_2 97

/* Sequence number helpers */
#define SEQ_DIFF(a, b) ((int16_t)((a) - (b)))
#define SEQ_IN_RANGE(seq, begin, end) \
  (SEQ_DIFF((seq), (begin)) >= 0 && SEQ_DIFF((end), (seq)) >= 0)

/**
 * Recalculate min_end_seq from all active groups
 */
static void fec_recalc_min_end_seq(fec_context_t *ctx)
{
  ctx->min_end_seq_valid = 0;

  for (int i = 0; i < FEC_MAX_GROUPS; i++)
  {
    fec_group_t *grp = &ctx->groups[i];
    if (!grp->fec_slots)
      continue;

    if (!ctx->min_end_seq_valid ||
        SEQ_DIFF(grp->end_seq, ctx->min_end_seq) < 0)
    {
      ctx->min_end_seq = grp->end_seq;
      ctx->min_end_seq_valid = 1;
    }
  }
}

/**
 * Find or create FEC group for given sequence range
 */
static fec_group_t *fec_find_or_create_group(fec_context_t *ctx,
                                             uint16_t begin_seq,
                                             uint16_t end_seq, int k, int m,
                                             uint16_t rtp_len)
{
  /* Skip if group is already expired (base_seq > end_seq).
   * This happens when FEC packets arrive late, after all RTP packets
   * in the group have already been delivered. Creating such a group
   * would be wasteful as it would be immediately released. */
  if (ctx->reorder && SEQ_DIFF(ctx->reorder->base_seq, end_seq) > 0)
  {
    return NULL;
  }

  /* Look for existing group */
  for (int i = 0; i < FEC_MAX_GROUPS; i++)
  {
    fec_group_t *grp = &ctx->groups[i];
    if (grp->fec_slots && grp->begin_seq == begin_seq && grp->end_seq == end_seq)
    {
      return grp;
    }
  }

  /* Find empty slot */
  fec_group_t *new_grp = NULL;
  for (int i = 0; i < FEC_MAX_GROUPS; i++)
  {
    if (!ctx->groups[i].fec_slots)
    {
      new_grp = &ctx->groups[i];
      break;
    }
  }

  /* If no empty slot, evict oldest (lowest begin_seq) */
  int evicted = 0;
  if (!new_grp)
  {
    int oldest_idx = 0;
    int16_t max_diff = 0;
    for (int i = 0; i < FEC_MAX_GROUPS; i++)
    {
      /* Find group with smallest begin_seq relative to new group */
      int16_t diff = (int16_t)(begin_seq - ctx->groups[i].begin_seq);
      if (diff > max_diff)
      {
        max_diff = diff;
        oldest_idx = i;
      }
    }
    new_grp = &ctx->groups[oldest_idx];

    /* Release RTP buffers for evicted group */
    if (ctx->reorder)
    {
      rtp_reorder_release_range(ctx->reorder, new_grp->begin_seq,
                                new_grp->end_seq);
    }

    /* Free old group FEC resources */
    if (new_grp->fec_slots)
    {
      for (int j = 0; j < new_grp->m; j++)
      {
        if (new_grp->fec_slots[j].data)
        {
          free(new_grp->fec_slots[j].data);
        }
      }
      free(new_grp->fec_slots);
    }
    ctx->group_count--;
    evicted = 1;
  }

  /* Initialize new group */
  memset(new_grp, 0, sizeof(*new_grp));
  new_grp->begin_seq = begin_seq;
  new_grp->end_seq = end_seq;
  new_grp->k = k;
  new_grp->m = m;
  new_grp->rtp_len = rtp_len;

  /* Allocate FEC slots (marks group as active) */
  new_grp->fec_slots = calloc(m, sizeof(fec_packet_t));
  if (!new_grp->fec_slots)
  {
    return NULL;
  }

  ctx->group_count++;

  /* Update min_end_seq: new group may have smaller end_seq */
  if (!ctx->min_end_seq_valid || SEQ_DIFF(end_seq, ctx->min_end_seq) < 0)
  {
    ctx->min_end_seq = end_seq;
    ctx->min_end_seq_valid = 1;
  }
  else if (evicted)
  {
    /* Evicted a group, need to recalculate min_end_seq */
    fec_recalc_min_end_seq(ctx);
  }

  return new_grp;
}

/**
 * Free resources of a single FEC group
 */
static void fec_free_group(fec_group_t *grp)
{
  if (!grp->fec_slots)
  {
    return;
  }

  for (int i = 0; i < grp->m; i++)
  {
    if (grp->fec_slots[i].data)
    {
      free(grp->fec_slots[i].data);
    }
  }
  free(grp->fec_slots);
  grp->fec_slots = NULL;
}

void fec_init(fec_context_t *ctx, uint16_t fec_port, rtp_reorder_t *reorder)
{
  memset(ctx, 0, sizeof(*ctx));
  ctx->sock = -1;
  ctx->reorder = reorder;
  ctx->fec_port = fec_port;
}

void fec_cleanup(fec_context_t *ctx, int epoll_fd)
{
  /* Close FEC socket if open */
  if (ctx->sock >= 0)
  {
    worker_cleanup_socket_from_epoll(epoll_fd, ctx->sock);
    ctx->sock = -1;
    logger(LOG_DEBUG, "FEC: Closed socket");
  }

  /* Free all groups */
  for (int i = 0; i < FEC_MAX_GROUPS; i++)
  {
    fec_free_group(&ctx->groups[i]);
  }
  ctx->group_count = 0;

  /* Free RS decoder */
  if (ctx->rs_decoder)
  {
    rs_fec_free(ctx->rs_decoder);
    ctx->rs_decoder = NULL;
  }

  /* Log statistics only if FEC was enabled */
  if (fec_is_enabled(ctx) &&
      (ctx->packets_lost > 0 || ctx->recovery_successes > 0))
  {
    uint64_t total_loss = ctx->packets_lost + ctx->recovery_successes;
    int recovery_pct = total_loss > 0
                           ? (int)(ctx->recovery_successes * 100 / total_loss)
                           : 0;
    logger(LOG_INFO,
           "FEC stats: %lu total loss, %lu recovered (%d%%)",
           (unsigned long)total_loss,
           (unsigned long)ctx->recovery_successes, recovery_pct);
  }
}

int fec_process_packet(fec_context_t *ctx, const uint8_t *data, int len)
{
  const fec_packet_header_t *hdr;
  uint16_t begin_seq, end_seq;
  int k, m;
  uint16_t rtp_len, fec_len;
  int redund_idx;

  /* Validate minimum length: RTP header (12) + FEC header (12) */
  if (len < 24)
  {
    return -1;
  }

  /* Check RTP version */
  if ((data[0] & 0xC0) != 0x80)
  {
    return -1;
  }

  /* Check payload type */
  uint8_t payload_type = data[1] & 0x7F;
  if (payload_type != FEC_PAYLOAD_TYPE_1 &&
      payload_type != FEC_PAYLOAD_TYPE_2)
  {
    return -1;
  }

  /* Skip RTP header to get FEC header */
  int rtp_header_len = 12;
  rtp_header_len += (data[0] & 0x0F) * 4; /* CSRC */
  if (data[0] & 0x10)
  { /* Extension */
    if (rtp_header_len + 4 > len)
    {
      return -1;
    }
    uint16_t ext_len;
    memcpy(&ext_len, data + rtp_header_len + 2, sizeof(ext_len));
    rtp_header_len += 4 + 4 * ntohs(ext_len);
  }

  if (rtp_header_len + sizeof(fec_packet_header_t) > (size_t)len)
  {
    return -1;
  }

  hdr = (const fec_packet_header_t *)(data + rtp_header_len);

  begin_seq = ntohs(hdr->rtp_begin_seq);
  end_seq = ntohs(hdr->rtp_end_seq);
  m = hdr->redund_num;
  redund_idx = hdr->redund_idx;
  fec_len = ntohs(hdr->fec_len);
  rtp_len = ntohs(hdr->rtp_len);

  /* Calculate k from sequence range */
  k = SEQ_DIFF(end_seq, begin_seq) + 1;
  if (k <= 0 || m <= 0)
  {
    logger(LOG_DEBUG, "FEC: Invalid k=%d or m=%d", k, m);
    return -1;
  }

  if (redund_idx >= m)
  {
    logger(LOG_DEBUG, "FEC: Invalid redund_idx=%d >= m=%d", redund_idx, m);
    return -1;
  }

  /* Validate FEC data length */
  size_t fec_data_offset = rtp_header_len + sizeof(fec_packet_header_t);
  if (fec_data_offset + fec_len > (size_t)len)
  {
    logger(LOG_DEBUG, "FEC: Truncated FEC data");
    return -1;
  }

  /* Activate FEC on first valid packet (enables mixed-port mode).
   * Do this before group creation since expired groups return NULL
   * but we still want to track that FEC is active. */
  if (!ctx->fec_active)
  {
    ctx->fec_active = 1;
    logger(LOG_INFO, "FEC: Activated (first FEC packet received)");
  }

  /* Find or create group */
  fec_group_t *grp =
      fec_find_or_create_group(ctx, begin_seq, end_seq, k, m, rtp_len);
  if (!grp)
  {
    /* NULL is returned for expired groups (base_seq > end_seq) or allocation
     * failure. Expired groups are common and expected - silently ignore. */
    return 0;
  }

  /* Store FEC packet if slot is empty */
  if (!grp->fec_slots[redund_idx].received)
  {
    grp->fec_slots[redund_idx].data = malloc(fec_len);
    if (grp->fec_slots[redund_idx].data)
    {
      memcpy(grp->fec_slots[redund_idx].data, data + fec_data_offset, fec_len);
      grp->fec_slots[redund_idx].data_len = fec_len;
      grp->fec_slots[redund_idx].received = 1;
      grp->fec_received++;
    }
  }

  return 0;
}

int fec_attempt_recovery(fec_context_t *ctx, uint16_t seq,
                         uint8_t **recovered_data, int *recovered_len)
{
  if (!fec_is_enabled(ctx) || !ctx->reorder)
  {
    return -1;
  }

  rtp_reorder_t *reorder = ctx->reorder;

  /* Find group containing this sequence */
  fec_group_t *grp = NULL;
  for (int i = 0; i < FEC_MAX_GROUPS; i++)
  {
    if (ctx->groups[i].fec_slots &&
        SEQ_IN_RANGE(seq, ctx->groups[i].begin_seq, ctx->groups[i].end_seq))
    {
      grp = &ctx->groups[i];
      break;
    }
  }

  if (!grp)
  {
    /* No FEC group covers this sequence - common when FEC packets arrive late
     * or when loss occurs outside FEC-protected ranges. Not an error. */
    return -1;
  }

  /* Quick check: k exceeds reorder buffer size, recovery impossible */
  if (grp->k > RTP_REORDER_WINDOW_SIZE)
  {
    return -1;
  }

  int target_slot = SEQ_DIFF(seq, grp->begin_seq);
  if (target_slot < 0 || target_slot >= grp->k)
  {
    return -1;
  }

  /* Check if we already have this packet in reorder buffer */
  buffer_ref_t *existing = rtp_reorder_get(reorder, seq);
  if (existing)
  {
    uint8_t *payload = (uint8_t *)existing->data + existing->data_offset;
    *recovered_data = malloc(existing->data_size);
    if (*recovered_data)
    {
      memcpy(*recovered_data, payload, existing->data_size);
      *recovered_len = (int)existing->data_size;
      return 0;
    }
    return -1;
  }

  /* Count RTP packets available in reorder buffer for this group */
  int rtp_received = 0;
  for (int i = 0; i < grp->k; i++)
  {
    uint16_t pkt_seq = grp->begin_seq + i;
    if (rtp_reorder_get(reorder, pkt_seq))
    {
      rtp_received++;
    }
  }

  /* Check if we have enough packets for recovery */
  int total_received = rtp_received + grp->fec_received;
  if (total_received < grp->k)
  {
    return -1;
  }

  /* Get or create RS decoder */
  if (!ctx->rs_decoder || ctx->rs_k != grp->k || ctx->rs_m != grp->m)
  {
    if (ctx->rs_decoder)
    {
      rs_fec_free(ctx->rs_decoder);
    }
    ctx->rs_decoder = rs_fec_new(grp->k, grp->m);
    if (!ctx->rs_decoder)
    {
      logger(LOG_ERROR, "FEC: Failed to create RS decoder for k=%d m=%d",
             grp->k, grp->m);
      return -1;
    }
    ctx->rs_k = grp->k;
    ctx->rs_m = grp->m;
  }

  /* Prepare data arrays for RS decoder */
  uint8_t **data_ptrs = calloc(grp->k, sizeof(uint8_t *));
  uint8_t **fec_ptrs = calloc(grp->m, sizeof(uint8_t *));
  int *lost_map = calloc(grp->k + grp->m, sizeof(int));
  uint8_t **allocated = calloc(grp->k, sizeof(uint8_t *));

  if (!data_ptrs || !fec_ptrs || !lost_map || !allocated)
  {
    goto decode_error;
  }

  /* Prepare RTP data pointers from reorder buffer.
   * IMPORTANT: FEC encoding uses COMPLETE RTP packets (header + payload).
   * The buffer stores payload only (data_offset points past RTP header),
   * so we need to access the original data from offset 0.
   * Complete RTP packet size = data_offset + data_size */
  for (int i = 0; i < grp->k; i++)
  {
    uint16_t pkt_seq = grp->begin_seq + i;
    buffer_ref_t *ref = rtp_reorder_get(reorder, pkt_seq);
    if (ref)
    {
      /* Calculate complete RTP packet size (header + payload) */
      size_t rtp_packet_size = ref->data_offset + ref->data_size;

      /* RTP packets may be shorter than rtp_len (padded to max during encoding).
       * We need to copy to a padded buffer for RS decode to work correctly. */
      if (rtp_packet_size < grp->rtp_len)
      {
        /* Allocate padded buffer and copy complete RTP packet from offset 0 */
        allocated[i] = calloc(1, grp->rtp_len);
        if (!allocated[i])
        {
          goto decode_error;
        }
        memcpy(allocated[i], (uint8_t *)ref->data, rtp_packet_size);
        /* Rest is already zeroed by calloc (padding) */
        data_ptrs[i] = allocated[i];
      }
      else
      {
        /* Use original buffer directly (complete RTP packet from offset 0) */
        data_ptrs[i] = (uint8_t *)ref->data;
      }
      lost_map[i] = 1; /* received */
    }
    else
    {
      /* Allocate buffer for recovery */
      allocated[i] = calloc(1, grp->rtp_len);
      if (!allocated[i])
      {
        goto decode_error;
      }
      data_ptrs[i] = allocated[i];
      lost_map[i] = 0; /* lost */
    }
  }

  /* Prepare FEC data pointers */
  for (int i = 0; i < grp->m; i++)
  {
    if (grp->fec_slots[i].received)
    {
      /* Verify FEC parity data length */
      if (grp->fec_slots[i].data_len < grp->rtp_len)
      {
        logger(LOG_DEBUG, "FEC: Parity data size mismatch (%u < %u)",
               grp->fec_slots[i].data_len, grp->rtp_len);
        goto decode_error;
      }
      fec_ptrs[i] = grp->fec_slots[i].data;
      lost_map[grp->k + i] = 1; /* received */
    }
    else
    {
      fec_ptrs[i] = NULL;
      lost_map[grp->k + i] = 0; /* lost */
    }
  }

  /* Attempt RS decode */
  if (rs_fec_decode(ctx->rs_decoder, data_ptrs, fec_ptrs, lost_map,
                    grp->rtp_len) != 0)
  {
    logger(LOG_DEBUG, "FEC: RS decode failed");
    goto decode_error;
  }

  /* Return recovered packet - strip RTP header, return payload only */
  if (allocated[target_slot])
  {
    uint8_t *rtp_packet = allocated[target_slot];

    /* Parse RTP header to find payload offset */
    int rtp_hdr_len = 12; /* Basic RTP header */
    if ((rtp_packet[0] & 0xC0) != 0x80)
    {
      logger(LOG_DEBUG, "FEC: Recovered data is not valid RTP");
      goto decode_error;
    }
    rtp_hdr_len += (rtp_packet[0] & 0x0F) * 4; /* CSRC */
    if (rtp_packet[0] & 0x10)
    { /* Extension */
      if (rtp_hdr_len + 4 > (int)grp->rtp_len)
      {
        goto decode_error;
      }
      uint16_t ext_len;
      memcpy(&ext_len, rtp_packet + rtp_hdr_len + 2, sizeof(ext_len));
      rtp_hdr_len += 4 + 4 * ntohs(ext_len);
    }

    int payload_len = (int)grp->rtp_len - rtp_hdr_len;
    if (rtp_packet[0] & 0x20)
    { /* Padding */
      payload_len -= rtp_packet[grp->rtp_len - 1];
    }

    if (payload_len <= 0)
    {
      logger(LOG_DEBUG, "FEC: Recovered RTP has invalid payload length");
      goto decode_error;
    }

    /* Allocate and copy payload only */
    uint8_t *payload = malloc(payload_len);
    if (!payload)
    {
      goto decode_error;
    }
    memcpy(payload, rtp_packet + rtp_hdr_len, payload_len);

    *recovered_data = payload;
    *recovered_len = payload_len;
    ctx->recovery_successes++;

    logger(LOG_DEBUG, "FEC: Recovered seq=%u payload_len=%d", seq, payload_len);

    /* Cleanup */
    for (int i = 0; i < grp->k; i++)
    {
      if (allocated[i])
      {
        free(allocated[i]);
      }
    }
    free(data_ptrs);
    free(fec_ptrs);
    free(lost_map);
    free(allocated);

    return 0;
  }

decode_error:
  if (allocated)
  {
    for (int i = 0; i < grp->k; i++)
    {
      if (allocated[i])
      {
        free(allocated[i]);
      }
    }
    free(allocated);
  }
  free(data_ptrs);
  free(fec_ptrs);
  free(lost_map);

  return -1;
}

void fec_release_expired_groups(fec_context_t *ctx, uint16_t base_seq)
{
  /* Release all expired groups */
  for (int i = 0; i < FEC_MAX_GROUPS; i++)
  {
    fec_group_t *grp = &ctx->groups[i];
    if (!grp->fec_slots)
      continue;

    /* Group expired if base_seq > end_seq */
    if (SEQ_DIFF(base_seq, grp->end_seq) > 0)
    {
      /* Release RTP buffers in this range */
      if (ctx->reorder)
      {
        rtp_reorder_release_range(ctx->reorder, grp->begin_seq, grp->end_seq);
      }

      /* Free group */
      fec_free_group(grp);
      ctx->group_count--;
    }
  }

  /* Recalculate min_end_seq from remaining groups */
  fec_recalc_min_end_seq(ctx);
}
