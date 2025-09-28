#ifndef __RTP2HTTPD_H__
#define __RTP2HTTPD_H__

#ifdef HAVE_CONFIG_H
#include "config.h"
#endif /* HAVE_CONFIG_H */

#include <stdio.h>
#include <sys/types.h>
#include <sys/socket.h>
#include <netdb.h>

#ifndef SYSCONFDIR
#define SYSCONFDIR "."
#endif /* SYSCONFDIR */

#define CONFIGFILE SYSCONFDIR "/rtp2httpd.conf"

#define max(a, b) ((a) > (b) ? (a) : (b))
#define min(a, b) ((a) < (b) ? (a) : (b))

enum loglevel
{
  LOG_FATAL = 0, /* Always shown */
  LOG_ERROR,     /* Could be silenced */
  LOG_INFO,      /* Default verbosity */
  LOG_DEBUG
};

enum fcc_nat_traversal
{
  FCC_NAT_T_DISABLED = 0,
  FCC_NAT_T_PUNCHHOLE,
  FCC_NAT_T_NAT_PMP
};

enum service_type
{
  SERVICE_MRTP = 0,
  SERVICE_MUDP,
  SERVICE_RTSP
};

/*
 * Linked list of adresses to bind
 */
struct bindaddr_s
{
  char *node;
  char *service;
  struct bindaddr_s *next;
};

/*
 * Linked list of allowed services
 */
struct services_s
{
  char *url;
  char *msrc;
  enum service_type service_type;
  struct addrinfo *addr;
  struct addrinfo *msrc_addr;
  struct addrinfo *fcc_addr;
  char *rtsp_url;       /* Full RTSP URL for SERVICE_RTSP */
  char *playseek_param; /* playseek parameter for time range */
  struct services_s *next;
};

/* GLOBAL CONFIGURATION VARIABLES */

extern enum loglevel conf_verbosity;
extern int conf_daemonise;
extern int conf_udpxy;
extern int conf_maxclients;
extern char *conf_hostname;
extern enum fcc_nat_traversal conf_fcc_nat_traversal;
extern struct ifreq conf_upstream_interface;

/* GLOBALS */
extern struct services_s *services;
extern struct bindaddr_s *bind_addresses;
extern int client_count;

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

/* Signal handlers */
void child_handler(int signum);

/* Return values used across multiple modules */
typedef enum
{
  RETVAL_CLEAN = 0,
  RETVAL_WRITE_FAILED = 1,
  RETVAL_READ_FAILED = 2,
  RETVAL_UNKNOWN_METHOD = 3,
  RETVAL_BAD_REQUEST = 4,
  RETVAL_RTP_FAILED = 5,
  RETVAL_SOCK_READ_FAILED = 6
} retval_t;

#endif /* __RTP2HTTPD_H__*/

#ifndef strndupa
#define strndupa(s, n) \
  (__extension__({const char *__in = (s); \
                        size_t __len = strnlen (__in, (n)) + 1; \
                        char *__out = (char *) alloca (__len); \
                        __out[__len-1] = '\0'; \
                        (char *) memcpy (__out, __in, __len-1); }))
#endif
