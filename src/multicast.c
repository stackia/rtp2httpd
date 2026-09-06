#include "multicast.h"
#include "buffer_pool.h"
#include "connection.h"
#include "fcc.h"
#include "platform_compat.h"
#include "poller.h"
#include "rtp.h"
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

static int create_igmp_raw_socket(service_t *service) {
  int raw_sock;
  const char *upstream_if = service->ifname;

  raw_sock = socket(AF_INET, SOCK_RAW, IPPROTO_IGMP);
  if (raw_sock < 0) {
    logger(LOG_ERROR, "Failed to create raw IGMP socket: %s (need root?)", strerror(errno));
    return -1;
  }

  if (connection_set_nonblocking(raw_sock) < 0) {
    logger(LOG_ERROR, "Failed to set raw IGMP socket non-blocking: %s", strerror(errno));
    close(raw_sock);
    return -1;
  }

  bind_to_upstream_interface(raw_sock, upstream_if);

  int hdrincl = 0;
  if (setsockopt(raw_sock, IPPROTO_IP, IP_HDRINCL, &hdrincl, sizeof(hdrincl)) < 0) {
    logger(LOG_WARN, "Failed to set IP_HDRINCL: %s", strerror(errno));
  }

  unsigned char router_alert_option[4] = {IPOPT_RA, 4, 0x00, 0x00};
  if (setsockopt(raw_sock, IPPROTO_IP, IP_OPTIONS, router_alert_option, sizeof(router_alert_option)) < 0) {
    logger(LOG_ERROR, "Failed to set Router Alert IP option: %s", strerror(errno));
    close(raw_sock);
    return -1;
  }

  if (upstream_if && upstream_if[0] != '\0') {
    struct ip_mreqn mreq;
    memset(&mreq, 0, sizeof(mreq));
    mreq.imr_ifindex = if_nametoindex(upstream_if);
    if (setsockopt(raw_sock, IPPROTO_IP, IP_MULTICAST_IF, &mreq, sizeof(mreq)) < 0) {
      logger(LOG_WARN, "Failed to set IP_MULTICAST_IF: %s", strerror(errno));
    }
  }

  return raw_sock;
}

/*
 * Helper function to perform multicast group join/leave operation
 * is_join: 1 for join, 0 for leave
 */
static int mcast_group_op(int sock, service_t *service, int is_join, const char *op_name) {
  const char *upstream_if;
  const struct sockaddr *source_addr = NULL;
  socklen_t source_addr_len = 0;
  unsigned int ifindex = 0;
  int r;
  int is_ssm; /* Source-Specific Multicast */

  if (!service || !service->addr || !service->addr->ai_addr) {
    logger(LOG_ERROR, "Multicast: invalid service address");
    return -1;
  }

  if (service->addr->ai_family != AF_INET && service->addr->ai_family != AF_INET6) {
    logger(LOG_ERROR, "Multicast: address family is not supported");
    return -1;
  }

  upstream_if = service->ifname;
  if (upstream_if && upstream_if[0] != '\0') {
    ifindex = if_nametoindex(upstream_if);
    if (ifindex == 0) {
      logger(LOG_ERROR, "Multicast: interface %s does not exist", upstream_if);
      return -1;
    }
  } else if (service->addr->ai_family == AF_INET6) {
    ifindex = ((struct sockaddr_in6 *)(uintptr_t)service->addr->ai_addr)->sin6_scope_id;
  }

  is_ssm = (service->msrc != NULL && strcmp(service->msrc, "") != 0);
  if (is_ssm) {
    if (!service->msrc_addr || !service->msrc_addr->ai_addr) {
      logger(LOG_ERROR, "Multicast: source-specific group has no source address");
      return -1;
    }
    if (service->msrc_addr->ai_family != service->addr->ai_family) {
      logger(LOG_ERROR, "Multicast: source address family must match group address family");
      return -1;
    }
    source_addr = service->msrc_addr->ai_addr;
    source_addr_len = service->msrc_addr->ai_addrlen;
  }

  r = platform_mcast_group_op(sock, service->addr->ai_family, service->addr->ai_addr, service->addr->ai_addrlen,
                              source_addr, source_addr_len, ifindex, is_join);
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

  sock = socket(service->addr->ai_family, service->addr->ai_socktype, service->addr->ai_protocol);
  if (sock < 0) {
    logger(LOG_ERROR, "%s: Failed to create socket: %s", log_prefix, strerror(errno));
    return -1;
  }

  /* Set socket to non-blocking mode for epoll */
  if (connection_set_nonblocking(sock) < 0) {
    logger(LOG_ERROR, "%s: Failed to set socket non-blocking: %s", log_prefix, strerror(errno));
    close(sock);
    return -1;
  }

  /* Set receive buffer size */
  if (set_socket_rcvbuf(sock, config.udp_rcvbuf_size) < 0) {
    logger(LOG_WARN, "%s: Failed to set SO_RCVBUF to %d: %s", log_prefix, config.udp_rcvbuf_size, strerror(errno));
  }

  r = setsockopt(sock, SOL_SOCKET, SO_REUSEADDR, &on, sizeof(on));
  if (r) {
    logger(LOG_ERROR, "%s: SO_REUSEADDR failed: %s", log_prefix, strerror(errno));
  }

#ifdef SO_REUSEPORT
  /* SO_REUSEPORT allows multiple sockets to bind to the same multicast
   * address:port. Required on macOS/BSD for reliable multicast receive. */
  r = setsockopt(sock, SOL_SOCKET, SO_REUSEPORT, &on, sizeof(on));
  if (r) {
    logger(LOG_DEBUG, "%s: SO_REUSEPORT failed: %s", log_prefix, strerror(errno));
  }
#endif

  /* Determine which interface to use */
  upstream_if = service->ifname;
  bind_to_upstream_interface(sock, upstream_if);

  /* Prepare bind address with appropriate port */
  memset(&bind_addr, 0, sizeof(bind_addr));
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
    logger(LOG_INFO, "%s: Successfully joined group (port %u)", log_prefix, service->fec_port);
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
  uint8_t packet_v3[sizeof(struct igmpv3_report) + sizeof(struct igmpv3_grec) + sizeof(uint32_t)];
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

  if (service->msrc != NULL && strcmp(service->msrc, "") != 0 && service->msrc_addr != NULL) {
    if (service->msrc_addr->ai_family != AF_INET) {
      logger(LOG_ERROR, "IGMP raw socket rejoin: source address must be IPv4");
      return -1;
    }
    source_addr = (struct sockaddr_in *)(uintptr_t)service->msrc_addr->ai_addr;
    is_ssm = 1;
    nsrcs = 1;
  }

  raw_sock = create_igmp_raw_socket(service);
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

    if (sendto(raw_sock, &report_v2, sizeof(report_v2), 0, (struct sockaddr *)&dest, sizeof(dest)) < 0) {
      logger(LOG_ERROR, "Failed to send IGMPv2 Report: %s", strerror(errno));
    } else {
      sent_v2 = 1;
      char group_str[INET_ADDRSTRLEN];
      inet_ntop(AF_INET, &mcast_addr->sin_addr, group_str, sizeof(group_str));
      logger(LOG_DEBUG, "Multicast: Sent IGMPv2 Report for ASM group %s via raw socket", group_str);
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
    uint32_t *src_list = (uint32_t *)((uintptr_t)grec + sizeof(struct igmpv3_grec));
    src_list[0] = source_addr->sin_addr.s_addr;
    packet_len_v3 = sizeof(struct igmpv3_report) + sizeof(struct igmpv3_grec) + sizeof(uint32_t);
  } else {
    grec->grec_type = IGMPV3_MODE_IS_EXCLUDE;
    grec->grec_mca = group_addr;
    packet_len_v3 = sizeof(struct igmpv3_report) + sizeof(struct igmpv3_grec);
  }

  report_v3->csum = calculate_checksum(packet_v3, packet_len_v3);

  memset(&dest, 0, sizeof(dest));
  dest.sin_family = AF_INET;
  dest.sin_addr.s_addr = inet_addr("224.0.0.22");

  if (sendto(raw_sock, packet_v3, packet_len_v3, 0, (struct sockaddr *)&dest, sizeof(dest)) < 0) {
    logger(LOG_ERROR, "Failed to send IGMPv3 Report: %s", strerror(errno));
  } else {
    sent_v3 = 1;
    char group_str[INET_ADDRSTRLEN];
    inet_ntop(AF_INET, &mcast_addr->sin_addr, group_str, sizeof(group_str));
    if (is_ssm) {
      char source_str[INET_ADDRSTRLEN];
      inet_ntop(AF_INET, &source_addr->sin_addr, source_str, sizeof(source_str));
      logger(LOG_DEBUG,
             "Multicast: Sent IGMPv3 Report for SSM group %s source %s via raw "
             "socket",
             group_str, source_str);
    } else {
      logger(LOG_DEBUG, "Multicast: Sent IGMPv3 Report for ASM group %s via raw socket", group_str);
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

/* Each worker owns its registry. Socket membership and timers live here,
 * independently of the client that first requested the source. */
struct mcast_source_s {
  int sock;
  int fec_sock;
  int epoll_fd;
  unsigned int ifindex;
  unsigned int refs;
  int failed;
  int64_t last_data_time;
  int64_t last_rejoin_time;
  int rejoin_unsupported_warned;
  service_t *service; /* Deep copy with the effective multicast interface frozen */
  mcast_session_t *subscribers;
  mcast_session_t *packet_subscribers;
  unsigned int batch_clients;
  int shared_output;
  rtp_reorder_t reorder;
  buffer_ref_t *batch;
  int packet_type;
  int batch_packet_type;
  int64_t batch_since;
  int64_t next_receive;
  int64_t receive_check_since;
  int receive_delay_max;
  int receive_coalesced;
  unsigned int receive_packet_limit;
  unsigned int receive_check_packets;
  mcast_source_t *receive_next;
  mcast_source_t **receive_link;
  mcast_source_t *next;
};

static mcast_source_t *mcast_sources;
static mcast_source_t *receive_head;

/* Only active coalesced sources enter this list. Idle channels add no work to
 * the worker's timeout calculation, and destruction unlinks in constant time. */
static void mcast_receive_unlink(mcast_source_t *source) {
  if (!source->receive_link)
    return;
  *source->receive_link = source->receive_next;
  if (source->receive_next)
    source->receive_next->receive_link = source->receive_link;
  source->receive_link = NULL;
  source->receive_next = NULL;
}

static void mcast_source_flush(mcast_source_t *source);
static int mcast_source_append(void *arg, buffer_ref_t *packet);

/* Compare resolved endpoints, never channel names, URL spelling or sockaddr
 * padding. The source port does not participate in an IGMP source filter. */
static int mcast_address_equal(const struct addrinfo *a, const struct addrinfo *b, int compare_port) {
  if (!a || !b)
    return a == b;
  if (a->ai_family != b->ai_family)
    return 0;
  if (a->ai_family == AF_INET) {
    const struct sockaddr_in *sa = (const struct sockaddr_in *)(uintptr_t)a->ai_addr;
    const struct sockaddr_in *sb = (const struct sockaddr_in *)(uintptr_t)b->ai_addr;
    return sa->sin_addr.s_addr == sb->sin_addr.s_addr && (!compare_port || sa->sin_port == sb->sin_port);
  }
  if (a->ai_family == AF_INET6) {
    const struct sockaddr_in6 *sa = (const struct sockaddr_in6 *)(uintptr_t)a->ai_addr;
    const struct sockaddr_in6 *sb = (const struct sockaddr_in6 *)(uintptr_t)b->ai_addr;
    return memcmp(&sa->sin6_addr, &sb->sin6_addr, sizeof(sa->sin6_addr)) == 0 &&
           sa->sin6_scope_id == sb->sin6_scope_id && (!compare_port || sa->sin6_port == sb->sin6_port);
  }
  return 0;
}

static void mcast_source_free(mcast_source_t *source) {
  mcast_receive_unlink(source);
  if (source->sock >= 0)
    worker_cleanup_socket_from_epoll(source->epoll_fd, source->sock);
  if (source->fec_sock >= 0)
    worker_cleanup_socket_from_epoll(source->epoll_fd, source->fec_sock);
  rtp_reorder_cleanup(&source->reorder);
  buffer_ref_put(source->batch);
  service_free(source->service);
  free(source);
}

void mcast_session_init(mcast_session_t *session) {
  memset(session, 0, sizeof(*session));
  session->initialized = 1;
  session->sock = -1;
  session->fec_sock = -1;
}

void mcast_session_cleanup(mcast_session_t *session) {
  if (!session || !session->initialized)
    return;

  mcast_source_t *source = session->source;
  if (source) {
    mcast_session_t **subscriber = &source->subscribers;
    while (*subscriber && *subscriber != session)
      subscriber = &(*subscriber)->next;
    if (*subscriber)
      *subscriber = session->next;
    if (session->batched) {
      source->batch_clients--;
    } else {
      mcast_session_t **packet_subscriber = &source->packet_subscribers;
      while (*packet_subscriber && *packet_subscriber != session)
        packet_subscriber = &(*packet_subscriber)->packet_next;
      if (*packet_subscriber)
        *packet_subscriber = session->packet_next;
    }
    source->refs--;
    logger(LOG_DEBUG, "Multicast: Subscriber detached (fd=%d, refs=%u)", source->sock, source->refs);
    if (source->refs == 0) {
      mcast_source_t **entry = &mcast_sources;
      while (*entry && *entry != source)
        entry = &(*entry)->next;
      if (*entry)
        *entry = source->next;
      logger(LOG_DEBUG, "Multicast: Last subscriber left, releasing shared source (fd=%d)", source->sock);
      mcast_source_free(source);
    } else {
      /* Reassign event dispatch before the departing connection is freed. */
      fdmap_set(source->sock, source->subscribers->ctx->conn);
      if (source->fec_sock >= 0)
        fdmap_set(source->fec_sock, source->subscribers->ctx->conn);
    }
  }
  session->source = NULL;
  session->ctx = NULL;
  session->next = NULL;
  session->packet_next = NULL;
  session->batched = 0;
  session->sock = -1;
  session->fec_sock = -1;
  session->initialized = 0;
}

int mcast_session_join(mcast_session_t *session, stream_context_t *ctx) {
  if (!session || !session->initialized || !ctx || !ctx->service || !ctx->service->addr)
    return -1;
  if (session->source)
    return 0;

  service_t *service = ctx->service;
  const char *ifname = get_upstream_interface_for_multicast(service->ifname);
  unsigned int ifindex = 0;
  if (ifname && ifname[0]) {
    ifindex = if_nametoindex(ifname);
    if (!ifindex) {
      logger(LOG_ERROR, "Multicast: interface %s does not exist", ifname);
      return -1;
    }
  } else if (service->addr->ai_family == AF_INET6) {
    ifindex = ((const struct sockaddr_in6 *)(uintptr_t)service->addr->ai_addr)->sin6_scope_id;
  }

  mcast_source_t *source;
  for (source = mcast_sources; source; source = source->next) {
    if (!source->failed && source->epoll_fd == ctx->epoll_fd && source->ifindex == ifindex &&
        source->service->fec_port == service->fec_port &&
        mcast_address_equal(source->service->addr, service->addr, 1) &&
        mcast_address_equal(source->service->msrc_addr, service->msrc_addr, 0))
      break;
  }

  /* Ordinary subscribers use the source's reorder window. Allocate a private
   * window only for packet delivery, including late joins after in-band FEC. */
  int private_output =
      (source ? !source->shared_output : service->fec_port > 0) || ctx->snapshot.initialized || ctx->fcc.initialized;
  if (private_output && !ctx->reorder.initialized && rtp_reorder_init(&ctx->reorder, service->fec_port > 0) < 0) {
    logger(LOG_ERROR, "Multicast: Failed to initialize private RTP reorder buffer");
    return -1;
  }

  if (!source) {
    source = calloc(1, sizeof(*source));
    if (!source)
      return -1;
    source->sock = -1;
    source->fec_sock = -1;
    source->epoll_fd = ctx->epoll_fd;
    source->ifindex = ifindex;
    source->service = service_clone(service);
    if (!source->service) {
      mcast_source_free(source);
      return -1;
    }
    free(source->service->ifname);
    source->service->ifname = strdup(ifname ? ifname : "");
    if (!source->service->ifname) {
      mcast_source_free(source);
      return -1;
    }
    if (service->fec_port == 0) {
      if (rtp_reorder_init(&source->reorder, 0) < 0) {
        mcast_source_free(source);
        return -1;
      }
      source->shared_output = 1;
      source->reorder.deliver = mcast_source_append;
      source->reorder.deliver_arg = source;
    }
    source->sock = join_mcast_group(source->service, 0);
    int receive_bytes = 0;
    socklen_t receive_length = sizeof(receive_bytes);
    if (source->sock >= 0 && getsockopt(source->sock, SOL_SOCKET, SO_RCVBUF, &receive_bytes, &receive_length) == 0) {
      source->receive_delay_max = receive_bytes >= 256 * 1024 ? 2 : receive_bytes >= 128 * 1024 ? 1 : 0;
      /* Reserve ample headroom for kernel packet overhead and scheduling
       * jitter. A busy source switches back to readiness-driven reads. */
      source->receive_packet_limit = (unsigned int)receive_bytes / (BUFFER_POOL_BUFFER_SIZE * 8);
      if (source->receive_packet_limit > 32)
        source->receive_packet_limit = 32;
    }
    source->receive_coalesced = source->receive_delay_max != 0;
    uint32_t read_events = POLLER_IN | (source->receive_coalesced ? POLLER_ONESHOT : POLLER_LEVEL);
    if (source->sock < 0 || poller_add(ctx->epoll_fd, source->sock, read_events) < 0) {
      mcast_source_free(source);
      return -1;
    }
    if (service->fec_port > 0) {
      source->fec_sock = join_mcast_group(source->service, 1);
      if (source->fec_sock >= 0 && poller_add(ctx->epoll_fd, source->fec_sock, POLLER_IN) < 0) {
        close(source->fec_sock);
        source->fec_sock = -1;
      }
    }
    source->last_data_time = get_time_ms();
    source->last_rejoin_time = source->last_data_time;
    source->next = mcast_sources;
    mcast_sources = source;
  } else {
    logger(LOG_DEBUG, "Multicast: Reusing shared source (fd=%d)", source->sock);
  }

  /* A newly attached viewer starts after the current batch, not with bytes
   * already delivered during its private FCC/snapshot processing. */
  mcast_source_flush(source);

  session->source = source;
  session->ctx = ctx;
  session->sock = source->sock;
  session->fec_sock = source->fec_sock;
  session->next = source->subscribers;
  source->subscribers = session;
  source->refs++;
  session->batched = source->shared_output && !ctx->snapshot.initialized && !ctx->fcc.initialized;
  if (session->batched) {
    source->batch_clients++;
  } else {
    session->packet_next = source->packet_subscribers;
    source->packet_subscribers = session;
  }
  fdmap_set(source->sock, ctx->conn);
  if (source->fec_sock >= 0)
    fdmap_set(source->fec_sock, ctx->conn);
  logger(LOG_DEBUG, "Multicast: Subscriber attached (fd=%d, refs=%u)", source->sock, source->refs);
  return 0;
}

/* Only queue metadata is private. The immutable payload stays alive until
 * every send queue releases its reference. */
static void mcast_source_fanout(mcast_source_t *source, buffer_ref_t *batch, int packet_type, int flush) {
  for (mcast_session_t *session = source->subscribers; session; session = session->next) {
    stream_context_t *ctx = session->ctx;
    if (!session->batched || session->failed || ctx->conn->state == CONN_CLOSING)
      continue;
    buffer_ref_t *view;
    if (source->refs == 1) {
      /* One subscriber needs no separate mutable send view. */
      view = batch;
      buffer_ref_get(view);
    } else {
      view = buffer_ref_view(batch);
    }
    if (!view) {
      session->failed = 1;
      continue;
    }
    stream_metadata_note_media(ctx, packet_type, (uint8_t *)view->data + view->data_offset, (int)view->data_size,
                               ctx->fcc.initialized ? STREAM_MEDIA_ORIGIN_FCC_MULTICAST
                                                    : STREAM_MEDIA_ORIGIN_MULTICAST);
    if (rtp_queue_buf_direct(ctx->conn, view) >= 0 && flush && view->data_size < SEND_QUEUE_BATCH_BYTES) {
      connection_schedule_write(ctx->conn);
    }
    buffer_ref_put(view);
  }
}

static void mcast_source_flush(mcast_source_t *source) {
  buffer_ref_t *batch = source->batch;
  if (!batch)
    return;
  source->batch = NULL;
  if (source->batch_clients > 1 && batch->data_size >= BUFFER_POOL_BATCH_SIZE - BUFFER_POOL_BUFFER_SIZE)
    buffer_ref_snapshot(batch);
  mcast_source_fanout(source, batch, source->batch_packet_type, 1);
  buffer_ref_put(batch);
}

static int mcast_source_append(void *arg, buffer_ref_t *packet) {
  mcast_source_t *source = arg;
  if (!source->batch_clients)
    return (int)packet->data_size;
  /* Flush before crossing the cap. Besides bounding storage, this avoids
   * creating a second TCP/GSO block for a small tail above 64 KiB. */
  if (source->batch && packet->data_size > BUFFER_POOL_BATCH_SIZE - source->batch->data_size)
    mcast_source_flush(source);
  if (!source->batch) {
    source->batch = buffer_pool_alloc_batch();
    source->batch_since = get_time_ms();
    source->batch_packet_type = source->packet_type;
  }
  if (!source->batch) {
    /* Keep forwarding when slow viewers pin the bounded batch pool. */
    mcast_source_fanout(source, packet, source->packet_type, 0);
    return (int)packet->data_size;
  }
  buffer_ref_t *batch = source->batch;
  memcpy((uint8_t *)batch->data + batch->data_size, (uint8_t *)packet->data + packet->data_offset, packet->data_size);
  batch->data_size += packet->data_size;
  if (batch->data_size == BUFFER_POOL_BATCH_SIZE)
    mcast_source_flush(source);
  return (int)packet->data_size;
}

/* In-band FEC can appear even without a configured FEC port. Transfer the
 * current reorder window to each viewer before resuming its private FEC path. */
static void mcast_source_enable_private_fec(mcast_source_t *source) {
  mcast_source_flush(source);
  source->shared_output = 0;
  for (mcast_session_t *session = source->subscribers; session; session = session->next) {
    if (!session->batched)
      continue;
    rtp_reorder_t *r = &session->ctx->reorder;
    rtp_reorder_cleanup(r);
    if (rtp_reorder_init(r, 0) < 0) {
      session->failed = 1;
    } else {
      r->base_seq = source->reorder.base_seq;
      r->phase = source->reorder.phase;
      r->count = source->reorder.count;
      for (int i = 0; i < r->window_size; i++) {
        r->seq[i] = source->reorder.seq[i];
        if (source->reorder.slots[i]) {
          r->slots[i] = buffer_ref_view(source->reorder.slots[i]);
          if (!r->slots[i])
            session->failed = 1;
        }
      }
    }
    session->batched = 0;
    session->packet_next = source->packet_subscribers;
    source->packet_subscribers = session;
  }
  source->batch_clients = 0;
  rtp_reorder_cleanup(&source->reorder);
}

/* FCC unicast/pending data must finish first. Switch only at an identical
 * delivered sequence boundary, so there is no replay or skipped handoff data. */
static void mcast_source_promote_ready(mcast_source_t *source) {
  mcast_session_t **entry = &source->packet_subscribers;
  while (*entry) {
    mcast_session_t *session = *entry;
    stream_context_t *ctx = session->ctx;
    if (!session->failed && ctx->conn->state != CONN_CLOSING && !ctx->snapshot.initialized &&
        !fec_is_enabled(&ctx->fec) &&
        (!ctx->fcc.initialized || (ctx->fcc.state == FCC_STATE_MCAST_ACTIVE && !ctx->fcc.pending_list_head)) &&
        (source->packet_type == 0 || (source->reorder.phase == 2 && ctx->reorder.phase == 2 &&
                                      ctx->reorder.count == 0 && ctx->reorder.base_seq == source->reorder.base_seq))) {
      mcast_source_flush(source);
      *entry = session->packet_next;
      session->packet_next = NULL;
      session->batched = 1;
      source->batch_clients++;
      logger(LOG_DEBUG, "Multicast: Subscriber joined shared payload batches (fd=%d)", ctx->conn->fd);
    } else {
      entry = &session->packet_next;
    }
  }
}

static void mcast_deliver_packet(mcast_session_t *session, buffer_ref_t *packet) {
  stream_context_t *ctx = session->ctx;
  if (session->failed || ctx->conn->state == CONN_CLOSING)
    return;

  /* Queue linkage and RTP offsets are mutable and
   * must never be shared between clients. Only the backing data is shared. */
  buffer_ref_t *view;
  if (session->source->refs == 1 && !session->source->shared_output) {
    /* Preserve the allocation-free descriptor path for a lone subscriber. */
    view = packet;
    buffer_ref_get(view);
  } else {
    view = buffer_ref_view(packet);
  }
  if (!view)
    return; /* A local drop must not interrupt other subscribers. */
  int result = 0;
  if (!ctx->fcc.initialized) {
    stream_process_rtp_payload(ctx, view, STREAM_MEDIA_ORIGIN_MULTICAST);
  } else if (ctx->fcc.state == FCC_STATE_MCAST_ACTIVE) {
    result = fcc_handle_mcast_active(ctx, view);
  } else if (ctx->fcc.state == FCC_STATE_MCAST_REQUESTED) {
    result = fcc_handle_mcast_transition(ctx, view);
  }
  buffer_ref_put(view);
  if (result < 0)
    session->failed = 1;
}

static void mcast_source_process_packet(mcast_source_t *source, buffer_ref_t *packet, size_t len, int64_t now) {
  void *data = packet ? packet->data : NULL;
  source->last_data_time = now;
  if (packet) {
    packet->data_offset = 0;
    packet->data_size = (size_t)len;
    uint8_t *payload = NULL;
    int payload_len = 0;
    uint16_t seq = 0;
    int packet_type = source->shared_output ? rtp_get_payload(data, (int)len, &payload, &payload_len, &seq) : -1;
    if (packet_type == 2)
      mcast_source_enable_private_fec(source);
    for (mcast_session_t *subscriber = source->packet_subscribers; subscriber; subscriber = subscriber->packet_next)
      mcast_deliver_packet(subscriber, packet);
    if (source->shared_output &&
        (packet_type == 1 || (packet_type == 0 && stream_payload_is_mpegts(payload, payload_len)))) {
      source->packet_type = packet_type;
      packet->data_offset = (size_t)(payload - (uint8_t *)packet->data);
      packet->data_size = (size_t)payload_len;
      if (packet_type == 1)
        rtp_reorder_insert(&source->reorder, packet, seq, NULL, 0, NULL);
      else
        mcast_source_append(source, packet);
      if (source->packet_subscribers)
        mcast_source_promote_ready(source);
    }
  }
}

/* A receive buffer can be reused in place once parsing copied its payload into
 * a batch. Reorder/FEC windows and client queues retain references when they
 * still need the packet, so those buffers must be returned through the pool. */
static void mcast_receive_recycle(buffer_ref_t **packet) {
  if (*packet && (*packet)->refcount == 1)
    return;
  buffer_ref_put(*packet);
  *packet = NULL;
}

static buffer_ref_t *receive_single_packet;

#if defined(__linux__) || defined(__FreeBSD__)
/* The worker dispatches receive callbacks serially. Keep scratch descriptors
 * and unused pool buffers across callbacks, rather than allocating a full batch
 * on every readiness notification (which often carries only one datagram). */
enum { RECEIVE_BATCH = 16 };
static struct mmsghdr receive_messages[RECEIVE_BATCH];
static struct iovec receive_iov[RECEIVE_BATCH];
static buffer_ref_t *receive_packets[RECEIVE_BATCH];
static uint8_t receive_discard[BUFFER_POOL_BUFFER_SIZE];
static int receive_initialized;

static int mcast_source_receive_batch(mcast_source_t *source, int fd, int64_t now) {
  static int unavailable;
  if (unavailable)
    return -1;
  struct mmsghdr *messages = receive_messages;
  struct iovec *iov = receive_iov;
  buffer_ref_t **packets = receive_packets;
  int fallback = 0;
  unsigned int received = 0;
  if (!receive_initialized) {
    for (int i = 0; i < RECEIVE_BATCH; i++) {
      messages[i].msg_hdr.msg_iov = &iov[i];
      messages[i].msg_hdr.msg_iovlen = 1;
      iov[i].iov_len = BUFFER_POOL_BUFFER_SIZE;
    }
    receive_initialized = 1;
  }
  for (;;) {
    for (int i = 0; i < RECEIVE_BATCH; i++) {
      if (!packets[i]) {
        packets[i] = buffer_pool_alloc();
        iov[i].iov_base = packets[i] ? packets[i]->data : receive_discard;
      }
    }
    int count = recvmmsg(fd, messages, RECEIVE_BATCH, MSG_DONTWAIT, NULL);
    if (count < 0) {
      if (errno == EINTR)
        continue;
      if (errno == ENOSYS || errno == EOPNOTSUPP) {
        unavailable = 1;
        fallback = -1;
      } else if (errno != EAGAIN && errno != EWOULDBLOCK) {
        logger(LOG_ERROR, "Multicast: Batch receive failed: %s", strerror(errno));
        source->failed = 1;
      }
      break;
    }
    for (int i = 0; i < count; i++) {
      mcast_source_process_packet(source, packets[i], messages[i].msg_len, now);
      mcast_receive_recycle(&packets[i]);
    }
    received += (unsigned int)count;
    /* A short receive may have been interrupted with data still queued.
     * Coalesced sources drain to EAGAIN before sleeping; level-triggered
     * sources can yield because remaining data stays ready. */
    if ((!source->receive_coalesced && count < RECEIVE_BATCH) || received >= 256)
      break;
  }
  if (fallback)
    mcast_worker_cleanup();
  return fallback ? fallback : (int)received;
}
#endif

void mcast_worker_cleanup(void) {
  buffer_ref_put(receive_single_packet);
  receive_single_packet = NULL;
#if defined(__linux__) || defined(__FreeBSD__)
  for (int i = 0; i < RECEIVE_BATCH; i++) {
    buffer_ref_put(receive_packets[i]);
    receive_packets[i] = NULL;
  }
  receive_initialized = 0;
#endif
}

static int mcast_source_receive(mcast_source_t *source, int fd, int64_t now) {
#if defined(__linux__) || defined(__FreeBSD__)
  if (fd == source->sock) {
    int count = mcast_source_receive_batch(source, fd, now);
    if (count >= 0)
      return count;
  }
#endif
  int received = 0;

  /* Drain to EAGAIN for edge-triggered pollers, including on pool exhaustion.
   * All subscribers are detached by the worker outside this delivery loop. */
  for (;;) {
    if (fd == source->sock && !receive_single_packet)
      receive_single_packet = buffer_pool_alloc();
    buffer_ref_t *packet = fd == source->sock ? receive_single_packet : NULL;
    uint8_t discard[BUFFER_POOL_BUFFER_SIZE];
    void *data = packet ? packet->data : discard;
    ssize_t len = recv(fd, data, BUFFER_POOL_BUFFER_SIZE, 0);
    if (len < 0) {
      int recv_errno = errno;
      if (recv_errno == EINTR)
        continue;
      if (recv_errno != EAGAIN && recv_errno != EWOULDBLOCK) {
        logger(LOG_ERROR, "Multicast: Receive failed: %s", strerror(recv_errno));
        source->failed = 1;
      }
      break;
    }
    if (fd == source->sock) {
      mcast_source_process_packet(source, packet, (size_t)len, now);
      mcast_receive_recycle(&receive_single_packet);
      if (++received >= 256)
        break;
    } else {
      for (mcast_session_t *subscriber = source->subscribers; subscriber; subscriber = subscriber->next) {
        if (!subscriber->failed && subscriber->ctx->conn->state != CONN_CLOSING)
          fec_process_packet(&subscriber->ctx->fec, data, (int)len);
      }
    }
  }
  return received;
}

static int mcast_source_rearm(mcast_source_t *source, int coalesced) {
  uint32_t events = POLLER_IN | (coalesced ? POLLER_ONESHOT : POLLER_LEVEL);
  int result = source->receive_coalesced == coalesced ? poller_mod(source->epoll_fd, source->sock, events)
                                                      : poller_reset(source->epoll_fd, source->sock, events);
  if (result < 0) {
    logger(LOG_ERROR, "Multicast: Cannot rearm receive socket: %s", strerror(errno));
    source->failed = 1;
    return -1;
  }
  source->receive_coalesced = coalesced;
  return 0;
}

static void mcast_source_schedule_receive(mcast_source_t *source, int count, int64_t now) {
  if (source->failed) {
    source->next_receive = 0;
  } else if (!source->receive_coalesced) {
    source->next_receive = 0;
    if (source->receive_delay_max) {
      source->receive_check_packets += (unsigned int)count;
      int64_t elapsed = now - source->receive_check_since;
      if (elapsed >= 100) {
        /* A transient burst must not disable coalescing for the rest of a
         * continuous stream. Reassess its rate with 2x scheduling headroom. */
        if ((int64_t)source->receive_check_packets * source->receive_delay_max * 2 <
            elapsed * source->receive_packet_limit)
          mcast_source_rearm(source, 1);
        source->receive_check_since = now;
        source->receive_check_packets = 0;
      }
    }
  } else if ((unsigned int)count >= source->receive_packet_limit) {
    /* At high packet rates even a millisecond can be too long. Keep readiness
     * enabled until the observed rate permits a short delay again. */
    source->next_receive = 0;
    mcast_source_rearm(source, 0);
    source->receive_check_since = now;
    source->receive_check_packets = 0;
  } else if (count > 0) {
    /* The first notification reads immediately. Subsequent reads can collect
     * a short burst; only low packet rates and enough storage permit 2 ms. */
    int delay = source->next_receive && count < 16 ? source->receive_delay_max : 1;
    source->next_receive = now + delay;
  } else {
    source->next_receive = 0;
    mcast_source_rearm(source, 1);
  }
  if (!source->next_receive) {
    mcast_receive_unlink(source);
  } else if (!source->receive_link) {
    source->receive_next = receive_head;
    source->receive_link = &receive_head;
    if (receive_head)
      receive_head->receive_link = &source->receive_next;
    receive_head = source;
  }
}

int mcast_session_handle_event(mcast_session_t *session, int fd, int64_t now) {
  mcast_source_t *source = session->source;
  if (!source)
    return -1;
  int count = mcast_source_receive(source, fd, now);
  if (fd == source->sock)
    mcast_source_schedule_receive(source, count, now);
  return 0;
}

int mcast_worker_timeout(int64_t now, int timeout) {
  for (mcast_source_t *source = receive_head; source; source = source->receive_next) {
    int delay = source->next_receive > now ? (int)(source->next_receive - now) : 0;
    if (timeout < 0 || delay < timeout)
      timeout = delay;
  }
  return timeout;
}

void mcast_worker_receive(int64_t now) {
  for (mcast_source_t *source = receive_head, *next; source; source = next) {
    next = source->receive_next;
    if (source->next_receive <= now) {
      mcast_receive_unlink(source);
      int count = mcast_source_receive(source, source->sock, now);
      mcast_source_schedule_receive(source, count, now);
    }
  }
}

int mcast_session_tick(mcast_session_t *session, int64_t now) {
  if (!session || !session->initialized || !session->source)
    return 0;
  mcast_source_t *source = session->source;
  service_t *service = source->service;
  if (session->failed || source->failed)
    return -1;
  /* Bound low-bitrate batching delay; the worker ticks every 100 ms. */
  if (source->batch && now - source->batch_since >= 100)
    mcast_source_flush(source);

  /* Periodic rejoin and timeout belong to the source, not each subscriber. */
  if (config.mcast_rejoin_interval > 0) {
    if (service->addr->ai_family != AF_INET) {
      if (!source->rejoin_unsupported_warned) {
        logger(LOG_WARN, "Multicast: mcast-rejoin-interval is not supported for IPv6 groups (no MLD "
                         "raw-socket rejoin), skipping periodic rejoin");
        source->rejoin_unsupported_warned = 1;
      }
    } else if (now - source->last_rejoin_time >= (int64_t)config.mcast_rejoin_interval * 1000) {
      source->last_rejoin_time = now;
      logger(LOG_DEBUG, "Multicast: Periodic rejoin (interval: %d seconds)", config.mcast_rejoin_interval);
      if (rejoin_mcast_group(service) < 0)
        logger(LOG_ERROR, "Multicast: Failed to rejoin group, will retry next interval");
    }
  }
  if (now - source->last_data_time >= MCAST_TIMEOUT_SEC * 1000) {
    logger(LOG_ERROR, "Multicast: No data received for %d seconds, closing subscribers", MCAST_TIMEOUT_SEC);
    source->failed = 1;
    return -1;
  }
  return 0;
}
