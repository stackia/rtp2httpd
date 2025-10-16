#ifdef HAVE_CONFIG_H
#include "config.h"
#endif /* HAVE_CONFIG_H */

#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <stdarg.h>
#include <errno.h>
#include <string.h>
#include <signal.h>
#include <sys/prctl.h>
#include <sys/types.h>
#include <sys/socket.h>
#include <netdb.h>
#include <time.h>
#include <stdint.h>

#include "rtp2httpd.h"
#include "configuration.h"
#include "status.h"
#include "worker.h"
#include "zerocopy.h"

#define MAX_S 10

/* GLOBALS */
service_t *services = NULL;
struct bindaddr_s *bind_addresses = NULL;
int client_count = 0;
int worker_id = 0; /* Worker ID for this process (0-based) */

/**
 * Get current monotonic time in milliseconds.
 * Uses CLOCK_MONOTONIC for high precision and immunity to system clock changes.
 * Thread-safe.
 *
 * @return Current time in milliseconds since an unspecified starting point
 */
int64_t get_time_ms(void)
{
  struct timespec ts;
  if (clock_gettime(CLOCK_MONOTONIC, &ts) != 0)
  {
    /* Fallback to CLOCK_REALTIME if MONOTONIC is not available */
    if (clock_gettime(CLOCK_REALTIME, &ts) != 0)
    {
      return 0;
    }
  }
  return (int64_t)ts.tv_sec * 1000LL + ts.tv_nsec / 1000000LL;
}

/**
 * Get current real time in milliseconds since Unix epoch.
 * Uses CLOCK_REALTIME for wall clock time.
 * Thread-safe.
 *
 * @return Current time in milliseconds since Unix epoch (1970-01-01 00:00:00 UTC)
 */
int64_t get_realtime_ms(void)
{
  struct timespec ts;
  if (clock_gettime(CLOCK_REALTIME, &ts) != 0)
  {
    return 0;
  }
  return (int64_t)ts.tv_sec * 1000LL + ts.tv_nsec / 1000000LL;
}

/**
 * Logger function. Show the message if current verbosity is above
 * logged level.
 *
 * @param level Message log level
 * @param format printf style format string
 * @returns Whatever printf returns
 */
int logger(enum loglevel level, const char *format, ...)
{
  va_list ap;
  int r = 0;
  char message[1024];
  int prefix_len = 0;

  /* Check log level from shared memory if available, otherwise use config */
  enum loglevel current_level = config.verbosity;
  if (status_shared)
  {
    current_level = status_shared->current_log_level;
  }

  if (current_level >= level)
  {
    /* Add worker_id prefix only if multiple workers */
    if (config.workers > 1)
    {
      prefix_len = snprintf(message, sizeof(message), "[Worker %d] ", worker_id);
    }

    /* Format the actual message after the prefix (if any) */
    va_start(ap, format);
    vsnprintf(message + prefix_len, sizeof(message) - prefix_len, format, ap);
    va_end(ap);

    /* Output to stderr */
    r = fputs(message, stderr);

    /* Store in status log buffer */
    status_add_log_entry(level, message);

    // Automatically add newline if format doesn't end with one
    if (format && strlen(format) > 0 && format[strlen(format) - 1] != '\n')
    {
      fputc('\n', stderr);
    }
  }
  return r;
}

int main(int argc, char *argv[])
{
  struct addrinfo hints, *res, *ai;
  struct bindaddr_s *bind_addr;
  int r;
  int s[MAX_S];
  int maxs, nfds;
  char hbuf[NI_MAXHOST], sbuf[NI_MAXSERV];
  const int on = 1;
  int notif_fd = -1;

  parse_cmd_line(argc, argv);

  /* Initialize status tracking system (before fork, shared memory) */
  if (status_init() != 0)
  {
    logger(LOG_ERROR, "Failed to initialize status tracking");
    /* Continue anyway - status page won't work but streaming will */
  }

  if (config.daemonise)
  {
    logger(LOG_INFO, "Forking to background...");

    if (daemon(1, 0) != 0)
    {
      logger(LOG_FATAL, "Cannot fork: %s", strerror(errno));
      exit(EXIT_FAILURE);
    }
  }

  /* Prefork N-1 additional workers for SO_REUSEPORT sharding (the original process is also a worker) */
  if (config.workers > 1)
  {
    int k;
    logger(LOG_INFO, "Starting %d worker threads with SO_REUSEPORT", config.workers);
    for (k = 1; k < config.workers; k++)
    {
      pid_t w = fork();
      if (w < 0)
      {
        logger(LOG_ERROR, "Failed to fork worker: %s", strerror(errno));
        continue;
      }
      if (w == 0)
      {
        /* Child becomes a worker: ensure it dies when parent exits */
        prctl(PR_SET_PDEATHSIG, SIGTERM);
        worker_id = k; /* Assign worker ID to child */
        break;
      }
    }
    logger(LOG_INFO, "Worker started: pid=%d", (int)getpid());
  }

  /* Get notification pipe read fd for this worker (after fork)
   * This also closes read fds for other workers to avoid fd leaks */
  if (status_shared)
  {
    notif_fd = status_worker_get_notif_fd();
    if (notif_fd < 0)
    {
      logger(LOG_ERROR, "Failed to get worker notification pipe");
    }
    if (worker_id >= 0 && worker_id < STATUS_MAX_WORKERS)
      status_shared->worker_stats[worker_id].worker_pid = getpid();
  }
  else
  {
    logger(LOG_INFO, "Starting single worker (pid=%d)", (int)getpid());
  }

  /* Per-worker listener setup (SO_REUSEPORT allows multiple binds) */
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
      logger(LOG_FATAL, "GAI: %s", gai_strerror(r));
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
        logger(LOG_ERROR, "SO_REUSEADDR failed: %s",
               strerror(errno));
      }
#ifdef SO_REUSEPORT
      r = setsockopt(s[maxs], SOL_SOCKET, SO_REUSEPORT, &on, sizeof(on));
      if (r)
      {
        logger(LOG_ERROR, "SO_REUSEPORT failed: %s", strerror(errno));
      }
#endif

#ifdef IPV6_V6ONLY
      if (ai->ai_family == AF_INET6)
      {
        r = setsockopt(s[maxs], IPPROTO_IPV6,
                       IPV6_V6ONLY, &on, sizeof(on));
        if (r)
        {
          logger(LOG_ERROR, "IPV6_V6ONLY "
                            "failed: %s",
                 strerror(errno));
        }
      }
#endif /* IPV6_V6ONLY */

      r = bind(s[maxs], ai->ai_addr, ai->ai_addrlen);
      if (r)
      {
        logger(LOG_ERROR, "Cannot bind: %s",
               strerror(errno));
        close(s[maxs]);
        continue;
      }
      r = listen(s[maxs], 128);
      if (r)
      {
        logger(LOG_ERROR, "Cannot listen: %s",
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
        logger(LOG_ERROR, "getnameinfo failed: %s",
               gai_strerror(r));
      }
      else
      {
        logger(LOG_INFO, "Listening on %s port %s",
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
    logger(LOG_FATAL, "No socket to listen!");
    exit(EXIT_FAILURE);
  }

  /* Initialize zero-copy infrastructure for this worker (mandatory) */
  if (zerocopy_init() != 0)
  {
    logger(LOG_FATAL, "Failed to initialize zero-copy infrastructure");
    logger(LOG_FATAL, "MSG_ZEROCOPY support is required (kernel 4.14+)");
    exit(EXIT_FAILURE);
  }

  logger(LOG_INFO, "Server initialization complete, ready to accept connections");

  /* Run worker event loop */
  int result = worker_run_event_loop(s, maxs, notif_fd);

  status_cleanup();

  return result;
}
