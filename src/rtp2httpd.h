/*
 *  RTP2HTTP Proxy - Multicast RTP stream to UNICAST HTTP translator
 *
 *  Copyright (C) 2008,2009 Ondrej Caletka <o.caletka@sh.cvut.cz>
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

#ifndef __RTP2HTTPD_H__
#define __RTP2HTTPD_H__

#include <sys/types.h>
#include <sys/socket.h>
#include <netdb.h>


#ifdef HAVE_CONFIG_H
#include "config.h"
#endif /* HAVE_CONFIG_H */

#ifndef SYSCONFDIR
#define SYSCONFDIR "."
#endif /* SYSCONFDIR */

#define CONFIGFILE SYSCONFDIR "/rtp2httpd.conf"

#define max(a,b) ((a)>(b) ? (a):(b))
#define min(a,b) ((a)<(b) ? (a):(b))

enum loglevel {
	LOG_FATAL = 0, /* Always shown */
	LOG_ERROR,     /* Could be silenced */
	LOG_INFO,      /* Default verbosity */
	LOG_DEBUG
};

enum service_type {
	SERVICE_MRTP = 0,
	SERVICE_MUDP
};

/*
 * Linked list of adresses to bind
 */
struct bindaddr_s {
	char *node;
	char *service;
	struct bindaddr_s *next;
};

/*
 * Linked list of allowed services
 */
struct services_s {
	char *url;
	char *msrc;
	enum service_type service_type;
	struct addrinfo *addr;
	struct addrinfo *msrc_addr;
	struct addrinfo *fcc_addr;
	struct services_s *next;
};

/* GLOBAL CONFIGURATION VARIABLES */

extern enum loglevel conf_verbosity;
extern int conf_daemonise;
extern int conf_udpxy;
extern int conf_maxclients;
extern char *conf_hostname;

/* GLOBALS */
extern struct services_s *services;
extern struct bindaddr_s *bindaddr;
extern int clientcount;


/* rtp2httpd.c INTERFACE */

/**
 * Logger function. Show the message if current verbosity is above
 * logged level.
 *
 * @param levem Message log level
 * @param format printf style format string
 * @returns Whatever printf returns
 */
int logger(enum loglevel level, const char *format, ...);


/* httpclients.c INTERFACE */

/*
 * Service for connected client.
 * Run in forked thread.
 *
 * @params s connected socket
 */
void clientService(int s);

/* Return values of clientService() */
#define RETVAL_CLEAN 0
#define RETVAL_WRITE_FAILED 1
#define RETVAL_READ_FAILED 2
#define RETVAL_UNKNOWN_METHOD 3
#define RETVAL_BAD_REQUEST 4
#define RETVAL_RTP_FAILED 5
#define RETVAL_SOCK_READ_FAILED 6

/* configfile.c INTERFACE */

void parseCmdLine(int argc, char *argv[]);
struct bindaddr_s* newEmptyBindaddr();
void freeBindaddr(struct bindaddr_s*);

#endif /* __RTP2HTTPD_H__*/

#ifndef strndupa
#define strndupa(s, n) \
       (__extension__ ({const char *__in = (s); \
                        size_t __len = strnlen (__in, (n)) + 1; \
                        char *__out = (char *) alloca (__len); \
                        __out[__len-1] = '\0'; \
                        (char *) memcpy (__out, __in, __len-1);}))
#endif
