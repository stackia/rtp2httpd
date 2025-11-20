#include "fcc_telecom.h"
#include "service.h"
#include "stream.h"
#include "utils.h"
#include <arpa/inet.h>
#include <errno.h>
#include <netinet/in.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

uint8_t *build_fcc_request_pk_telecom(struct addrinfo *maddr,
                                      uint16_t fcc_client_nport) {
  struct sockaddr_in *maddr_sin = (struct sockaddr_in *)maddr->ai_addr;

  static uint8_t pk[FCC_PK_LEN_REQ_TELECOM];
  memset(&pk, 0, sizeof(pk));

  // RTCP Header (8 bytes)
  pk[0] = 0x80 | FCC_FMT_TELECOM_REQ; // Version 2, Padding 0, FMT 2
  pk[1] = 205;                        // Type: Generic RTP Feedback (205)
  uint16_t len_words = htons(sizeof(pk) / 4 - 1); // Length
  memcpy(pk + 2, &len_words, sizeof(len_words));
  // pk[4-7]: Sender SSRC = 0 (already zeroed by memset)

  // Media source SSRC (4 bytes) - multicast IP address
  uint32_t ssrc = maddr_sin->sin_addr.s_addr;
  memcpy(pk + 8, &ssrc, sizeof(ssrc));

  // FCI - Feedback Control Information
  // pk[12-15]: Version 0, Reserved 3 bytes (already zeroed)
  memcpy(pk + 16, &fcc_client_nport,
         sizeof(fcc_client_nport)); // FCC client port
  memcpy(pk + 18, &maddr_sin->sin_port,
         sizeof(maddr_sin->sin_port)); // Mcast group port
  memcpy(pk + 20, &maddr_sin->sin_addr.s_addr,
         sizeof(maddr_sin->sin_addr.s_addr)); // Mcast group IP

  return pk;
}

uint8_t *build_fcc_term_pk_telecom(struct addrinfo *maddr, uint16_t seqn) {
  struct sockaddr_in *maddr_sin = (struct sockaddr_in *)maddr->ai_addr;

  static uint8_t pk[FCC_PK_LEN_TERM_TELECOM];
  memset(&pk, 0, sizeof(pk));

  // RTCP Header (8 bytes)
  pk[0] = 0x80 | FCC_FMT_TELECOM_TERM; // Version 2, Padding 0, FMT 5
  pk[1] = 205;                         // Type: Generic RTP Feedback (205)
  uint16_t len_words = htons(sizeof(pk) / 4 - 1); // Length
  memcpy(pk + 2, &len_words, sizeof(len_words));
  // pk[4-7]: Sender SSRC = 0 (already zeroed by memset)

  // Media source SSRC (4 bytes) - multicast IP address
  uint32_t ssrc = maddr_sin->sin_addr.s_addr;
  memcpy(pk + 8, &ssrc, sizeof(ssrc));

  // FCI - Feedback Control Information
  pk[12] = seqn ? 0 : 1; // Stop bit, 0 = normal, 1 = force
  // pk[13]: Reserved (already zeroed)
  uint16_t seq_be = htons(seqn); // First multicast packet sequence
  memcpy(pk + 14, &seq_be, sizeof(seq_be));

  return pk;
}

int fcc_telecom_initialize_and_request(stream_context_t *ctx) {
  fcc_session_t *fcc = &ctx->fcc;
  int r;

  /* Telecom FCC: Send standard request (FMT 2) */
  r = sendto_triple(fcc->fcc_sock,
                    build_fcc_request_pk_telecom(ctx->service->addr,
                                                 fcc->fcc_client.sin_port),
                    FCC_PK_LEN_REQ_TELECOM, 0, fcc->fcc_server,
                    sizeof(*fcc->fcc_server));
  if (r < 0) {
    logger(LOG_ERROR, "FCC (Telecom): Unable to send request message: %s",
           strerror(errno));
    return -1;
  }
  logger(LOG_DEBUG, "FCC (Telecom): Request (FMT 2) sent to server %s:%u",
         inet_ntoa(fcc->fcc_server->sin_addr),
         ntohs(fcc->fcc_server->sin_port));

  return 0;
}

int fcc_telecom_handle_server_response(stream_context_t *ctx, uint8_t *buf) {
  fcc_session_t *fcc = &ctx->fcc;
  uint8_t fmt = buf[0] & 0x1F;

  /* Check FMT type and dispatch */
  if (fmt == FCC_FMT_TELECOM_RESP) {
    /* FMT 3 - Server Response */
    if (fcc->state != FCC_STATE_REQUESTED)
      return 0;

    if (buf[1] != 205) {
      logger(LOG_DEBUG, "FCC (Telecom): Unrecognized payload type: %u", buf[1]);
      return 0;
    }
  } else if (fmt == FCC_FMT_TELECOM_SYN) {
    /* FMT 4 - Sync notification */
    return fcc_handle_sync_notification(ctx, 0);
  } else {
    logger(LOG_DEBUG, "FCC (Telecom): Unrecognized FMT: %u", fmt);
    return 0;
  }

  /* Handle FMT 3 - Telecom Server Response */
  uint8_t result_code = buf[12];
  uint8_t type = buf[13];
  uint16_t new_signal_port_be;
  memcpy(&new_signal_port_be, buf + 14, sizeof(new_signal_port_be));
  uint16_t new_media_port_be;
  memcpy(&new_media_port_be, buf + 16, sizeof(new_media_port_be));
  uint32_t new_fcc_ip_be;
  memcpy(&new_fcc_ip_be, buf + 20, sizeof(new_fcc_ip_be));
  uint32_t valid_time_be;
  memcpy(&valid_time_be, buf + 24, sizeof(valid_time_be));
  uint32_t valid_time = ntohl(valid_time_be);
  uint32_t speed_be;
  memcpy(&speed_be, buf + 28, sizeof(speed_be)); // bitrate in bps
  uint32_t speed = ntohl(speed_be);
  uint32_t speed_after_sync_be;
  memcpy(&speed_after_sync_be, buf + 32,
         sizeof(speed_after_sync_be)); // bitrate in bps
  uint32_t speed_after_sync = ntohl(speed_after_sync_be);

  /* Log response for debugging */
  char speed_str[32];
  char speed_after_sync_str[32];
  if (speed >= 1048576) {
    snprintf(speed_str, sizeof(speed_str), "%.2f Mbps", speed / 1048576.0);
  } else if (speed >= 1024) {
    snprintf(speed_str, sizeof(speed_str), "%.2f Kbps", speed / 1024.0);
  } else {
    snprintf(speed_str, sizeof(speed_str), "%u bps", speed);
  }
  if (speed_after_sync >= 1048576) {
    snprintf(speed_after_sync_str, sizeof(speed_after_sync_str), "%.2f Mbps",
             speed_after_sync / 1048576.0);
  } else if (speed_after_sync >= 1024) {
    snprintf(speed_after_sync_str, sizeof(speed_after_sync_str), "%.2f Kbps",
             speed_after_sync / 1024.0);
  } else {
    snprintf(speed_after_sync_str, sizeof(speed_after_sync_str), "%u bps",
             speed_after_sync);
  }
  logger(LOG_DEBUG,
         "FCC Response: FMT=3, result=%u, signal_port=%u, media_port=%u, "
         "valid_time=%u, speed=%s, speed_after_sync=%s",
         result_code, ntohs(new_signal_port_be), ntohs(new_media_port_be),
         valid_time, speed_str, speed_after_sync_str);

  if (result_code != 0) {
    logger(LOG_WARN,
           "FCC (Telecom): Server response error code: %u, falling back to "
           "multicast",
           result_code);
    fcc_session_set_state(fcc, FCC_STATE_MCAST_ACTIVE, "Server error");
    stream_join_mcast_group(ctx);
    return 0;
  }

  /* Update server endpoints if provided */
  int signal_port_changed = 0, media_port_changed = 0;

  if (new_signal_port_be && new_signal_port_be != fcc->fcc_server->sin_port) {
    fcc->fcc_server->sin_port = new_signal_port_be;
    logger(LOG_DEBUG, "FCC (Telecom): Server provided new signal port: %u",
           ntohs(fcc->fcc_server->sin_port));
    signal_port_changed = 1;
  }

  if (new_media_port_be && new_media_port_be != fcc->media_port) {
    fcc->media_port = new_media_port_be;
    logger(LOG_DEBUG, "FCC (Telecom): Server provided new media port: %u",
           ntohs(fcc->media_port));
    media_port_changed = 1;
  }

  if (new_fcc_ip_be != 0) {
    fcc->verify_server_ip = true;
    if (new_fcc_ip_be != fcc->fcc_server->sin_addr.s_addr) {
      fcc->fcc_server->sin_addr.s_addr = new_fcc_ip_be;
      logger(LOG_DEBUG, "FCC (Telecom): Server provided new IP: %s",
             inet_ntoa(fcc->fcc_server->sin_addr));
      signal_port_changed = 1;
      media_port_changed = 1;
    }
  }

  /* Handle different action codes */
  if (type == 1) {
    /* Join multicast immediately */
    logger(LOG_INFO,
           "FCC (Telecom): Server says no unicast needed, joining multicast");
    fcc_session_set_state(fcc, FCC_STATE_MCAST_ACTIVE, "No unicast needed");
    stream_join_mcast_group(ctx);
  } else if (type == 2) {
    /* Normal FCC flow - server will start unicast stream */
    if (media_port_changed && fcc->media_port) {
      struct sockaddr_in sintmp = *fcc->fcc_server;
      sintmp.sin_port = fcc->media_port;
      sendto_triple(fcc->fcc_sock, NULL, 0, 0, &sintmp, sizeof(sintmp));
    }
    if (signal_port_changed) {
      sendto_triple(fcc->fcc_sock, NULL, 0, 0, fcc->fcc_server,
                    sizeof(*fcc->fcc_server));
    }

    /* Record start time for unicast phase (for sync wait timeout) */
    fcc->unicast_start_time = get_time_ms();
    fcc_session_set_state(fcc, FCC_STATE_UNICAST_PENDING,
                          "Server accepted request");
    logger(
        LOG_DEBUG,
        "FCC (Telecom): Server accepted request, waiting for unicast stream");
  } else if (type == 3) {
    /* Redirect to new FCC server */
    fcc->redirect_count++;
    if (fcc->redirect_count > FCC_MAX_REDIRECTS) {
      logger(
          LOG_WARN,
          "FCC (Telecom): Too many redirects (%d), falling back to multicast",
          fcc->redirect_count);
      fcc_session_set_state(fcc, FCC_STATE_MCAST_ACTIVE, "Too many redirects");
      stream_join_mcast_group(ctx);
      return 0;
    }
    logger(LOG_DEBUG,
           "FCC (Telecom): Server requests redirection to new server %s:%u "
           "(redirect #%d)",
           inet_ntoa(fcc->fcc_server->sin_addr),
           ntohs(fcc->fcc_server->sin_port), fcc->redirect_count);
    fcc_session_set_state(fcc, FCC_STATE_INIT, "Server redirect");
    return 1;
  } else {
    logger(LOG_WARN,
           "FCC (Telecom): Unsupported type=%u, falling back to multicast",
           type);
    fcc_session_set_state(fcc, FCC_STATE_MCAST_ACTIVE, "Unsupported type");
    stream_join_mcast_group(ctx);
  }

  return 0;
}

int fcc_telecom_send_term_packet(fcc_session_t *fcc, service_t *service,
                                 uint16_t seqn, const char *reason) {
  int r;

  if (fcc->fcc_sock < 0 || !fcc->fcc_server) {
    logger(LOG_DEBUG, "FCC: Cannot send termination - missing socket/server");
    return -1;
  }

  if (!service) {
    logger(LOG_DEBUG,
           "FCC (Telecom): Cannot send termination - missing service");
    return -1;
  }

  /* Telecom FCC: Send standard termination packet (FMT 5) */
  r = sendto_triple(
      fcc->fcc_sock, build_fcc_term_pk_telecom(service->addr, seqn),
      FCC_PK_LEN_TERM_TELECOM, 0, fcc->fcc_server, sizeof(*fcc->fcc_server));
  if (r < 0) {
    logger(LOG_ERROR,
           "FCC (Telecom): Unable to send termination packet (FMT 5) (%s): %s",
           reason, strerror(errno));
    return -1;
  }
  logger(LOG_DEBUG,
         "FCC (Telecom): Termination packet (FMT 5) sent (%s), seqn=%u", reason,
         seqn);

  return 0;
}
