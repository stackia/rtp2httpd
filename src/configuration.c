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
#include <getopt.h>
#include <net/if.h>

#include "rtp2httpd.h"
#include "configuration.h"

#define MAX_LINE 1024

/* GLOBAL CONFIGURATION VARIABLES */

enum loglevel conf_verbosity;
int conf_daemonise;
int conf_udpxy;
int conf_maxclients;
char *conf_hostname = NULL;
struct ifreq conf_upstream_interface;
enum fcc_nat_traversal conf_fcc_nat_traversal;

/* *** */

int cmd_verbosity_set;
int cmd_daemonise_set;
int cmd_udpxy_set;
int cmd_maxclients_set;
int cmd_bind_set;
int cmd_fcc_nat_traversal_set;
int cmd_hostname_set;
int cmd_upstream_interface_set;

enum section_e
{
  SEC_NONE = 0,
  SEC_BIND,
  SEC_SERVICES,
  SEC_GLOBAL
};

void parse_bind_sec(char *line)
{
  int i, j;
  char *node, *service;
  struct bindaddr_s *ba;

  j = i = 0;
  while (!isspace(line[j]))
    j++;
  node = strndup(line, j);

  i = j;
  while (isspace(line[i]))
    i++;
  j = i;
  while (!isspace(line[j]))
    j++;
  service = strndup(line + i, j - i);

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
  struct services_s *service;

  memset(&hints, 0, sizeof(hints));
  hints.ai_socktype = SOCK_DGRAM;

  /* Initialize string pointers */
  msrc = strdup("");
  msaddr = strdup("");
  msport = strdup("");

  j = i = 0;
  while (!isspace(line[j]))
    j++;
  servname = strndup(line, j);

  i = j;
  while (isspace(line[i]))
    i++;
  j = i;
  while (!isspace(line[j]))
    j++;
  type = strndupa(line + i, j - i);

  /* Check if this is an RTSP service - different parsing logic */
  if (strcasecmp("RTSP", type) == 0)
  {
    /* For RTSP: SERVICE_NAME RTSP RTSP_URL */
    i = j;
    while (isspace(line[i]))
      i++;
    /* Rest of the line is the RTSP URL */
    char *rtsp_url = strdup(line + i);
    /* Remove trailing whitespace */
    char *end = rtsp_url + strlen(rtsp_url) - 1;
    while (end > rtsp_url && isspace(*end))
      *end-- = '\0';

    if (strlen(rtsp_url) == 0)
    {
      logger(LOG_ERROR, "RTSP service %s: missing RTSP URL", servname);
      free(servname);
      free(msrc);
      free(rtsp_url);
      return;
    }

    service = malloc(sizeof(struct services_s));
    memset(service, 0, sizeof(*service));
    service->service_type = SERVICE_RTSP;
    service->url = servname;
    service->rtsp_url = rtsp_url;
    service->msrc = strdup(msrc);
    service->next = services;
    services = service;

    logger(LOG_DEBUG, "RTSP service: %s, URL: %s", servname, rtsp_url);

    /* Free allocated temporary strings */
    free(msrc);
    free(msaddr);
    free(msport);
    return;
  }

  /* Parsing logic for MRTP/MUDP services */
  i = j;
  while (isspace(line[i]))
    i++;
  j = i;
  while (!isspace(line[j]))
    j++;
  maddr = strndupa(line + i, j - i);

  i = j;
  while (isspace(line[i]))
    i++;
  j = i;
  while (!isspace(line[j]))
    j++;
  mport = strndupa(line + i, j - i);

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
    free(servname);
    free(msrc);
    return;
  }

  service = malloc(sizeof(struct services_s));
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
    {
      logger(LOG_ERROR, "Cannot init service %s. GAI: %s",
             servname, gai_strerror(r));
    }
    if (rr)
    {
      logger(LOG_ERROR, "Cannot init service %s. GAI: %s",
             servname, gai_strerror(rr));
    }
    free(servname);
    free(msrc);
    free(service);
    return;
  }
  if (service->addr->ai_next != NULL)
  {
    logger(LOG_ERROR, "Warning: maddr is ambiguos.");
  }
  if (strcmp(msrc, "") != 0 && msrc != NULL)
  {
    if (service->msrc_addr->ai_next != NULL)
    {
      logger(LOG_ERROR, "Warning: msrc is ambiguos.");
    }
  }

  if (strcasecmp("MRTP", type) == 0)
  {
    service->service_type = SERVICE_MRTP;
  }
  else if (strcasecmp("MUDP", type) == 0)
  {
    service->service_type = SERVICE_MUDP;
  }

  service->url = servname;
  service->msrc = strdup(msrc);
  service->next = services;
  services = service;

  /* Free allocated temporary strings */
  free(msrc);
  free(msaddr);
  free(msport);
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
  while (!isspace(line[j]))
    j++;
  value = strndupa(line + i, j - i);

  if (strcasecmp("verbosity", param) == 0)
  {
    if (!cmd_verbosity_set)
    {
      conf_verbosity = atoi(value);
    }
    else
    {
      logger(LOG_INFO, "Warning: Config file value \"verbosity\" ignored. It's already set on CmdLine.");
    }
    return;
  }
  if (strcasecmp("daemonise", param) == 0)
  {
    if (!cmd_daemonise_set)
    {
      if ((strcasecmp("on", value) == 0) ||
          (strcasecmp("true", value) == 0) ||
          (strcasecmp("yes", value) == 0) ||
          (strcasecmp("1", value) == 0))
      {
        conf_daemonise = 1;
      }
      else
      {
        conf_daemonise = 0;
      }
    }
    else
    {
      logger(LOG_INFO, "Warning: Config file value \"daemonise\" ignored. It's already set on CmdLine.");
    }
    return;
  }
  if (strcasecmp("maxclients", param) == 0)
  {
    if (!cmd_maxclients_set)
    {
      if (atoi(value) < 1)
      {
        logger(LOG_ERROR, "Invalid maxclients! Ignoring.");
        return;
      }
      conf_maxclients = atoi(value);
    }
    else
    {
      logger(LOG_INFO, "Warning: Config file value \"maxclients\" ignored. It's already set on CmdLine.");
    }
    return;
  }
  if (strcasecmp("udpxy", param) == 0)
  {
    if (!cmd_udpxy_set)
    {
      if ((strcasecmp("on", value) == 0) ||
          (strcasecmp("true", value) == 0) ||
          (strcasecmp("yes", value) == 0) ||
          (strcasecmp("1", value) == 0))
      {
        conf_udpxy = 1;
      }
      else
      {
        conf_udpxy = 0;
      }
    }
    else
    {
      logger(LOG_INFO, "Warning: Config file value \"udpxy\" ignored. It's already set on CmdLine.");
    }
    return;
  }
  if (strcasecmp("hostname", param) == 0)
  {
    if (!cmd_hostname_set)
    {
      conf_hostname = strdup(value);
    }
    else
    {
      logger(LOG_INFO, "Warning: Config file value \"hostname\" ignored. It's already set on CmdLine.");
    }
    return;
  }
  if (strcasecmp("upstream-interface", param) == 0)
  {
    if (!cmd_upstream_interface_set)
    {
      strncpy(conf_upstream_interface.ifr_name, value, IFNAMSIZ - 1);
      conf_upstream_interface.ifr_ifindex = if_nametoindex(conf_upstream_interface.ifr_name);
    }
    else
    {
      logger(LOG_INFO, "Warning: Config file value \"upstream-interface\" ignored. It's already set on CmdLine.");
    }
    return;
  }
  if (strcasecmp("fcc-nat-traversal", param) == 0)
  {
    if (!cmd_fcc_nat_traversal_set)
    {
      conf_fcc_nat_traversal = atoi(value);
    }
    else
    {
      logger(LOG_INFO, "Warning: Config file value \"fcc-nat-traversal\" ignored. It's already set on CmdLine.");
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
        logger(LOG_INFO, "Warning: Config file section \"[bind]\" ignored. It's already set on CmdLine.");
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
  ba->service = strdup("8080");
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

/* Setup configuration defaults */
void restore_conf_defaults(void)
{
  struct services_s *service_tmp;
  struct bindaddr_s *bind_tmp;

  conf_verbosity = LOG_ERROR;
  cmd_verbosity_set = 0;
  conf_daemonise = 0;
  cmd_daemonise_set = 0;
  conf_maxclients = 5;
  cmd_maxclients_set = 0;
  conf_udpxy = 1;
  cmd_udpxy_set = 0;
  cmd_bind_set = 0;
  conf_fcc_nat_traversal = FCC_NAT_T_DISABLED;
  cmd_fcc_nat_traversal_set = 0;

  if (conf_hostname != NULL)
  {
    free(conf_hostname);
    conf_hostname = NULL;
  }
  cmd_hostname_set = 0;

  if (conf_upstream_interface.ifr_name[0] != '\0')
  {
    memset(&conf_upstream_interface, 0, sizeof(struct ifreq));
  }
  cmd_upstream_interface_set = 0;

  while (services != NULL)
  {
    service_tmp = services;
    services = services->next;
    if (service_tmp->url != NULL)
    {
      free(service_tmp->url);
    }
    if (service_tmp->addr != NULL)
    {
      freeaddrinfo(service_tmp->addr);
    }
    if (service_tmp->msrc_addr != NULL)
    {
      freeaddrinfo(service_tmp->msrc_addr);
    }
    if (service_tmp->fcc_addr != NULL)
    {
      freeaddrinfo(service_tmp->fcc_addr);
    }
    if (service_tmp->rtsp_url != NULL)
    {
      free(service_tmp->rtsp_url);
    }
    if (service_tmp->playseek_param != NULL)
    {
      free(service_tmp->playseek_param);
    }
    if (service_tmp->msrc != NULL)
    {
      free(service_tmp->msrc);
    }
    free(service_tmp);
  }

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
          "\t-v --verbose         Increase verbosity\n"
          "\t-q --quiet           Report only fatal errors\n"
          "\t-d --daemon          Fork to background (implies -q)\n"
          "\t-D --nodaemon        Do not daemonise. (default)\n"
          "\t-U --noudpxy         Disable UDPxy compatibility\n"
          "\t-m --maxclients <n>  Serve max n requests simultaneously (dfl 5)\n"
          "\t-l --listen [addr:]port  Address/port to bind (default ANY:8080)\n"
          "\t-c --config <file>   Read this file for configuration, instead of the default one\n"
          "\t-C --noconfig        Do not read the default config\n"
          "\t-n --fcc-nat-traversal <0/1/2> NAT traversal for FCC media stream, 0=disabled, 1=punchhole, 2=NAT-PMP (default 0)\n"
          "\t-H --hostname <hostname> Hostname to check in the Host: HTTP header (default none)\n"
          "\t-i --upstream-interface <interface> Interface to use for requesting upstream media stream (default none, which follows the routing table)\n"
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
      {"listen", required_argument, 0, 'l'},
      {"config", required_argument, 0, 'c'},
      {"noconfig", no_argument, 0, 'C'},
      {"fcc-nat-traversal", required_argument, 0, 'n'},
      {"hostname", required_argument, 0, 'H'},
      {"upstream-interface", required_argument, 0, 'i'},
      {0, 0, 0, 0}};

  const char short_opts[] = "v:qhdDUm:c:l:n:H:i:C";
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
      conf_verbosity = atoi(optarg);
      cmd_verbosity_set = 1;
      break;
    case 'q':
      conf_verbosity = 0;
      cmd_verbosity_set = 1;
      break;
    case 'h':
      usage(stdout, argv[0]);
      exit(EXIT_SUCCESS);
      break;
    case 'd':
      conf_daemonise = 1;
      cmd_daemonise_set = 1;
      break;
    case 'D':
      conf_daemonise = 0;
      cmd_daemonise_set = 1;
      break;
    case 'U':
      conf_udpxy = 0;
      cmd_udpxy_set = 1;
      break;
    case 'm':
      if (atoi(optarg) < 1)
      {
        logger(LOG_ERROR, "Invalid maxclients! Ignoring.");
      }
      else
      {
        conf_maxclients = atoi(optarg);
        cmd_maxclients_set = 1;
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
      conf_fcc_nat_traversal = atoi(optarg);
      cmd_fcc_nat_traversal_set = 1;
      break;
    case 'H':
      conf_hostname = strdup(optarg);
      cmd_hostname_set = 1;
      break;
    case 'i':
      strncpy(conf_upstream_interface.ifr_name, optarg, IFNAMSIZ - 1);
      conf_upstream_interface.ifr_ifindex = if_nametoindex(conf_upstream_interface.ifr_name);
      cmd_upstream_interface_set = 1;
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
    logger(LOG_INFO, "Warning: No configfile found.");
  }
  logger(LOG_DEBUG, "Verbosity: %d, Daemonise: %d, Maxclients: %d",
         conf_verbosity, conf_daemonise, conf_maxclients);
}
