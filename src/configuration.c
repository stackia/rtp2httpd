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

/* Cleanup helper for parse_services_sec */
static void cleanup_service_parse_temps(char *servname, char *msrc, char *msaddr, char *msport)
{
  if (servname)
    free(servname);
  if (msrc)
    free(msrc);
  if (msaddr)
    free(msaddr);
  if (msport)
    free(msport);
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

void parse_services_sec(char *line)
{
  int i, j, r, rr;
  struct addrinfo hints;
  char *servname, *type, *maddr, *mport, *msrc, *msaddr, *msport;
  service_t *service;
  int pos = 0;

  memset(&hints, 0, sizeof(hints));
  hints.ai_socktype = SOCK_DGRAM;

  /* Initialize string pointers */
  msrc = strdup("");
  msaddr = strdup("");
  msport = strdup("");

  /* Extract service name and type */
  servname = extract_token(line, &pos);
  type = strndupa(line + pos, strcspn(line + pos, " \t\n\r"));

  /* Skip whitespace after type */
  while (isspace(line[pos]))
    pos++;
  j = pos;
  while (!isspace(line[j]) && line[j] != '\0')
    j++;
  type = strndupa(line + pos, j - pos);
  pos = j;

  /* Check if this is an RTSP service - different parsing logic */
  if (strcasecmp("RTSP", type) == 0)
  {
    /* For RTSP: SERVICE_NAME RTSP RTSP_URL */
    /* Skip whitespace and get rest of line as RTSP URL */
    while (isspace(line[pos]))
      pos++;
    char *rtsp_url = strdup(line + pos);

    /* Remove trailing whitespace */
    char *end = rtsp_url + strlen(rtsp_url) - 1;
    while (end > rtsp_url && isspace(*end))
      *end-- = '\0';

    if (strlen(rtsp_url) == 0)
    {
      logger(LOG_ERROR, "RTSP service %s: missing RTSP URL", servname);
      cleanup_service_parse_temps(servname, msrc, msaddr, msport);
      free(rtsp_url);
      return;
    }

    service = malloc(sizeof(service_t));
    memset(service, 0, sizeof(*service));
    service->service_type = SERVICE_RTSP;
    service->url = servname;
    service->rtsp_url = rtsp_url;
    service->msrc = strdup(msrc);
    service->next = services;
    services = service;

    logger(LOG_INFO, "Service created: %s (RTSP)", servname);
    logger(LOG_DEBUG, "RTSP service: %s, URL: %s", servname, rtsp_url);

    /* Free allocated temporary strings */
    cleanup_service_parse_temps(NULL, msrc, msaddr, msport);
    return;
  }

  /* Parsing logic for MRTP/MUDP services */
  /* Extract multicast address and port */
  while (isspace(line[pos]))
    pos++;
  i = pos;
  while (!isspace(line[pos]) && line[pos] != '\0')
    pos++;
  maddr = strndupa(line + i, pos - i);

  while (isspace(line[pos]))
    pos++;
  i = pos;
  while (!isspace(line[pos]) && line[pos] != '\0')
    pos++;
  mport = strndupa(line + i, pos - i);

  if (strstr(maddr, "@") != NULL)
  {
    char *split;
    char *current;
    int cnt = 0;
    split = strtok(maddr, "@");
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
        maddr = current;
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

  logger(LOG_DEBUG, "serv: %s, type: %s, maddr: %s, mport: %s, msaddr: %s, msport: %s",
         servname, type, maddr, mport, msaddr, msport);

  if ((strcasecmp("MRTP", type) != 0) && (strcasecmp("MUDP", type) != 0))
  {
    logger(LOG_ERROR, "Unsupported service type: %s", type);
    cleanup_service_parse_temps(servname, msrc, msaddr, msport);
    return;
  }

  service = malloc(sizeof(service_t));
  memset(service, 0, sizeof(*service));

  r = getaddrinfo(maddr, mport, &hints, &(service->addr));
  rr = 0;
  if (strcmp(msrc, "") != 0 && msrc != NULL)
  {
    rr = getaddrinfo(msaddr, msport, &hints, &(service->msrc_addr));
  }
  if (r || rr)
  {
    if (r)
      logger(LOG_ERROR, "Cannot init service %s. GAI: %s", servname, gai_strerror(r));
    if (rr)
      logger(LOG_ERROR, "Cannot init service %s. GAI: %s", servname, gai_strerror(rr));

    cleanup_service_parse_temps(servname, msrc, msaddr, msport);
    free(service);
    return;
  }

  if (service->addr->ai_next != NULL)
    logger(LOG_WARN, "Multicast address is ambiguous (multiple results)");

  if (strcmp(msrc, "") != 0 && msrc != NULL && service->msrc_addr->ai_next != NULL)
    logger(LOG_WARN, "Source address is ambiguous (multiple results)");

  /* Set service type */
  if (strcasecmp("MRTP", type) == 0)
    service->service_type = SERVICE_MRTP;
  else if (strcasecmp("MUDP", type) == 0)
    service->service_type = SERVICE_MUDP;

  service->url = servname;
  service->msrc = strdup(msrc);
  service->next = services;
  services = service;

  logger(LOG_INFO, "Service created: %s (%s %s:%s)", servname, type, maddr, mport);
  logger(LOG_DEBUG, "Service details: %s, Type: %s, Addr: %s, Port: %s", servname, type, maddr, mport);

  /* Free allocated temporary strings (servname is now owned by service) */
  cleanup_service_parse_temps(NULL, msrc, msaddr, msport);
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
      config.hostname = strdup(value);
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
      config.r2h_token = strdup(value);
    return;
  }

  if (strcasecmp("ffmpeg-path", param) == 0)
  {
    if (set_if_not_cmd_override(cmd_ffmpeg_path_set, "ffmpeg-path"))
      config.ffmpeg_path = strdup(value);
    return;
  }

  if (strcasecmp("ffmpeg-args", param) == 0)
  {
    if (set_if_not_cmd_override(cmd_ffmpeg_args_set, "ffmpeg-args"))
      config.ffmpeg_args = strdup(value);
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

  logger(LOG_ERROR, "Unknown config parameter: %s", param);
}

int parse_config_file(const char *path)
{
  FILE *cfile;
  char line[MAX_LINE];
  int i, bind_msg_done = 0;
  enum section_e section = SEC_NONE;

  logger(LOG_DEBUG, "Opening %s", path);
  cfile = fopen(path, "r");
  if (cfile == NULL)
    return -1;

  while (fgets(line, MAX_LINE, cfile))
  {
    i = 0;

    while (isspace(line[i]))
      i++;

    if (line[i] == '\0' || line[i] == '#' ||
        line[i] == ';')
      continue;
    if (line[i] == '[')
    { /* section change */
      char *end = index(line + i, ']');
      if (end)
      {
        char *section_name = strndupa(line + i + 1, end - line - i - 1);
        if (strcasecmp("bind", section_name) == 0)
        {
          section = SEC_BIND;
          continue;
        }
        if (strcasecmp("services", section_name) == 0)
        {
          section = SEC_SERVICES;
          continue;
        }
        if (strcasecmp("global", section_name) == 0)
        {
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
  struct bindaddr_s *bind_tmp;

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
  while (bind_addresses != NULL)
  {
    bind_tmp = bind_addresses;
    bind_addresses = bind_addresses->next;
    if (bind_tmp->node != NULL)
      free(bind_tmp->node);
    if (bind_tmp->service != NULL)
      free(bind_tmp->service);
  }
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
      {0, 0, 0, 0}};

  const char short_opts[] = "v:qhdDUm:w:b:c:l:n:P:H:T:i:r:R:F:A:s:SC";
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
      config.hostname = strdup(optarg);
      cmd_hostname_set = 1;
      break;
    case 'T':
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
      config.ffmpeg_path = strdup(optarg);
      cmd_ffmpeg_path_set = 1;
      break;
    case 'A':
      config.ffmpeg_args = strdup(optarg);
      cmd_ffmpeg_args_set = 1;
      break;
    case 'S':
      config.video_snapshot = 1;
      cmd_video_snapshot_set = 1;
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
  logger(LOG_DEBUG, "Verbosity: %d, Daemonise: %d, Maxclients: %d, Workers: %d",
         config.verbosity, config.daemonise, config.maxclients, config.workers);
}
