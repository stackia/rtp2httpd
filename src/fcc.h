#ifndef __FCC_H__
#define __FCC_H__

#include "buffer_pool.h"
#include "service.h"
#include <netinet/in.h>
#include <stdbool.h>
#include <stdint.h>

/* Forward declarations */
typedef struct stream_context_s stream_context_t;

/* FCC Protocol Type - Based on vendor and port */
typedef enum {
  FCC_TYPE_TELECOM = 0, /* Telecom/ZTE/Fiberhome (FMT 2,3,4,5) */
  FCC_TYPE_HUAWEI = 1   /* Huawei (FMT 5,6,8,9,12) */
} fcc_type_t;

#define FCC_MAX_REDIRECTS 5

/* FCC Timeout Configuration */
#define FCC_TIMEOUT_SIGNALING_MS                                               \
  80 /* Timeout for signaling phase (FCC_STATE_REQUESTED or                    \
        FCC_STATE_UNICAST_PENDING) */
#define FCC_TIMEOUT_UNICAST_SEC                                                \
  1.0 /* Timeout for unicast media packets (FCC_STATE_UNICAST_ACTIVE) */
#define FCC_TIMEOUT_SYNC_WAIT_SEC                                              \
  15.0 /* Max wait time for server sync notification before joining multicast  \
        */

/* FCC State Machine - Based on Fast Channel Change Protocol */
typedef enum {
  FCC_STATE_INIT =
      0, /* Initial state - prepare FCC request or join multicast */
  FCC_STATE_REQUESTED,       /* FCC request sent, waiting for server response */
  FCC_STATE_UNICAST_PENDING, /* Server accepted, waiting for first unicast
                                packet */
  FCC_STATE_UNICAST_ACTIVE,  /* Receiving FCC unicast stream (fast push at 1.3x
                                speed) */
  FCC_STATE_MCAST_REQUESTED, /* Server notified to join multicast, transitioning
                              */
  FCC_STATE_MCAST_ACTIVE,    /* Fully switched to multicast reception */
  FCC_STATE_ERROR            /* Error state */
} fcc_state_t;

/* FCC Session Context - encapsulates all FCC-related state */
typedef struct {
  fcc_state_t state;
  fcc_type_t type;  /* FCC protocol type (Telecom or Huawei) */
  int status_index; /* Index in status_shared->clients array for state updates
                     */
  int fcc_sock;
  struct sockaddr_in *fcc_server;
  struct sockaddr_in fcc_client;
  uint16_t media_port;   /* RTP media port (network byte order, for direct
                            comparison with sin_port) */
  bool verify_server_ip; /* Verify server ip before processing packets */
  uint16_t current_seqn;
  uint16_t fcc_term_seqn;
  int fcc_term_sent;
  uint16_t not_first_packet;
  int redirect_count;         /* Number of redirects followed */
  int64_t unicast_start_time; /* Timestamp when unicast started (for sync wait
                                 timeout) */

  /* Huawei FCC specific fields */
  uint32_t session_id;        /* Session ID for NAT traversal correlation */
  uint8_t need_nat_traversal; /* NAT traversal support flag from server */

  /* Multicast pending buffer for smooth transition - zero-copy chain */
  buffer_ref_t *pending_list_head;
  buffer_ref_t *pending_list_tail;
  uint16_t mcast_pbuf_last_seqn;
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
 * - If fcc_term_sent=1 (normal flow sent termination): Skip sending, just
 * cleanup
 * - If fcc_term_sent=0 (abnormal termination): Send emergency termination
 * packet
 *
 * @param fcc FCC session structure to terminate and cleanup
 * @param service Service structure for termination message
 * @param epoll_fd Epoll file descriptor for socket cleanup
 */
void fcc_session_cleanup(fcc_session_t *fcc, service_t *service, int epoll_fd);

/**
 * Set FCC session state with logging and status update
 *
 * @param fcc FCC session structure
 * @param new_state New state to set
 * @param reason Reason for state change
 * @return 1 if state changed, 0 if no change
 */
int fcc_session_set_state(fcc_session_t *fcc, fcc_state_t new_state,
                          const char *reason);

/*
 * FCC Protocol Handler Functions
 */

/**
 * Stage 1: Initialize FCC socket and send request
 *
 * @param ctx Stream context containing FCC session and service info
 * @return 0 on success, -1 on error
 */
int fcc_initialize_and_request(stream_context_t *ctx);

/**
 * Stage 2: Handle server response (FMT 3)
 *
 * @param ctx Stream context
 * @param buf Response buffer
 * @param buf_len Buffer length
 * @return 0 on success, -1 for fallback to multicast, 1 for state restart
 */
int fcc_handle_server_response(stream_context_t *ctx, uint8_t *buf,
                               int buf_len);

/**
 * Stage 3: Handle synchronization notification (FMT 4)
 *
 * @param ctx Stream context
 * @param timeout_ms If non-zero, indicates this is called due to timeout
 * @return 0 on success
 */
int fcc_handle_sync_notification(stream_context_t *ctx, int timeout_ms);

/**
 * Stage 4: Handle RTP media packets from unicast stream
 *
 * @param ctx Stream context
 * @param buf_ref Buffer reference for zero-copy
 * @return 0 on success
 */
int fcc_handle_unicast_media(stream_context_t *ctx, buffer_ref_t *buf_ref);

/**
 * Handle multicast data during transition period
 *
 * @param ctx Stream context
 * @param buf_ref Buffer reference for zero-copy
 * @return 0 on success
 */
int fcc_handle_mcast_transition(stream_context_t *ctx, buffer_ref_t *buf_ref);

/**
 * Handle multicast data in active state
 *
 * @param ctx Stream context
 * @param buf_ref Buffer reference for zero-copy
 * @return 0 on success
 */
int fcc_handle_mcast_active(stream_context_t *ctx, buffer_ref_t *buf_ref);

/**
 * Send UDP packet 3 times to FCC server (for reliability)
 *
 * @param fd Socket file descriptor
 * @param buf Buffer to send
 * @param n Size of buffer
 * @param flags Send flags
 * @param addr Destination address
 * @param addr_len Address length
 * @return Number of bytes sent, or -1 on error
 */
ssize_t sendto_triple(int fd, const void *buf, size_t n, int flags,
                      struct sockaddr_in *addr, socklen_t addr_len);

#endif /* __FCC_H__ */
