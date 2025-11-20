#include "multicast.h"
#include "connection.h"
#include "service.h"
#include "utils.h"
#include <arpa/inet.h>
#include <errno.h>
#include <ifaddrs.h>
#include <net/if.h>
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

void bind_to_upstream_interface(int sock, const char *ifname) {
  if (ifname && ifname[0] != '\0') {
    struct ifreq ifr;
    memset(&ifr, 0, sizeof(struct ifreq));
    strncpy(ifr.ifr_name, ifname, IFNAMSIZ - 1);

    /* Get the latest interface index dynamically to handle interface restarts
     * (e.g., PPPoE reconnection) */
    unsigned int ifindex = if_nametoindex(ifr.ifr_name);
    if (ifindex > 0) {
      ifr.ifr_ifindex = ifindex;
    } else {
      logger(LOG_WARN, "Failed to get interface index for %s: %s", ifr.ifr_name,
             strerror(errno));
    }

    if (setsockopt(sock, SOL_SOCKET, SO_BINDTODEVICE, &ifr,
                   sizeof(struct ifreq)) < 0) {
      logger(LOG_ERROR, "Failed to bind to upstream interface %s: %s",
             ifr.ifr_name, strerror(errno));
    }
  }
}

const char *get_upstream_interface_for_fcc(void) {
  /* Priority: upstream_interface_fcc > upstream_interface */
  if (config.upstream_interface_fcc[0] != '\0') {
    return config.upstream_interface_fcc;
  }
  if (config.upstream_interface[0] != '\0') {
    return config.upstream_interface;
  }
  return NULL;
}

const char *get_upstream_interface_for_rtsp(void) {
  /* Priority: upstream_interface_rtsp > upstream_interface */
  if (config.upstream_interface_rtsp[0] != '\0') {
    return config.upstream_interface_rtsp;
  }
  if (config.upstream_interface[0] != '\0') {
    return config.upstream_interface;
  }
  return NULL;
}

const char *get_upstream_interface_for_multicast(void) {
  /* Priority: upstream_interface_multicast > upstream_interface */
  if (config.upstream_interface_multicast[0] != '\0') {
    return config.upstream_interface_multicast;
  }
  if (config.upstream_interface[0] != '\0') {
    return config.upstream_interface;
  }
  return NULL;
}

/**
 * Get local IP address for FCC packets
 * Priority: upstream_interface_fcc > upstream_interface > first non-loopback IP
 */
uint32_t get_local_ip_for_fcc(void) {
  const char *ifname = get_upstream_interface_for_fcc();
  struct ifaddrs *ifaddr, *ifa;
  uint32_t local_ip = 0;

  if (getifaddrs(&ifaddr) == -1) {
    logger(LOG_ERROR, "getifaddrs failed: %s", strerror(errno));
    return 0;
  }

  /* If specific interface is configured, get its IP */
  if (ifname && ifname[0] != '\0') {
    for (ifa = ifaddr; ifa != NULL; ifa = ifa->ifa_next) {
      if (ifa->ifa_addr == NULL)
        continue;

      if (ifa->ifa_addr->sa_family == AF_INET &&
          strcmp(ifa->ifa_name, ifname) == 0) {
        struct sockaddr_in *addr = (struct sockaddr_in *)ifa->ifa_addr;
        local_ip = ntohl(addr->sin_addr.s_addr);
        logger(LOG_DEBUG, "FCC: Using local IP from interface %s: %u.%u.%u.%u",
               ifname, (local_ip >> 24) & 0xFF, (local_ip >> 16) & 0xFF,
               (local_ip >> 8) & 0xFF, local_ip & 0xFF);
        break;
      }
    }
  }

  /* Fallback: Get first non-loopback IPv4 address */
  if (local_ip == 0) {
    for (ifa = ifaddr; ifa != NULL; ifa = ifa->ifa_next) {
      if (ifa->ifa_addr == NULL)
        continue;

      if (ifa->ifa_addr->sa_family == AF_INET) {
        struct sockaddr_in *addr = (struct sockaddr_in *)ifa->ifa_addr;
        uint32_t ip = ntohl(addr->sin_addr.s_addr);

        /* Skip loopback (127.0.0.0/8) */
        if ((ip >> 24) != 127) {
          local_ip = ip;
          logger(
              LOG_DEBUG,
              "FCC: Using first non-loopback IP from interface %s: %u.%u.%u.%u",
              ifa->ifa_name, (local_ip >> 24) & 0xFF, (local_ip >> 16) & 0xFF,
              (local_ip >> 8) & 0xFF, local_ip & 0xFF);
          break;
        }
      }
    }
  }

  freeifaddrs(ifaddr);

  if (local_ip == 0) {
    logger(LOG_WARN, "FCC: Could not determine local IP address");
  }

  return local_ip;
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
        ((const struct sockaddr_in6 *)(service->addr->ai_addr))->sin6_scope_id;
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
  if (strcmp(service->msrc, "") != 0 && service->msrc != NULL) {
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
  is_ssm = (strcmp(service->msrc, "") != 0 && service->msrc != NULL);

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

int join_mcast_group(service_t *service) {
  int sock, r;
  int on = 1;
  const char *upstream_if;

  sock = socket(service->addr->ai_family, service->addr->ai_socktype,
                service->addr->ai_protocol);

  /* Set socket to non-blocking mode for epoll */
  if (connection_set_nonblocking(sock) < 0) {
    logger(LOG_ERROR, "Failed to set multicast socket non-blocking: %s",
           strerror(errno));
    close(sock);
    exit(RETVAL_SOCK_READ_FAILED);
  }

  /* Set receive buffer size to 512KB */
  int rcvbuf_size = UDP_RCVBUF_SIZE;
  r = setsockopt(sock, SOL_SOCKET, SO_RCVBUF, &rcvbuf_size,
                 sizeof(rcvbuf_size));
  if (r < 0) {
    logger(LOG_WARN, "Failed to set SO_RCVBUF to %d: %s", rcvbuf_size,
           strerror(errno));
  }

  r = setsockopt(sock, SOL_SOCKET, SO_REUSEADDR, &on, sizeof(on));
  if (r) {
    logger(LOG_ERROR, "SO_REUSEADDR failed: %s", strerror(errno));
  }

  /* Determine which interface to use */
  upstream_if = get_upstream_interface_for_multicast();
  bind_to_upstream_interface(sock, upstream_if);

  r = bind(sock, (struct sockaddr *)service->addr->ai_addr,
           service->addr->ai_addrlen);
  if (r) {
    logger(LOG_ERROR, "Cannot bind: %s", strerror(errno));
    exit(RETVAL_RTP_FAILED);
  }

  /* Join the multicast group */
  if (mcast_group_op(sock, service, 1, "join") < 0) {
    logger(LOG_ERROR, "Cannot join mcast group");
    exit(RETVAL_RTP_FAILED);
  }

  logger(LOG_INFO, "Multicast: Successfully joined group");
  return sock;
}

int rejoin_mcast_group(service_t *service) {
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

  mcast_addr = (struct sockaddr_in *)service->addr->ai_addr;
  group_addr = mcast_addr->sin_addr.s_addr;

  if (service->msrc != NULL && strcmp(service->msrc, "") != 0 &&
      service->msrc_addr != NULL) {
    if (service->msrc_addr->ai_family != AF_INET) {
      logger(LOG_ERROR, "IGMP raw socket rejoin: source address must be IPv4");
      return -1;
    }
    source_addr = (struct sockaddr_in *)service->msrc_addr->ai_addr;
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
    dest.sin_addr.s_addr = inet_addr("224.0.0.2");

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
        (uint32_t *)((uint8_t *)grec + sizeof(struct igmpv3_grec));
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
