/*
 *  RTP2HTTP Proxy - Stream processing module
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

#ifndef __STREAM_H__
#define __STREAM_H__

#include "rtp2httpd.h"

/* Stream receive states */
#define RECV_STATE_INIT 0
#define RECV_STATE_FCC_REQUESTED 1
#define RECV_STATE_MCAST_REQUESTED 2
#define RECV_STATE_MCAST_ACCEPTED 3

/**
 * Start RTP stream processing for a client
 *
 * This function handles the complete flow of:
 * - FCC (Fast Channel Change) protocol if enabled
 * - Multicast group joining
 * - RTP packet reception and forwarding
 * - State machine management
 *
 * @param client Client socket file descriptor
 * @param service Service configuration
 */
void start_rtp_stream(int client, struct services_s *service);

#endif /* __STREAM_H__ */
