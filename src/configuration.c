/*
 *  RTP2HTTP Proxy - Multicast RTP stream to UNICAST HTTP translator
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

#define _GNU_SOURCE

#include <stdio.h>
#include <stdlib.h>
#include <sys/socket.h>
#include <string.h>
#include <strings.h>
#include <errno.h>
#include <signal.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <ctype.h>
#include <getopt.h>
#include <net/if.h>

#include "rtp2httpd.h"

#ifdef HAVE_CONFIG_H
#include "config.h"
#endif /* HAVE_CONFIG_H */

#define MAX_LINE 150

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

void parseBindSec(char *line)
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
  logger(LOG_DEBUG, "node: %s, port: %s\n", node, service);

  ba = malloc(sizeof(struct bindaddr_s));
  ba->node = node;
  ba->service = service;
  ba->next = bindaddr;
  bindaddr = ba;
}

void parseServicesSec(char *line)
{
  int i, j, r, rr;
  struct addrinfo hints;
  char *servname, *type, *maddr, *mport, *msrc = "", *msaddr = "", *msport = "";
  struct services_s *service;

  memset(&hints, 0, sizeof(hints));
  hints.ai_socktype = SOCK_DGRAM;

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

  logger(LOG_DEBUG, "serv: %s, type: %s, maddr: %s, mport: %s, msaddr: %s, msport: %s\n",
         servname, type, maddr, mport, msaddr, msport);

  if ((strcasecmp("MRTP", type) != 0) && (strcasecmp("MUDP", type) != 0))
  {
    logger(LOG_ERROR, "Unsupported service type: %s\n", type);
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
      logger(LOG_ERROR, "Cannot init service %s. GAI: %s\n",
             servname, gai_strerror(r));
    }
    if (rr)
    {
      logger(LOG_ERROR, "Cannot init service %s. GAI: %s\n",
             servname, gai_strerror(rr));
    }
    free(servname);
    free(msrc);
    free(service);
    return;
  }
  if (service->addr->ai_next != NULL)
  {
    logger(LOG_ERROR, "Warning: maddr is ambiguos.\n");
  }
  if (strcmp(msrc, "") != 0 && msrc != NULL)
  {
    if (service->msrc_addr->ai_next != NULL)
    {
      logger(LOG_ERROR, "Warning: msrc is ambiguos.\n");
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
}

void parseGlobalSec(char *line)
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
    logger(LOG_ERROR, "Unrecognised config line: %s\n", line);
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
      logger(LOG_INFO, "Warning: Config file value \"verbosity\" ignored. It's already set on CmdLine.\n");
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
      logger(LOG_INFO, "Warning: Config file value \"daemonise\" ignored. It's already set on CmdLine.\n");
    }
    return;
  }
  if (strcasecmp("maxclients", param) == 0)
  {
    if (!cmd_maxclients_set)
    {
      if (atoi(value) < 1)
      {
        logger(LOG_ERROR, "Invalid maxclients! Ignoring.\n");
        return;
      }
      conf_maxclients = atoi(value);
    }
    else
    {
      logger(LOG_INFO, "Warning: Config file value \"maxclients\" ignored. It's already set on CmdLine.\n");
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
      logger(LOG_INFO, "Warning: Config file value \"udpxy\" ignored. It's already set on CmdLine.\n");
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
      logger(LOG_INFO, "Warning: Config file value \"hostname\" ignored. It's already set on CmdLine.\n");
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
      logger(LOG_INFO, "Warning: Config file value \"upstream-interface\" ignored. It's already set on CmdLine.\n");
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
      logger(LOG_INFO, "Warning: Config file value \"fcc-nat-traversal\" ignored. It's already set on CmdLine.\n");
    }
    return;
  }

  logger(LOG_ERROR, "Unknown config parameter: %s\n", param);
}

int parseConfigFile(char *path)
{
  FILE *cfile;
  char line[MAX_LINE];
  int i, bindMsgDone = 0;
  enum section_e section = SEC_NONE;

  logger(LOG_DEBUG, "Opening %s\n", path);
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
        char *secname = strndupa(line + i + 1, end - line - i - 1);
        if (strcasecmp("bind", secname) == 0)
        {
          section = SEC_BIND;
          continue;
        }
        if (strcasecmp("services", secname) == 0)
        {
          section = SEC_SERVICES;
          continue;
        }
        if (strcasecmp("global", secname) == 0)
        {
          section = SEC_GLOBAL;
          continue;
        }
        logger(LOG_ERROR, "Invalid section name: %s\n", secname);
        continue;
      }
      else
      {
        logger(LOG_ERROR, "Unterminated section: %s\n", line + i);
        continue;
      }
    }

    if (cmd_bind_set && section == SEC_BIND)
    {
      if (!bindMsgDone)
      {
        logger(LOG_INFO, "Warning: Config file section \"[bind]\" ignored. It's already set on CmdLine.\n");
        bindMsgDone = 1;
      }
      continue;
    }

    switch (section)
    {
    case SEC_BIND:
      parseBindSec(line + i);
      break;
    case SEC_SERVICES:
      parseServicesSec(line + i);
      break;
    case SEC_GLOBAL:
      parseGlobalSec(line + i);
      break;
    default:
      logger(LOG_ERROR, "Unrecognised config line: %s\n", line);
    }
  }
  fclose(cfile);
  return 0;
}

struct bindaddr_s *newEmptyBindaddr()
{
  struct bindaddr_s *ba;
  ba = malloc(sizeof(struct bindaddr_s));
  memset(ba, 0, sizeof(*ba));
  ba->service = strdup("8080");
  return ba;
}

void freeBindaddr(struct bindaddr_s *ba)
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
void restoreConfDefaults()
{
  struct services_s *servtmp;
  struct bindaddr_s *bindtmp;

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

  if (conf_upstream_interface.ifr_name != NULL)
  {
    memset(&conf_upstream_interface, 0, sizeof(struct ifreq));
  }
  cmd_upstream_interface_set = 0;

  while (services != NULL)
  {
    servtmp = services;
    services = services->next;
    if (servtmp->url != NULL)
    {
      free(servtmp->url);
    }
    if (servtmp->addr != NULL)
    {
      freeaddrinfo(servtmp->addr);
    }
  }

  while (bindaddr != NULL)
  {
    bindtmp = bindaddr;
    bindaddr = bindaddr->next;
    if (bindtmp->node != NULL)
      free(bindtmp->node);
    if (bindtmp->service != NULL)
      free(bindtmp->service);
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
          "\t-c --config <file>   Read this file, instead of\n"
          "\t-C --noconfig        Do not read the default config\n"
          "\t-n --fcc-nat-traversal <0/1/2> NAT traversal for FCC media stream, 0=disabled, 1=punchhole, 2=NAT-PMP (default 0)\n"
          "\t-H --hostname <hostname> Hostname to check in the Host: HTTP header (default none)\n"
          "\t-i --upstream-interface <interface> Interface to use for requesting upstream media stream (default none, which follows the routing table)\n"
          "\t                     default " CONFIGFILE "\n",
          prog);
}

void parseBindCmd(char *optarg)
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

  logger(LOG_DEBUG, "node: %s, port: %s\n", node, service);
  ba = malloc(sizeof(struct bindaddr_s));
  ba->node = node;
  ba->service = service;
  ba->next = bindaddr;
  bindaddr = ba;
}

void parseCmdLine(int argc, char *argv[])
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

  const char shortopts[] = "v:qhdDUm:c:l:n:H:i:C";
  int option_index, opt;
  int configfile_failed = 1;

  restoreConfDefaults();

  while ((opt = getopt_long(argc, argv, shortopts,
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
        logger(LOG_ERROR, "Invalid maxclients! Ignoring.\n");
      }
      else
      {
        conf_maxclients = atoi(optarg);
        cmd_maxclients_set = 1;
      }
      break;
    case 'c':
      configfile_failed = parseConfigFile(optarg);
      break;
    case 'C':
      configfile_failed = 0;
      break;
    case 'l':
      parseBindCmd(optarg);
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
      logger(LOG_FATAL, "Unknown option! %d \n", opt);
      usage(stderr, argv[0]);
      exit(EXIT_FAILURE);
    }
  }
  if (configfile_failed)
  {
    configfile_failed = parseConfigFile(CONFIGFILE);
  }
  if (configfile_failed)
  {
    logger(LOG_INFO, "Warning: No configfile found.\n");
  }
  logger(LOG_DEBUG, "Verbosity: %d, Daemonise: %d, Maxclients: %d\n",
         conf_verbosity, conf_daemonise, conf_maxclients);
}
