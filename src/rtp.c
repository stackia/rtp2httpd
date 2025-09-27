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

#include <stdint.h>
#include <arpa/inet.h>
#include "rtp.h"
#include "rtp2httpd.h"
#include "http.h"

int get_rtp_payload(uint8_t *buf, int recv_len, uint8_t **payload, int *size)
{
  int payloadstart, payloadlength;

  if (recv_len < 12 || (buf[0] & 0xC0) != 0x80)
  {
    /*malformed RTP/UDP/IP packet*/
    logger(LOG_DEBUG, "Malformed RTP packet received\n");
    return -1;
  }

  payloadstart = 12;                   /* basic RTP header length */
  payloadstart += (buf[0] & 0x0F) * 4; /*CRSC headers*/
  if (buf[0] & 0x10)
  { /*Extension header*/
    payloadstart += 4 + 4 * ntohs(*((uint16_t *)(buf + payloadstart + 2)));
  }
  payloadlength = recv_len - payloadstart;
  if (buf[0] & 0x20)
  { /*Padding*/
    payloadlength -= buf[recv_len];
    /*last octet indicate padding length*/
  }
  if (payloadlength < 0)
  {
    logger(LOG_DEBUG, "Malformed RTP packet received\n");
    return -1;
  }

  *payload = buf + payloadstart;
  *size = payloadlength;
  return 0;
}

void write_rtp_payload_to_client(int client, int recv_len, uint8_t *buf, uint16_t *old_seqn, uint16_t *not_first)
{
  int payloadlength;
  uint8_t *payload;
  uint16_t seqn;

  get_rtp_payload(buf, recv_len, &payload, &payloadlength);

  seqn = ntohs(*(uint16_t *)(buf + 2));
  if (*not_first && seqn == *old_seqn)
  {
    logger(LOG_DEBUG, "Duplicated RTP packet "
                      "received (seqn %d)\n",
           seqn);
    return;
  }
  if (*not_first && (seqn != ((*old_seqn + 1) & 0xFFFF)))
  {
    logger(LOG_DEBUG, "Congestion - expected %d, "
                      "received %d\n",
           (*old_seqn + 1) & 0xFFFF, seqn);
  }
  *old_seqn = seqn;
  *not_first = 1;

  write_to_client(client, payload, payloadlength);
}
