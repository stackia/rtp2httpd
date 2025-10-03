#ifdef HAVE_CONFIG_H
#include "config.h"
#endif /* HAVE_CONFIG_H */

#include <stdint.h>
#include <arpa/inet.h>
#include <sys/socket.h>
#include "rtp.h"
#include "rtp2httpd.h"
#include "connection.h"

int get_rtp_payload(uint8_t *buf, int recv_len, uint8_t **payload, int *size)
{
  int payloadstart, payloadlength;
  uint8_t flags;

  /* Check minimum packet size and RTP version (v2 = 0x80) */
  if (unlikely(recv_len < 12) || unlikely((buf[0] & 0xC0) != 0x80))
  {
    /*malformed RTP/UDP/IP packet*/
    logger(LOG_DEBUG, "Malformed RTP packet received");
    return -1;
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
  return 0;
}

int write_rtp_payload_to_client(struct connection_s *conn, int recv_len, uint8_t *buf, uint16_t *old_seqn, uint16_t *not_first)
{
  int payloadlength;
  uint8_t *payload;
  uint16_t seqn;

  /* Extract payload - most packets are well-formed */
  if (unlikely(get_rtp_payload(buf, recv_len, &payload, &payloadlength) != 0))
  {
    return 0; /* Malformed packet, already logged */
  }

  /* Read sequence number */
  seqn = ntohs(*(uint16_t *)(buf + 2));

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
    logger(LOG_DEBUG, "Congestion - expected %d, "
                      "received %d",
           (*old_seqn + 1) & 0xFFFF, seqn);
  }

  *old_seqn = seqn;
  *not_first = 1;

  /* Queue payload to connection output buffer for reliable delivery */
  if (connection_queue_output(conn, payload, payloadlength) == 0)
  {
    return payloadlength;
  }
  else
  {
    /* Buffer full - backpressure */
    logger(LOG_DEBUG, "RTP: Output buffer full, backpressure");
    return -1;
  }
}
