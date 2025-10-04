#ifndef __RTP_H__
#define __RTP_H__

#include <stdint.h>
#include <sys/types.h>

/* Forward declarations */
struct connection_s;
struct buffer_ref_s;
typedef struct buffer_ref_s buffer_ref_t;

/**
 * Extract RTP payload from an RTP packet
 *
 * @param buf Buffer containing RTP packet
 * @param recv_len Length of received data
 * @param payload Pointer to store payload location
 * @param size Pointer to store payload size
 * @return 0 on success, -1 on malformed packet
 */
int get_rtp_payload(uint8_t *buf, int recv_len, uint8_t **payload, int *size);

/**
 * Write RTP payload to client via connection output buffer, handling sequence numbers and duplicates
 * Uses true zero-copy by sending payload directly from buffer pool without memcpy
 *
 * @param conn Connection object for output buffering
 * @param recv_len Length of received RTP packet
 * @param buf Buffer containing RTP packet (must be from buffer pool)
 * @param buf_ref Buffer reference for the buffer containing the RTP packet
 * @param old_seqn Pointer to store/track previous sequence number
 * @param not_first Pointer to track if this is not the first packet
 * @return number of payload bytes queued to the client (>=0), or -1 if buffer full
 */
int write_rtp_payload_to_client(struct connection_s *conn, int recv_len, uint8_t *buf,
                                buffer_ref_t *buf_ref, uint16_t *old_seqn, uint16_t *not_first);

#endif /* __RTP_H__ */
