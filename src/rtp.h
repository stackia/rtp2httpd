/*
 *  RTP2HTTP Proxy - RTP packet processing module
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

#ifndef __RTP_H__
#define __RTP_H__

#include <stdint.h>
#include <sys/types.h>

/**
 * Extract RTP payload from an RTP packet
 *
 * @param buf Buffer containing RTP packet
 * @param recv_len Length of received data
 * @param payload Pointer to store payload location
 * @param size Pointer to store payload size
 * @return 0 on success, -1 on malformed packet
 */
int get_rtp_payload(uint8_t *buf, int recv_len, uint8_t **payload, int *size);

/**
 * Write RTP payload to client, handling sequence numbers and duplicates
 *
 * @param client Client socket file descriptor
 * @param recv_len Length of received RTP packet
 * @param buf Buffer containing RTP packet
 * @param old_seqn Pointer to store/track previous sequence number
 * @param not_first Pointer to track if this is not the first packet
 */
void write_rtp_payload_to_client(int client, int recv_len, uint8_t *buf,
                                uint16_t *old_seqn, uint16_t *not_first);

#endif /* __RTP_H__ */
