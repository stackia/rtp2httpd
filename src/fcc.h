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

#ifndef __FCC_H__
#define __FCC_H__

#include <stdint.h>
#include <netinet/in.h>
#include <netdb.h>
#include "rtp2httpd.h"

#define FCC_PK_LEN_REQ 40
#define FCC_PK_LEN_TERM 16

/**
 * Build FCC request packet
 *
 * @param maddr Multicast address info
 * @param fcc_client_nport FCC client port in network byte order
 * @return Pointer to static packet buffer
 */
uint8_t *build_fcc_request_pk(struct addrinfo *maddr, uint16_t fcc_client_nport);

/**
 * Build FCC termination packet
 *
 * @param maddr Multicast address info
 * @param seqn Sequence number
 * @return Pointer to static packet buffer
 */
uint8_t *build_fcc_term_pk(struct addrinfo *maddr, uint16_t seqn);

/**
 * Send packet three times for reliability
 *
 * @param fd Socket file descriptor
 * @param buf Buffer to send
 * @param n Buffer length
 * @param flags Send flags
 * @param addr Destination address
 * @param addr_len Address length
 * @return Number of bytes sent or -1 on error
 */
ssize_t sendto_triple(int fd, const void *buf, size_t n, int flags,
                     struct sockaddr_in *addr, socklen_t addr_len);

/**
 * Cleanup FCC resources
 *
 * @param fcc_sock FCC socket file descriptor
 * @param fcc_server FCC server address
 * @param service Service structure
 * @param mapped_pub_port Mapped public port (for NAT-PMP)
 * @param fcc_client FCC client address
 */
void fcc_cleanup(int fcc_sock, struct sockaddr_in *fcc_server,
                struct services_s *service, uint16_t mapped_pub_port,
                struct sockaddr_in *fcc_client);

/**
 * NAT-PMP port mapping
 *
 * @param nport Port in network byte order
 * @param lifetime Mapping lifetime in seconds
 * @return Mapped public port in network byte order, 0 on failure
 */
uint16_t nat_pmp(uint16_t nport, uint32_t lifetime);

/**
 * Get default gateway IP address
 *
 * @param addr Pointer to store gateway address
 * @return 0 on success, -1 on failure
 */
int get_gw_ip(in_addr_t *addr);

#endif /* __FCC_H__ */
