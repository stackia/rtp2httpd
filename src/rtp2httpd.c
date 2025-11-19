#include "rtp2httpd.h"
#include "configuration.h"
#include "service.h"
#include "status.h"
#include "utils.h"
#include "worker.h"
#include "zerocopy.h"
#include <errno.h>
#include <netdb.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <unistd.h>

#define MAX_S 10

/* GLOBALS */
int worker_id = 0; /* Worker ID for this process (0-based) */

int main(int argc, char *argv[]) {
  struct addrinfo hints, *res, *ai;
  bindaddr_t *bind_addr;
  int r;
  int s[MAX_S];
  int maxs, nfds;
  char hbuf[NI_MAXHOST], sbuf[NI_MAXSERV];
  const int on = 1;
  int notif_fd = -1;

  parse_cmd_line(argc, argv);

  /* Initialize status tracking system (before fork, shared memory) */
  if (status_init() != 0) {
    logger(LOG_ERROR, "Failed to initialize status tracking");
    /* Continue anyway - status page won't work but streaming will */
  }

  /* Prefork N-1 additional workers for SO_REUSEPORT sharding (the original
   * process is also a worker) */
  if (config.workers > 1) {
    int k;
    logger(LOG_INFO, "Starting %d worker threads with SO_REUSEPORT",
           config.workers);
    for (k = 1; k < config.workers; k++) {
      pid_t w = fork();
      if (w < 0) {
        logger(LOG_ERROR, "Failed to fork worker: %s", strerror(errno));
        continue;
      }
      if (w == 0) {
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
  if (status_shared) {
    notif_fd = status_worker_get_notif_fd();
    if (notif_fd < 0) {
      logger(LOG_ERROR, "Failed to get worker notification pipe");
    }
    if (worker_id >= 0 && worker_id < STATUS_MAX_WORKERS)
      status_shared->worker_stats[worker_id].worker_pid = getpid();
  } else {
    logger(LOG_INFO, "Starting single worker (pid=%d)", (int)getpid());
  }

  /* Per-worker listener setup (SO_REUSEPORT allows multiple binds) */
  memset(&hints, 0, sizeof(hints));
  hints.ai_socktype = SOCK_STREAM;
  hints.ai_flags = AI_PASSIVE;
  maxs = 0;
  nfds = -1;

  if (bind_addresses == NULL) {
    bind_addresses = new_empty_bindaddr();
  }

  for (bind_addr = bind_addresses; bind_addr; bind_addr = bind_addr->next) {
    r = getaddrinfo(bind_addr->node, bind_addr->service, &hints, &res);
    if (r) {
      logger(LOG_FATAL, "GAI: %s", gai_strerror(r));
      exit(EXIT_FAILURE);
    }

    for (ai = res; ai && maxs < MAX_S; ai = ai->ai_next) {
      s[maxs] = socket(ai->ai_family, ai->ai_socktype, ai->ai_protocol);
      if (s[maxs] < 0)
        continue;
      r = setsockopt(s[maxs], SOL_SOCKET, SO_REUSEADDR, &on, sizeof(on));
      if (r) {
        logger(LOG_ERROR, "SO_REUSEADDR failed: %s", strerror(errno));
      }
#ifdef SO_REUSEPORT
      r = setsockopt(s[maxs], SOL_SOCKET, SO_REUSEPORT, &on, sizeof(on));
      if (r) {
        logger(LOG_ERROR, "SO_REUSEPORT failed: %s", strerror(errno));
      }
#endif

#ifdef IPV6_V6ONLY
      if (ai->ai_family == AF_INET6) {
        r = setsockopt(s[maxs], IPPROTO_IPV6, IPV6_V6ONLY, &on, sizeof(on));
        if (r) {
          logger(LOG_ERROR,
                 "IPV6_V6ONLY "
                 "failed: %s",
                 strerror(errno));
        }
      }
#endif /* IPV6_V6ONLY */

      r = bind(s[maxs], ai->ai_addr, ai->ai_addrlen);
      if (r) {
        logger(LOG_ERROR, "Cannot bind: %s", strerror(errno));
        close(s[maxs]);
        continue;
      }
      r = listen(s[maxs], 128);
      if (r) {
        logger(LOG_ERROR, "Cannot listen: %s", strerror(errno));
        close(s[maxs]);
        continue;
      }
      r = getnameinfo(ai->ai_addr, ai->ai_addrlen, hbuf, sizeof(hbuf), sbuf,
                      sizeof(sbuf), NI_NUMERICHOST | NI_NUMERICSERV);
      if (r) {
        logger(LOG_ERROR, "getnameinfo failed: %s", gai_strerror(r));
      } else {
        logger(LOG_INFO, "Listening on %s port %s", hbuf, sbuf);
      }

      if (s[maxs] > nfds)
        nfds = s[maxs];
      maxs++;
    }
    freeaddrinfo(res);
  }

  if (maxs == 0) {
    logger(LOG_FATAL, "No socket to listen!");
    exit(EXIT_FAILURE);
  }

  /* Initialize zero-copy infrastructure for this worker (mandatory) */
  if (zerocopy_init() != 0) {
    logger(LOG_FATAL, "Failed to initialize zero-copy infrastructure");
    logger(LOG_FATAL, "MSG_ZEROCOPY support is required (kernel 4.14+)");
    exit(EXIT_FAILURE);
  }

  logger(LOG_INFO,
         "Server initialization complete, ready to accept connections");

  /* Run worker event loop */
  int result = worker_run_event_loop(s, maxs, notif_fd);

  free_bindaddr(bind_addresses);
  status_cleanup();
  service_hashmap_free();

  return result;
}
