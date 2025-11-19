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

int rtp_queue_buf(connection_t *conn, buffer_ref_t *buf_ref, uint16_t *old_seqn,
                  uint16_t *not_first) {
  int payloadlength;
  uint8_t *payload;
  uint16_t seqn;
  int is_rtp;
  uint8_t *data_ptr = (uint8_t *)buf_ref->data + buf_ref->data_offset;

  /* Extract payload and sequence number - automatically handles RTP and non-RTP
   * packets */
  is_rtp = rtp_get_payload(data_ptr, buf_ref->data_size, &payload,
                           &payloadlength, &seqn);
  if (unlikely(is_rtp < 0)) {
    return 0; /* Malformed packet, already logged */
  }

  /* Perform sequence number tracking only for RTP packets (is_rtp == 1) */
  if (likely(is_rtp == 1)) {
    /* Sequence number validation - discard duplicate/backward/out-of-order
     * packets */
    if (unlikely(*not_first)) {
      /* Calculate sequence number difference (handling wrap-around) */
      int16_t seq_diff = (int16_t)(seqn - *old_seqn);

      /* Discard duplicate/backward/out-of-order packets (seq_diff <= 0) */
      if (seq_diff <= 0) {
        logger(LOG_DEBUG,
               "Out-of-order RTP packet discarded - last sent seq %d, received "
               "%d (diff: %d)",
               *old_seqn, seqn, seq_diff);
        return 0;
      }

      /* Forward packet but detect gaps for logging */
      uint16_t expected = (*old_seqn + 1) & 0xFFFF;
      if (seqn != expected) {
        /* This indicates upstream packet loss (network or source), NOT local
         * send congestion */
        logger(LOG_DEBUG,
               "RTP packet loss detected - expected seq %d, received %d (gap: "
               "%d packets)",
               expected, seqn, seq_diff - 1);
      }
    }

    *old_seqn = seqn;
    *not_first = 1;
  }
  /* For non-RTP packets (is_rtp == 0), skip sequence number tracking */

  /* Send headers lazily on first data packet */
  if (!conn->headers_sent) {
    send_http_headers(conn, STATUS_200, "video/mp2t", NULL);
  }

  /* True zero-copy send - payload is in buffer pool, send directly without
   * memcpy */
  /* Calculate offset of payload in the buffer */
  buf_ref->data_offset = payload - (uint8_t *)buf_ref->data;
  buf_ref->data_size = (size_t)payloadlength;

  /* Queue for zero-copy send */
  /* Note: zerocopy_queue_add() will automatically increment refcount */
  if (connection_queue_zerocopy(conn, buf_ref) == 0) {
    /* Successfully queued - send queue now holds a reference */
    return payloadlength;
  } else {
    /* Queue full - backpressure */
    return -1;
  }
}
