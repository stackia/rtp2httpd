#include "supervisor.h"
#include "configuration.h"
#include "rtp2httpd.h"
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
#include <sys/wait.h>
#include <unistd.h>

#define MAX_S 10

/* Restart rate limiting constants */
#define RESTART_WINDOW_SEC 5     /* Time window for restart counting */
#define MAX_RESTARTS_IN_WINDOW 3 /* Max restarts allowed in window */

/* Worker process information */
typedef struct {
  pid_t pid;     /* Worker PID, 0 if not running */
  int worker_id; /* Worker ID (0-based) */
  int64_t restart_times[MAX_RESTARTS_IN_WINDOW]; /* Recent restart timestamps */
  int restart_count; /* Number of restarts in current window */
  int rate_limited;  /* 1 if currently rate limited, 0 otherwise */
} worker_info_t;

/* Supervisor state */
static worker_info_t *workers = NULL;
static int num_workers = 0;
static volatile sig_atomic_t supervisor_stop_flag = 0;
static volatile sig_atomic_t supervisor_reload_flag = 0;
static volatile sig_atomic_t supervisor_restart_workers_flag = 0;

/* Forward declarations */
static void supervisor_signal_handler(int signum);
static void supervisor_sighup_handler(int signum);
static void supervisor_sigusr1_handler(int signum);
static int spawn_worker(int worker_idx);
static void cleanup_workers(void);

/**
 * Signal handler for supervisor process (SIGTERM/SIGINT)
 */
static void supervisor_signal_handler(int signum) {
  (void)signum;
  supervisor_stop_flag = 1;
}

/**
 * Signal handler for SIGHUP (config reload)
 */
static void supervisor_sighup_handler(int signum) {
  (void)signum;
  supervisor_reload_flag = 1;
}

/**
 * Signal handler for SIGUSR1 (restart all workers)
 */
static void supervisor_sigusr1_handler(int signum) {
  (void)signum;
  supervisor_restart_workers_flag = 1;
}

/**
 * Check if restart is allowed (rate limiting)
 * Returns 1 if restart is allowed, 0 if rate limited
 */
static int restart_allowed(worker_info_t *w) {
  int64_t now = get_time_ms();
  int64_t window_start = now - (RESTART_WINDOW_SEC * 1000);
  int recent_restarts = 0;

  /* Count restarts within the window */
  for (int i = 0; i < MAX_RESTARTS_IN_WINDOW; i++) {
    if (w->restart_times[i] >= window_start) {
      recent_restarts++;
    }
  }

  return recent_restarts < MAX_RESTARTS_IN_WINDOW;
}

/**
 * Record a restart event
 */
static void record_restart(worker_info_t *w) {
  int64_t now = get_time_ms();

  /* Shift old times and add new one */
  for (int i = MAX_RESTARTS_IN_WINDOW - 1; i > 0; i--) {
    w->restart_times[i] = w->restart_times[i - 1];
  }
  w->restart_times[0] = now;
  w->restart_count++;
}

/**
 * Spawn a worker process
 * @param worker_idx Index in workers array (also used as worker_id)
 * @return 0 on success, -1 on error
 */
static int spawn_worker(int worker_idx) {
  pid_t supervisor_pid = getpid();
  pid_t pid = fork();

  if (pid < 0) {
    logger(LOG_ERROR, "Failed to fork worker %d: %s", worker_idx,
           strerror(errno));
    return -1;
  }

  if (pid == 0) {
    /* Child process: become a worker */

    /* Ensure child dies when parent (supervisor) exits */
    prctl(PR_SET_PDEATHSIG, SIGTERM);

    /* Check if parent already exited (race condition protection) */
    if (getppid() != supervisor_pid) {
      /* Parent already exited, exit immediately */
      _exit(EXIT_FAILURE);
    }

    /* Set worker ID */
    worker_id = worker_idx;

    /* Run worker business logic */
    int result = run_worker();

    /* Clean exit */
    _exit(result);
  }

  /* Parent: record worker info */
  workers[worker_idx].pid = pid;
  workers[worker_idx].worker_id = worker_idx;

  logger(LOG_INFO, "Spawned worker %d with pid %d", worker_idx, (int)pid);

  return 0;
}

/**
 * Broadcast a signal to all running workers
 * @param signum Signal number to send
 * @param reason Log message describing why the signal is being sent
 */
static void broadcast_signal_to_workers(int signum, const char *reason) {
  logger(LOG_INFO, "%s, sending %s to %d workers", reason,
         signum == SIGTERM  ? "SIGTERM"
         : signum == SIGHUP ? "SIGHUP"
                            : "signal",
         num_workers);
  for (int i = 0; i < num_workers; i++) {
    if (workers[i].pid > 0) {
      kill(workers[i].pid, signum);
    }
  }
}

/**
 * Find worker by PID
 * @return worker index, or -1 if not found
 */
static int find_worker_by_pid(pid_t pid) {
  for (int i = 0; i < num_workers; i++) {
    if (workers[i].pid == pid) {
      return i;
    }
  }
  return -1;
}

/**
 * Clean up worker array
 */
static void cleanup_workers(void) {
  if (workers) {
    free(workers);
    workers = NULL;
  }
  num_workers = 0;
}

int supervisor_run(void) {
  int i;

  num_workers = config.workers;
  workers = calloc(num_workers, sizeof(worker_info_t));
  if (!workers) {
    logger(LOG_FATAL, "Failed to allocate worker array");
    return -1;
  }

  /* Initialize worker info */
  for (i = 0; i < num_workers; i++) {
    workers[i].pid = 0;
    workers[i].worker_id = i;
    workers[i].restart_count = 0;
    workers[i].rate_limited = 0;
    for (int j = 0; j < MAX_RESTARTS_IN_WINDOW; j++) {
      workers[i].restart_times[j] = 0;
    }
  }

  /* Spawn all workers */
  for (i = 0; i < num_workers; i++) {
    if (spawn_worker(i) < 0) {
      logger(LOG_ERROR, "Failed to spawn worker %d", i);
    }
  }

  /* Set up signal handlers for supervisor */
  struct sigaction sa;
  memset(&sa, 0, sizeof(sa));
  sa.sa_handler = supervisor_signal_handler;
  sigemptyset(&sa.sa_mask);
  sa.sa_flags = 0;

  sigaction(SIGTERM, &sa, NULL);
  sigaction(SIGINT, &sa, NULL);

  /* SIGHUP for config reload */
  struct sigaction sa_hup;
  memset(&sa_hup, 0, sizeof(sa_hup));
  sa_hup.sa_handler = supervisor_sighup_handler;
  sigemptyset(&sa_hup.sa_mask);
  sa_hup.sa_flags = 0;
  sigaction(SIGHUP, &sa_hup, NULL);

  /* SIGUSR1 for restarting all workers */
  struct sigaction sa_usr1;
  memset(&sa_usr1, 0, sizeof(sa_usr1));
  sa_usr1.sa_handler = supervisor_sigusr1_handler;
  sigemptyset(&sa_usr1.sa_mask);
  sa_usr1.sa_flags = 0;
  sigaction(SIGUSR1, &sa_usr1, NULL);

  /* Ignore SIGCHLD - we use waitpid() to collect children */
  signal(SIGCHLD, SIG_DFL);

  logger(LOG_INFO, "Entering monitoring loop");

  /* Main monitoring loop */
  while (!supervisor_stop_flag) {
    int status;
    pid_t pid;

    /* Non-blocking wait for any child */
    while ((pid = waitpid(-1, &status, WNOHANG)) > 0) {
      int worker_idx = find_worker_by_pid(pid);

      if (worker_idx < 0) {
        continue;
      }

      /* Log exit reason */
      if (WIFEXITED(status)) {
        logger(LOG_WARN, "Worker %d (pid %d) exited with status %d", worker_idx,
               (int)pid, WEXITSTATUS(status));
      } else if (WIFSIGNALED(status)) {
        logger(LOG_WARN, "Worker %d (pid %d) killed by signal %d", worker_idx,
               (int)pid, WTERMSIG(status));
      }

      workers[worker_idx].pid = 0;

      /* Restart if not stopping */
      if (!supervisor_stop_flag) {
        if (restart_allowed(&workers[worker_idx])) {
          record_restart(&workers[worker_idx]);
          workers[worker_idx].rate_limited = 0;
          logger(LOG_INFO, "Restarting worker %d", worker_idx);
          if (spawn_worker(worker_idx) < 0) {
            logger(LOG_ERROR, "Failed to restart worker %d", worker_idx);
          }
        } else {
          workers[worker_idx].rate_limited = 1;
          logger(LOG_ERROR,
                 "Worker %d restart rate limited (%d restarts in %d seconds)",
                 worker_idx, MAX_RESTARTS_IN_WINDOW, RESTART_WINDOW_SEC);
        }
      }
    }

    /* Check for rate-limited workers that can now be restarted */
    for (i = 0; i < num_workers; i++) {
      if (workers[i].rate_limited && workers[i].pid == 0 &&
          !supervisor_stop_flag) {
        if (restart_allowed(&workers[i])) {
          record_restart(&workers[i]);
          workers[i].rate_limited = 0;
          logger(LOG_INFO, "Rate limit expired, restarting worker %d", i);
          if (spawn_worker(i) < 0) {
            logger(LOG_ERROR, "Failed to restart worker %d", i);
          }
        }
      }
    }

    /* Handle SIGHUP reload request */
    if (supervisor_reload_flag) {
      supervisor_reload_flag = 0;
      logger(LOG_INFO, "Received SIGHUP, reloading configuration");

      int bind_changed = 0;
      if (config_reload(&bind_changed) == 0) {
        /* Handle worker count changes */
        if (config.workers > num_workers) {
          if (bind_changed) {
            broadcast_signal_to_workers(SIGTERM, "Bind addresses changed");
          } else {
            broadcast_signal_to_workers(SIGHUP, "Forwarding config reload");
          }

          /* Need to spawn more workers */
          int new_count = config.workers;
          worker_info_t *new_workers =
              realloc(workers, new_count * sizeof(worker_info_t));
          if (new_workers) {
            workers = new_workers;
            /* Initialize new worker slots */
            for (i = num_workers; i < new_count; i++) {
              workers[i].pid = 0;
              workers[i].worker_id = i;
              workers[i].restart_count = 0;
              workers[i].rate_limited = 0;
              for (int j = 0; j < MAX_RESTARTS_IN_WINDOW; j++) {
                workers[i].restart_times[j] = 0;
              }
              /* Spawn new worker - it inherits new config automatically */
              logger(LOG_INFO, "Spawning new worker %d", i);
              if (spawn_worker(i) < 0) {
                logger(LOG_ERROR, "Failed to spawn new worker %d", i);
              }
            }
            num_workers = new_count;
          } else {
            logger(LOG_ERROR, "Failed to allocate memory for new workers");
          }
        } else if (config.workers < num_workers) {
          /* Need to terminate excess workers */
          logger(LOG_INFO, "Reducing worker count from %d to %d", num_workers,
                 config.workers);
          for (i = config.workers; i < num_workers; i++) {
            if (workers[i].pid > 0) {
              logger(LOG_INFO, "Sending SIGTERM to excess worker %d (pid %d)",
                     i, (int)workers[i].pid);
              kill(workers[i].pid, SIGTERM);
            }
          }
          /* Update num_workers - excess workers will be reaped normally */
          num_workers = config.workers;
          /* Shrink array */
          worker_info_t *new_workers =
              realloc(workers, num_workers * sizeof(worker_info_t));
          if (new_workers) {
            workers = new_workers;
          }

          if (bind_changed) {
            broadcast_signal_to_workers(SIGTERM, "Bind addresses changed");
          } else {
            broadcast_signal_to_workers(SIGHUP, "Forwarding config reload");
          }
        } else {
          if (bind_changed) {
            broadcast_signal_to_workers(SIGTERM, "Bind addresses changed");
          } else {
            broadcast_signal_to_workers(SIGHUP, "Forwarding config reload");
          }
        }
      } else {
        logger(LOG_ERROR,
               "Configuration reload failed, not forwarding SIGHUP to workers");
      }
    }

    /* Handle SIGUSR1 restart workers request */
    if (supervisor_restart_workers_flag) {
      supervisor_restart_workers_flag = 0;
      broadcast_signal_to_workers(SIGTERM,
                                  "Received SIGUSR1, restarting workers");
    }

    /* Sleep before next check */
    usleep(100000); /* 100ms */
  }

  broadcast_signal_to_workers(SIGTERM, "Received stop signal, shutting down");

  /* Wait for all workers to exit with timeout */
  int remaining = num_workers;
  int timeout_count = 0;
  const int max_timeout = 50; /* 5 seconds (50 * 100ms) */

  while (remaining > 0 && timeout_count < max_timeout) {
    int status;
    pid_t pid = waitpid(-1, &status, WNOHANG);

    if (pid > 0) {
      int worker_idx = find_worker_by_pid(pid);
      if (worker_idx >= 0) {
        workers[worker_idx].pid = 0;
        remaining--;
        logger(LOG_INFO, "Worker %d exited", worker_idx);
      }
    } else if (pid == 0) {
      /* No child exited yet, wait a bit */
      usleep(100000); /* 100ms */
      timeout_count++;
    } else {
      /* No more children or error */
      break;
    }
  }

  /* Force kill any remaining workers */
  if (remaining > 0) {
    logger(LOG_WARN, "%d workers didn't exit gracefully, sending SIGKILL",
           remaining);
    for (i = 0; i < num_workers; i++) {
      if (workers[i].pid > 0) {
        kill(workers[i].pid, SIGKILL);
        waitpid(workers[i].pid, NULL, 0);
        workers[i].pid = 0;
      }
    }
  }

  logger(LOG_INFO, "All workers stopped, cleaning up");

  /* Clean up worker array */
  cleanup_workers();

  /* Clean up shared memory and other resources
   * Supervisor is now the last process, so it does final cleanup */
  status_cleanup();

  return 0;
}

int run_worker(void) {
  struct addrinfo hints, *res, *ai;
  bindaddr_t *bind_addr;
  int r;
  int s[MAX_S];
  int maxs, nfds;
  char hbuf[NI_MAXHOST], sbuf[NI_MAXSERV];
  const int on = 1;
  int notif_fd = -1;

  /* Get notification pipe read fd for this worker (after fork)
   * This also closes read fds for other workers to avoid fd leaks */
  if (status_shared) {
    notif_fd = status_worker_get_notif_fd();
    if (notif_fd < 0) {
      logger(LOG_ERROR, "Failed to get worker notification pipe");
    }
    if (worker_id >= 0 && worker_id < STATUS_MAX_WORKERS)
      status_shared->worker_stats[worker_id].worker_pid = getpid();
  }

  logger(LOG_INFO, "Worker %d started (pid=%d)", worker_id, (int)getpid());

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
      return EXIT_FAILURE;
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
    return EXIT_FAILURE;
  }

  /* Initialize zero-copy infrastructure for this worker (mandatory) */
  if (zerocopy_init() != 0) {
    logger(LOG_FATAL, "Failed to initialize zero-copy infrastructure");
    logger(LOG_FATAL, "MSG_ZEROCOPY support is required (kernel 4.14+)");
    return EXIT_FAILURE;
  }

  logger(LOG_INFO,
         "Server initialization complete, ready to accept connections");

  /* Run worker event loop */
  int result = worker_run_event_loop(s, maxs, notif_fd);

  status_cleanup();
  config_cleanup(true);

  return result;
}
