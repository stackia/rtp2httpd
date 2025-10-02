#ifndef __FCC_H__
#define __FCC_H__

#include <stdint.h>
#include <netinet/in.h>
#include <netdb.h>
#include "rtp2httpd.h"
#include "buffer_config.h"

/* Forward declaration for stream context - full definition in stream.h */
struct stream_context_s;

#define FCC_PK_LEN_REQ 40
#define FCC_PK_LEN_TERM 16
#define FCC_SELECT_TIMEOUT_SEC 1
#define FCC_PENDING_BUFFER_MULTIPLIER 1500
#define FCC_MIN_BUFFER_PACKETS 10

/* FCC State Machine - Based on Fast Channel Change Protocol */
typedef enum
{
    FCC_STATE_INIT = 0,        /* Initial state - prepare FCC request or join multicast */
    FCC_STATE_REQUESTED,       /* FCC request sent, waiting for server response */
    FCC_STATE_UNICAST_ACTIVE,  /* Receiving FCC unicast stream (fast push at 1.3x speed) */
    FCC_STATE_MCAST_REQUESTED, /* Server notified to join multicast, transitioning */
    FCC_STATE_MCAST_ACTIVE,    /* Fully switched to multicast reception */
    FCC_STATE_ERROR            /* Error state */
} fcc_state_t;

/* FCC Session Context - encapsulates all FCC-related state */
typedef struct
{
    fcc_state_t state;
    int fcc_sock;
    struct sockaddr_in *fcc_server;
    struct sockaddr_in fcc_client;
    uint16_t mapped_pub_port;
    uint16_t media_port;
    uint16_t current_seqn;
    uint16_t fcc_term_seqn;
    int fcc_term_sent;
    uint16_t not_first_packet;

    /* Multicast pending buffer for smooth transition */
    uint8_t *mcast_pending_buf;
    uint8_t *mcast_pbuf_current;
    uint32_t mcast_pbuf_len;
    uint16_t mcast_pbuf_last_seqn;
    int mcast_pbuf_full;
} fcc_session_t;

/*
 * FCC Session Management Functions
 */

/**
 * Initialize FCC session
 *
 * @param fcc FCC session structure to initialize
 */
void fcc_session_init(fcc_session_t *fcc);

/**
 * Complete FCC session termination and cleanup
 *
 * This function performs cleanup and sends termination packet
 * ONLY if it hasn't been sent before during normal flow. This prevents
 * duplicate termination packets and follows the protocol correctly:
 *
 * - If fcc_term_sent=1 (normal flow sent termination): Skip sending, just cleanup
 * - If fcc_term_sent=0 (abnormal termination): Send emergency termination packet
 *
 * @param fcc FCC session structure to terminate and cleanup
 * @param service Service structure for termination message
 */
void fcc_session_cleanup(fcc_session_t *fcc, struct services_s *service);

/**
 * Set FCC session state with logging
 *
 * @param fcc FCC session structure
 * @param new_state New state to set
 * @param reason Reason for state change
 * @return 1 if state changed, 0 if no change
 */
int fcc_session_set_state(fcc_session_t *fcc, fcc_state_t new_state, const char *reason);

/*
 * FCC Protocol Handler Functions
 */

/**
 * Stage 1: Initialize FCC socket and send request
 *
 * @param ctx Stream context containing FCC session and service info
 * @return 0 on success, -1 on error
 */
int fcc_initialize_and_request(struct stream_context_s *ctx);

/**
 * Stage 2: Handle server response (FMT 3)
 *
 * @param ctx Stream context
 * @param buf Response buffer
 * @param buf_len Buffer length
 * @param peer_addr Peer address
 * @return 0 on success, -1 for fallback to multicast, 1 for state restart
 */
int fcc_handle_server_response(struct stream_context_s *ctx, uint8_t *buf, int buf_len,
                               struct sockaddr_in *peer_addr);

/**
 * Stage 3: Handle synchronization notification (FMT 4)
 *
 * @param ctx Stream context
 * @return 0 on success
 */
int fcc_handle_sync_notification(struct stream_context_s *ctx);

/**
 * Stage 4: Handle RTP media packets from unicast stream
 *
 * @param ctx Stream context
 * @param buf Data buffer
 * @param buf_len Buffer length
 * @return 0 on success
 */
int fcc_handle_unicast_media(struct stream_context_s *ctx, uint8_t *buf, int buf_len);

/**
 * Handle multicast data during transition period
 *
 * @param ctx Stream context
 * @param buf Data buffer
 * @param buf_len Buffer length
 * @return 0 on success
 */
int fcc_handle_mcast_transition(struct stream_context_s *ctx, uint8_t *buf, int buf_len);

/**
 * Handle multicast data in active state
 *
 * @param ctx Stream context
 * @param buf Data buffer
 * @param buf_len Buffer length
 * @return 0 on success
 */
int fcc_handle_mcast_active(struct stream_context_s *ctx, uint8_t *buf, int buf_len);

#endif /* __FCC_H__ */
