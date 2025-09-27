/*
 *  RTP2HTTP Proxy - Multicast networking module
 *
 *  Copyright (C) 2008-2010 Ondrej Caletka <o.caletka@sh.cvut.cz>
 *
 *  This program is free software; you can redistribute it and/or modify
 *  it under the terms of the GNU General Public License version 2
 *  as published by the Free Software Foundation.
 *
 *  This program is distributed in the hope that it will be useful,
 *  but WITHOUT ANY WARRANTY; without even the implied warranty of
 *  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *  GNU General Public License for more details.
 *
 *  You should have received a copy of the GNU General Public License
 *  along with this program (see the file COPYING included with this
 *  distribution); if not, write to the Free Software Foundation, Inc.,
 *  59 Temple Place, Suite 330, Boston, MA  02111-1307  USA
 */

#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <unistd.h>
#include <net/if.h>
#include "multicast.h"
#include "rtp2httpd.h"

void bind_to_upstream_interface(int sock)
{
  if (conf_upstream_interface.ifr_name != NULL)
  {
    if (setsockopt(sock, SOL_SOCKET, SO_BINDTODEVICE, (void *)&conf_upstream_interface, sizeof(struct ifreq)) < 0)
    {
      logger(LOG_ERROR, "Failed to bind to upstream interface %s: %s\n", conf_upstream_interface.ifr_name, strerror(errno));
    }
  }
}

int join_mcast_group(struct services_s *service)
{
  struct group_req gr;
  struct group_source_req gsr;
  int sock, r, level;
  int on = 1;

  sock = socket(service->addr->ai_family, service->addr->ai_socktype,
                service->addr->ai_protocol);
  r = setsockopt(sock, SOL_SOCKET,
                 SO_REUSEADDR, &on, sizeof(on));
  if (r)
  {
    logger(LOG_ERROR, "SO_REUSEADDR "
                      "failed: %s\n",
           strerror(errno));
  }

  r = bind(sock, (struct sockaddr *)service->addr->ai_addr, service->addr->ai_addrlen);
  if (r)
  {
    logger(LOG_ERROR, "Cannot bind: %s\n",
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
    logger(LOG_ERROR, "Address family don't support mcast.\n");
    exit(RETVAL_SOCK_READ_FAILED);
  }

  if (conf_upstream_interface.ifr_name != NULL)
  {
    gr.gr_interface = conf_upstream_interface.ifr_ifindex;
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
    logger(LOG_ERROR, "Cannot join mcast group: %s\n",
           strerror(errno));
    exit(RETVAL_RTP_FAILED);
  }

  return sock;
}
