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

#ifndef __MULTICAST_H__
#define __MULTICAST_H__

#include "rtp2httpd.h"

/**
 * Bind socket to upstream interface if configured
 *
 * @param sock Socket file descriptor to bind
 */
void bind_to_upstream_interface(int sock);

/**
 * Join a multicast group and return socket
 *
 * @param service Service structure containing multicast address info
 * @return Socket file descriptor on success, exits on failure
 */
int join_mcast_group(struct services_s *service);

#endif /* __MULTICAST_H__ */
