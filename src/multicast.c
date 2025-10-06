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

int join_mcast_group(service_t *service)
{
  struct group_req gr;
  struct group_source_req gsr;
  int sock, r, level;
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

  r = setsockopt(sock, SOL_SOCKET,
                 SO_REUSEADDR, &on, sizeof(on));
  if (r)
  {
    logger(LOG_ERROR, "SO_REUSEADDR "
                      "failed: %s",
           strerror(errno));
  }

  /* Determine which interface to use */
  upstream_if = &config.upstream_interface_multicast;

  bind_to_upstream_interface(sock, upstream_if);

  r = bind(sock, (struct sockaddr *)service->addr->ai_addr, service->addr->ai_addrlen);
  if (r)
  {
    logger(LOG_ERROR, "Cannot bind: %s",
           strerror(errno));
    exit(RETVAL_RTP_FAILED);
  }

  memcpy(&(gr.gr_group), service->addr->ai_addr, service->addr->ai_addrlen);

  switch (service->addr->ai_family)
  {
  case AF_INET:
    level = SOL_IP;
    gr.gr_interface = 0;
    break;

  case AF_INET6:
    level = SOL_IPV6;
    gr.gr_interface = ((const struct sockaddr_in6 *)(service->addr->ai_addr))->sin6_scope_id;
    break;
  default:
    logger(LOG_ERROR, "Address family don't support mcast.");
    exit(RETVAL_SOCK_READ_FAILED);
  }

  if (upstream_if->ifr_name[0] != '\0')
  {
    gr.gr_interface = upstream_if->ifr_ifindex;
  }

  if (strcmp(service->msrc, "") != 0 && service->msrc != NULL)
  {
    gsr.gsr_group = gr.gr_group;
    gsr.gsr_interface = gr.gr_interface;
    memcpy(&(gsr.gsr_source), service->msrc_addr->ai_addr, service->msrc_addr->ai_addrlen);
    r = setsockopt(sock, level,
                   MCAST_JOIN_SOURCE_GROUP, &gsr, sizeof(gsr));
  }
  else
  {
    r = setsockopt(sock, level,
                   MCAST_JOIN_GROUP, &gr, sizeof(gr));
  }

  if (r)
  {
    logger(LOG_ERROR, "Cannot join mcast group: %s",
           strerror(errno));
    exit(RETVAL_RTP_FAILED);
  }

  logger(LOG_INFO, "Multicast: Successfully joined group");
  return sock;
}
