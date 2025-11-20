#include "fcc_huawei.h"
#include "multicast.h"
#include "stream.h"
#include "utils.h"
#include <arpa/inet.h>
#include <errno.h>
#include <netinet/in.h>
#include <string.h>
#include <sys/socket.h>

/*
 * Huawei FCC Packet Builders
 */

/**
 * Build Huawei FCC request packet - FMT 5
 */
uint8_t *build_fcc_request_pk_huawei(struct addrinfo *maddr, uint32_t local_ip,
                                     uint16_t fcc_client_nport) {
  struct sockaddr_in *maddr_sin = (struct sockaddr_in *)maddr->ai_addr;

  static uint8_t pk[FCC_PK_LEN_REQ_HUAWEI];
  memset(&pk, 0, sizeof(pk));

  // RTCP Header (8 bytes)
  pk[0] = 0x80 | FCC_FMT_HUAWEI_REQ; // V=2, P=0, FMT=5
  pk[1] = 205;                       // PT=205 (Generic RTP Feedback)
  uint16_t len_words = htons(7);     // Length = 8 words - 1 = 7
  memcpy(pk + 2, &len_words, sizeof(len_words));
  // pk[4-7]: Sender SSRC = 0 (already zeroed by memset)

  // Media Source SSRC (4 bytes) - multicast IP address
  uint32_t ssrc = maddr_sin->sin_addr.s_addr;
  memcpy(pk + 8, &ssrc, sizeof(ssrc));

  // FCI - Feedback Control Information (16 bytes)
  // pk[12-19]: Reserved (8 bytes, already zeroed)

  // Local IP address (4 bytes) - network byte order
  uint32_t local_ip_be = htonl(local_ip);
  memcpy(pk + 20, &local_ip_be, sizeof(local_ip_be));

  // FCC client port (2 bytes) + Flag (2 bytes)
  memcpy(pk + 24, &fcc_client_nport, sizeof(fcc_client_nport));
  uint16_t flag_be = htons(0x8000);
  memcpy(pk + 26, &flag_be, sizeof(flag_be));

  // Redirect support flag (4 bytes) - 0x20000000
  uint32_t redirect_flag = htonl(0x20000000);
  memcpy(pk + 28, &redirect_flag, sizeof(redirect_flag));

  return pk;
}

/**
 * Build Huawei FCC NAT traversal packet - FMT 12
 */
uint8_t *build_fcc_nat_pk_huawei(uint32_t session_id) {
  static uint8_t pk[FCC_PK_LEN_NAT_HUAWEI];
  memset(&pk, 0, sizeof(pk));

  // Special header for NAT packet (not RTCP format)
  pk[0] = 0x00;
  pk[1] = 0x03;
  pk[2] = 0x00;
  pk[3] = 0x00;

  // Session ID - 4 bytes, network byte order
  uint32_t session_id_be = htonl(session_id);
  memcpy(pk + 4, &session_id_be, sizeof(session_id_be));

  return pk;
}

/**
 * Build Huawei FCC termination packet - FMT 9
 */
uint8_t *build_fcc_term_pk_huawei(struct addrinfo *maddr, uint16_t seqn) {
  struct sockaddr_in *maddr_sin = (struct sockaddr_in *)maddr->ai_addr;

  static uint8_t pk[FCC_PK_LEN_TERM_HUAWEI];
  memset(&pk, 0, sizeof(pk));

  // RTCP Header (8 bytes)
  pk[0] = 0x80 | FCC_FMT_HUAWEI_TERM; // V=2, P=0, FMT=9
  pk[1] = 205;                        // PT=205 (Generic RTP Feedback)
  uint16_t len_words = htons(3);      // Length = 4 words - 1 = 3
  memcpy(pk + 2, &len_words, sizeof(len_words));
  // pk[4-7]: Sender SSRC = 0 (already zeroed by memset)

  // Media Source SSRC (4 bytes) - multicast IP address
  uint32_t ssrc = maddr_sin->sin_addr.s_addr;
  memcpy(pk + 8, &ssrc, sizeof(ssrc));

  // FCI - Status byte and sequence number (4 bytes)
  if (seqn > 0) {
    pk[12] = 0x01; // Status: joined multicast successfully
    pk[13] = 0x00;
    uint16_t seq_be = htons(seqn); // First multicast sequence number
    memcpy(pk + 14, &seq_be, sizeof(seq_be));
  } else {
    pk[12] = 0x02; // Status: error, cannot join multicast
    pk[13] = 0x00;
    // pk[14-15]: seqn already 0 from memset
  }

  return pk;
}

int fcc_huawei_initialize_and_request(stream_context_t *ctx) {
  fcc_session_t *fcc = &ctx->fcc;
  int r;

  /* Huawei FCC: Send RSR (FMT 5) with local IP and FCC client port */
  uint32_t local_ip = get_local_ip_for_fcc();
  uint16_t fcc_client_nport = fcc->fcc_client.sin_port;

  if (local_ip == 0) {
    logger(LOG_ERROR, "FCC (Huawei): Cannot determine local IP for request");
    return -1;
  }

  uint8_t *request_pk = build_fcc_request_pk_huawei(ctx->service->addr,
                                                    local_ip, fcc_client_nport);

  r = sendto_triple(fcc->fcc_sock, request_pk, FCC_PK_LEN_REQ_HUAWEI, 0,
                    fcc->fcc_server, sizeof(*fcc->fcc_server));
  if (r < 0) {
    logger(LOG_ERROR, "FCC (Huawei): Unable to send request message: %s",
           strerror(errno));
    return -1;
  }

  char server_ip_str[INET_ADDRSTRLEN];
  struct in_addr local_addr;
  local_addr.s_addr = htonl(local_ip);
  char local_ip_str[INET_ADDRSTRLEN];
  inet_ntop(AF_INET, &fcc->fcc_server->sin_addr, server_ip_str,
            sizeof(server_ip_str));
  inet_ntop(AF_INET, &local_addr, local_ip_str, sizeof(local_ip_str));
  logger(LOG_DEBUG,
         "FCC (Huawei): Request (FMT 5) sent to server %s:%u (local %s:%u)",
         server_ip_str, ntohs(fcc->fcc_server->sin_port), local_ip_str,
         ntohs(fcc_client_nport));

  return 0;
}

int fcc_huawei_handle_server_response(stream_context_t *ctx, uint8_t *buf,
                                      int buf_len) {
  fcc_session_t *fcc = &ctx->fcc;
  uint8_t fmt = buf[0] & 0x1F;

  /* Check FMT type and dispatch */
  if (fmt == FCC_FMT_HUAWEI_RESP) {
    /* FMT 6 - Server Response */
    if (fcc->state != FCC_STATE_REQUESTED)
      return 0;

    if (buf[1] != 205) {
      logger(LOG_DEBUG, "FCC (Huawei): Unrecognized payload type: %u", buf[1]);
      return 0;
    }
  } else if (fmt == FCC_FMT_HUAWEI_SYN) {
    /* FMT 8 - Sync notification */
    return fcc_handle_sync_notification(ctx, 0);
  } else {
    logger(LOG_DEBUG, "FCC (Huawei): Unrecognized FMT: %u", fmt);
    return 0;
  }

  /* Handle FMT 6 - Huawei Server Response */
  uint8_t result_code = buf[12]; // 1 = success
  uint16_t type_be;
  memcpy(&type_be, buf + 14, sizeof(type_be));
  uint16_t type = ntohs(type_be); // 1=no unicast, 2=unicast, 3=redirect

  logger(LOG_DEBUG, "FCC (Huawei): Response received: result=%u, type=%u",
         result_code, type);

  if (result_code != 1) {
    logger(LOG_WARN,
           "FCC (Huawei): Server response error (result=%u), falling back to "
           "multicast",
           result_code);
    fcc_session_set_state(fcc, FCC_STATE_MCAST_ACTIVE, "Server error");
    stream_join_mcast_group(ctx);
    return 0;
  }

  if (type == 1) {
    /* No need for unicast, join multicast immediately */
    logger(LOG_INFO,
           "FCC (Huawei): Server says no unicast needed, joining multicast");
    fcc_session_set_state(fcc, FCC_STATE_MCAST_ACTIVE, "No unicast needed");
    stream_join_mcast_group(ctx);
  } else if (type == 2) {
    /* Server will send unicast stream */
    uint8_t nat_flag = buf[24];
    uint8_t need_nat_traversal = (nat_flag << 2) >> 7; // Extract bit 5
    uint16_t server_port_be;
    memcpy(&server_port_be, buf + 26, sizeof(server_port_be));
    uint32_t server_ip_be;
    memcpy(&server_ip_be, buf + 32, sizeof(server_ip_be));

    /* Check if server supports NAT traversal */
    if (buf_len > 28) {
      uint32_t session_id_be;
      memcpy(&session_id_be, buf + 28, sizeof(session_id_be));
      fcc->session_id = ntohl(session_id_be);
    }

    if (need_nat_traversal == 1 && fcc->session_id != 0) {
      /* NAT traversal supported - update server address and send NAT packet */
      fcc->need_nat_traversal = 1;

      /* Update unicast server IP and media port (keep fcc_server->sin_port as
       * control port7) */
      if (server_ip_be != 0) {
        fcc->fcc_server->sin_addr.s_addr = server_ip_be;
        fcc->verify_server_ip = true;
      }
      if (server_port_be != 0) {
        fcc->media_port = server_port_be;
      }

      /* Build and send NAT traversal packet (FMT 12) to punch hole in NAT */
      uint8_t *nat_pk = build_fcc_nat_pk_huawei(fcc->session_id);

      /* Send NAT packet to media port (for NAT hole punching on RTP port) */
      struct sockaddr_in media_addr;
      memcpy(&media_addr, fcc->fcc_server, sizeof(media_addr));
      if (fcc->media_port != 0) {
        media_addr.sin_port = fcc->media_port;
      }

      int r =
          sendto_triple(fcc->fcc_sock, nat_pk, FCC_PK_LEN_NAT_HUAWEI, 0,
                        (struct sockaddr_in *)&media_addr, sizeof(media_addr));
      if (r < 0) {
        logger(LOG_ERROR, "FCC (Huawei): Failed to send NAT packet: %s",
               strerror(errno));
      }

      logger(LOG_DEBUG, "FCC (Huawei): NAT traversal packet sent");
    }

    /* Record start time and transition to waiting for unicast */
    fcc->unicast_start_time = get_time_ms();
    fcc_session_set_state(fcc, FCC_STATE_UNICAST_PENDING,
                          "Server accepted request");
    logger(LOG_DEBUG, "FCC (Huawei): Waiting for unicast stream");
  } else if (type == 3) {
    /* Redirect to new server */
    fcc->redirect_count++;
    if (fcc->redirect_count > FCC_MAX_REDIRECTS) {
      logger(LOG_WARN,
             "FCC (Huawei): Too many redirects (%d), falling back to multicast",
             fcc->redirect_count);
      fcc_session_set_state(fcc, FCC_STATE_MCAST_ACTIVE, "Too many redirects");
      stream_join_mcast_group(ctx);
      return 0;
    }

    uint16_t server_port_be;
    memcpy(&server_port_be, buf + 26, sizeof(server_port_be));
    uint32_t server_ip_be;
    memcpy(&server_ip_be, buf + 32, sizeof(server_ip_be));

    if (server_ip_be != 0) {
      fcc->fcc_server->sin_addr.s_addr = server_ip_be;
      fcc->verify_server_ip = true;
    }
    if (server_port_be != 0) {
      fcc->fcc_server->sin_port = server_port_be;
    }

    logger(LOG_DEBUG, "FCC (Huawei): Server redirect to %s:%u (redirect #%d)",
           inet_ntoa(fcc->fcc_server->sin_addr),
           ntohs(fcc->fcc_server->sin_port), fcc->redirect_count);
    fcc_session_set_state(fcc, FCC_STATE_INIT, "Server redirect");
    return 1;
  } else {
    logger(LOG_WARN,
           "FCC (Huawei): Unsupported type=%u, falling back to multicast",
           type);
    fcc_session_set_state(fcc, FCC_STATE_MCAST_ACTIVE, "Unsupported type");
    stream_join_mcast_group(ctx);
  }

  return 0;
}

int fcc_huawei_send_term_packet(fcc_session_t *fcc, service_t *service,
                                uint16_t seqn, const char *reason) {
  int r;

  if (fcc->fcc_sock < 0 || !fcc->fcc_server) {
    logger(LOG_DEBUG, "FCC: Cannot send termination - missing socket/server");
    return -1;
  }

  /* Huawei FCC: Send SCR (FMT 9) termination packet */
  r = sendto_triple(
      fcc->fcc_sock, build_fcc_term_pk_huawei(service->addr, seqn),
      FCC_PK_LEN_TERM_HUAWEI, 0, fcc->fcc_server, sizeof(*fcc->fcc_server));
  if (r < 0) {
    logger(LOG_ERROR,
           "FCC (Huawei): Unable to send termination packet (FMT 9) (%s): %s",
           reason, strerror(errno));
    return -1;
  }
  logger(LOG_DEBUG,
         "FCC (Huawei): Termination packet (FMT 9) sent (%s), seqn=%u", reason,
         seqn);

  return 0;
}
