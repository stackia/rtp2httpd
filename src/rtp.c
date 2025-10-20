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

int rtp_get_payload(uint8_t *buf, size_t len, uint8_t **payload, size_t *size, uint16_t *seqn)
{
  size_t payloadstart;
  size_t payloadlength;
  uint8_t flags;

  /* Check if this is an RTP packet (version 2, minimum size 12 bytes) */
  if (likely(len >= 12) && likely((buf[0] & 0xC0) == 0x80))
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
      if (unlikely(payloadstart + 4 > len))
      {
        logger(LOG_DEBUG, "Malformed RTP packet: extension header truncated");
        return -1;
      }
      payloadstart += 4 + 4 * ntohs(*((uint16_t *)(buf + payloadstart + 2)));
    }

    payloadlength = len - payloadstart;

    /* Padding is uncommon in most RTP streams */
    if (unlikely(flags & 0x20))
    { /*Padding*/
      payloadlength -= buf[len - 1];
      /*last octet indicate padding length*/
    }

    /* Validate final payload bounds */
    if (unlikely(payloadlength <= 0) || unlikely(payloadstart + payloadlength > len))
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
    *size = len;
    return 0; /* Non-RTP packet */
  }
}

buffer_ref_t *rtp_clip_buffer_to_valid_payload(buffer_ref_t *buf_ref_list, uint16_t *last_seqn, int *not_first, size_t *total_payload_length, const char *log_label)
{
  buffer_ref_t *list_head = NULL;
  buffer_ref_t *list_tail = NULL;
  buffer_ref_t *current = buf_ref_list;

  /* Process each buffer in the list, filtering out invalid ones */
  while (current)
  {
    buffer_ref_t *next = current->process_next;
    size_t payload_length;
    uint8_t *payload;
    uint16_t seqn;
    int is_rtp;
    uint8_t *data_ptr = (uint8_t *)current->data + current->data_offset;
    int skip_buffer = 0;

    /* Extract payload and sequence number - automatically handles RTP and non-RTP packets */
    is_rtp = rtp_get_payload(data_ptr, current->data_len, &payload, &payload_length, &seqn);
    if (unlikely(is_rtp < 0))
    {
      skip_buffer = 1;
    }
    else if (likely(is_rtp == 1))
    {
      /* Perform sequence number tracking only for RTP packets (is_rtp == 1) */

      /* Duplicate detection - duplicates are rare */
      if (unlikely(*not_first && seqn == *last_seqn))
      {
        logger(LOG_DEBUG, "RTP: Duplicated RTP packet "
                          "received (seqn %d) (%s)",
               seqn, log_label);
        skip_buffer = 1;
      }
      else
      {
        /* Out-of-order detection - packets are usually in order */
        uint16_t expected = (*last_seqn + 1) & 0xFFFF;
        if (unlikely(*not_first && (seqn != expected)))
        {
          int gap = seqn - expected;
          /* This indicates upstream packet loss (network or source), NOT local send congestion */
          logger(LOG_DEBUG, "RTP: Packet loss detected - expected seq %d, received %d (gap: %d packets) (%s)",
                 expected, seqn, gap, log_label);
        }

        *last_seqn = seqn;
        *not_first = 1;
      }
    }
    /* For non-RTP packets (is_rtp == 0), skip sequence number tracking */

    /* Handle skipped buffers - release reference since we're removing them from the chain */
    if (skip_buffer)
    {
      if (!list_tail)
      {
        /* We modified the chain by not including this buffer, so we take ownership and must release it */
        buffer_ref_put(current);
      }
      current = next;
      continue;
    }

    /* Calculate offset of payload in the buffer */
    off_t payload_offset = payload - data_ptr;
    current->data_offset += payload_offset;
    current->data_len = payload_length;

    /* Keep this buffer in the list by linking it */
    if (list_tail)
    {
      list_tail->process_next = current;
    }
    else
    {
      list_head = current;
    }
    list_tail = current;

    if (total_payload_length)
    {
      *total_payload_length += payload_length;
    }
    current = next;
  }

  /* Terminate the list */
  if (list_tail)
  {
    list_tail->process_next = NULL;
  }

  return list_head;
}

int rtp_queue_payload_to_client(connection_t *conn, buffer_ref_t *buf_ref_list, uint16_t *last_seqn, int *not_first)
{
  size_t total_payload_length = 0;
  buffer_ref_t *clipped_buf_list = rtp_clip_buffer_to_valid_payload(buf_ref_list, last_seqn, not_first, &total_payload_length, "instant queue");

  if (!clipped_buf_list)
  {
    /* No valid payload to send */
    return 0;
  }

  int num_queued = 0;
  connection_queue_zerocopy(conn, clipped_buf_list, &num_queued);
  if (num_queued > 0)
  {
    /* Successfully queued (full or partial) - send queue now holds a reference */
    return (int)total_payload_length;
  }
  else
  {
    /* Queue full or error - backpressure */
    return -1;
  }
}
