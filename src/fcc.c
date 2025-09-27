/*
 *  RTP2HTTP Proxy - FCC (Fast Channel Change) protocol module
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

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <unistd.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include "fcc.h"
#include "rtp2httpd.h"
#include "multicast.h"

uint8_t *build_fcc_request_pk(struct addrinfo *maddr, uint16_t fcc_client_nport)
{
  struct sockaddr_in *maddr_sin = (struct sockaddr_in *)
                                      maddr->ai_addr;

  static uint8_t pk[FCC_PK_LEN_REQ];
  memset(&pk, 0, sizeof(pk));
  uint8_t *p = pk;
  *(p++) = 0x82;                              // Version 2, Padding 0, FMT 2
  *(p++) = 205;                               // Type: Generic RTP Feedback (205)
  *(uint16_t *)p = htons(sizeof(pk) / 4 - 1); // Length
  p += 2;
  p += 4;                                      // Sender SSRC
  *(uint32_t *)p = maddr_sin->sin_addr.s_addr; // Media source SSRC
  p += 4;

  // FCI
  p += 4;                            // Version 0, Reserved 3 bytes
  *(uint16_t *)p = fcc_client_nport; // FCC client port
  p += 2;
  *(uint16_t *)p = maddr_sin->sin_port; // Mcast group port
  p += 2;
  *(uint32_t *)p = maddr_sin->sin_addr.s_addr; // Mcast group IP
  p += 4;

  return pk;
}

int get_gw_ip(in_addr_t *addr)
{
  long destination, gateway;
  char buf[4096];
  FILE *file;

  memset(buf, 0, sizeof(buf));

  file = fopen("/proc/net/route", "r");
  if (!file)
  {
    return -1;
  }

  while (fgets(buf, sizeof(buf), file))
  {
    if (sscanf(buf, "%*s %lx %lx", &destination, &gateway) == 2)
    {
      if (destination == 0)
      { /* default */
        *addr = gateway;
        fclose(file);
        return 0;
      }
    }
  }

  /* default route not found */
  if (file)
    fclose(file);
  return -1;
}

uint16_t nat_pmp(uint16_t nport, uint32_t lifetime)
{
  struct sockaddr_in gw_addr = {.sin_family = AF_INET, .sin_port = htons(5351)};
  uint8_t pk[12];
  uint8_t buf[16];
  struct timeval tv = {.tv_sec = 1, .tv_usec = 0};

  if (get_gw_ip(&gw_addr.sin_addr.s_addr) < 0)
    return 0;
  int sock = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
  bind_to_upstream_interface(sock);
  setsockopt(sock, SOL_SOCKET, SO_RCVTIMEO, (const char *)&tv, sizeof tv);
  pk[0] = 0;                     // Version
  pk[1] = 1;                     // UDP
  *(uint16_t *)(pk + 2) = 0;     // Reserved
  *(uint16_t *)(pk + 4) = nport; // Private port
  *(uint16_t *)(pk + 6) = 0;     // Public port
  *(uint32_t *)(pk + 8) = htonl(lifetime);
  sendto(sock, pk, sizeof(pk), 0, (struct sockaddr *)&gw_addr, sizeof(gw_addr));
  if (recv(sock, buf, sizeof(buf), 0) > 0)
  {
    if (*(uint16_t *)(buf + 2) == 0)
    { // Result code
      close(sock);
      return *(uint16_t *)(buf + 10); // Mapped public port
    }
  }
  close(sock);
  return 0;
}

uint8_t *build_fcc_term_pk(struct addrinfo *maddr, uint16_t seqn)
{
  struct sockaddr_in *maddr_sin = (struct sockaddr_in *)maddr->ai_addr;

  static uint8_t pk[FCC_PK_LEN_TERM];
  memset(&pk, 0, sizeof(pk));
  uint8_t *p = pk;
  *(p++) = 0x85;                              // Version 2, Padding 0, FMT 5
  *(p++) = 205;                               // Type: Generic RTP Feedback (205)
  *(uint16_t *)p = htons(sizeof(pk) / 4 - 1); // Length
  p += 2;
  p += 4;                                      // Sender SSRC
  *(uint32_t *)p = maddr_sin->sin_addr.s_addr; // Media source SSRC
  p += 4;

  // FCI
  *(p++) = seqn ? 0 : 1;        // Stop bit, 0 = normal, 1 = force
  p++;                          // Reserved
  *(uint16_t *)p = htons(seqn); // First multicast packet sequence
  p += 2;

  return pk;
}

ssize_t sendto_triple(int fd, const void *buf, size_t n,
                     int flags, struct sockaddr_in *addr, socklen_t addr_len)
{
  static uint8_t i;
  for (i = 0; i < 3; i++)
  {
    if (sendto(fd, buf, n, flags, (struct sockaddr *)addr, addr_len) < 0)
    {
      return -1;
    }
  }
  return n;
}

void fcc_cleanup(int fcc_sock, struct sockaddr_in *fcc_server, struct services_s *service, uint16_t mapped_pub_port, struct sockaddr_in *fcc_client)
{
  if (fcc_sock)
    sendto_triple(fcc_sock, build_fcc_term_pk(service->addr, 0), FCC_PK_LEN_TERM, 0, fcc_server, sizeof(*fcc_server));
  if (mapped_pub_port)
    nat_pmp(fcc_client->sin_port, 0);
}
