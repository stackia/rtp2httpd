/*
 *  RTP2HTTP Proxy - HTTP protocol handling module
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
#include <strings.h>
#include <unistd.h>
#include <errno.h>
#include <signal.h>
#include <netdb.h>
#include <ctype.h>
#include "http.h"
#include "rtp2httpd.h"

#ifdef HAVE_CONFIG_H
#include "config.h"
#endif /* HAVE_CONFIG_H */

static const char *response_codes[] = {
    "HTTP/1.1 200 OK\r\n",                  /* 0 */
    "HTTP/1.1 404 Not Found\r\n",           /* 1 */
    "HTTP/1.1 400 Bad Request\r\n",         /* 2 */
    "HTTP/1.1 501 Not Implemented\r\n",     /* 3 */
    "HTTP/1.1 503 Service Unavailable\r\n", /* 4 */
};

static const char *content_types[] = {
    "Content-Type: application/octet-stream\r\n", /* 0 */
    "Content-Type: text/html\r\n",                /* 1 */
    "Content-Type: text/html; charset=utf-8\r\n", /* 2 */
    "Content-Type: video/mpeg\r\n",               /* 3 */
    "Content-Type: audio/mpeg\r\n",               /* 4 */
};

static const char static_headers[] =
    "Server: " PACKAGE "/" VERSION "\r\n"
    "\r\n";

void write_to_client(int s, const uint8_t *buf, const size_t buflen)
{
  ssize_t actual;
  size_t written = 0;
  while (written < buflen)
  {
    actual = write(s, buf + written, buflen - written);
    if (actual <= 0)
    {
      exit(RETVAL_WRITE_FAILED);
    }
    written += actual;
  }
}

void send_http_headers(int s, int status, int type)
{
  write_to_client(s, (uint8_t *)response_codes[status],
                strlen(response_codes[status]));
  write_to_client(s, (uint8_t *)content_types[type],
                strlen(content_types[type]));
  write_to_client(s, (uint8_t *)static_headers,
                sizeof(static_headers) - 1);
}

void sigpipe_handler(int signum)
{
  exit(RETVAL_WRITE_FAILED);
}

/**
 * Parses URL in UDPxy format, i.e. /rtp/<maddr>:port
 * returns a pointer to statically allocated service struct if success,
 * NULL otherwise.
 */
struct services_s *parse_udpxy_url(char *url)
{
  static struct services_s serv;
  static struct addrinfo res_ai, msrc_res_ai, fcc_res_ai;
  static struct sockaddr_storage res_addr, msrc_res_addr, fcc_res_addr;

  char *addrstr, *portstr, *msrc = "", *msaddr = "", *msport = "", *fccaddr, *fccport;
  int i, r, rr, rrr;
  char c;
  struct addrinfo hints, *res, *msrc_res, *fcc_res;

  if (strncmp("/rtp/", url, 5) == 0)
    serv.service_type = SERVICE_MRTP;
  else if (strncmp("/udp/", url, 5) == 0)
    serv.service_type = SERVICE_MUDP;
  else
    return NULL;
  addrstr = rindex(url, '/');
  if (!addrstr)
    return NULL;
  /* Decode URL encoded strings */
  for (i = 0; i < (strlen(addrstr) - 2); i++)
  {
    if (addrstr[i] == '%' &&
        sscanf(addrstr + i + 1, "%2hhx", (unsigned char *)&c) > 0)
    {
      addrstr[i] = c;
      memmove(addrstr + i + 1, addrstr + i + 3, 1 + strlen(addrstr + i + 3));
    }
  }
  logger(LOG_DEBUG, "decoded addr: %s\n", addrstr);
  fccaddr = rindex(addrstr, '?');
  if (fccaddr)
  {
    *fccaddr = '\0';
    fccaddr++;
    fccaddr = strcasestr(fccaddr, "fcc=");
    if (fccaddr)
    {
      fccaddr += 4;
      fccport = rindex(fccaddr, ':');
      if (fccport)
      {
        *fccport = '\0';
        fccport++;
      }
    }
  }
  else
  {
    fccaddr = "";
  }
  if (!fccport)
  {
    fccport = "";
  }
  if (addrstr[1] == '[')
  {
    portstr = index(addrstr, ']');
    addrstr += 2;
    if (portstr)
    {
      *portstr = '\0';
      portstr = rindex(++portstr, ':');
    }
  }
  else
  {
    portstr = rindex(addrstr++, ':');
  }

  if (strstr(addrstr, "@") != NULL)
  {
    char *split;
    char *current;
    int cnt = 0;
    split = strtok(addrstr, "@");
    while (split != NULL)
    {
      current = split;
      if (cnt == 0)
        msrc = current;
      split = strtok(NULL, "@");
      if (cnt > 0 && split != NULL)
      {
        strcat(msrc, "@");
        strcat(msrc, current);
      }
      if (cnt > 0 && split == NULL)
        addrstr = current;
      cnt++;
    }

    cnt = 0;
    msaddr = msrc;
    split = strtok(msrc, ":");
    while (split != NULL)
    {
      current = split;
      if (cnt == 0)
        msaddr = current;
      split = strtok(NULL, ":");
      if (cnt > 0 && split != NULL)
      {
        strcat(msaddr, ":");
        strcat(msaddr, current);
      }
      if (cnt > 0 && split == NULL)
        msport = current;
      cnt++;
    }
  }

  if (portstr)
  {
    *portstr = '\0';
    portstr++;
  }
  else
    portstr = "1234";

  logger(LOG_DEBUG, "addrstr: %s portstr: %s msrc: %s fccaddr: %s fccport: %s\n", addrstr, portstr, msrc, fccaddr, fccport);

  memset(&hints, 0, sizeof(hints));
  hints.ai_socktype = SOCK_DGRAM;
  r = getaddrinfo(addrstr, portstr, &hints, &res);
  rr = 0;
  rrr = 0;
  if (strcmp(msrc, "") != 0 && msrc != NULL)
  {
    rr = getaddrinfo(msrc, 0, &hints, &msrc_res);
  }
  if (strcmp(fccaddr, "") != 0 && fccaddr != NULL)
  {
    rrr = getaddrinfo(fccaddr, fccport, &hints, &fcc_res);
  }
  if (r | rr | rrr)
  {
    if (r)
    {
      logger(LOG_ERROR, "Cannot resolve Multicast address. GAI: %s\n",
             gai_strerror(r));
    }
    if (rr)
    {
      logger(LOG_ERROR, "Cannot resolve Multicast source address. GAI: %s\n",
             gai_strerror(rr));
    }
    if (rrr)
    {
      logger(LOG_ERROR, "Cannot resolve FCC server address. GAI: %s\n",
             gai_strerror(rrr));
    }

    free(msrc);
    msrc = NULL;
    return NULL;
  }
  if (res->ai_next != NULL)
  {
    logger(LOG_ERROR, "Warning: maddr is ambiguos.\n");
  }
  if (strcmp(msrc, "") != 0 && msrc != NULL)
  {
    if (msrc_res->ai_next != NULL)
    {
      logger(LOG_ERROR, "Warning: msrc is ambiguos.\n");
    }
  }
  if (strcmp(fccaddr, "") != 0 && fccaddr != NULL)
  {
    if (fcc_res->ai_next != NULL)
    {
      logger(LOG_ERROR, "Warning: fcc is ambiguos.\n");
    }
  }

  /* Copy result into statically allocated structs */
  memcpy(&res_addr, res->ai_addr, res->ai_addrlen);
  memcpy(&res_ai, res, sizeof(struct addrinfo));
  res_ai.ai_addr = (struct sockaddr *)&res_addr;
  res_ai.ai_canonname = NULL;
  res_ai.ai_next = NULL;
  serv.addr = &res_ai;

  serv.msrc_addr = NULL;
  if (strcmp(msrc, "") != 0 && msrc != NULL)
  {
    /* Copy result into statically allocated structs */
    memcpy(&msrc_res_addr, msrc_res->ai_addr, msrc_res->ai_addrlen);
    memcpy(&msrc_res_ai, msrc_res, sizeof(struct addrinfo));
    msrc_res_ai.ai_addr = (struct sockaddr *)&msrc_res_addr;
    msrc_res_ai.ai_canonname = NULL;
    msrc_res_ai.ai_next = NULL;
    serv.msrc_addr = &msrc_res_ai;
  }

  serv.msrc = strdup(msrc);

  serv.fcc_addr = NULL;
  if (strcmp(fccaddr, "") != 0 && fccaddr != NULL)
  {
    /* Copy result into statically allocated structs */
    memcpy(&fcc_res_addr, fcc_res->ai_addr, fcc_res->ai_addrlen);
    memcpy(&fcc_res_ai, fcc_res, sizeof(struct addrinfo));
    fcc_res_ai.ai_addr = (struct sockaddr *)&fcc_res_addr;
    fcc_res_ai.ai_canonname = NULL;
    fcc_res_ai.ai_next = NULL;
    serv.fcc_addr = &fcc_res_ai;
  }

  return &serv;
}
