#ifdef HAVE_CONFIG_H
#include "config.h"
#endif /* HAVE_CONFIG_H */

#include <stdio.h>
#include <stdlib.h>
#include <sys/socket.h>
#include <string.h>
#include <strings.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <ctype.h>
#include <errno.h>
#include <limits.h>
#include <getopt.h>
#include <net/if.h>
#include <libgen.h>

#include "rtp2httpd.h"
#include "configuration.h"
#include "service.h"
#include "m3u.h"
#include "http_fetch.h"

#define MAX_LINE 1024

/* GLOBAL CONFIGURATION */

config_t config;

/* *** */

int cmd_verbosity_set;
int cmd_daemonise_set;
int cmd_udpxy_set;
int cmd_maxclients_set;
int cmd_bind_set;
int cmd_fcc_nat_traversal_set;
int cmd_hostname_set;
int cmd_r2h_token_set;
int cmd_buffer_pool_max_size_set;
int cmd_mcast_rejoin_interval_set;
int cmd_ffmpeg_path_set;
int cmd_ffmpeg_args_set;
int cmd_video_snapshot_set;
int cmd_upstream_interface_unicast_set;
int cmd_upstream_interface_multicast_set;
int cmd_fcc_listen_port_range_set;
int cmd_status_page_path_set;

enum section_e
{
  SEC_NONE = 0,
  SEC_BIND,
  SEC_SERVICES,
  SEC_GLOBAL
};

/* M3U parsing state variables */
static char *inline_m3u_buffer = NULL;
static size_t inline_m3u_buffer_size = 0;
static size_t inline_m3u_buffer_used = 0;

/* Helper functions for parsing */

/* Skip whitespace and extract next token */
static char *extract_token(char *line, int *pos)
{
  int i = *pos;
  int j = i;

  while (isspace(line[i]))
    i++;
  j = i;
  while (line[j] != '\0' && !isspace(line[j]))
    j++;

  *pos = j;
  return strndup(line + i, j - i);
}

/* Parse boolean value from string */
static int parse_bool(const char *value)
{
  return (strcasecmp("on", value) == 0) ||
         (strcasecmp("true", value) == 0) ||
         (strcasecmp("yes", value) == 0) ||
         (strcasecmp("1", value) == 0);
}

/* Set config value if not already set by command line */
static int set_if_not_cmd_override(int cmd_flag, const char *param_name)
{
  if (cmd_flag)
  {
    logger(LOG_WARN, "Config file value \"%s\" ignored (already set on command line)", param_name);
    return 0;
  }
  return 1;
}

/* Free a string pointer if not NULL */
static void safe_free_string(char **str)
{
  if (*str != NULL)
  {
    free(*str);
    *str = NULL;
  }
}

static int parse_port_range_value(const char *value, int *min_port, int *max_port)
{
  char *endptr = NULL;
  long start = 0;
  long end = 0;

  if (!value || !min_port || !max_port)
    return -1;

  errno = 0;
  start = strtol(value, &endptr, 10);
  if (endptr == value)
    return -1;

  while (*endptr && isspace((unsigned char)*endptr))
    endptr++;

  if (*endptr == '\0')
  {
    end = start;
  }
  else if (*endptr == '-')
  {
    const char *end_str = endptr + 1;
    while (*end_str && isspace((unsigned char)*end_str))
      end_str++;
    if (*end_str == '\0')
    {
      return -1;
    }
    errno = 0;
    end = strtol(end_str, &endptr, 10);
    if (endptr == end_str || *endptr != '\0')
      return -1;
  }
  else
  {
    return -1;
  }

  if (errno != 0 || start < 1 || start > 65535 || end < 1 || end > 65535)
    return -1;

  if (end < start)
    return -1;

  *min_port = (int)start;
  *max_port = (int)end;
  return 0;
}

static void set_status_page_path_value(const char *value)
{
  char normalized[HTTP_URL_BUFFER_SIZE];
  size_t len = 0;
  const char *src;

  if (!value || value[0] == '\0')
  {
    logger(LOG_ERROR, "status-page-path cannot be empty, keeping previous value");
    return;
  }

  src = value;
  while (*src == '/')
    src++;

  normalized[len++] = '/';

  while (*src && len < sizeof(normalized) - 1)
    normalized[len++] = *src++;

  if (*src != '\0')
  {
    logger(LOG_ERROR, "status-page-path is too long, keeping previous value");
    return;
  }

  while (len > 1 && normalized[len - 1] == '/')
    len--;

  normalized[len] = '\0';

  safe_free_string(&config.status_page_path);
  safe_free_string(&config.status_page_route);

  config.status_page_path = strdup(normalized);
  if (!config.status_page_path)
  {
    logger(LOG_ERROR, "Failed to allocate status-page-path");
    config.status_page_route = NULL;
    return;
  }

  if (normalized[1] != '\0')
    config.status_page_route = strdup(normalized + 1);
  else
    config.status_page_route = strdup("");

  if (!config.status_page_route)
  {
    logger(LOG_ERROR, "Failed to allocate status-page-path route");
    safe_free_string(&config.status_page_path);
  }
}

void parse_bind_sec(char *line)
{
  int pos = 0;
  char *node, *service;
  struct bindaddr_s *ba;

  node = extract_token(line, &pos);
  service = extract_token(line, &pos);

  if (strcmp("*", node) == 0)
  {
    free(node);
    node = NULL;
  }
  logger(LOG_DEBUG, "node: %s, port: %s", node, service);

  ba = malloc(sizeof(struct bindaddr_s));
  ba->node = node;
  ba->service = service;
  ba->next = bind_addresses;
  bind_addresses = ba;
}

/* process_m3u_content() removed - directly call m3u_parse_and_create_services() instead */

void parse_services_sec(char *line)
{
  int i;

  /* Check if this line is the start of M3U content (#EXTM3U header) */
  if (m3u_is_header(line))
  {
    /* Allocate initial buffer for inline M3U */
    if (!inline_m3u_buffer)
    {
      inline_m3u_buffer_size = 8192;
      inline_m3u_buffer = malloc(inline_m3u_buffer_size);
      if (!inline_m3u_buffer)
      {
        logger(LOG_ERROR, "Failed to allocate M3U buffer");
        return;
      }
      inline_m3u_buffer_used = 0;
    }

    /* Add this line to buffer */
    size_t line_len = strlen(line);
    while (inline_m3u_buffer_used + line_len + 2 > inline_m3u_buffer_size)
    {
      /* Grow buffer */
      size_t new_size = inline_m3u_buffer_size * 2;
      char *new_buf = realloc(inline_m3u_buffer, new_size);
      if (!new_buf)
      {
        logger(LOG_ERROR, "Failed to grow M3U buffer");
        return;
      }
      inline_m3u_buffer = new_buf;
      inline_m3u_buffer_size = new_size;
    }
    memcpy(inline_m3u_buffer + inline_m3u_buffer_used, line, line_len);
    inline_m3u_buffer_used += line_len;
    inline_m3u_buffer[inline_m3u_buffer_used++] = '\n';
    inline_m3u_buffer[inline_m3u_buffer_used] = '\0';
    return;
  }

  /* If we're currently buffering M3U content, continue buffering */
  if (inline_m3u_buffer && inline_m3u_buffer_used > 0)
  {
    /* Check if this is a comment line (M3U metadata) or URL line */
    if (line[0] == '#' || strncmp(line, "rtp://", 6) == 0 ||
        strncmp(line, "rtsp://", 7) == 0 || strncmp(line, "udp://", 6) == 0 ||
        strncmp(line, "http://", 7) == 0 || strncmp(line, "https://", 8) == 0)
    {
      /* Continue buffering */
      size_t line_len = strlen(line);
      while (inline_m3u_buffer_used + line_len + 2 > inline_m3u_buffer_size)
      {
        /* Grow buffer */
        size_t new_size = inline_m3u_buffer_size * 2;
        char *new_buf = realloc(inline_m3u_buffer, new_size);
        if (!new_buf)
        {
          logger(LOG_ERROR, "Failed to grow M3U buffer");
          return;
        }
        inline_m3u_buffer = new_buf;
        inline_m3u_buffer_size = new_size;
      }
      memcpy(inline_m3u_buffer + inline_m3u_buffer_used, line, line_len);
      inline_m3u_buffer_used += line_len;
      inline_m3u_buffer[inline_m3u_buffer_used++] = '\n';
      inline_m3u_buffer[inline_m3u_buffer_used] = '\0';
      return;
    }
    else
    {
      /* This line doesn't look like M3U content, stop buffering and process what we have */
      /* This will fall through to parameter parsing below */
    }
  }

  /* If we reach here with non-empty line, log it for debugging */
  /* Note: external-m3u and external-m3u-update-interval are now in [global] section */
  /* Trim whitespace to check if line is empty */
  i = 0;
  while (isspace(line[i]))
    i++;

  if (line[i] != '\0' && line[i] != '\n' && line[i] != '\r')
  {
    logger(LOG_DEBUG, "Ignoring unparsable line in [services]: '%s'", line);
  }
}

void parse_global_sec(char *line)
{
  int i, j;
  char *param, *value;
  char *ind;

  j = i = 0;
  while (!isspace(line[j]))
    j++;
  param = strndupa(line, j);

  ind = index(line + j, '=');
  if (ind == NULL)
  {
    logger(LOG_ERROR, "Unrecognised config line: %s", line);
    return;
  }

  i = ind - line + 1;
  while (isspace(line[i]))
    i++;
  j = i;
  /* Find end of line (excluding trailing whitespace and newline) */
  while (line[j] != '\0' && line[j] != '\n' && line[j] != '\r')
    j++;
  /* Trim trailing whitespace */
  while (j > i && isspace(line[j - 1]))
    j--;
  value = strndupa(line + i, j - i);

  /* Integer parameters with command line override */
  if (strcasecmp("verbosity", param) == 0)
  {
    if (set_if_not_cmd_override(cmd_verbosity_set, "verbosity"))
      config.verbosity = atoi(value);
    return;
  }

  if (strcasecmp("maxclients", param) == 0)
  {
    if (set_if_not_cmd_override(cmd_maxclients_set, "maxclients"))
    {
      if (atoi(value) < 1)
      {
        logger(LOG_ERROR, "Invalid maxclients! Ignoring.");
        return;
      }
      config.maxclients = atoi(value);
    }
    return;
  }

  if (strcasecmp("workers", param) == 0)
  {
    int n = atoi(value);
    if (n < 1)
    {
      logger(LOG_ERROR, "Invalid workers value! Must be >= 1. Ignoring.");
      return;
    }
    config.workers = n;
    return;
  }

  if (strcasecmp("fcc-nat-traversal", param) == 0)
  {
    if (set_if_not_cmd_override(cmd_fcc_nat_traversal_set, "fcc-nat-traversal"))
      config.fcc_nat_traversal = atoi(value);
    return;
  }

  if (strcasecmp("fcc-listen-port-range", param) == 0)
  {
    if (set_if_not_cmd_override(cmd_fcc_listen_port_range_set, "fcc-listen-port-range"))
    {
      int min_port = 0, max_port = 0;
      if (parse_port_range_value(value, &min_port, &max_port) == 0)
      {
        config.fcc_listen_port_min = min_port;
        config.fcc_listen_port_max = max_port;
        logger(LOG_INFO, "FCC listen port range set to %d-%d", min_port, max_port);
      }
      else
      {
        logger(LOG_ERROR, "Invalid fcc-listen-port-range value: %s", value);
      }
    }
    return;
  }

  if (strcasecmp("buffer-pool-max-size", param) == 0)
  {
    if (set_if_not_cmd_override(cmd_buffer_pool_max_size_set, "buffer-pool-max-size"))
    {
      int val = atoi(value);
      if (val < 1)
      {
        logger(LOG_ERROR, "Invalid buffer-pool-max-size! Must be >= 1. Ignoring.");
      }
      else
      {
        config.buffer_pool_max_size = val;
      }
    }
    return;
  }

  /* Boolean parameters with command line override */
  if (strcasecmp("daemonise", param) == 0)
  {
    if (set_if_not_cmd_override(cmd_daemonise_set, "daemonise"))
      config.daemonise = parse_bool(value);
    return;
  }

  if (strcasecmp("udpxy", param) == 0)
  {
    if (set_if_not_cmd_override(cmd_udpxy_set, "udpxy"))
      config.udpxy = parse_bool(value);
    return;
  }

  if (strcasecmp("video-snapshot", param) == 0)
  {
    if (set_if_not_cmd_override(cmd_video_snapshot_set, "video-snapshot"))
      config.video_snapshot = parse_bool(value);
    return;
  }

  /* String parameters with command line override */
  if (strcasecmp("hostname", param) == 0)
  {
    if (set_if_not_cmd_override(cmd_hostname_set, "hostname"))
    {
      safe_free_string(&config.hostname);
      config.hostname = strdup(value);
    }
    return;
  }

  if (strcasecmp("status-page-path", param) == 0)
  {
    if (set_if_not_cmd_override(cmd_status_page_path_set, "status-page-path"))
      set_status_page_path_value(value);
    return;
  }

  if (strcasecmp("r2h-token", param) == 0)
  {
    if (set_if_not_cmd_override(cmd_r2h_token_set, "r2h-token"))
    {
      safe_free_string(&config.r2h_token);
      config.r2h_token = strdup(value);
    }
    return;
  }

  if (strcasecmp("ffmpeg-path", param) == 0)
  {
    if (set_if_not_cmd_override(cmd_ffmpeg_path_set, "ffmpeg-path"))
    {
      safe_free_string(&config.ffmpeg_path);
      config.ffmpeg_path = strdup(value);
    }
    return;
  }

  if (strcasecmp("ffmpeg-args", param) == 0)
  {
    if (set_if_not_cmd_override(cmd_ffmpeg_args_set, "ffmpeg-args"))
    {
      safe_free_string(&config.ffmpeg_args);
      config.ffmpeg_args = strdup(value);
    }
    return;
  }

  /* Interface parameters with command line override */
  if (strcasecmp("upstream-interface-unicast", param) == 0)
  {
    if (set_if_not_cmd_override(cmd_upstream_interface_unicast_set, "upstream-interface-unicast"))
    {
      strncpy(config.upstream_interface_unicast.ifr_name, value, IFNAMSIZ - 1);
      config.upstream_interface_unicast.ifr_ifindex = if_nametoindex(config.upstream_interface_unicast.ifr_name);
    }
    return;
  }

  if (strcasecmp("upstream-interface-multicast", param) == 0)
  {
    if (set_if_not_cmd_override(cmd_upstream_interface_multicast_set, "upstream-interface-multicast"))
    {
      strncpy(config.upstream_interface_multicast.ifr_name, value, IFNAMSIZ - 1);
      config.upstream_interface_multicast.ifr_ifindex = if_nametoindex(config.upstream_interface_multicast.ifr_name);
    }
    return;
  }

  if (strcasecmp("mcast-rejoin-interval", param) == 0)
  {
    if (set_if_not_cmd_override(cmd_mcast_rejoin_interval_set, "mcast-rejoin-interval"))
    {
      int interval = atoi(value);
      if (interval < 0)
      {
        logger(LOG_ERROR, "Invalid mcast-rejoin-interval value: %s (must be >= 0)", value);
      }
      else
      {
        config.mcast_rejoin_interval = interval;
        if (interval > 0)
        {
          logger(LOG_INFO, "Multicast rejoin interval set to %d seconds", interval);
        }
      }
    }
    return;
  }

  /* External M3U configuration */
  if (strcasecmp("external-m3u", param) == 0)
  {
    if (config.external_m3u_url)
      free(config.external_m3u_url);
    config.external_m3u_url = strdup(value);
    logger(LOG_INFO, "External M3U URL configured: %s", config.external_m3u_url);
    return;
  }

  if (strcasecmp("external-m3u-update-interval", param) == 0)
  {
    config.external_m3u_update_interval = atoi(value);
    logger(LOG_INFO, "External M3U update interval: %d seconds", config.external_m3u_update_interval);
    return;
  }

  logger(LOG_ERROR, "Unknown config parameter: %s", param);
}

int parse_config_file(const char *path)
{
  FILE *cfile;
  char line[MAX_LINE];
  int i, bind_msg_done = 0;
  enum section_e section = SEC_NONE;
  enum section_e prev_section = SEC_NONE;

  logger(LOG_DEBUG, "Opening %s", path);
  cfile = fopen(path, "r");
  if (cfile == NULL)
    return -1;

  /* Reset transformed M3U playlist buffer at start of config parsing */
  m3u_reset_transformed_playlist();

  while (fgets(line, MAX_LINE, cfile))
  {
    i = 0;

    while (isspace(line[i]))
      i++;

    /* Allow # comments in [services] section for M3U content, skip in other sections */
    if ((line[i] == '#' || line[i] == ';') && section != SEC_SERVICES)
      continue;

    if (line[i] == '\0')
      continue;

    if (line[i] == '[')
    { /* section change */
      /* Process any buffered M3U content before changing sections */
      if (prev_section == SEC_SERVICES)
      {
        if (inline_m3u_buffer && inline_m3u_buffer_used > 0)
        {
          m3u_parse_and_create_services(inline_m3u_buffer, "inline");
          free(inline_m3u_buffer);
          inline_m3u_buffer = NULL;
          inline_m3u_buffer_size = 0;
          inline_m3u_buffer_used = 0;
        }
      }

      char *end = index(line + i, ']');
      if (end)
      {
        char *section_name = strndupa(line + i + 1, end - line - i - 1);
        if (strcasecmp("bind", section_name) == 0)
        {
          prev_section = section;
          section = SEC_BIND;
          continue;
        }
        if (strcasecmp("services", section_name) == 0)
        {
          prev_section = section;
          section = SEC_SERVICES;
          continue;
        }
        if (strcasecmp("global", section_name) == 0)
        {
          prev_section = section;
          section = SEC_GLOBAL;
          continue;
        }
        logger(LOG_ERROR, "Invalid section name: %s", section_name);
        continue;
      }
      else
      {
        logger(LOG_ERROR, "Unterminated section: %s", line + i);
        continue;
      }
    }

    if (cmd_bind_set && section == SEC_BIND)
    {
      if (!bind_msg_done)
      {
        logger(LOG_WARN, "Config file section \"[bind]\" ignored (already set on command line)");
        bind_msg_done = 1;
      }
      continue;
    }

    switch (section)
    {
    case SEC_BIND:
      parse_bind_sec(line + i);
      break;
    case SEC_SERVICES:
      parse_services_sec(line + i);
      break;
    case SEC_GLOBAL:
      parse_global_sec(line + i);
      break;
    default:
      logger(LOG_ERROR, "Unrecognised config line: %s", line);
    }
  }

  /* Process any remaining buffered inline M3U content at end of file */
  if (section == SEC_SERVICES)
  {
    if (inline_m3u_buffer && inline_m3u_buffer_used > 0)
    {
      m3u_parse_and_create_services(inline_m3u_buffer, "inline");
      free(inline_m3u_buffer);
      inline_m3u_buffer = NULL;
      inline_m3u_buffer_size = 0;
      inline_m3u_buffer_used = 0;
    }
  }

  fclose(cfile);
  return 0;
}

struct bindaddr_s *new_empty_bindaddr(void)
{
  struct bindaddr_s *ba;
  ba = malloc(sizeof(struct bindaddr_s));
  memset(ba, 0, sizeof(*ba));
  ba->service = strdup("5140");
  return ba;
}

void free_bindaddr(struct bindaddr_s *ba)
{
  struct bindaddr_s *bat;
  while (ba)
  {
    bat = ba;
    ba = ba->next;
    if (bat->node)
      free(bat->node);
    if (bat->service)
      free(bat->service);
    free(bat);
  }
}

/*
 * Free service structure created from configuration file
 */
static void free_config_service(service_t *service)
{
  if (service->url != NULL)
    free(service->url);
  if (service->addr != NULL)
    freeaddrinfo(service->addr);
  if (service->msrc_addr != NULL)
    freeaddrinfo(service->msrc_addr);
  if (service->fcc_addr != NULL)
    freeaddrinfo(service->fcc_addr);
  if (service->rtsp_url != NULL)
    free(service->rtsp_url);
  if (service->playseek_param != NULL)
    free(service->playseek_param);
  if (service->user_agent != NULL)
    free(service->user_agent);
  if (service->msrc != NULL)
    free(service->msrc);
  free(service);
}

/* Setup configuration defaults */
void restore_conf_defaults(void)
{
  service_t *service_tmp;

  /* Initialize configuration structure with defaults */
  memset(&config, 0, sizeof(config_t));

  /* Set default values and reset command line flags */
  config.verbosity = LOG_ERROR;
  cmd_verbosity_set = 0;

  config.daemonise = 0;
  cmd_daemonise_set = 0;

  config.maxclients = 5;
  cmd_maxclients_set = 0;

  config.udpxy = 1;
  cmd_udpxy_set = 0;

  cmd_bind_set = 0;

  config.fcc_nat_traversal = FCC_NAT_T_DISABLED;
  cmd_fcc_nat_traversal_set = 0;
  config.fcc_listen_port_min = 0;
  config.fcc_listen_port_max = 0;
  cmd_fcc_listen_port_range_set = 0;

  config.workers = 1; /* default single worker for low-end OpenWrt */

  config.buffer_pool_max_size = 16384;
  cmd_buffer_pool_max_size_set = 0;

  safe_free_string(&config.hostname);
  cmd_hostname_set = 0;

  safe_free_string(&config.r2h_token);
  cmd_r2h_token_set = 0;

  safe_free_string(&config.ffmpeg_path);
  cmd_ffmpeg_path_set = 0;

  safe_free_string(&config.ffmpeg_args);
  config.ffmpeg_args = strdup("-hwaccel none"); /* Set default ffmpeg args */
  cmd_ffmpeg_args_set = 0;

  config.video_snapshot = 0;
  cmd_video_snapshot_set = 0;

  config.mcast_rejoin_interval = 0; /* default disabled */
  cmd_mcast_rejoin_interval_set = 0;

  set_status_page_path_value("/status");
  cmd_status_page_path_set = 0;

  safe_free_string(&config.external_m3u_url);
  config.external_m3u_update_interval = 86400; /* 24 hours default */
  config.last_external_m3u_update_time = 0;

  if (config.upstream_interface_unicast.ifr_name[0] != '\0')
    memset(&config.upstream_interface_unicast, 0, sizeof(struct ifreq));
  cmd_upstream_interface_unicast_set = 0;

  if (config.upstream_interface_multicast.ifr_name[0] != '\0')
    memset(&config.upstream_interface_multicast, 0, sizeof(struct ifreq));
  cmd_upstream_interface_multicast_set = 0;

  /* Free all services */
  while (services != NULL)
  {
    service_tmp = services;
    services = services->next;
    free_config_service(service_tmp);
  }

  /* Free all bind addresses */
  free_bindaddr(bind_addresses);
  bind_addresses = NULL;
}

void usage(FILE *f, char *progname)
{
  char *prog = basename(progname);
  fprintf(f,
          PACKAGE " - Multicast RTP to Unicast HTTP stream convertor\n"
                  "\n"
                  "Version " VERSION "\n"
                  "Copyright 2008-2014 Ondrej Caletka <ondrej@caletka.cz>\n"
                  "\n"
                  "This program is free software; you can redistribute it and/or modify\n"
                  "it under the terms of the GNU General Public License version 2\n"
                  "as published by the Free Software Foundation.\n");
  fprintf(f,
          "\n"
          "Usage: %s [options]\n"
          "\n"
          "Options:\n"
          "\t-h --help            Show this help\n"
          "\t-v --verbose         Increase verbosity (0=FATAL, 1=ERROR, 2=WARN, 3=INFO, 4=DEBUG)\n"
          "\t-q --quiet           Report only fatal errors\n"
          "\t-d --daemon          Fork to background (implies -q)\n"
          "\t-D --nodaemon        Do not daemonise. (default)\n"
          "\t-U --noudpxy         Disable UDPxy compatibility\n"
          "\t-m --maxclients <n>  Serve max n requests simultaneously (default 5)\n"
          "\t-w --workers <n>     Number of worker processes with SO_REUSEPORT (default 1)\n"
          "\t-b --buffer-pool-max-size <n> Maximum number of buffers in zero-copy pool (default 16384)\n"
          "\t-l --listen [addr:]port  Address/port to bind (default ANY:5140)\n"
          "\t-c --config <file>   Read this file for configuration, instead of the default one\n"
          "\t-C --noconfig        Do not read the default config\n"
          "\t-n --fcc-nat-traversal <0/1/2> NAT traversal for FCC media stream, 0=disabled, 1=punchhole (deprecated), 2=NAT-PMP (default 0)\n"
          "\t-P --fcc-listen-port-range <start[-end]>  Restrict FCC UDP listen sockets to specific ports\n"
          "\t-H --hostname <hostname> Hostname to check in the Host: HTTP header (default none)\n"
          "\t-T --r2h-token <token>   Authentication token for HTTP requests (default none)\n"
          "\t-i --upstream-interface-unicast <interface>  Interface for unicast traffic (FCC/RTSP)\n"
          "\t-r --upstream-interface-multicast <interface>  Interface for multicast traffic (RTP/UDP)\n"
          "\t-R --mcast-rejoin-interval <seconds>  Periodic multicast rejoin interval (0=disabled, default 0)\n"
          "\t-F --ffmpeg-path <path>  Path to ffmpeg executable (default: ffmpeg)\n"
          "\t-A --ffmpeg-args <args>  Additional ffmpeg arguments (default: -hwaccel none)\n"
          "\t-S --video-snapshot      Enable video snapshot feature (default: off)\n"
          "\t-s --status-page-path <path>  HTTP path for status UI (default: /status)\n"
          "\t-M --external-m3u <url>  External M3U playlist URL (file://, http://, https://)\n"
          "\t-I --external-m3u-update-interval <seconds>  Auto-update interval (default: 86400 = 24h, 0=disabled)\n"
          "\t                     default " CONFIGFILE "\n",
          prog);
}

void parse_bind_cmd(char *optarg)
{
  char *p, *node, *service;
  struct bindaddr_s *ba;

  if (optarg[0] == '[')
  {
    p = index(optarg++, ']');
    if (p)
    {
      *p = '\0';
      p = rindex(++p, ':');
    }
  }
  else
  {
    p = rindex(optarg, ':');
  }
  if (p)
  {
    *p = '\0';
    node = strdup(optarg);
    service = strdup(p + 1);
  }
  else
  {
    node = NULL;
    service = strdup(optarg);
  }

  logger(LOG_DEBUG, "node: %s, port: %s", node, service);
  ba = malloc(sizeof(struct bindaddr_s));
  ba->node = node;
  ba->service = service;
  ba->next = bind_addresses;
  bind_addresses = ba;
}

void parse_cmd_line(int argc, char *argv[])
{
  const struct option longopts[] = {
      {"verbose", required_argument, 0, 'v'},
      {"quiet", no_argument, 0, 'q'},
      {"help", no_argument, 0, 'h'},
      {"daemon", no_argument, 0, 'd'},
      {"nodaemon", no_argument, 0, 'D'},
      {"noudpxy", no_argument, 0, 'U'},
      {"maxclients", required_argument, 0, 'm'},
      {"workers", required_argument, 0, 'w'},
      {"buffer-pool-max-size", required_argument, 0, 'b'},
      {"listen", required_argument, 0, 'l'},
      {"config", required_argument, 0, 'c'},
      {"noconfig", no_argument, 0, 'C'},
      {"fcc-nat-traversal", required_argument, 0, 'n'},
      {"fcc-listen-port-range", required_argument, 0, 'P'},
      {"hostname", required_argument, 0, 'H'},
      {"r2h-token", required_argument, 0, 'T'},
      {"upstream-interface-unicast", required_argument, 0, 'i'},
      {"upstream-interface-multicast", required_argument, 0, 'r'},
      {"mcast-rejoin-interval", required_argument, 0, 'R'},
      {"ffmpeg-path", required_argument, 0, 'F'},
      {"ffmpeg-args", required_argument, 0, 'A'},
      {"video-snapshot", no_argument, 0, 'S'},
      {"status-page-path", required_argument, 0, 's'},
      {"external-m3u", required_argument, 0, 'M'},
      {"external-m3u-update-interval", required_argument, 0, 'I'},
      {0, 0, 0, 0}};

  const char short_opts[] = "v:qhdDUm:w:b:c:l:n:P:H:T:i:r:R:F:A:s:M:I:SC";
  int option_index, opt;
  int configfile_failed = 1;

  restore_conf_defaults();

  while ((opt = getopt_long(argc, argv, short_opts,
                            longopts, &option_index)) != -1)
  {
    switch (opt)
    {
    case 0:
      break;
    case 'v':
      config.verbosity = atoi(optarg);
      cmd_verbosity_set = 1;
      break;
    case 'q':
      config.verbosity = 0;
      cmd_verbosity_set = 1;
      break;
    case 'h':
      usage(stdout, argv[0]);
      exit(EXIT_SUCCESS);
      break;
    case 'd':
      config.daemonise = 1;
      cmd_daemonise_set = 1;
      break;
    case 'D':
      config.daemonise = 0;
      cmd_daemonise_set = 1;
      break;
    case 'U':
      config.udpxy = 0;
      cmd_udpxy_set = 1;
      break;
    case 'm':
      if (atoi(optarg) < 1)
      {
        logger(LOG_ERROR, "Invalid maxclients! Ignoring.");
      }
      else
      {
        config.maxclients = atoi(optarg);
        cmd_maxclients_set = 1;
      }
      break;
    case 'w':
      if (atoi(optarg) < 1)
      {
        logger(LOG_ERROR, "Invalid workers! Ignoring.");
      }
      else
      {
        config.workers = atoi(optarg);
      }
      break;
    case 'b':
      if (atoi(optarg) < 1)
      {
        logger(LOG_ERROR, "Invalid buffer-pool-max-size! Ignoring.");
      }
      else
      {
        config.buffer_pool_max_size = atoi(optarg);
        cmd_buffer_pool_max_size_set = 1;
      }
      break;
    case 'c':
      configfile_failed = parse_config_file(optarg);
      break;
    case 'C':
      configfile_failed = 0;
      break;
    case 'l':
      parse_bind_cmd(optarg);
      cmd_bind_set = 1;
      break;
    case 'n':
      config.fcc_nat_traversal = atoi(optarg);
      cmd_fcc_nat_traversal_set = 1;
      break;
    case 'P':
    {
      int min_port = 0;
      int max_port = 0;
      if (parse_port_range_value(optarg, &min_port, &max_port) == 0)
      {
        config.fcc_listen_port_min = min_port;
        config.fcc_listen_port_max = max_port;
        cmd_fcc_listen_port_range_set = 1;
        logger(LOG_INFO, "FCC listen port range set to %d-%d", min_port, max_port);
      }
      else
      {
        logger(LOG_ERROR, "Invalid fcc-listen-port-range value: %s", optarg);
      }
      break;
    }
    case 'H':
      safe_free_string(&config.hostname);
      config.hostname = strdup(optarg);
      cmd_hostname_set = 1;
      break;
    case 'T':
      safe_free_string(&config.r2h_token);
      config.r2h_token = strdup(optarg);
      cmd_r2h_token_set = 1;
      break;
    case 's':
      set_status_page_path_value(optarg);
      cmd_status_page_path_set = 1;
      break;
    case 'i':
      strncpy(config.upstream_interface_unicast.ifr_name, optarg, IFNAMSIZ - 1);
      config.upstream_interface_unicast.ifr_ifindex = if_nametoindex(config.upstream_interface_unicast.ifr_name);
      cmd_upstream_interface_unicast_set = 1;
      break;
    case 'r':
      strncpy(config.upstream_interface_multicast.ifr_name, optarg, IFNAMSIZ - 1);
      config.upstream_interface_multicast.ifr_ifindex = if_nametoindex(config.upstream_interface_multicast.ifr_name);
      cmd_upstream_interface_multicast_set = 1;
      break;
    case 'R':
      if (atoi(optarg) < 0)
      {
        logger(LOG_ERROR, "Invalid mcast-rejoin-interval! Ignoring.");
      }
      else
      {
        config.mcast_rejoin_interval = atoi(optarg);
        cmd_mcast_rejoin_interval_set = 1;
        if (config.mcast_rejoin_interval > 0)
        {
          logger(LOG_INFO, "Multicast rejoin interval set to %d seconds", config.mcast_rejoin_interval);
        }
      }
      break;
    case 'F':
      safe_free_string(&config.ffmpeg_path);
      config.ffmpeg_path = strdup(optarg);
      cmd_ffmpeg_path_set = 1;
      break;
    case 'A':
      safe_free_string(&config.ffmpeg_args);
      config.ffmpeg_args = strdup(optarg);
      cmd_ffmpeg_args_set = 1;
      break;
    case 'S':
      config.video_snapshot = 1;
      cmd_video_snapshot_set = 1;
      break;
    case 'M':
      if (config.external_m3u_url)
        free(config.external_m3u_url);
      config.external_m3u_url = strdup(optarg);
      logger(LOG_INFO, "External M3U URL set to: %s", config.external_m3u_url);
      break;
    case 'I':
      if (atoi(optarg) < 0)
      {
        logger(LOG_ERROR, "Invalid external-m3u-update-interval! Ignoring.");
      }
      else
      {
        config.external_m3u_update_interval = atoi(optarg);
        logger(LOG_INFO, "External M3U update interval set to %d seconds", config.external_m3u_update_interval);
      }
      break;
    default:
      logger(LOG_FATAL, "Unknown option! %d ", opt);
      usage(stderr, argv[0]);
      exit(EXIT_FAILURE);
    }
  }
  if (configfile_failed)
  {
    configfile_failed = parse_config_file(CONFIGFILE);
  }
  if (configfile_failed)
  {
    logger(LOG_WARN, "No config file found");
  }

  /* Load external M3U if configured (from config file or command line)
   * This happens after all config/cmdline parsing is complete, so command line
   * arguments can override config file settings */
  if (config.external_m3u_url)
  {
    logger(LOG_DEBUG, "Loading external M3U: %s", config.external_m3u_url);
    char *m3u_content = m3u_fetch_url(config.external_m3u_url);
    if (m3u_content)
    {
      m3u_parse_and_create_services(m3u_content, config.external_m3u_url);
      free(m3u_content);
      /* Record initial load time */
      config.last_external_m3u_update_time = get_time_ms();
      logger(LOG_INFO, "External M3U loaded successfully from: %s", config.external_m3u_url);
    }
    else
    {
      logger(LOG_ERROR, "Failed to fetch external M3U from: %s", config.external_m3u_url);
    }
  }

  logger(LOG_DEBUG, "Verbosity: %d, Daemonise: %d, Maxclients: %d, Workers: %d",
         config.verbosity, config.daemonise, config.maxclients, config.workers);
}

/* Reload external M3U playlist
 * This function fetches the external M3U and creates/updates services
 * Returns: 0 on success, -1 on error
 */
int reload_external_m3u(void)
{
  char *m3u_content;

  /* Check if external M3U is configured */
  if (!config.external_m3u_url)
  {
    logger(LOG_DEBUG, "No external M3U URL configured, skipping reload");
    return -1;
  }

  /* Check if update interval is configured */
  if (config.external_m3u_update_interval <= 0)
  {
    logger(LOG_DEBUG, "External M3U update interval not configured, skipping reload");
    return -1;
  }

  logger(LOG_INFO, "Reloading external M3U from: %s", config.external_m3u_url);

  /* Fetch M3U content */
  m3u_content = m3u_fetch_url(config.external_m3u_url);
  if (!m3u_content)
  {
    logger(LOG_ERROR, "Failed to fetch external M3U during reload from: %s", config.external_m3u_url);
    return -1;
  }

  /* Clear existing external services before loading new ones */
  service_free_external();

  /* Reset external transformed playlist buffer before reloading */
  m3u_reset_external_playlist();

  /* Parse M3U content and create services */
  m3u_parse_and_create_services(m3u_content, config.external_m3u_url);
  free(m3u_content);

  logger(LOG_INFO, "External M3U reloaded successfully");
  return 0;
}

/* Callback for async M3U fetch completion */
static void reload_m3u_async_callback(http_fetch_ctx_t *ctx, char *content, void *user_data)
{
  (void)ctx;       /* Unused */
  (void)user_data; /* Unused */

  if (!content)
  {
    logger(LOG_ERROR, "Async external M3U fetch failed: %s", config.external_m3u_url);
    return;
  }

  logger(LOG_DEBUG, "Async external M3U fetch completed, processing content");

  /* Clear existing external services before loading new ones */
  service_free_external();

  /* Reset external transformed playlist buffer before reloading */
  m3u_reset_external_playlist();

  /* Parse M3U content and create services */
  m3u_parse_and_create_services(content, config.external_m3u_url);
  free(content);

  logger(LOG_INFO, "External M3U reloaded successfully (async)");
}

/* Async version of reload_external_m3u for worker processes */
int reload_external_m3u_async(int epfd)
{
  http_fetch_ctx_t *fetch_ctx;

  /* Check if external M3U is configured */
  if (!config.external_m3u_url)
  {
    logger(LOG_DEBUG, "No external M3U URL configured, skipping async reload");
    return -1;
  }

  /* Check if update interval is configured */
  if (config.external_m3u_update_interval <= 0)
  {
    logger(LOG_DEBUG, "External M3U update interval not configured, skipping async reload");
    return -1;
  }

  /* Check if URL is HTTP(S) - only these can be fetched asynchronously */
  if (strncmp(config.external_m3u_url, "http://", 7) != 0 &&
      strncmp(config.external_m3u_url, "https://", 8) != 0)
  {
    logger(LOG_DEBUG, "External M3U URL is not HTTP(S), using synchronous fetch");
    return reload_external_m3u();
  }

  logger(LOG_INFO, "Starting async reload of external M3U from: %s", config.external_m3u_url);

  /* Start async fetch */
  fetch_ctx = http_fetch_start_async(config.external_m3u_url, reload_m3u_async_callback, NULL, epfd);
  if (!fetch_ctx)
  {
    logger(LOG_ERROR, "Failed to start async fetch for external M3U");
    return -1;
  }

  logger(LOG_DEBUG, "Async external M3U fetch started successfully");
  return 0;
}
