#ifdef HAVE_CONFIG_H
#include "config.h"
#endif /* HAVE_CONFIG_H */

#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <sys/socket.h>
#include <sys/epoll.h>
#include <netinet/in.h>
#include <netinet/ip.h>
#include <arpa/inet.h>
#include <unistd.h>
#include <net/if.h>
#include "multicast.h"
#include "rtp2httpd.h"
#include "service.h"
#include "connection.h"

/* IGMPv3 Protocol Definitions */
#define IGMP_V3_MEMBERSHIP_REPORT 0x22
#define IGMPV3_MODE_IS_INCLUDE 1
#define IGMPV3_MODE_IS_EXCLUDE 2
#define IGMPV3_CHANGE_TO_INCLUDE 3
#define IGMPV3_CHANGE_TO_EXCLUDE 4
#define IGMPV3_ALLOW_NEW_SOURCES 5
#define IGMPV3_BLOCK_OLD_SOURCES 6

/* IGMPv3 Membership Report structures */
struct igmpv3_grec
{
  uint8_t grec_type;
  uint8_t grec_auxwords;
  uint16_t grec_nsrcs;
  uint32_t grec_mca;
  uint32_t grec_src[0];
} __attribute__((packed));

struct igmpv3_report
{
  uint8_t type;
  uint8_t resv1;
  uint16_t csum;
  uint16_t resv2;
  uint16_t ngrec;
  struct igmpv3_grec grec[0];
} __attribute__((packed));

/* Calculate Internet Checksum (RFC 1071) */
static uint16_t calculate_checksum(const void *data, size_t len)
{
  const uint16_t *buf = data;
  uint32_t sum = 0;

  while (len > 1)
  {
    sum += *buf++;
    len -= 2;
  }

  if (len == 1)
  {
    sum += *(const uint8_t *)buf;
  }

  sum = (sum >> 16) + (sum & 0xFFFF);
  sum += (sum >> 16);

  return ~sum;
}

void bind_to_upstream_interface(int sock, const struct ifreq *ifr)
{
  if (ifr && ifr->ifr_name[0] != '\0')
  {
    if (setsockopt(sock, SOL_SOCKET, SO_BINDTODEVICE, ifr, sizeof(struct ifreq)) < 0)
    {
      logger(LOG_ERROR, "Failed to bind to upstream interface %s: %s", ifr->ifr_name, strerror(errno));
    }
  }
}

/*
 * Helper function to prepare multicast group request structures
 * Returns the socket level (SOL_IP or SOL_IPV6) and fills gr/gsr structures
 */
static int prepare_mcast_group_req(service_t *service, struct group_req *gr, struct group_source_req *gsr)
{
  int level;
  const struct ifreq *upstream_if;

  memcpy(&(gr->gr_group), service->addr->ai_addr, service->addr->ai_addrlen);

  switch (service->addr->ai_family)
  {
  case AF_INET:
    level = SOL_IP;
    gr->gr_interface = 0;
    break;

  case AF_INET6:
    level = SOL_IPV6;
    gr->gr_interface = ((const struct sockaddr_in6 *)(service->addr->ai_addr))->sin6_scope_id;
    break;
  default:
    logger(LOG_ERROR, "Address family don't support mcast.");
    return -1;
  }

  upstream_if = &config.upstream_interface_multicast;
  if (upstream_if->ifr_name[0] != '\0')
  {
    gr->gr_interface = upstream_if->ifr_ifindex;
  }

  /* Prepare source-specific multicast structure if needed */
  if (strcmp(service->msrc, "") != 0 && service->msrc != NULL)
  {
    gsr->gsr_group = gr->gr_group;
    gsr->gsr_interface = gr->gr_interface;
    memcpy(&(gsr->gsr_source), service->msrc_addr->ai_addr, service->msrc_addr->ai_addrlen);
  }

  return level;
}

/*
 * Helper function to perform multicast group join/leave operation
 * is_join: 1 for join, 0 for leave
 */
static int mcast_group_op(int sock, service_t *service, int is_join, const char *op_name)
{
  struct group_req gr;
  struct group_source_req gsr;
  int level, r;
  int op;
  int is_ssm; /* Source-Specific Multicast */

  level = prepare_mcast_group_req(service, &gr, &gsr);
  if (level < 0)
  {
    return -1;
  }

  /* Determine if this is source-specific multicast */
  is_ssm = (strcmp(service->msrc, "") != 0 && service->msrc != NULL);

  /* Select the appropriate operation */
  if (is_ssm)
  {
    op = is_join ? MCAST_JOIN_SOURCE_GROUP : MCAST_LEAVE_SOURCE_GROUP;
    r = setsockopt(sock, level, op, &gsr, sizeof(gsr));
  }
  else
  {
    op = is_join ? MCAST_JOIN_GROUP : MCAST_LEAVE_GROUP;
    r = setsockopt(sock, level, op, &gr, sizeof(gr));
  }

  if (r < 0)
  {
    logger(LOG_ERROR, "Multicast: %s failed: %s", op_name, strerror(errno));
    return -1;
  }

  return 0;
}

int join_mcast_group(service_t *service)
{
  int sock, r;
  int on = 1;
  const struct ifreq *upstream_if;

  sock = socket(service->addr->ai_family, service->addr->ai_socktype,
                service->addr->ai_protocol);

  /* Set socket to non-blocking mode for epoll */
  if (connection_set_nonblocking(sock) < 0)
  {
    logger(LOG_ERROR, "Failed to set multicast socket non-blocking: %s", strerror(errno));
    close(sock);
    exit(RETVAL_SOCK_READ_FAILED);
  }

  r = setsockopt(sock, SOL_SOCKET, SO_REUSEADDR, &on, sizeof(on));
  if (r)
  {
    logger(LOG_ERROR, "SO_REUSEADDR failed: %s", strerror(errno));
  }

  /* Determine which interface to use */
  upstream_if = &config.upstream_interface_multicast;
  bind_to_upstream_interface(sock, upstream_if);

  r = bind(sock, (struct sockaddr *)service->addr->ai_addr, service->addr->ai_addrlen);
  if (r)
  {
    logger(LOG_ERROR, "Cannot bind: %s", strerror(errno));
    exit(RETVAL_RTP_FAILED);
  }

  /* Join the multicast group */
  if (mcast_group_op(sock, service, 1, "join") < 0)
  {
    logger(LOG_ERROR, "Cannot join mcast group");
    exit(RETVAL_RTP_FAILED);
  }

  logger(LOG_INFO, "Multicast: Successfully joined group");
  return sock;
}

/*
 * Rejoin multicast group by sending IGMPv3 Membership Report via raw socket
 *
 * Background:
 * In our multi-process architecture, each client connection maintains its own
 * multicast socket. When multiple clients are playing the same multicast source,
 * the kernel maintains a reference count for that multicast group membership.
 *
 * Problem:
 * The traditional leave/join approach (MCAST_LEAVE_GROUP + MCAST_JOIN_GROUP)
 * will NOT trigger an IGMP Report in this scenario because:
 * 1. When we call MCAST_LEAVE_GROUP, the kernel decrements the reference count
 * 2. If other sockets still have membership (refcount > 0), no IGMP Leave is sent
 * 3. When we call MCAST_JOIN_GROUP again, the kernel sees the group already exists
 * 4. No IGMP Report is sent because the interface is still a member of the group
 *
 * Solution:
 * We manually construct and send an IGMPv3 Membership Report packet using a
 * raw socket. This bypasses the kernel's membership tracking and ensures that
 * the upstream router receives periodic membership reports, preventing it from
 * timing out and stopping the multicast stream delivery.
 *
 * This is particularly important when:
 * - The upstream router requires periodic IGMP Reports (typical timeout: 3 minutes)
 * - We want to ensure we become the "Reporter" for the group
 * - Multiple worker processes are serving the same multicast stream
 *
 * @param sock The existing multicast socket (unused, for API compatibility)
 * @param service Service structure containing multicast group and optional source
 * @return 0 on success, -1 on failure
 */
int rejoin_mcast_group(int sock, service_t *service)
{
  int raw_sock;
  struct sockaddr_in dest;
  struct igmpv3_report *report;
  struct igmpv3_grec *grec;
  uint8_t packet[sizeof(struct igmpv3_report) + sizeof(struct igmpv3_grec) + sizeof(uint32_t)];
  size_t packet_len;
  int r;
  const struct ifreq *upstream_if;
  struct sockaddr_in *mcast_addr;
  struct sockaddr_in *source_addr = NULL;
  uint32_t group_addr;
  uint16_t nsrcs = 0;
  int is_ssm = 0;

  /* Only support IPv4 for now */
  if (service->addr->ai_family != AF_INET)
  {
    logger(LOG_ERROR, "IGMPv3 raw socket rejoin only supports IPv4");
    return -1;
  }

  mcast_addr = (struct sockaddr_in *)service->addr->ai_addr;
  group_addr = mcast_addr->sin_addr.s_addr;

  /* Check if this is Source-Specific Multicast (SSM) */
  if (service->msrc != NULL && strcmp(service->msrc, "") != 0 && service->msrc_addr != NULL)
  {
    if (service->msrc_addr->ai_family != AF_INET)
    {
      logger(LOG_ERROR, "IGMPv3 raw socket rejoin: source address must be IPv4");
      return -1;
    }
    source_addr = (struct sockaddr_in *)service->msrc_addr->ai_addr;
    is_ssm = 1;
    nsrcs = 1;
  }

  /* Create raw socket for IGMP */
  raw_sock = socket(AF_INET, SOCK_RAW, IPPROTO_IGMP);
  if (raw_sock < 0)
  {
    logger(LOG_ERROR, "Failed to create raw IGMP socket: %s (need root?)", strerror(errno));
    return -1;
  }

  /* Set socket to non-blocking mode to avoid blocking on sendto */
  if (connection_set_nonblocking(raw_sock) < 0)
  {
    logger(LOG_ERROR, "Failed to set raw IGMP socket non-blocking: %s", strerror(errno));
    close(raw_sock);
    return -1;
  }

  /* Bind to upstream interface if specified */
  upstream_if = &config.upstream_interface_multicast;
  bind_to_upstream_interface(raw_sock, upstream_if);

  /* Set IP_HDRINCL to 0 - kernel will add IP header */
  int hdrincl = 0;
  if (setsockopt(raw_sock, IPPROTO_IP, IP_HDRINCL, &hdrincl, sizeof(hdrincl)) < 0)
  {
    logger(LOG_WARN, "Failed to set IP_HDRINCL: %s", strerror(errno));
  }

  /* Set IP_MULTICAST_IF to send from correct interface */
  if (upstream_if->ifr_name[0] != '\0')
  {
    struct ip_mreqn mreq;
    memset(&mreq, 0, sizeof(mreq));
    mreq.imr_ifindex = upstream_if->ifr_ifindex;
    if (setsockopt(raw_sock, IPPROTO_IP, IP_MULTICAST_IF, &mreq, sizeof(mreq)) < 0)
    {
      logger(LOG_WARN, "Failed to set IP_MULTICAST_IF: %s", strerror(errno));
    }
  }

  /* Construct IGMPv3 Membership Report packet */
  memset(packet, 0, sizeof(packet));

  report = (struct igmpv3_report *)packet;
  report->type = IGMP_V3_MEMBERSHIP_REPORT;
  report->resv1 = 0;
  report->csum = 0; /* Will calculate later */
  report->resv2 = 0;
  report->ngrec = htons(1); /* One group record */

  /* Group Record */
  grec = (struct igmpv3_grec *)(packet + sizeof(struct igmpv3_report));

  if (is_ssm)
  {
    /* Source-Specific Multicast: MODE_IS_INCLUDE with source list */
    grec->grec_type = IGMPV3_MODE_IS_INCLUDE;
    grec->grec_auxwords = 0;
    grec->grec_nsrcs = htons(nsrcs);
    grec->grec_mca = group_addr;

    /* Add source address to the source list */
    uint32_t *src_list = (uint32_t *)((uint8_t *)grec + sizeof(struct igmpv3_grec));
    src_list[0] = source_addr->sin_addr.s_addr;

    packet_len = sizeof(struct igmpv3_report) + sizeof(struct igmpv3_grec) + sizeof(uint32_t);
  }
  else
  {
    /* Any-Source Multicast (ASM): MODE_IS_EXCLUDE with empty source list */
    grec->grec_type = IGMPV3_MODE_IS_EXCLUDE; /* Exclude mode = join group, receive all sources */
    grec->grec_auxwords = 0;
    grec->grec_nsrcs = htons(0); /* No source list in exclude mode = receive from any source */
    grec->grec_mca = group_addr; /* Multicast group address (already in network byte order) */

    packet_len = sizeof(struct igmpv3_report) + sizeof(struct igmpv3_grec);
  }

  /* Calculate checksum */
  report->csum = calculate_checksum(packet, packet_len);

  /* Destination: 224.0.0.22 (IGMPv3 reports destination) */
  memset(&dest, 0, sizeof(dest));
  dest.sin_family = AF_INET;
  dest.sin_addr.s_addr = inet_addr("224.0.0.22");

  /* Send the IGMPv3 Report */
  r = sendto(raw_sock, packet, packet_len, 0,
             (struct sockaddr *)&dest, sizeof(dest));

  if (r < 0)
  {
    logger(LOG_ERROR, "Failed to send IGMPv3 Report: %s", strerror(errno));
    close(raw_sock);
    return -1;
  }

  close(raw_sock);

  char group_str[INET_ADDRSTRLEN];
  inet_ntop(AF_INET, &mcast_addr->sin_addr, group_str, sizeof(group_str));

  if (is_ssm)
  {
    char source_str[INET_ADDRSTRLEN];
    inet_ntop(AF_INET, &source_addr->sin_addr, source_str, sizeof(source_str));
    logger(LOG_DEBUG, "Multicast: Sent IGMPv3 Report for SSM group %s source %s via raw socket",
           group_str, source_str);
  }
  else
  {
    logger(LOG_DEBUG, "Multicast: Sent IGMPv3 Report for ASM group %s via raw socket", group_str);
  }

  return 0;
}
