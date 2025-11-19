#include "worker.h"
#include "connection.h"
#include "epg.h"
#include "hashmap.h"
#include "http_fetch.h"
#include "m3u.h"
#include "rtp2httpd.h"
#include "status.h"
#include "stream.h"
#include "utils.h"
#include "zerocopy.h"
#include <errno.h>
#include <signal.h>
#include <stdlib.h>
#include <string.h>
#include <sys/epoll.h>
#include <sys/socket.h>
#include <unistd.h>

/* fd -> connection map entry */
typedef struct {
  int fd;
  connection_t *conn;
} fdmap_entry_t;

/* fd -> connection map (hashmap-based for O(1) lookups) */
static struct hashmap *fd_map = NULL;

/* Connection list head */
static connection_t *conn_head = NULL;

/* Stop flag for graceful shutdown */
static volatile sig_atomic_t stop_flag = 0;

#define WORKER_MAX_WRITE_BATCH 128

/**
 * Hash function for file descriptors
 */
static uint64_t hash_fd(const void *item, uint64_t seed0, uint64_t seed1) {
  const fdmap_entry_t *entry = item;
  return hashmap_xxhash3(&entry->fd, sizeof(int), seed0, seed1);
}

/**
 * Compare function for file descriptors
 */
static int compare_fds(const void *a, const void *b, void *udata) {
  const fdmap_entry_t *ea = a;
  const fdmap_entry_t *eb = b;
  (void)udata; /* unused */
  return ea->fd - eb->fd;
}

/**
 * Initialize the fd map (hashmap-based)
 */
void fdmap_init(void) {
  if (fd_map)
    hashmap_free(fd_map);

  fd_map = hashmap_new(sizeof(fdmap_entry_t), /* element size */
                       0,                     /* initial capacity */
                       0, 0,                  /* seeds (use default) */
                       hash_fd,               /* hash function */
                       compare_fds,           /* compare function */
                       NULL,                  /* no element free function */
                       NULL                   /* no udata */
  );

  if (!fd_map) {
    logger(LOG_FATAL, "Failed to create fd map hashmap");
    exit(1);
  }
}

/**
 * Set fd -> connection mapping
 */
void fdmap_set(int fd, connection_t *c) {
  if (fd < 0 || !fd_map)
    return;

  fdmap_entry_t entry = {.fd = fd, .conn = c};
  hashmap_set(fd_map, &entry);
}

/**
 * Get connection by fd
 */
connection_t *fdmap_get(int fd) {
  if (fd < 0 || !fd_map)
    return NULL;

  fdmap_entry_t key = {.fd = fd};
  const fdmap_entry_t *entry = hashmap_get(fd_map, &key);
  return entry ? entry->conn : NULL;
}

/**
 * Delete fd from map
 */
void fdmap_del(int fd) {
  if (fd < 0 || !fd_map)
    return;

  fdmap_entry_t key = {.fd = fd};
  hashmap_delete(fd_map, &key);
}

/**
 * Cleanup and free the fd map
 */
void fdmap_cleanup(void) {
  if (fd_map) {
    hashmap_free(fd_map);
    fd_map = NULL;
  }
}

void worker_cleanup_socket_from_epoll(int epoll_fd, int sock) {
  if (sock < 0) {
    return;
  }

  /* Remove from fdmap first */
  fdmap_del(sock);

  /* Remove from epoll */
  if (epoll_fd >= 0) {
    if (epoll_ctl(epoll_fd, EPOLL_CTL_DEL, sock, NULL) < 0) {
      /* Log but continue - socket might not be in epoll */
      logger(LOG_DEBUG,
             "Worker: epoll_ctl DEL failed for fd %d: %s (continuing)", sock,
             strerror(errno));
    }
  }

  /* Close socket */
  close(sock);
}

static void remove_connection_from_list(connection_t *c) {
  if (!c)
    return;
  if (conn_head == c) {
    conn_head = c->next;
    return;
  }
  for (connection_t *p = conn_head; p; p = p->next) {
    if (p->next == c) {
      p->next = c->next;
      return;
    }
  }
}

void worker_close_and_free_connection(connection_t *c) {
  if (!c)
    return;

  /* CRITICAL: For streaming connections, initiate cleanup first to check if
   * async TEARDOWN will be started This prevents use-after-free when TEARDOWN
   * response arrives after connection is freed. */
  if (c->streaming) {
    /* Initiate stream cleanup - this may start async RTSP TEARDOWN */
    int async_cleanup = stream_context_cleanup(&c->stream);
    c->streaming =
        0; /* Mark as no longer streaming to prevent double cleanup */

    if (async_cleanup) {
      /* Async RTSP TEARDOWN initiated - defer connection cleanup */
      logger(LOG_DEBUG, "Worker: Async RTSP TEARDOWN initiated, deferring "
                        "connection cleanup");

      /* Close and cleanup client socket immediately */
      if (c->fd >= 0) {
        fdmap_del(c->fd);
        if (c->epfd >= 0) {
          epoll_ctl(c->epfd, EPOLL_CTL_DEL, c->fd, NULL);
        }
        close(c->fd);
        c->fd = -1;
      }

      /* Mark connection as closing but keep it in list */
      c->state = CONN_CLOSING;

      /* Keep connection alive for RTSP TEARDOWN completion */
      /* RTSP TEARDOWN completion will trigger final cleanup via stream event
       * handler returning -1 */
      logger(LOG_DEBUG,
             "Worker: Deferred cleanup - waiting for RTSP TEARDOWN completion");
      return;
    }
  }

  /* Normal cleanup path: remove from fd map */
  fdmap_del(c->fd);

  /* Remove from epoll - CRITICAL: Must remove all sockets before close() to
   * prevent fd reuse issues */
  if (c->epfd >= 0) {
    /* Remove client socket */
    if (c->fd >= 0) {
      epoll_ctl(c->epfd, EPOLL_CTL_DEL, c->fd, NULL);
    }
  }

  /* Remove from list */
  remove_connection_from_list(c);

  /* Free connection */
  connection_free(c);
}

static void term_handler(int signum) {
  (void)signum;
  stop_flag = 1;
}

int worker_run_event_loop(int *listen_sockets, int num_sockets, int notif_fd) {
  int i;
  struct sockaddr_storage client;

  /* Initialize fd map */
  fdmap_init();

  /* Build epoll set for listening sockets */
  int epfd = epoll_create1(EPOLL_CLOEXEC);
  if (epfd < 0) {
    logger(LOG_FATAL, "epoll_create1 failed: %s", strerror(errno));
    return -1;
  }

  struct epoll_event ev, events[1024];
  for (i = 0; i < num_sockets; i++) {
    connection_set_nonblocking(listen_sockets[i]);
    memset(&ev, 0, sizeof(ev));
    ev.events = EPOLLIN;
    ev.data.fd = listen_sockets[i];
    if (epoll_ctl(epfd, EPOLL_CTL_ADD, listen_sockets[i], &ev) < 0) {
      logger(LOG_FATAL, "epoll_ctl ADD failed: %s", strerror(errno));
      close(epfd);
      return -1;
    }
  }

  if (notif_fd >= 0) {
    memset(&ev, 0, sizeof(ev));
    ev.events = EPOLLIN;
    ev.data.fd = notif_fd;
    if (epoll_ctl(epfd, EPOLL_CTL_ADD, notif_fd, &ev) < 0) {
      logger(LOG_ERROR, "epoll_ctl ADD notif_fd failed: %s", strerror(errno));
      notif_fd = -1;
    }
  }

  /* Register signal handlers */
  signal(SIGTERM, &term_handler);
  signal(SIGINT, &term_handler);

  /* Unified event loop: accept + clients + stream fds */
  int64_t last_tick = get_time_ms();

  while (!stop_flag) {
    int timeout_ms = 100;
    int n = epoll_wait(epfd, events, (int)(sizeof(events) / sizeof(events[0])),
                       timeout_ms);
    if (n < 0) {
      if (errno == EINTR)
        continue;
      logger(LOG_FATAL, "epoll_wait failed: %s", strerror(errno));
      break;
    }

    int64_t now = get_time_ms();

    /* 1) Handle all ready events */
    for (int e = 0; e < n; e++) {
      int fd_ready = events[e].data.fd;
      int is_listener = 0;
      for (i = 0; i < num_sockets; i++)
        if (fd_ready == listen_sockets[i]) {
          is_listener = 1;
          break;
        }

      if (notif_fd >= 0 && fd_ready == notif_fd) {
        /* Read event notifications from pipe */
        uint8_t event_buf[256];
        ssize_t bytes_read;
        int has_sse_update = 0;
        int has_disconnect_request = 0;

        while ((bytes_read = read(notif_fd, event_buf, sizeof(event_buf))) >
               0) {
          /* Check event types in the buffer */
          for (ssize_t j = 0; j < bytes_read; j++) {
            if (event_buf[j] == STATUS_EVENT_SSE_UPDATE)
              has_sse_update = 1;
            else if (event_buf[j] == STATUS_EVENT_DISCONNECT_REQUEST)
              has_disconnect_request = 1;
          }
        }

        /* Handle SSE updates */
        if (has_sse_update) {
          status_handle_sse_notification(conn_head);
        }

        /* Handle disconnect requests */
        if (has_disconnect_request && status_shared) {
          connection_t *c = conn_head;
          while (c) {
            connection_t *next = c->next;

            /* Check if disconnect was requested for this client */
            if (c->status_index >= 0 &&
                status_shared->clients[c->status_index].active &&
                status_shared->clients[c->status_index].disconnect_requested) {
              logger(LOG_INFO, "Disconnect requested for client %s via API",
                     status_shared->clients[c->status_index].client_addr);
              worker_close_and_free_connection(c);
            }

            c = next;
          }
        }

        continue;
      }

      if (is_listener) {
        /* Accept as many as possible */
        for (;;) {
          socklen_t alen = sizeof(client);
          int cfd = accept(fd_ready, (struct sockaddr *)&client, &alen);
          if (cfd < 0) {
            if (errno == EAGAIN || errno == EINTR)
              break;
            logger(LOG_ERROR, "accept failed: %s", strerror(errno));
            break;
          }
          connection_set_nonblocking(cfd);
          connection_set_tcp_nodelay(cfd);

          /* Create connection
           * status_index will be assigned later by status_register_client() if
           * this is a streaming client */
          connection_t *c = connection_create(cfd, epfd, &client, alen);
          if (!c) {
            close(cfd);
            continue;
          }

          /* link */
          c->next = conn_head;
          conn_head = c;

          /* Add client fd to epoll and map */
          struct epoll_event cev;
          memset(&cev, 0, sizeof(cev));
          cev.events = EPOLLIN | EPOLLRDHUP | EPOLLHUP | EPOLLERR;
          cev.data.fd = cfd;
          if (epoll_ctl(epfd, EPOLL_CTL_ADD, cfd, &cev) < 0) {
            logger(LOG_ERROR, "epoll_ctl ADD client failed: %s",
                   strerror(errno));
            worker_close_and_free_connection(c);
          } else {
            fdmap_set(cfd, c);
          }
        }
        continue;
      }

      /* Check if this is an async HTTP fetch fd */
      http_fetch_ctx_t *fetch_ctx = http_fetch_find_by_fd(fd_ready);
      if (fetch_ctx) {
        /* Handle HTTP fetch event */
        (void)http_fetch_handle_event(fetch_ctx);
        /* Return value: 0 = more data expected, 1 = completed, -1 = error
         * In all cases, the context handles cleanup internally */
        continue;
      }

      /* Non-listener: lookup by fd map */
      connection_t *c = fdmap_get(fd_ready);
      if (c) {
        if (fd_ready == c->fd) {
          /* Client socket events */

          /* First, handle EPOLLERR for MSG_ZEROCOPY completions before checking
           * for real errors */
          if (events[e].events & EPOLLERR) {
            /* EPOLLERR can indicate either:
             * 1. MSG_ZEROCOPY completion notification (normal operation)
             * 2. Actual socket error
             * We need to check MSG_ERRQUEUE first to distinguish between them.
             */
            int had_zerocopy_completions = 0;
            if (c->zerocopy_enabled) {
              int completions =
                  zerocopy_handle_completions(c->fd, &c->zc_queue);
              if (completions > 0) {
                had_zerocopy_completions = 1;
                if (c->state == CONN_CLOSING && !c->zc_queue.head &&
                    !c->zc_queue.pending_head) {
                  worker_close_and_free_connection(c);
                  continue; /* Skip further processing for this connection */
                }
              } else if (completions < 0) {
                /* Error reading MSG_ERRQUEUE - treat as real socket error */
                logger(LOG_DEBUG, "Failed to read MSG_ERRQUEUE: %s",
                       strerror(errno));
                worker_close_and_free_connection(c);
                continue;
              }
              /* completions == 0: no zerocopy completions, check for real error
               * below */
            }

            /* If EPOLLERR is set but we didn't get zerocopy completions,
             * check if it's a real socket error by trying to get SO_ERROR */
            if (!had_zerocopy_completions) {
              int socket_error = 0;
              socklen_t errlen = sizeof(socket_error);
              if (getsockopt(c->fd, SOL_SOCKET, SO_ERROR, &socket_error,
                             &errlen) == 0 &&
                  socket_error != 0) {
                /* Real socket error */
                logger(LOG_DEBUG, "Client connection error: %s",
                       strerror(socket_error));
                worker_close_and_free_connection(c);
                continue; /* Skip further processing for this connection */
              }
              /* Otherwise, EPOLLERR might be spurious or already handled by
               * zerocopy */
            }
          }

          /* Handle disconnect events */
          if (events[e].events & (EPOLLHUP | EPOLLRDHUP)) {
            logger(LOG_DEBUG, "Client disconnected");
            worker_close_and_free_connection(c);
            continue; /* Skip further processing for this connection */
          }

          /* Handle EPOLLIN and EPOLLOUT independently (not mutually exclusive)
           */
          if (events[e].events & EPOLLIN) {
            /* For streaming connections, client socket is monitored for
             * disconnect detection */
            if (c->streaming) {
              /* Client sent data or disconnected during streaming */
              char discard_buffer[1024];
              int bytes =
                  recv(c->fd, discard_buffer, sizeof(discard_buffer), 0);
              if (bytes <= 0 && errno != EAGAIN) {
                /* Client disconnected (bytes == 0) or error (bytes < 0) */
                if (bytes == 0)
                  logger(LOG_DEBUG,
                         "Client disconnected gracefully during streaming");
                else
                  logger(LOG_DEBUG, "Client socket error during streaming: %s",
                         strerror(errno));
                worker_close_and_free_connection(c);
                continue; /* Skip further processing for this connection */
              } else {
                /* Client sent unexpected data (e.g., additional HTTP request) -
                 * discard */
                logger(LOG_DEBUG,
                       "Client sent %d bytes during streaming (discarded)",
                       bytes);
              }
            } else {
              /* Normal HTTP request handling */
              connection_handle_read(c);
              if (c->state == CONN_CLOSING && !c->zc_queue.head) {
                worker_close_and_free_connection(c);
                continue; /* Skip further processing for this connection */
              }
            }
          }

          if (events[e].events & EPOLLOUT) {
            connection_write_status_t status = connection_handle_write(c);
            if (status == CONNECTION_WRITE_CLOSED) {
              worker_close_and_free_connection(c);
              continue;
            }
          }
        } else {
          int res = stream_handle_fd_event(&c->stream, fd_ready,
                                           events[e].events, now);
          if (res < 0) {
            /* Send 503 if headers not sent yet (no data ever arrived) */
            if (!c->headers_sent) {
              http_send_503(c);
              /* http_send_503 sets CONN_CLOSING, don't force immediate close */
            } else {
              worker_close_and_free_connection(c);
            }
            continue; /* Skip further processing for this connection */
          }
        }
      }
    }

    /* 2) Periodic tick: update streams and SSE heartbeats */
    if (now - last_tick >= timeout_ms) {
      last_tick = now;
      connection_t *c = conn_head;
      while (c) {
        connection_t *next =
            c->next; /* Save next pointer before potential cleanup */
        if (c->streaming) {
          if (stream_tick(&c->stream, now) < 0) {
            /* Send 503 if headers not sent yet (no data ever arrived) */
            if (!c->headers_sent) {
              http_send_503(c);
              /* http_send_503 sets CONN_CLOSING, don't force immediate close */
            } else {
              /* Stream timeout or error - close connection */
              worker_close_and_free_connection(c);
              c = next;
              continue;
            }
          }
        } else if (c->state == CONN_SSE) {
          status_handle_sse_heartbeat(c, now);
        }
        c = next;
      }

      /* Check if M3U/EPG needs to be reloaded (all workers perform this with
       * staggered timing) This handles both external M3U and inline M3U's EPG
       * updates */
      m3u_cache_t *m3u_cache = m3u_get_cache();
      epg_cache_t *epg_cache = epg_get_cache();

      if ((config.external_m3u_url || epg_cache->url) &&
          config.external_m3u_update_interval >= 0) {
        int64_t interval_ms =
            (int64_t)config.external_m3u_update_interval * 1000;
        int64_t last_update = config.last_external_m3u_update_time;
        int64_t worker_offset_ms = (int64_t)worker_id * 1000;

        /* Check if retry is scheduled for M3U */
        if (config.external_m3u_url && m3u_cache->next_retry_time > 0 &&
            now >= m3u_cache->next_retry_time) {
          logger(LOG_INFO, "M3U retry scheduled, attempting fetch (retry %d)",
                 m3u_cache->retry_count);
          m3u_cache->next_retry_time =
              0; /* Clear retry time before attempting */
          m3u_reload_external_async(epfd);
        }
        /* Check if retry is scheduled for EPG */
        else if (epg_cache->url && epg_cache->next_retry_time > 0 &&
                 now >= epg_cache->next_retry_time) {
          logger(LOG_INFO, "EPG retry scheduled, attempting fetch (retry %d)",
                 epg_cache->retry_count);
          epg_cache->next_retry_time =
              0; /* Clear retry time before attempting */
          epg_fetch_async(epfd);
        }
        /* Handle first-time load: if last_update is 0, load immediately with
           staggered timing */
        else if (last_update == 0) {
          /* Calculate uptime to compare against staggered offset */
          int64_t uptime_ms =
              get_realtime_ms() - status_shared->server_start_time;

          /* Each worker loads after a staggered delay from startup (0s, 1s, 2s,
           * ...) */
          if (uptime_ms >= worker_offset_ms) {
            /* Update timestamp immediately to prevent reentry during async
             * operation */
            config.last_external_m3u_update_time = now;

            if (config.external_m3u_url) {
              /* External M3U: reload it (will also fetch EPG if found in M3U)
               */
              logger(LOG_INFO, "Initial external M3U load for worker %d",
                     worker_id);
              m3u_reload_external_async(epfd);
            } else if (epg_cache->url) {
              /* Inline M3U with EPG: only fetch EPG */
              logger(LOG_INFO,
                     "Initial EPG load (from inline M3U) for worker %d",
                     worker_id);
              epg_fetch_async(epfd);
            }
          }
        }
        /* Handle periodic updates (only if interval > 0) */
        else if (interval_ms > 0) {
          int64_t time_since_last_update = now - last_update;

          /* Check if it's time for this worker to update */
          if (time_since_last_update >= (interval_ms + worker_offset_ms)) {
            /* Also check if this update cycle hasn't been done yet by checking
             * if enough time has passed since the interval started */
            int64_t current_cycle = time_since_last_update / interval_ms;
            int64_t expected_update_time =
                current_cycle * interval_ms + worker_offset_ms;

            if (time_since_last_update >= expected_update_time) {
              /* Update timestamp immediately to prevent reentry during async
               * operation */
              config.last_external_m3u_update_time = now;

              if (config.external_m3u_url) {
                /* External M3U: reload it (will also fetch EPG if found in M3U)
                 */
                logger(LOG_DEBUG,
                       "External M3U update interval reached for worker %d, "
                       "reloading...",
                       worker_id);
                /* Reset retry state for new update cycle */
                m3u_cache->retry_count = 0;
                m3u_cache->next_retry_time = 0;
                m3u_reload_external_async(epfd);
              } else if (epg_cache->url) {
                /* Inline M3U with EPG: only fetch EPG */
                logger(
                    LOG_DEBUG,
                    "EPG update interval reached for worker %d, reloading...",
                    worker_id);
                /* Reset retry state for new update cycle */
                epg_cache->retry_count = 0;
                epg_cache->next_retry_time = 0;
                epg_fetch_async(epfd);
              }
              /* Note: We always update timestamp regardless of success/failure
               * to avoid hammering the server with repeated requests */
            }
          }
        }
      }
    }
  }

  /* Cleanup: close all active connections */
  while (conn_head)
    worker_close_and_free_connection(conn_head);

  /* Cleanup fd map */
  fdmap_cleanup();

  /* Close notification pipe read end */
  if (notif_fd >= 0) {
    close(notif_fd);
  }

  /* Close epoll and listeners */
  close(epfd);
  for (i = 0; i < num_sockets; i++)
    close(listen_sockets[i]);

  return 0;
}
