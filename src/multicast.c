#include "multicast.h"
#include "buffer_pool.h"
#include "connection.h"
#include "fcc.h"
#include "rtp_fec.h"
#include "service.h"
#include "stream.h"
#include "utils.h"
#include "worker.h"
#include <arpa/inet.h>
#include <errno.h>
#include <net/if.h>
#include <netdb.h>
#include <netinet/in.h>
#include <netinet/ip.h>
#include <stdlib.h>
#include <string.h>
#include <sys/epoll.h>
#include <sys/socket.h>
#include <unistd.h>

/* IGMPv2/IGMPv3 Protocol Definitions */
#define IGMP_V2_MEMBERSHIP_REPORT 0x16
#define IGMP_V3_MEMBERSHIP_REPORT 0x22
#define IGMPV3_MODE_IS_INCLUDE 1
#define IGMPV3_MODE_IS_EXCLUDE 2
#define IGMPV3_CHANGE_TO_INCLUDE 3
#define IGMPV3_CHANGE_TO_EXCLUDE 4
#define IGMPV3_ALLOW_NEW_SOURCES 5
#define IGMPV3_BLOCK_OLD_SOURCES 6

/* IGMPv2 Membership Report structure */
struct igmpv2_report {
  uint8_t type;
  uint8_t max_resp_time;
  uint16_t csum;
  uint32_t group_addr;
} __attribute__((packed));

/* IGMPv3 Membership Report structures */
struct igmpv3_grec {
  uint8_t grec_type;
  uint8_t grec_auxwords;
  uint16_t grec_nsrcs;
  uint32_t grec_mca;
  uint32_t grec_src[0];
} __attribute__((packed));

struct igmpv3_report {
  uint8_t type;
  uint8_t resv1;
  uint16_t csum;
  uint16_t resv2;
  uint16_t ngrec;
  struct igmpv3_grec grec[0];
} __attribute__((packed));

/* Calculate Internet Checksum (RFC 1071) */
static uint16_t calculate_checksum(const void *data, size_t len) {
  const uint16_t *buf = data;
  uint32_t sum = 0;

  while (len > 1) {
    sum += *buf++;
    len -= 2;
  }

  if (len == 1) {
    sum += *(const uint8_t *)buf;
  }

  sum = (sum >> 16) + (sum & 0xFFFF);
  sum += (sum >> 16);

  return ~sum;
}

static int create_igmp_raw_socket(void) {
  int raw_sock;
  const char *upstream_if = get_upstream_interface_for_multicast();

  raw_sock = socket(AF_INET, SOCK_RAW, IPPROTO_IGMP);
  if (raw_sock < 0) {
    logger(LOG_ERROR, "Failed to create raw IGMP socket: %s (need root?)",
           strerror(errno));
    return -1;
  }

  if (connection_set_nonblocking(raw_sock) < 0) {
    logger(LOG_ERROR, "Failed to set raw IGMP socket non-blocking: %s",
           strerror(errno));
    close(raw_sock);
    return -1;
  }

  bind_to_upstream_interface(raw_sock, upstream_if);

  int hdrincl = 0;
  if (setsockopt(raw_sock, IPPROTO_IP, IP_HDRINCL, &hdrincl, sizeof(hdrincl)) <
      0) {
    logger(LOG_WARN, "Failed to set IP_HDRINCL: %s", strerror(errno));
  }

  unsigned char router_alert_option[4] = {IPOPT_RA, 4, 0x00, 0x00};
  if (setsockopt(raw_sock, IPPROTO_IP, IP_OPTIONS, router_alert_option,
                 sizeof(router_alert_option)) < 0) {
    logger(LOG_ERROR, "Failed to set Router Alert IP option: %s",
           strerror(errno));
    close(raw_sock);
    return -1;
  }

  if (upstream_if && upstream_if[0] != '\0') {
    struct ip_mreqn mreq;
    memset(&mreq, 0, sizeof(mreq));
    mreq.imr_ifindex = if_nametoindex(upstream_if);
    if (setsockopt(raw_sock, IPPROTO_IP, IP_MULTICAST_IF, &mreq, sizeof(mreq)) <
        0) {
      logger(LOG_WARN, "Failed to set IP_MULTICAST_IF: %s", strerror(errno));
    }
  }

  return raw_sock;
}

/*
 * Helper function to prepare multicast group request structures
 * Returns the socket level (SOL_IP or SOL_IPV6) and fills gr/gsr structures
 */
static int prepare_mcast_group_req(service_t *service, struct group_req *gr,
                                   struct group_source_req *gsr) {
  int level;
  const char *upstream_if;

  memcpy(&(gr->gr_group), service->addr->ai_addr, service->addr->ai_addrlen);

  switch (service->addr->ai_family) {
  case AF_INET:
    level = SOL_IP;
    gr->gr_interface = 0;
    break;

  case AF_INET6:
    level = SOL_IPV6;
    gr->gr_interface =
        ((struct sockaddr_in6 *)(uintptr_t)service->addr->ai_addr)
            ->sin6_scope_id;
    break;
  default:
    logger(LOG_ERROR, "Address family don't support mcast.");
    return -1;
  }

  upstream_if = get_upstream_interface_for_multicast();
  if (upstream_if && upstream_if[0] != '\0') {
    gr->gr_interface = if_nametoindex(upstream_if);
  }

  /* Prepare source-specific multicast structure if needed */
  if (service->msrc != NULL && strcmp(service->msrc, "") != 0) {
    gsr->gsr_group = gr->gr_group;
    gsr->gsr_interface = gr->gr_interface;
    memcpy(&(gsr->gsr_source), service->msrc_addr->ai_addr,
           service->msrc_addr->ai_addrlen);
  }

  return level;
}

/*
 * Helper function to perform multicast group join/leave operation
 * is_join: 1 for join, 0 for leave
 */
static int mcast_group_op(int sock, service_t *service, int is_join,
                          const char *op_name) {
  struct group_req gr;
  struct group_source_req gsr;
  int level, r;
  int op;
  int is_ssm; /* Source-Specific Multicast */

  level = prepare_mcast_group_req(service, &gr, &gsr);
  if (level < 0) {
    return -1;
  }

  /* Determine if this is source-specific multicast */
  is_ssm = (service->msrc != NULL && strcmp(service->msrc, "") != 0);

  /* Select the appropriate operation */
  if (is_ssm) {
    op = is_join ? MCAST_JOIN_SOURCE_GROUP : MCAST_LEAVE_SOURCE_GROUP;
    r = setsockopt(sock, level, op, &gsr, sizeof(gsr));
  } else {
    op = is_join ? MCAST_JOIN_GROUP : MCAST_LEAVE_GROUP;
    r = setsockopt(sock, level, op, &gr, sizeof(gr));
  }

  if (r < 0) {
    logger(LOG_ERROR, "Multicast: %s failed: %s", op_name, strerror(errno));
    return -1;
  }

  return 0;
}

static int join_mcast_group(service_t *service, int is_fec) {
  int sock, r;
  int on = 1;
  const char *upstream_if;
  struct sockaddr_storage bind_addr;
  socklen_t bind_addr_len;
  const char *log_prefix = is_fec ? "FEC" : "Multicast";

  sock = socket(service->addr->ai_family, service->addr->ai_socktype,
                service->addr->ai_protocol);
  if (sock < 0) {
    logger(LOG_ERROR, "%s: Failed to create socket: %s", log_prefix,
           strerror(errno));
    return -1;
  }

  /* Set socket to non-blocking mode for epoll */
  if (connection_set_nonblocking(sock) < 0) {
    logger(LOG_ERROR, "%s: Failed to set socket non-blocking: %s", log_prefix,
           strerror(errno));
    close(sock);
    return -1;
  }

  /* Set receive buffer size */
  if (set_socket_rcvbuf(sock, config.udp_rcvbuf_size) < 0) {
    logger(LOG_WARN, "%s: Failed to set SO_RCVBUF to %d: %s", log_prefix,
           config.udp_rcvbuf_size, strerror(errno));
  }

  r = setsockopt(sock, SOL_SOCKET, SO_REUSEADDR, &on, sizeof(on));
  if (r) {
    logger(LOG_ERROR, "%s: SO_REUSEADDR failed: %s", log_prefix,
           strerror(errno));
  }

  /* Determine which interface to use */
  upstream_if = get_upstream_interface_for_multicast();
  bind_to_upstream_interface(sock, upstream_if);

  /* Prepare bind address with appropriate port */
  memcpy(&bind_addr, service->addr->ai_addr, service->addr->ai_addrlen);
  bind_addr_len = service->addr->ai_addrlen;

  if (is_fec && service->fec_port > 0) {
    if (service->addr->ai_family == AF_INET) {
      ((struct sockaddr_in *)&bind_addr)->sin_port = htons(service->fec_port);
    } else if (service->addr->ai_family == AF_INET6) {
      ((struct sockaddr_in6 *)&bind_addr)->sin6_port = htons(service->fec_port);
    }
  }

  r = bind(sock, (struct sockaddr *)&bind_addr, bind_addr_len);
  if (r) {
    logger(LOG_ERROR, "%s: Cannot bind: %s", log_prefix, strerror(errno));
    close(sock);
    return -1;
  }

  /* Join the multicast group */
  if (mcast_group_op(sock, service, 1, "join") < 0) {
    logger(LOG_ERROR, "%s: Cannot join mcast group", log_prefix);
    close(sock);
    return -1;
  }

  if (is_fec) {
    logger(LOG_INFO, "%s: Successfully joined group (port %u)", log_prefix,
           service->fec_port);
  } else {
    logger(LOG_INFO, "%s: Successfully joined group", log_prefix);
  }
  return sock;
}

static int rejoin_mcast_group(service_t *service) {
  int raw_sock;
  struct sockaddr_in *mcast_addr;
  struct sockaddr_in *source_addr = NULL;
  struct sockaddr_in dest;
  struct igmpv2_report report_v2;
  struct igmpv3_report *report_v3;
  struct igmpv3_grec *grec;
  uint8_t packet_v3[sizeof(struct igmpv3_report) + sizeof(struct igmpv3_grec) +
                    sizeof(uint32_t)];
  size_t packet_len_v3 = 0;
  uint32_t group_addr;
  uint16_t nsrcs = 0;
  int is_ssm = 0;
  int result = -1;
  int sent_v2 = 0;
  int sent_v3 = 0;

  if (service->addr->ai_family != AF_INET) {
    logger(LOG_ERROR, "IGMP raw socket rejoin only supports IPv4");
    return -1;
  }

  mcast_addr = (struct sockaddr_in *)(uintptr_t)service->addr->ai_addr;
  group_addr = mcast_addr->sin_addr.s_addr;

  if (service->msrc != NULL && strcmp(service->msrc, "") != 0 &&
      service->msrc_addr != NULL) {
    if (service->msrc_addr->ai_family != AF_INET) {
      logger(LOG_ERROR, "IGMP raw socket rejoin: source address must be IPv4");
      return -1;
    }
    source_addr = (struct sockaddr_in *)(uintptr_t)service->msrc_addr->ai_addr;
    is_ssm = 1;
    nsrcs = 1;
  }

  raw_sock = create_igmp_raw_socket();
  if (raw_sock < 0) {
    return -1;
  }

  if (!is_ssm) {
    memset(&report_v2, 0, sizeof(report_v2));
    report_v2.type = IGMP_V2_MEMBERSHIP_REPORT;
    report_v2.group_addr = group_addr;
    report_v2.csum = calculate_checksum(&report_v2, sizeof(report_v2));

    memset(&dest, 0, sizeof(dest));
    dest.sin_family = AF_INET;
    /* RFC 2236 §3.7: Membership Reports go to the group address, not 224.0.0.2
     * (224.0.0.2 is for Leave Group messages only). */
    dest.sin_addr.s_addr = group_addr;

    if (sendto(raw_sock, &report_v2, sizeof(report_v2), 0,
               (struct sockaddr *)&dest, sizeof(dest)) < 0) {
      logger(LOG_ERROR, "Failed to send IGMPv2 Report: %s", strerror(errno));
    } else {
      sent_v2 = 1;
      char group_str[INET_ADDRSTRLEN];
      inet_ntop(AF_INET, &mcast_addr->sin_addr, group_str, sizeof(group_str));
      logger(LOG_DEBUG,
             "Multicast: Sent IGMPv2 Report for ASM group %s via raw socket",
             group_str);
    }
  } else {
    logger(LOG_DEBUG, "Skipping IGMPv2 report for SSM subscription");
  }

  memset(packet_v3, 0, sizeof(packet_v3));
  report_v3 = (struct igmpv3_report *)packet_v3;
  report_v3->type = IGMP_V3_MEMBERSHIP_REPORT;
  report_v3->ngrec = htons(1);

  grec = (struct igmpv3_grec *)(packet_v3 + sizeof(struct igmpv3_report));

  if (is_ssm) {
    grec->grec_type = IGMPV3_MODE_IS_INCLUDE;
    grec->grec_nsrcs = htons(nsrcs);
    grec->grec_mca = group_addr;
    uint32_t *src_list =
        (uint32_t *)((uintptr_t)grec + sizeof(struct igmpv3_grec));
    src_list[0] = source_addr->sin_addr.s_addr;
    packet_len_v3 = sizeof(struct igmpv3_report) + sizeof(struct igmpv3_grec) +
                    sizeof(uint32_t);
  } else {
    grec->grec_type = IGMPV3_MODE_IS_EXCLUDE;
    grec->grec_mca = group_addr;
    packet_len_v3 = sizeof(struct igmpv3_report) + sizeof(struct igmpv3_grec);
  }

  report_v3->csum = calculate_checksum(packet_v3, packet_len_v3);

  memset(&dest, 0, sizeof(dest));
  dest.sin_family = AF_INET;
  dest.sin_addr.s_addr = inet_addr("224.0.0.22");

  if (sendto(raw_sock, packet_v3, packet_len_v3, 0, (struct sockaddr *)&dest,
             sizeof(dest)) < 0) {
    logger(LOG_ERROR, "Failed to send IGMPv3 Report: %s", strerror(errno));
  } else {
    sent_v3 = 1;
    char group_str[INET_ADDRSTRLEN];
    inet_ntop(AF_INET, &mcast_addr->sin_addr, group_str, sizeof(group_str));
    if (is_ssm) {
      char source_str[INET_ADDRSTRLEN];
      inet_ntop(AF_INET, &source_addr->sin_addr, source_str,
                sizeof(source_str));
      logger(LOG_DEBUG,
             "Multicast: Sent IGMPv3 Report for SSM group %s source %s via raw "
             "socket",
             group_str, source_str);
    } else {
      logger(LOG_DEBUG,
             "Multicast: Sent IGMPv3 Report for ASM group %s via raw socket",
             group_str);
    }
  }

  close(raw_sock);

  if (sent_v2 || sent_v3) {
    result = 0;
  } else {
    logger(LOG_ERROR, "Multicast: Failed to send IGMPv2 and IGMPv3 reports");
  }

  return result;
}

/*
 * Multicast session management functions
 */

void mcast_session_init(mcast_session_t *session) {
  memset(session, 0, sizeof(mcast_session_t));
  session->initialized = 1;
  session->sock = -1;
}

void mcast_session_cleanup(mcast_session_t *session, int epoll_fd) {
  if (!session || !session->initialized) {
    return;
  }

  if (session->sock >= 0) {
    worker_cleanup_socket_from_epoll(epoll_fd, session->sock);
    session->sock = -1;
    logger(LOG_DEBUG, "Multicast: Socket closed");
  }

  session->initialized = 0;
}

int mcast_session_join(mcast_session_t *session, stream_context_t *ctx) {
  if (!session || !session->initialized) {
    return -1;
  }

  if (session->sock >= 0) {
    return 0; /* Already joined */
  }

  /* Join main RTP multicast group */
  int sock = join_mcast_group(ctx->service, 0);
  if (sock < 0) {
    return -1;
  }

  /* Register socket with epoll */
  struct epoll_event ev;
  ev.events = EPOLLIN;
  ev.data.fd = sock;
  if (epoll_ctl(ctx->epoll_fd, EPOLL_CTL_ADD, sock, &ev) < 0) {
    logger(LOG_ERROR, "Multicast: Failed to add socket to epoll: %s",
           strerror(errno));
    close(sock);
    return -1;
  }
  fdmap_set(sock, ctx->conn);
  logger(LOG_DEBUG, "Multicast: Socket registered with epoll");

  /* Reset timeout and rejoin timers */
  int64_t now = get_time_ms();
  session->last_data_time = now;
  session->last_rejoin_time = now;
  session->sock = sock;

  /* Join FEC multicast group if configured */
  if (ctx->fec.initialized && fec_is_enabled(&ctx->fec)) {
    int fec_sock = join_mcast_group(ctx->service, 1);
    if (fec_sock >= 0) {
      ev.events = EPOLLIN;
      ev.data.fd = fec_sock;
      if (epoll_ctl(ctx->epoll_fd, EPOLL_CTL_ADD, fec_sock, &ev) < 0) {
        logger(LOG_ERROR, "FEC: Failed to add socket to epoll: %s",
               strerror(errno));
        close(fec_sock);
      } else {
        ctx->fec.sock = fec_sock;
        fdmap_set(fec_sock, ctx->conn);
      }
    }
  }

  return 0;
}

int mcast_session_handle_event(mcast_session_t *session, stream_context_t *ctx,
                               int64_t now) {
  if (!session || !session->initialized || session->sock < 0) {
    return -1;
  }

  /* Allocate buffer from pool */
  buffer_ref_t *recv_buf = buffer_pool_alloc();
  if (!recv_buf) {
    logger(LOG_DEBUG, "Multicast: Buffer pool exhausted, dropping packet");
    session->last_data_time = now;
    /* Drain socket to prevent event loop spinning */
    uint8_t dummy[BUFFER_POOL_BUFFER_SIZE];
    recv(session->sock, dummy, sizeof(dummy), 0);
    return 0;
  }

  /* Receive into buffer */
  int actualr = recv(session->sock, recv_buf->data, BUFFER_POOL_BUFFER_SIZE, 0);
  if (actualr < 0) {
    if (errno != EAGAIN)
      logger(LOG_DEBUG, "Multicast: Receive failed: %s", strerror(errno));
    buffer_ref_put(recv_buf);
    return 0;
  }

  session->last_data_time = now;
  recv_buf->data_size = (size_t)actualr;

  int result = 0;

  /* Handle based on FCC state (if FCC initialized) */
  if (!ctx->fcc.initialized) {
    /* Direct multicast without FCC - forward to client */
    int processed_bytes = stream_process_rtp_payload(ctx, recv_buf);
    if (processed_bytes > 0) {
      ctx->total_bytes_sent += (uint64_t)processed_bytes;
    }
    buffer_ref_put(recv_buf);
    return 0;
  }

  switch (ctx->fcc.state) {
  case FCC_STATE_MCAST_ACTIVE:
    result = fcc_handle_mcast_active(ctx, recv_buf);
    break;

  case FCC_STATE_MCAST_REQUESTED:
    result = fcc_handle_mcast_transition(ctx, recv_buf);
    break;

  default:
    logger(LOG_DEBUG, "Received multicast data in unexpected FCC state: %d",
           ctx->fcc.state);
    break;
  }

  buffer_ref_put(recv_buf);
  return result;
}

int mcast_session_tick(mcast_session_t *session, service_t *service,
                       int64_t now) {
  if (!session || !session->initialized || session->sock < 0) {
    return 0;
  }

  /* Periodic multicast rejoin (if enabled) */
  if (config.mcast_rejoin_interval > 0) {
    int64_t elapsed_ms = now - session->last_rejoin_time;
    if (elapsed_ms >= config.mcast_rejoin_interval * 1000) {
      logger(LOG_DEBUG, "Multicast: Periodic rejoin (interval: %d seconds)",
             config.mcast_rejoin_interval);

      if (rejoin_mcast_group(service) == 0) {
        session->last_rejoin_time = now;
      } else {
        logger(LOG_ERROR,
               "Multicast: Failed to rejoin group, will retry next interval");
      }
    }
  }

  /* Check for multicast stream timeout */
  int64_t elapsed_ms = now - session->last_data_time;
  if (elapsed_ms >= MCAST_TIMEOUT_SEC * 1000) {
    logger(LOG_ERROR,
           "Multicast: No data received for %d seconds, closing connection",
           MCAST_TIMEOUT_SEC);
    return -1;
  }

  return 0;
}
