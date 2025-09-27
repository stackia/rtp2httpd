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
#include <unistd.h>
#include <stdarg.h>
#include <errno.h>
#include <sys/select.h>
#include <sys/types.h>
#include <sys/socket.h>
#include <netdb.h>
#include <fcntl.h>
#include <string.h>
#include <signal.h>
#include <sys/wait.h>

#include "rtp2httpd.h"

#ifdef HAVE_CONFIG_H
#include "config.h"
#endif /* HAVE_CONFIG_H */

#define MAX_S 10

/**
 * Linked list of clients
 */
struct client_s
{
  struct sockaddr_storage ss; /* Client host-port */
  pid_t pid;
  struct client_s *next;
};

static struct client_s *clients;

/* GLOBALS */
struct bindaddr_s *bind_addresses = NULL;

int client_count = 0;

/* *** */

/**
 * Logger function. Show the message if current verbosity is above
 * logged level.
 *
 * @param levem Message log level
 * @param format printf style format string
 * @returns Whatever printf returns
 */
int logger(enum loglevel level, const char *format, ...)
{
  va_list ap;
  int r = 0;
  if (conf_verbosity >= level)
  {
    va_start(ap, format);
    r = vfprintf(stderr, format, ap);
    va_end(ap);
  }
  return r;
}

void child_handler(int signum)
{ /* SIGCHLD handler */
  int child;
  int status;
  struct client_s *client, *next_client;
  int r;
  char hbuf[NI_MAXHOST], sbuf[NI_MAXSERV];

  while ((child = waitpid(-1, &status, WNOHANG)) > 0)
  {

    for (client = clients; client; client = client->next)
    {
      if (child == client->pid)
        break;
    }
    if (client != NULL)
    {
      r = getnameinfo((struct sockaddr *)&(client->ss), sizeof(client->ss),
                      hbuf, sizeof(hbuf),
                      sbuf, sizeof(sbuf),
                      NI_NUMERICHOST | NI_NUMERICSERV);
      if (r)
      {
        logger(LOG_ERROR, "getnameinfo failed: %s\n",
               gai_strerror(r));
      }
      else
      {
        logger(LOG_DEBUG, "Client %s port %s disconnected (%d, %d)\n",
               hbuf, sbuf, WEXITSTATUS(status),
               WIFSIGNALED(status));
      }

      /* remove client from the list */
      if (client == clients)
      {
        clients = client->next;
        free(client);
      }
      else
      {
        for (next_client = clients; next_client != NULL; next_client = next_client->next)
        {
          if (next_client->next == client)
          {
            next_client->next = client->next;
            free(client);
            break;
          }
        }
      }
    }
    else
    {
      if (child != 1)
        logger(LOG_ERROR, "Unknown child finished - pid %d\n", child);
    }

    client_count--;
    signal(signum, &child_handler);
  }
}

int main(int argc, char *argv[])
{
  struct addrinfo hints, *res, *ai;
  struct bindaddr_s *bind_addr;
  struct sockaddr_storage client;
  socklen_t client_len = sizeof(client);
  int client_socket;
  int r, i, j;
  int s[MAX_S];
  int maxs, nfds;
  char hbuf[NI_MAXHOST], sbuf[NI_MAXSERV];
  fd_set rfd, rfd0;
  pid_t child;
  struct client_s *new_client;
  const int on = 1;
  sigset_t childset;

  sigaddset(&childset, SIGCHLD);

  parse_cmd_line(argc, argv);

  memset(&hints, 0, sizeof(hints));
  hints.ai_socktype = SOCK_STREAM;
  hints.ai_flags = AI_PASSIVE;
  maxs = 0;
  nfds = -1;

  if (bind_addresses == NULL)
  {
    bind_addresses = new_empty_bindaddr();
  }

  for (bind_addr = bind_addresses; bind_addr; bind_addr = bind_addr->next)
  {
    r = getaddrinfo(bind_addr->node, bind_addr->service,
                    &hints, &res);
    if (r)
    {
      logger(LOG_FATAL, "GAI: %s\n", gai_strerror(r));
      exit(EXIT_FAILURE);
    }

    for (ai = res; ai && maxs < MAX_S; ai = ai->ai_next)
    {
      s[maxs] = socket(ai->ai_family, ai->ai_socktype,
                       ai->ai_protocol);
      if (s[maxs] < 0)
        continue;
      r = setsockopt(s[maxs], SOL_SOCKET,
                     SO_REUSEADDR, &on, sizeof(on));
      if (r)
      {
        logger(LOG_ERROR, "SO_REUSEADDR "
                          "failed: %s\n",
               strerror(errno));
      }

#ifdef IPV6_V6ONLY
      if (ai->ai_family == AF_INET6)
      {
        r = setsockopt(s[maxs], IPPROTO_IPV6,
                       IPV6_V6ONLY, &on, sizeof(on));
        if (r)
        {
          logger(LOG_ERROR, "IPV6_V6ONLY "
                            "failed: %s\n",
                 strerror(errno));
        }
      }
#endif /* IPV6_V6ONLY */

      r = bind(s[maxs], ai->ai_addr, ai->ai_addrlen);
      if (r)
      {
        logger(LOG_ERROR, "Cannot bind: %s\n",
               strerror(errno));
        close(s[maxs]);
        continue;
      }
      r = listen(s[maxs], 0);
      if (r)
      {
        logger(LOG_ERROR, "Cannot listen: %s\n",
               strerror(errno));
        close(s[maxs]);
        continue;
      }
      r = getnameinfo(ai->ai_addr, ai->ai_addrlen,
                      hbuf, sizeof(hbuf),
                      sbuf, sizeof(sbuf),
                      NI_NUMERICHOST | NI_NUMERICSERV);
      if (r)
      {
        logger(LOG_ERROR, "getnameinfo failed: %s\n",
               gai_strerror(r));
      }
      else
      {
        logger(LOG_INFO, "Listening on %s port %s\n",
               hbuf, sbuf);
      }

      if (s[maxs] > nfds)
        nfds = s[maxs];
      maxs++;
    }
    freeaddrinfo(res);
  }
  free_bindaddr(bind_addresses);

  if (maxs == 0)
  {
    logger(LOG_FATAL, "No socket to listen!\n");
    exit(EXIT_FAILURE);
  }

  FD_ZERO(&rfd0);
  for (i = 0; i < maxs; i++)
  {
    FD_SET(s[i], &rfd0);
  }

  if (conf_daemonise)
  {
    logger(LOG_INFO, "Forking to background...\n");
    if (daemon(1, 0) != 0)
    {
      logger(LOG_FATAL, "Cannot fork: %s\n", strerror(errno));
      exit(EXIT_FAILURE);
    }
  }

  signal(SIGCHLD, &child_handler);
  while (1)
  {
    rfd = rfd0;
    r = select(nfds + 1, &rfd, NULL, NULL, NULL);
    if (r < 0)
    {
      if (errno == EINTR)
        continue;
      logger(LOG_FATAL, "select() failed: %s\n",
             strerror(errno));
      exit(EXIT_FAILURE);
    }
    for (i = 0; i < maxs; i++)
    {
      if (FD_ISSET(s[i], &rfd))
      {
        client_socket = accept(s[i],
                     (struct sockaddr *)&client,
                     &client_len);

        /* We have to mask SIGCHLD before we add child to the list*/
        sigprocmask(SIG_BLOCK, &childset, NULL);
        client_count++;
        if ((child = fork()))
        { /* PARENT */
          close(client_socket);
          new_client = malloc(sizeof(struct client_s));
          new_client->ss = client;
          new_client->pid = child;
          new_client->next = clients;
          clients = new_client;

          r = getnameinfo((struct sockaddr *)&client, client_len,
                          hbuf, sizeof(hbuf),
                          sbuf, sizeof(sbuf),
                          NI_NUMERICHOST | NI_NUMERICSERV);
          if (r)
          {
            logger(LOG_ERROR, "getnameinfo failed: %s\n",
                   gai_strerror(r));
          }
          else
          {
            logger(LOG_INFO, "Connection from %s port %s\n",
                   hbuf, sbuf);
          }
          sigprocmask(SIG_UNBLOCK, &childset, NULL);
        }
        else
        { /* CHILD */
          sigprocmask(SIG_UNBLOCK, &childset, NULL);
          for (j = 0; j < maxs; j++)
            close(s[j]);
          client_service(client_socket);
          exit(EXIT_SUCCESS);
        }
      }
    }
  }
  /* Should never reach this */
  return 0;
}
