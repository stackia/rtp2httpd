#ifndef __CONFIGURATION_H__
#define __CONFIGURATION_H__

#include <net/if.h>
#include <stdint.h>
#include <stdio.h>

#ifndef SYSCONFDIR
#define SYSCONFDIR "."
#endif /* SYSCONFDIR */

#define CONFIGFILE SYSCONFDIR "/rtp2httpd.conf"

typedef enum loglevel {
  LOG_FATAL = 0, /* Always shown */
  LOG_ERROR,     /* Critical failures that prevent functionality */
  LOG_WARN,      /* Recoverable issues or unexpected conditions */
  LOG_INFO,      /* Important operational events (default verbosity) */
  LOG_DEBUG      /* Detailed diagnostic information */
} loglevel_t;

/*
 * Linked list of addresses to bind
 */
typedef struct bindaddr_s {
  char *node;
  char *service;
  struct bindaddr_s *next;
} bindaddr_t;

/**
 * Global configuration structure
 * Centralizes all runtime configuration parameters
 */
typedef struct {
  /* Logging settings */
  loglevel_t verbosity; /* Log verbosity level (LOG_FATAL to LOG_DEBUG) */

  /* Network and service settings */
  int udpxy;       /* Enable UDPxy URL format support (0=no, 1=yes) */
  int maxclients;  /* Maximum concurrent client connections */
  char *hostname;  /* Server hostname for URL generation (NULL=auto) */
  int xff;         /* Enable X-Forwarded-For header recognize (0=no, 1=yes) */
  char *r2h_token; /* Authentication token for HTTP requests (NULL=disabled) */

  /* Worker and performance settings */
  int workers; /* Number of worker threads (SO_REUSEPORT sharded), default 1 */
  int buffer_pool_max_size; /* Maximum number of buffers in zero-copy buffer
                               pool, default 16384 */

  /* FCC (Fast Channel Change) settings */
  int fcc_listen_port_min; /* Minimum UDP port for FCC sockets (0=any) */
  int fcc_listen_port_max; /* Maximum UDP port for FCC sockets (0=any) */

  /* Network interface settings */
  char upstream_interface[IFNAMSIZ]; /* Default interface for all upstream media
                                        requests (lowest priority) */
  char upstream_interface_fcc[IFNAMSIZ];  /* Interface for FCC unicast media
                                             requests (overrides
                                             upstream_interface) */
  char upstream_interface_rtsp[IFNAMSIZ]; /* Interface for RTSP unicast media
                                             requests (overrides
                                             upstream_interface) */
  char upstream_interface_multicast
      [IFNAMSIZ]; /* Interface for upstream multicast media requests (overrides
                     upstream_interface) */

  /* Multicast settings */
  int mcast_rejoin_interval; /* Periodic multicast rejoin interval in seconds
                                (0=disabled, default 0) */

  /* FFmpeg settings */
  char *ffmpeg_path; /* Path to ffmpeg executable (NULL=use system default
                        "ffmpeg") */
  char
      *ffmpeg_args; /* Additional ffmpeg arguments (default: "-hwaccel none") */

  /* Video snapshot settings */
  int video_snapshot; /* Enable video snapshot feature (0=off, 1=on) */

  /* Status page settings */
  char *
      status_page_path; /* Absolute HTTP path for status page (leading slash) */
  char *status_page_route; /* Status page path without leading slash (may be
                              empty) */

  /* Player page settings */
  char *
      player_page_path; /* Absolute HTTP path for player page (leading slash) */
  char *player_page_route; /* Player page path without leading slash (may be
                              empty) */

  /* External M3U settings */
  char *external_m3u_url;           /* External M3U URL (NULL=none) */
  int external_m3u_update_interval; /* Update interval in seconds (0=disabled)
                                     */
  int64_t last_external_m3u_update_time; /* Last update time in milliseconds */

  /* Zero-copy settings */
  int zerocopy_on_send; /* Enable zero-copy send with MSG_ZEROCOPY (0=disabled,
                           1=enabled) */
} config_t;

/* GLOBALS */
extern config_t config;
extern bindaddr_t *bind_addresses;

/* Configuration parsing functions */
void parse_bind_sec(char *line);
void parse_services_sec(char *line);
void parse_global_sec(char *line);
int parse_config_file(const char *path);
void restore_conf_defaults(void);
void usage(FILE *f, char *progname);
void parse_bind_cmd(char *optarg);

/* Command line parsing */
void parse_cmd_line(int argc, char *argv[]);

/* Memory management */
bindaddr_t *new_empty_bindaddr(void);
void free_bindaddr(bindaddr_t *);

#endif /* __CONFIGURATION_H__ */
