#include "rtp.h"
#include "connection.h"
#include "utils.h"
#include <stdint.h>
#include <string.h>

#define FEC_PAYLOAD_TYPE_1 127
#define FEC_PAYLOAD_TYPE_2 97

int rtp_get_payload(uint8_t *buf, int recv_len, uint8_t **payload, int *size,
                    uint16_t *seqn) {
  int payloadstart, payloadlength;
  uint8_t flags;
  uint8_t payload_type;

  /* Check if this is an RTP packet (version 2, minimum size 12 bytes) */
  if (likely(recv_len >= 12) && likely((buf[0] & 0xC0) == 0x80)) {
    /* RTP packet detected - strip RTP header and return payload */

    /* Extract and check payload type */
    payload_type = buf[1] & 0x7F;
    if (unlikely(payload_type == FEC_PAYLOAD_TYPE_1 ||
                 payload_type == FEC_PAYLOAD_TYPE_2)) {
      logger(LOG_DEBUG, "FEC packet detected (payload type %d), skipping",
             payload_type);
      return -1;
    }

    /* Extract sequence number if requested */
    if (seqn) {
      uint16_t seq_be;
      memcpy(&seq_be, buf + 2, sizeof(seq_be));
      *seqn = ntohs(seq_be);
    }

    /* Cache first byte to reduce memory access */
    flags = buf[0];

    payloadstart = 12;                  /* basic RTP header length */
    payloadstart += (flags & 0x0F) * 4; /*CSRC headers*/

    /* Extension header is uncommon in most RTP streams */
    if (unlikely(flags & 0x10)) { /*Extension header*/
      /* Validate extension header doesn't exceed packet bounds */
      if (unlikely(payloadstart + 4 > recv_len)) {
        logger(LOG_DEBUG, "Malformed RTP packet: extension header truncated");
        return -1;
      }
      uint16_t ext_len_be;
      memcpy(&ext_len_be, buf + payloadstart + 2, sizeof(ext_len_be));
      payloadstart += 4 + 4 * ntohs(ext_len_be);
    }

    payloadlength = recv_len - payloadstart;

    /* Padding is uncommon in most RTP streams */
    if (unlikely(flags & 0x20)) { /*Padding*/
      payloadlength -= buf[recv_len - 1];
      /*last octet indicate padding length*/
    }

    /* Validate final payload bounds */
    if (unlikely(payloadlength <= 0) ||
        unlikely(payloadstart + payloadlength > recv_len)) {
      logger(LOG_DEBUG, "Malformed RTP packet: invalid payload length");
      return -1;
    }

    *payload = buf + payloadstart;
    *size = payloadlength;
    return 1; /* RTP packet */
  } else {
    /* Not an RTP packet - treat entire packet as payload */
    *payload = buf;
    *size = recv_len;
    return 0; /* Non-RTP packet */
  }
}

int rtp_queue_buf_direct(connection_t *conn, buffer_ref_t *buf_ref) {
  /* Send headers lazily on first data packet */
  if (!conn->headers_sent) {
    send_http_headers(conn, STATUS_200, "video/mp2t", NULL);
  }

  /* Queue for zero-copy send */
  if (connection_queue_zerocopy(conn, buf_ref) == 0) {
    return (int)buf_ref->data_size;
  }
  return -1;
}
