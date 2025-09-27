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

#ifndef __HTTP_H__
#define __HTTP_H__

#include <stdint.h>
#include <sys/types.h>
#include "rtp2httpd.h"

/* HTTP Status Codes */
#define STATUS_200 0
#define STATUS_404 1
#define STATUS_400 2
#define STATUS_501 3
#define STATUS_503 4

/* Content Types */
#define CONTENT_OSTREAM 0
#define CONTENT_HTML 1
#define CONTENT_HTMLUTF 2
#define CONTENT_MPEGV 3
#define CONTENT_MPEGA 4

/**
 * Ensures that all data are written to the socket
 *
 * @param s Socket file descriptor
 * @param buf Buffer to write
 * @param buflen Buffer length
 */
void write_to_client(int s, const uint8_t *buf, const size_t buflen);

/**
 * Send HTTP response headers
 *
 * @param s Socket file descriptor
 * @param status Status code index
 * @param type Content type index
 */
void send_http_headers(int s, int status, int type);

/**
 * Parse UDPxy format URLs
 *
 * @param url URL string to parse
 * @return Pointer to service structure or NULL on failure
 */
struct services_s *parse_udpxy_url(char *url);

/**
 * Signal handler for broken pipe
 *
 * @param signum Signal number
 */
void sigpipe_handler(int signum);

#endif /* __HTTP_H__ */
