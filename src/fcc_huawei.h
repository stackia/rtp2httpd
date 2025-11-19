#ifndef __FCC_HUAWEI_H__
#define __FCC_HUAWEI_H__

#include "fcc.h"
#include <netdb.h>
#include <stdint.h>

/* Huawei FCC Packet Lengths */
#define FCC_PK_LEN_REQ_HUAWEI 32  /* Huawei request packet (FMT 5) */
#define FCC_PK_LEN_NAT_HUAWEI 8   /* Huawei NAT traversal packet (FMT 12) */
#define FCC_PK_LEN_TERM_HUAWEI 16 /* Huawei termination packet (FMT 9) */

/* Huawei FCC FMT Types */
#define FCC_FMT_HUAWEI_REQ 5  /* RTCP Request */
#define FCC_FMT_HUAWEI_RESP 6 /* RTCP Response */
#define FCC_FMT_HUAWEI_SYN 8  /* RTCP Sync Notification */
#define FCC_FMT_HUAWEI_TERM 9 /* RTCP Termination */
#define FCC_FMT_HUAWEI_NAT 12 /* NAT Traversal packet */

/**
 * Build Huawei FCC request packet - FMT 5
 *
 * @param maddr Multicast address information
 * @param local_ip Local IP address (host byte order)
 * @param fcc_client_nport FCC client port (network byte order)
 * @return Pointer to static packet buffer
 */
uint8_t *build_fcc_request_pk_huawei(struct addrinfo *maddr, uint32_t local_ip,
                                     uint16_t fcc_client_nport);

/**
 * Build Huawei FCC NAT traversal packet - FMT 12
 *
 * @param session_id Session ID for NAT traversal
 * @return Pointer to static packet buffer
 */
uint8_t *build_fcc_nat_pk_huawei(uint32_t session_id);

/**
 * Build Huawei FCC termination packet - FMT 9
 *
 * @param maddr Multicast address information
 * @param seqn First multicast sequence number
 * @return Pointer to static packet buffer
 */
uint8_t *build_fcc_term_pk_huawei(struct addrinfo *maddr, uint16_t seqn);

/**
 * Initialize and send Huawei FCC request
 *
 * @param ctx Stream context
 * @return 0 on success, -1 on error
 */
int fcc_huawei_initialize_and_request(stream_context_t *ctx);

/**
 * Handle Huawei FCC server response (FMT 6)
 *
 * @param ctx Stream context
 * @param buf Response buffer
 * @param buf_len Buffer length
 * @return 0 on success, -1 for fallback to multicast, 1 for state restart
 */
int fcc_huawei_handle_server_response(stream_context_t *ctx, uint8_t *buf,
                                      int buf_len);

/**
 * Send Huawei FCC termination packet
 *
 * @param fcc FCC session
 * @param service Service structure
 * @param seqn Sequence number
 * @param reason Reason for termination
 * @return 0 on success, -1 on error
 */
int fcc_huawei_send_term_packet(fcc_session_t *fcc, service_t *service,
                                uint16_t seqn, const char *reason);

#endif /* __FCC_HUAWEI_H__ */
