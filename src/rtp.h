#ifndef __RTP_H__
#define __RTP_H__

#include <stdint.h>
#include <sys/types.h>

/* Forward declarations */
typedef struct connection_s connection_t;
typedef struct buffer_ref_s buffer_ref_t;
typedef struct stream_context_s stream_context_t;

/**
 * Extract payload from a packet with automatic RTP detection
 *
 * This function automatically detects whether the packet is RTP or raw UDP:
 * - If RTP packet (version 2): Strips RTP header and returns only the payload (and optionally sequence number)
 * - If non-RTP packet: Returns the entire packet as payload
 *
 * @param buf Buffer containing packet data
 * @param recv_len Length of received data
 * @param payload Pointer to store payload location
 * @param size Pointer to store payload size
 * @param seqn Pointer to store RTP sequence number (can be NULL if not needed, only valid if return value is 1)
 * @return 1 if RTP packet, 0 if non-RTP packet, -1 on malformed RTP packet
 */
int rtp_get_payload(uint8_t *buf, int recv_len, uint8_t **payload, int *size, uint16_t *seqn);

/**
 * Write RTP payload to client via connection output buffer, handling sequence numbers and duplicates
 * Uses true zero-copy by sending payload directly from buffer pool without memcpy
 *
 * @param conn Connection object for output buffering
 * @param buf_ref Buffer reference for the buffer containing the RTP packet
 * @param old_seqn Pointer to store/track previous sequence number
 * @param not_first Pointer to track if this is not the first packet
 * @return number of payload bytes queued to the client (>=0), or -1 if buffer full
 */
int rtp_queue_buf(connection_t *conn, buffer_ref_t *buf_ref, uint16_t *old_seqn, uint16_t *not_first);

/**
 * RTP reordering and queueing with duplicate detection
 * Parses RTP packet once, caches result, performs reordering if enabled
 *
 * @param ctx Stream context containing reorder buffer
 * @param buf_ref Buffer reference for the buffer containing the packet
 * @return number of payload bytes queued (>=0), -1 if dropped (duplicate/buffer full), -2 if queue full
 */
int rtp_reorder_and_queue(stream_context_t *ctx, buffer_ref_t *buf_ref);

/**
 * Timeout recovery for RTP reordering buffer
 * Called from stream_tick when wait timeout expires
 *
 * @param ctx Stream context containing reorder buffer
 */
void rtp_reorder_timeout_recovery(stream_context_t *ctx);

#endif /* __RTP_H__ */
