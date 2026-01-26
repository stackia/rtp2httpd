#ifndef __RTP_H__
#define __RTP_H__

#include <stdint.h>

/* Forward declarations */
typedef struct connection_s connection_t;
typedef struct buffer_ref_s buffer_ref_t;

/**
 * Extract payload from a packet with automatic RTP detection
 *
 * This function automatically detects whether the packet is RTP or raw UDP:
 * - If RTP packet (version 2): Strips RTP header and returns only the payload
 * (and optionally sequence number)
 * - If non-RTP packet: Returns the entire packet as payload
 *
 * @param buf Buffer containing packet data
 * @param recv_len Length of received data
 * @param payload Pointer to store payload location
 * @param size Pointer to store payload size
 * @param seqn Pointer to store RTP sequence number (can be NULL if not needed,
 * only valid if return value is 1)
 * @return 1 if RTP packet, 0 if non-RTP packet, -1 on malformed RTP packet
 */
int rtp_get_payload(uint8_t *buf, int recv_len, uint8_t **payload, int *size,
                    uint16_t *seqn);

/**
 * Queue RTP payload directly to client (used by reorder module)
 *
 * @param conn Connection object for output buffering
 * @param buf_ref Buffer reference (already pointing to payload)
 * @return number of payload bytes queued (>=0), or -1 if buffer full
 */
int rtp_queue_buf_direct(connection_t *conn, buffer_ref_t *buf_ref);

#endif /* __RTP_H__ */
