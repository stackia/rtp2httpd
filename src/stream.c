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

#include <stdlib.h>
#include <signal.h>
#include <sys/select.h>
#include <sys/socket.h>
#include <errno.h>
#include <string.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include "stream.h"
#include "rtp2httpd.h"
#include "rtp.h"
#include "multicast.h"
#include "fcc.h"
#include "http.h"

#define UDPBUFLEN 2000

void start_rtp_stream(int client, struct services_s *service)
{
  int recv_state = RECV_STATE_INIT;
  int mcast_sock = 0, fcc_sock = 0, max_sock;
  int r;
  struct sockaddr_in *fcc_server;
  struct sockaddr_in fcc_client;
  struct sockaddr_in peer_addr;
  socklen_t slen = sizeof(peer_addr);
  uint8_t buf[UDPBUFLEN];
  uint8_t *mcast_pending_buf = NULL, *mcast_pbuf_c, *rtp_payload, mcast_pbuf_full;
  uint mcast_pbuf_len;
  int actualr;
  uint16_t mapped_pub_port = 0, media_port = 0, seqn, mcast_pbuf_lsqen, not_first = 0, fcc_term_sent = 0, fcc_term_seqn = 0;
  int payloadlength;
  fd_set rfds;
  struct timeval timeout;

  void sig_handler(int signum)
  {
    fcc_cleanup(fcc_sock, fcc_server, service, mapped_pub_port, &fcc_client);
    if (signum)
      exit(RETVAL_CLEAN);
  }

  void exit_handler()
  {
    sig_handler(0);
  }

  atexit(exit_handler);
  signal(SIGTERM, sig_handler);
  signal(SIGINT, sig_handler);
  signal(SIGPIPE, sig_handler);

  while (1)
  {
    if (recv_state == RECV_STATE_INIT)
    {
      if (service->service_type == SERVICE_MRTP && service->fcc_addr)
      {
        struct sockaddr_in sin;
        if (!fcc_sock)
        {
          fcc_sock = socket(AF_INET, service->fcc_addr->ai_socktype, service->fcc_addr->ai_protocol);
          bind_to_upstream_interface(fcc_sock);
          sin.sin_family = AF_INET;
          sin.sin_addr.s_addr = INADDR_ANY;
          sin.sin_port = 0;
          r = bind(fcc_sock, (struct sockaddr *)&sin, sizeof(sin));
          if (r)
          {
            logger(LOG_ERROR, "Cannot bind: %s\n", strerror(errno));
            exit(RETVAL_RTP_FAILED);
          }
          slen = sizeof(fcc_client);
          getsockname(fcc_sock, (struct sockaddr *)&fcc_client, &slen);
          if (conf_fcc_nat_traversal == FCC_NAT_T_NAT_PMP)
          {
            mapped_pub_port = nat_pmp(fcc_client.sin_port, 86400);
            logger(LOG_DEBUG, "NAT PMP result: %u\n", ntohs(mapped_pub_port));
          }
          fcc_server = (struct sockaddr_in *)service->fcc_addr->ai_addr;
        }
        r = sendto_triple(fcc_sock, build_fcc_request_pk(service->addr, mapped_pub_port ? mapped_pub_port : fcc_client.sin_port), FCC_PK_LEN_REQ, 0, fcc_server, sizeof(*fcc_server));
        if (r < 0)
        {
          logger(LOG_ERROR, "Unable to send FCC req message: %s\n", strerror(errno));
          exit(RETVAL_RTP_FAILED);
        }
        logger(LOG_DEBUG, "FCC server requested.\n");
        recv_state = RECV_STATE_FCC_REQUESTED;
      }
      else
      {
        mcast_sock = join_mcast_group(service);
        recv_state = RECV_STATE_MCAST_ACCEPTED;
      }
    }
    else
    {
      FD_ZERO(&rfds);
      max_sock = client;
      FD_SET(client, &rfds); /* Will be set if connection to client lost.*/
      if (fcc_sock && recv_state != RECV_STATE_MCAST_ACCEPTED)
      {
        FD_SET(fcc_sock, &rfds);
        if (fcc_sock > max_sock)
          max_sock = fcc_sock;
      }
      if (mcast_sock && recv_state != RECV_STATE_FCC_REQUESTED)
      {
        FD_SET(mcast_sock, &rfds);
        if (mcast_sock > max_sock)
          max_sock = mcast_sock;
      }
      timeout.tv_sec = 5;
      timeout.tv_usec = 0;

      /* We use select to get rid of recv stuck if
       * multicast group is unoperated.
       */
      r = select(max_sock + 1, &rfds, NULL, NULL, &timeout);
      if (r < 0 && errno == EINTR)
      {
        continue;
      }
      if (r == 0)
      { /* timeout reached */
        exit(RETVAL_SOCK_READ_FAILED);
      }
      if (FD_ISSET(client, &rfds))
      { /* client written stg, or conn. lost	 */
        exit(RETVAL_WRITE_FAILED);
      }
      else if (fcc_sock && FD_ISSET(fcc_sock, &rfds))
      {
        actualr = recvfrom(fcc_sock, buf, sizeof(buf), 0, (struct sockaddr *)&peer_addr, &slen);
        if (actualr < 0)
        {
          logger(LOG_ERROR, "FCC recv failed: %s\n", strerror(errno));
          continue;
        }
        if (peer_addr.sin_addr.s_addr != fcc_server->sin_addr.s_addr)
        {
          continue;
        }
        if (peer_addr.sin_port == fcc_server->sin_port)
        { // RTCP signal command
          if (buf[1] != 205)
          {
            logger(LOG_DEBUG, "Unrecognized FCC payload type: %u\n", buf[1]);
            continue;
          }
          if (buf[0] == 0x83)
          { // FMT 3
            if (buf[12] != 0)
            { // Result not success
              logger(LOG_DEBUG, "FCC (FMT 3) gives an error result code: %u\n", buf[12]);
              mcast_sock = join_mcast_group(service);
              recv_state = RECV_STATE_MCAST_ACCEPTED;
              continue;
            }
            uint16_t new_signal_port = *(uint16_t *)(buf + 14);
            int signal_port_changed = 0, media_port_changed = 0;
            if (new_signal_port && new_signal_port != fcc_server->sin_port)
            {
              logger(LOG_DEBUG, "FCC (FMT 3) gives a new signal port: %u\n", ntohs(new_signal_port));
              fcc_server->sin_port = new_signal_port;
              signal_port_changed = 1;
            }
            uint16_t new_media_port = *(uint16_t *)(buf + 16);
            if (new_media_port && new_media_port != media_port)
            {
              media_port = new_media_port;
              logger(LOG_DEBUG, "FCC (FMT 3) gives a new media port: %u\n", ntohs(new_media_port));
              media_port_changed = 1;
            }
            uint32_t new_fcc_ip = *(uint32_t *)(buf + 20);
            if (new_fcc_ip && new_fcc_ip != fcc_server->sin_addr.s_addr)
            {
              fcc_server->sin_addr.s_addr = new_fcc_ip;
              logger(LOG_DEBUG, "FCC (FMT 3) gives a new FCC ip: %s\n", inet_ntoa(fcc_server->sin_addr));
              signal_port_changed = 1;
              media_port_changed = 1;
            }
            if (buf[13] == 3)
            { // Redirect to new FCC server
              logger(LOG_DEBUG, "FCC (FMT 3) requests a redirection to a new server\n");
              recv_state = RECV_STATE_INIT;
            }
            else if (buf[13] != 2)
            { // Join mcast group instantly
              logger(LOG_DEBUG, "FCC (FMT 3) requests immediate mcast join, code: %u\n", buf[13]);
              mcast_sock = join_mcast_group(service);
              recv_state = RECV_STATE_MCAST_ACCEPTED;
            }
            else
            {
              // Send empty packet to make NAT happy
              if (conf_fcc_nat_traversal == FCC_NAT_T_PUNCHHOLE)
              {
                if (media_port_changed && media_port)
                {
                  struct sockaddr_in sintmp = *fcc_server;
                  sintmp.sin_port = media_port;
                  sendto_triple(fcc_sock, NULL, 0, 0, &sintmp, sizeof(sintmp));
                  logger(LOG_DEBUG, "Tried to NAT punch hole for media port %u\n", media_port);
                }
                if (signal_port_changed)
                {
                  sendto_triple(fcc_sock, NULL, 0, 0, fcc_server, sizeof(*fcc_server));
                  logger(LOG_DEBUG, "Tried to setup NAT punch hole for signal port %u\n", fcc_server->sin_port);
                }
              }
              logger(LOG_DEBUG, "FCC server accepted the req.\n");
            }
          }
          else if (buf[0] == 0x84)
          { // FMT 4
            logger(LOG_DEBUG, "FCC (FMT 4) indicates we can now join mcast\n");
            mcast_sock = join_mcast_group(service);
            recv_state = RECV_STATE_MCAST_REQUESTED;
          }
        }
        else if (peer_addr.sin_port == media_port)
        { // RTP media packet
          write_rtp_payload_to_client(client, actualr, buf, &seqn, &not_first);
          if (fcc_term_sent && seqn >= fcc_term_seqn - 1)
          {
            recv_state = RECV_STATE_MCAST_ACCEPTED;
          }
        }
      }
      else if (mcast_sock && FD_ISSET(mcast_sock, &rfds))
      {
        actualr = recv(mcast_sock, buf, sizeof(buf), 0);
        if (actualr < 0)
        {
          logger(LOG_DEBUG, "Mcast recv fail: %s", strerror(errno));
          continue;
        }
        if (service->service_type == SERVICE_MUDP)
        {
          write_to_client(client, buf, sizeof(buf));
          continue;
        }
        if (recv_state == RECV_STATE_MCAST_ACCEPTED)
        {
          if (mcast_pending_buf)
          {
            write_to_client(client, mcast_pending_buf, mcast_pbuf_len);
            free(mcast_pending_buf);
            mcast_pending_buf = NULL;
            seqn = mcast_pbuf_lsqen;
            logger(LOG_DEBUG, "Flushed mcast pending buffer to client. Term seqn: %u, mcast pending buffer last sqen: %u\n", fcc_term_seqn, mcast_pbuf_lsqen);
          }
          write_rtp_payload_to_client(client, actualr, buf, &seqn, &not_first);
        }
        else if (recv_state == RECV_STATE_MCAST_REQUESTED)
        {
          mcast_pbuf_lsqen = ntohs(*(uint16_t *)(buf + 2));
          if (!fcc_term_sent)
          {
            fcc_term_seqn = mcast_pbuf_lsqen;
            r = sendto_triple(fcc_sock, build_fcc_term_pk(service->addr, fcc_term_seqn + 2), FCC_PK_LEN_TERM, 0, fcc_server, sizeof(*fcc_server));
            if (r < 0)
            {
              logger(LOG_ERROR, "Unable to send FCC termination message: %s\n", strerror(errno));
            }
            mcast_pbuf_len = (max(fcc_term_seqn - seqn, 10) + 10) * 2000;
            mcast_pending_buf = malloc(mcast_pbuf_len);
            mcast_pbuf_c = mcast_pending_buf;
            mcast_pbuf_full = 0;
            fcc_term_sent = 1;
            logger(LOG_DEBUG, "FCC term message sent. Mcast pending buffer size: %u\n", mcast_pbuf_len);
          }
          if (mcast_pbuf_full)
            continue;
          if (get_rtp_payload(buf, actualr, &rtp_payload, &payloadlength) < 0)
          {
            continue;
          }
          if (mcast_pbuf_c + payloadlength > mcast_pending_buf + mcast_pbuf_len)
          {
            logger(LOG_ERROR, "Mcast pending buffer is full, video quality may suffer.\n", strerror(errno));
            mcast_pbuf_full = 1;
            continue;
          }
          memcpy(mcast_pbuf_c, rtp_payload, payloadlength);
          mcast_pbuf_c += payloadlength;
        }
      }
    }
  }

  /*SHOULD NEVER REACH THIS*/
  return;
}
