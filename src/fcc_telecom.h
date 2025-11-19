#ifndef __FCC_TELECOM_H__
#define __FCC_TELECOM_H__

#include "fcc.h"
#include <netdb.h>
#include <stdint.h>

/* Telecom FCC Packet Lengths */
#define FCC_PK_LEN_REQ_TELECOM 40  /* Telecom request packet (FMT 2) */
#define FCC_PK_LEN_TERM_TELECOM 16 /* Telecom termination packet (FMT 5) */

/* Telecom FCC FMT Types */
#define FCC_FMT_TELECOM_REQ 2  /* RTCP Request */
#define FCC_FMT_TELECOM_RESP 3 /* RTCP Response */
#define FCC_FMT_TELECOM_SYN 4  /* RTCP Sync Notification */
#define FCC_FMT_TELECOM_TERM 5 /* RTCP Termination */

/**
 * Build Telecom FCC request packet (FMT 2)
 *
 * @param maddr Multicast address information
 * @param fcc_client_nport FCC client port (network byte order)
 * @return Pointer to static packet buffer
 */
uint8_t *build_fcc_request_pk_telecom(struct addrinfo *maddr,
                                      uint16_t fcc_client_nport);

/**
 * Build Telecom FCC termination packet (FMT 5)
 *
 * @param maddr Multicast address information
 * @param seqn First multicast sequence number
 * @return Pointer to static packet buffer
 */
uint8_t *build_fcc_term_pk_telecom(struct addrinfo *maddr, uint16_t seqn);

/**
 * Initialize and send Telecom FCC request
 *
 * @param ctx Stream context
 * @return 0 on success, -1 on error
 */
int fcc_telecom_initialize_and_request(stream_context_t *ctx);

/**
 * Handle Telecom FCC server response (FMT 3)
 *
 * @param ctx Stream context
 * @param buf Response buffer
 * @return 0 on success, -1 for fallback to multicast, 1 for state restart
 */
int fcc_telecom_handle_server_response(stream_context_t *ctx, uint8_t *buf);

/**
 * Send Telecom FCC termination packet
 *
 * @param fcc FCC session
 * @param service Service structure
 * @param seqn Sequence number
 * @param reason Reason for termination
 * @return 0 on success, -1 on error
 */
int fcc_telecom_send_term_packet(fcc_session_t *fcc, service_t *service,
                                 uint16_t seqn, const char *reason);

#endif /* __FCC_TELECOM_H__ */
