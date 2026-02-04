/**
 * STUN (Session Traversal Utilities for NAT) client implementation
 * RFC 5389 compliant for NAT traversal in RTSP UDP transport
 */

#ifndef __STUN_H__
#define __STUN_H__

#include <stddef.h>
#include <stdint.h>

/* STUN protocol constants */
#define STUN_DEFAULT_PORT 3478
#define STUN_TIMEOUT_MS 1000
#define STUN_MAX_RETRIES 2
#define STUN_TRANSACTION_ID_SIZE 12

/**
 * STUN state structure for tracking NAT traversal
 * Embedded in rtsp_session_t for per-session STUN handling
 */
typedef struct {
  int in_progress;       /* STUN request is pending */
  int completed;         /* STUN completed (success or timeout) */
  int64_t request_time_ms;              /* Timestamp when request was sent */
  int retry_count;                      /* Number of retries attempted */
  uint16_t mapped_rtp_port;             /* Discovered mapped RTP port (0=none) */
  uint16_t mapped_rtcp_port;            /* Discovered mapped RTCP port (0=none) */
  unsigned char transaction_id[STUN_TRANSACTION_ID_SIZE]; /* Transaction ID */
} stun_state_t;

/**
 * Send STUN Binding Request from the specified socket
 * The socket should be the RTP socket to ensure NAT mapping is for that socket
 * @param state STUN state structure
 * @param socket_fd UDP socket to send from (typically RTP socket)
 * @return 0 on success, -1 on error
 */
int stun_send_request(stun_state_t *state, int socket_fd);

/**
 * Parse STUN Binding Response and extract mapped address
 * Supports both XOR-MAPPED-ADDRESS (RFC 5389) and MAPPED-ADDRESS (RFC 3489)
 * @param state STUN state structure
 * @param data Received UDP packet data
 * @param len Length of received data
 * @return 0 on success (mapped address extracted), -1 on error/invalid
 */
int stun_parse_response(stun_state_t *state, const uint8_t *data, size_t len);

/**
 * Check if STUN request has timed out and handle retry/abort
 * Should be called periodically while in_progress is true
 * @param state STUN state structure
 * @param socket_fd UDP socket to send from (typically RTP socket)
 * @return Return values:
 *   0: Still in progress (waiting for response or retry sent)
 *   1: STUN completed (timeout after max retries, proceed without mapped port)
 */
int stun_check_timeout(stun_state_t *state, int socket_fd);

/**
 * Get the discovered mapped RTP port
 * @param state STUN state structure
 * @return Mapped port number, or 0 if not discovered
 */
uint16_t stun_get_mapped_port(const stun_state_t *state);

/**
 * Check if a UDP packet looks like a STUN response
 * STUN messages have first two bits as 00
 * @param data Packet data
 * @param len Packet length
 * @return 1 if likely STUN, 0 otherwise
 */
int stun_is_stun_packet(const uint8_t *data, size_t len);

#endif /* __STUN_H__ */
