#ifndef __RTP2HTTPD_H__
#define __RTP2HTTPD_H__

#ifdef HAVE_CONFIG_H
#include "config.h"
#endif /* HAVE_CONFIG_H */

#include <stdio.h>
#include <sys/types.h>
#include <sys/socket.h>
#include <netdb.h>
#include <net/if.h> /* For struct ifreq */

#ifndef SYSCONFDIR
#define SYSCONFDIR "."
#endif /* SYSCONFDIR */

#define CONFIGFILE SYSCONFDIR "/rtp2httpd.conf"

#define max(a, b) ((a) > (b) ? (a) : (b))
#define min(a, b) ((a) < (b) ? (a) : (b))

/* Array size calculation macro */
#define ARRAY_SIZE(arr) (sizeof(arr) / sizeof((arr)[0]))

/* Branch prediction hints for compiler optimization */
#ifdef __GNUC__
#define likely(x) __builtin_expect(!!(x), 1)
#define unlikely(x) __builtin_expect(!!(x), 0)
#else
#define likely(x) (x)
#define unlikely(x) (x)
#endif

enum loglevel
{
  LOG_FATAL = 0, /* Always shown */
  LOG_ERROR,     /* Critical failures that prevent functionality */
  LOG_WARN,      /* Recoverable issues or unexpected conditions */
  LOG_INFO,      /* Important operational events (default verbosity) */
  LOG_DEBUG      /* Detailed diagnostic information */
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

/* Forward declaration - full definition in service.h */
typedef struct service_s service_t;

/**
 * Global configuration structure
 * Centralizes all runtime configuration parameters
 */
typedef struct
{
  /* Logging and daemon settings */
  enum loglevel verbosity; /* Log verbosity level (LOG_FATAL to LOG_DEBUG) */
  int daemonise;           /* Run as daemon in background (0=no, 1=yes) */

  /* Network and service settings */
  int udpxy;       /* Enable UDPxy URL format support (0=no, 1=yes) */
  int maxclients;  /* Maximum concurrent client connections */
  char *hostname;  /* Server hostname for URL generation (NULL=auto) */
  char *r2h_token; /* Authentication token for HTTP requests (NULL=disabled) */

  /* Worker and performance settings */
  int workers;              /* Number of worker threads (SO_REUSEPORT sharded), default 1 */
  int buffer_pool_max_size; /* Maximum number of buffers in zero-copy buffer pool, default 16384 */

  /* FCC (Fast Channel Change) settings */
  int fcc_listen_port_min; /* Minimum UDP port for FCC sockets (0=any) */
  int fcc_listen_port_max; /* Maximum UDP port for FCC sockets (0=any) */

  /* Network interface settings */
  struct ifreq upstream_interface;           /* Default interface for all upstream media requests (lowest priority) */
  struct ifreq upstream_interface_fcc;       /* Interface for FCC unicast media requests (overrides upstream_interface) */
  struct ifreq upstream_interface_rtsp;      /* Interface for RTSP unicast media requests (overrides upstream_interface) */
  struct ifreq upstream_interface_multicast; /* Interface for upstream multicast media requests (overrides upstream_interface) */

  /* Multicast settings */
  int mcast_rejoin_interval; /* Periodic multicast rejoin interval in seconds (0=disabled, default 0) */

  /* FFmpeg settings */
  char *ffmpeg_path; /* Path to ffmpeg executable (NULL=use system default "ffmpeg") */
  char *ffmpeg_args; /* Additional ffmpeg arguments (default: "-hwaccel none") */

  /* Video snapshot settings */
  int video_snapshot; /* Enable video snapshot feature (0=off, 1=on) */

  /* Status page settings */
  char *status_page_path;  /* Absolute HTTP path for status page (leading slash) */
  char *status_page_route; /* Status page path without leading slash (may be empty) */

  /* External M3U settings */
  char *external_m3u_url;             /* External M3U URL (NULL=none) */
  int external_m3u_update_interval;   /* Update interval in seconds (0=disabled) */
  int64_t last_external_m3u_update_time; /* Last update time in milliseconds */
} config_t;

/* GLOBAL CONFIGURATION */
extern config_t config;

/* GLOBALS */
extern service_t *services;
extern struct bindaddr_s *bind_addresses;
extern int client_count;
extern int worker_id;

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

/**
 * Get current monotonic time in milliseconds.
 * Uses CLOCK_MONOTONIC for high precision and immunity to system clock changes.
 * Thread-safe.
 *
 * @return Current time in milliseconds since an unspecified starting point
 */
int64_t get_time_ms(void);

/**
 * Get current real time in milliseconds since Unix epoch.
 * Uses CLOCK_REALTIME for wall clock time.
 * Thread-safe.
 *
 * @return Current time in milliseconds since Unix epoch (1970-01-01 00:00:00 UTC)
 */
int64_t get_realtime_ms(void);

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
