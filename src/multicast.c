#ifdef HAVE_CONFIG_H
#include "config.h"
#endif /* HAVE_CONFIG_H */

#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <sys/socket.h>
#include <sys/epoll.h>
#include <netinet/in.h>
#include <unistd.h>
#include <net/if.h>
#include "multicast.h"
#include "rtp2httpd.h"
#include "service.h"
#include "connection.h"

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

int rejoin_mcast_group(int sock, service_t *service)
{
  /* Step 1: Leave the multicast group */
  if (mcast_group_op(sock, service, 0, "leave") < 0)
  {
    return -1;
  }

  /* Step 2: Rejoin the multicast group (this will send IGMP Report) */
  if (mcast_group_op(sock, service, 1, "rejoin") < 0)
  {
    return -1;
  }

  logger(LOG_DEBUG, "Multicast: Successfully rejoined group (IGMP Report sent)");
  return 0;
}
