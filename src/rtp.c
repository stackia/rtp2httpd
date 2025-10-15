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

int get_rtp_payload(uint8_t *buf, int recv_len, uint8_t **payload, int *size, uint16_t *seqn)
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

int write_rtp_payload_to_client(connection_t *conn, int recv_len, uint8_t *buf,
                                buffer_ref_t *buf_ref, uint16_t *old_seqn, uint16_t *not_first)
{
  int payloadlength;
  uint8_t *payload;
  uint16_t seqn;
  int is_rtp;

  /* Extract payload and sequence number - automatically handles RTP and non-RTP packets */
  is_rtp = get_rtp_payload(buf, recv_len, &payload, &payloadlength, &seqn);
  if (unlikely(is_rtp < 0))
  {
    return 0; /* Malformed packet, already logged */
  }

  /* Perform sequence number tracking only for RTP packets (is_rtp == 1) */
  if (likely(is_rtp == 1))
  {
    /* Duplicate detection - duplicates are rare */
    if (unlikely(*not_first && seqn == *old_seqn))
    {
      logger(LOG_DEBUG, "Duplicated RTP packet "
                        "received (seqn %d)",
             seqn);
      return 0;
    }

    /* Out-of-order detection - packets are usually in order */
    if (unlikely(*not_first && (seqn != ((*old_seqn + 1) & 0xFFFF))))
    {
      int expected = (*old_seqn + 1) & 0xFFFF;
      int gap = (seqn - expected) & 0xFFFF;
      /* This indicates upstream packet loss (network or source), NOT local send congestion */
      logger(LOG_DEBUG, "RTP packet loss detected - expected seq %d, received %d (gap: %d packets)",
             expected, seqn, gap);
    }

    *old_seqn = seqn;
    *not_first = 1;
  }
  /* For non-RTP packets (is_rtp == 0), skip sequence number tracking */

  /* True zero-copy send - payload is in buffer pool, send directly without memcpy */
  /* Calculate offset of payload in the buffer */
  size_t payload_offset = payload - (uint8_t *)buf_ref->data;

  /* Queue for zero-copy send */
  /* Note: zerocopy_queue_add() will automatically increment refcount */
  if (connection_queue_zerocopy(conn, buf_ref, payload_offset, (size_t)payloadlength) == 0)
  {
    /* Successfully queued - send queue now holds a reference */
    return payloadlength;
  }
  else
  {
    /* Queue full - backpressure */
    logger(LOG_DEBUG, "Zero-copy queue full, backpressure");
    return -1;
  }
}
