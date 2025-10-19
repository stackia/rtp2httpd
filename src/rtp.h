#ifndef __RTP_H__
#define __RTP_H__

#include <stdint.h>
#include <sys/types.h>

/* Forward declarations */
typedef struct connection_s connection_t;
typedef struct buffer_ref_s buffer_ref_t;

/**
 * Extract payload from a packet with automatic RTP detection
 *
 * This function automatically detects whether the packet is RTP or raw UDP:
 * - If RTP packet (version 2): Strips RTP header and returns only the payload (and optionally sequence number)
 * - If non-RTP packet: Returns the entire packet as payload
 *
 * @param buf Buffer containing packet data
 * @param buf_len Length of data
 * @param payload Pointer to store payload location
 * @param size Pointer to store payload size
 * @param seqn Pointer to store RTP sequence number (can be NULL if not needed, only valid if return value is 1)
 * @return 1 if RTP packet, 0 if non-RTP packet, -1 on malformed RTP packet
 */
int rtp_get_payload(uint8_t *buf, size_t buf_len, uint8_t **payload, size_t *size, uint16_t *seqn);

/**
 * Clip buffer reference list to only valid RTP payload buffers, filtering out duplicates and invalid packets
 *
 * @param buf_ref_list Input buffer reference list containing RTP packets
 * @param last_seqn Pointer to store/track previous sequence number
 * @param not_first Pointer to track if this is not the first packet
 * @param total_payload_length [Out] Pointer to store total payload length of valid buffers (can be NULL)
 * @param log_label Label for logging
 * @return New buffer reference list containing only valid RTP payload buffers
 */
buffer_ref_t *rtp_clip_buffer_to_valid_payload(buffer_ref_t *buf_ref_list, uint16_t *last_seqn, int *not_first, size_t *total_payload_length, const char *log_label);

/**
 * Write RTP payload to client via connection output buffer, handling sequence numbers and duplicates
 * Uses true zero-copy by sending payload directly from buffer pool without memcpy
 *
 * @param conn Connection object for output buffering
 * @param buf_ref Buffer reference for the buffer containing the RTP packet
 * @param last_seqn Pointer to store/track previous sequence number
 * @param not_first Pointer to track if this is not the first packet
 * @return number of payload bytes queued to the client (>=0), or -1 if buffer full
 */
int rtp_queue_payload_to_client(connection_t *conn, buffer_ref_t *buf_ref_list, uint16_t *last_seqn, int *not_first);

#endif /* __RTP_H__ */
