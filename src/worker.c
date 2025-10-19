#ifdef HAVE_CONFIG_H
#include "config.h"
#endif

#include "worker.h"
#include "connection.h"
#include "rtp2httpd.h"
#include "status.h"
#include "stream.h"
#include "rtsp.h"
#include "zerocopy.h"
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>
#include <signal.h>
#include <sys/epoll.h>
#include <sys/socket.h>
#include <netdb.h>

/* fd -> connection map */
static fdmap_entry_t fd_map[FD_MAP_SIZE];

/* Connection list head */
static connection_t *conn_head = NULL;

/* Round-robin write queue */
static connection_t *write_queue_head = NULL;
static connection_t *write_queue_tail = NULL;

/* Stop flag for graceful shutdown */
static volatile sig_atomic_t stop_flag = 0;

#define WORKER_MAX_WRITE_BATCH 32

static inline unsigned fd_hash(int fd) { return (unsigned)fd & (FD_MAP_SIZE - 1); }

void fdmap_init(void)
{
  memset(fd_map, 0, sizeof(fd_map));
}

void fdmap_set(int fd, connection_t *c)
{
  if (fd < 0)
    return;
  unsigned idx = fd_hash(fd);
  for (unsigned n = 0; n < FD_MAP_SIZE; n++)
  {
    unsigned i = (idx + n) & (FD_MAP_SIZE - 1);
    if (fd_map[i].conn == NULL || fd_map[i].fd == fd)
    {
      fd_map[i].fd = fd;
      fd_map[i].conn = c;
      return;
    }
  }
}

connection_t *fdmap_get(int fd)
{
  if (fd < 0)
    return NULL;
  unsigned idx = fd_hash(fd);
  for (unsigned n = 0; n < FD_MAP_SIZE; n++)
  {
    unsigned i = (idx + n) & (FD_MAP_SIZE - 1);
    if (fd_map[i].conn == NULL)
      return NULL;
    if (fd_map[i].fd == fd)
      return fd_map[i].conn;
  }
  return NULL;
}

void fdmap_del(int fd)
{
  if (fd < 0)
    return;
  unsigned idx = fd_hash(fd);
  for (unsigned n = 0; n < FD_MAP_SIZE; n++)
  {
    unsigned i = (idx + n) & (FD_MAP_SIZE - 1);
    if (fd_map[i].conn == NULL)
      return;
    if (fd_map[i].fd == fd)
    {
      fd_map[i].conn = NULL;
      fd_map[i].fd = -1;
      return;
    }
  }
}

void worker_cleanup_socket_from_epoll(int epoll_fd, int sock)
{
  if (sock < 0)
  {
    return;
  }

  /* Remove from fdmap first */
  fdmap_del(sock);

  /* Remove from epoll */
  if (epoll_fd >= 0)
  {
    if (epoll_ctl(epoll_fd, EPOLL_CTL_DEL, sock, NULL) < 0)
    {
      /* Log but continue - socket might not be in epoll */
      logger(LOG_DEBUG, "Worker: epoll_ctl DEL failed for fd %d: %s (continuing)", sock, strerror(errno));
    }
  }

  /* Close socket */
  close(sock);
}

connection_t *worker_get_conn_head(void)
{
  return conn_head;
}

void worker_set_conn_head(connection_t *head)
{
  conn_head = head;
}

static void worker_enqueue_writable(connection_t *c)
{
  if (!c || c->write_queue_pending)
    return;

  c->write_queue_pending = 1;
  c->write_queue_next = NULL;

  if (write_queue_tail)
  {
    write_queue_tail->write_queue_next = c;
  }
  else
  {
    write_queue_head = c;
  }

  write_queue_tail = c;
}

static void worker_remove_from_write_queue(connection_t *c)
{
  if (!c || !c->write_queue_pending)
    return;

  connection_t *prev = NULL;
  connection_t *cur = write_queue_head;

  while (cur)
  {
    if (cur == c)
    {
      if (prev)
        prev->write_queue_next = cur->write_queue_next;
      else
        write_queue_head = cur->write_queue_next;

      if (write_queue_tail == cur)
        write_queue_tail = prev;

      c->write_queue_next = NULL;
      c->write_queue_pending = 0;
      return;
    }

    prev = cur;
    cur = cur->write_queue_next;
  }

  c->write_queue_pending = 0;
  c->write_queue_next = NULL;
}

static void worker_drain_write_queue(void)
{
  int processed = 0;

  while (write_queue_head && processed < WORKER_MAX_WRITE_BATCH)
  {
    connection_t *c = write_queue_head;
    write_queue_head = c->write_queue_next;
    if (!write_queue_head)
      write_queue_tail = NULL;

    c->write_queue_next = NULL;
    c->write_queue_pending = 0;

    connection_write_status_t status = connection_handle_write(c);

    if (status == CONNECTION_WRITE_PENDING)
    {
      worker_enqueue_writable(c);
    }
    else if (status == CONNECTION_WRITE_CLOSED)
    {
      worker_close_and_free_connection(c);
    }

    processed++;
  }
}

static void remove_connection_from_list(connection_t *c)
{
  if (!c)
    return;
  if (conn_head == c)
  {
    conn_head = c->next;
    return;
  }
  for (connection_t *p = conn_head; p; p = p->next)
  {
    if (p->next == c)
    {
      p->next = c->next;
      return;
    }
  }
}

void worker_close_and_free_connection(connection_t *c)
{
  if (!c)
    return;

  worker_remove_from_write_queue(c);

  /* CRITICAL: For streaming connections, initiate cleanup first to check if async TEARDOWN will be started
   * This prevents use-after-free when TEARDOWN response arrives after connection is freed. */
  if (c->streaming)
  {
    /* Initiate stream cleanup - this may start async RTSP TEARDOWN */
    int async_cleanup = stream_context_cleanup(&c->stream);
    c->streaming = 0; /* Mark as no longer streaming to prevent double cleanup */

    if (async_cleanup)
    {
      /* Async RTSP TEARDOWN initiated - defer connection cleanup */
      logger(LOG_DEBUG, "Worker: Async RTSP TEARDOWN initiated, deferring connection cleanup");

      /* Close and cleanup client socket immediately */
      if (c->fd >= 0)
      {
        fdmap_del(c->fd);
        if (c->epfd >= 0)
        {
          epoll_ctl(c->epfd, EPOLL_CTL_DEL, c->fd, NULL);
        }
        close(c->fd);
        c->fd = -1;
      }

      /* Mark connection as closing but keep it in list */
      c->state = CONN_CLOSING;

      /* Keep connection alive for RTSP TEARDOWN completion */
      /* RTSP TEARDOWN completion will trigger final cleanup via stream event handler returning -1 */
      logger(LOG_DEBUG, "Worker: Deferred cleanup - waiting for RTSP TEARDOWN completion");
      return;
    }
  }

  /* Normal cleanup path: remove from fd map */
  fdmap_del(c->fd);

  /* Remove from epoll - CRITICAL: Must remove all sockets before close() to prevent fd reuse issues */
  if (c->epfd >= 0)
  {
    /* Remove client socket */
    if (c->fd >= 0)
    {
      epoll_ctl(c->epfd, EPOLL_CTL_DEL, c->fd, NULL);
    }
  }

  /* Remove from list */
  remove_connection_from_list(c);

  /* Free connection */
  connection_free(c);
}

static void term_handler(int signum)
{
  (void)signum;
  stop_flag = 1;
}

int worker_run_event_loop(int *listen_sockets, int num_sockets, int notif_fd)
{
  int i;
  struct sockaddr_storage client;

  /* Initialize fd map */
  fdmap_init();

  /* Build epoll set for listening sockets */
  int epfd = epoll_create1(EPOLL_CLOEXEC);
  if (epfd < 0)
  {
    logger(LOG_FATAL, "epoll_create1 failed: %s", strerror(errno));
    return -1;
  }

  struct epoll_event ev, events[1024];
  for (i = 0; i < num_sockets; i++)
  {
    connection_set_nonblocking(listen_sockets[i]);
    memset(&ev, 0, sizeof(ev));
    ev.events = EPOLLIN;
    ev.data.fd = listen_sockets[i];
    if (epoll_ctl(epfd, EPOLL_CTL_ADD, listen_sockets[i], &ev) < 0)
    {
      logger(LOG_FATAL, "epoll_ctl ADD failed: %s", strerror(errno));
      close(epfd);
      return -1;
    }
  }

  if (notif_fd >= 0)
  {
    memset(&ev, 0, sizeof(ev));
    ev.events = EPOLLIN;
    ev.data.fd = notif_fd;
    if (epoll_ctl(epfd, EPOLL_CTL_ADD, notif_fd, &ev) < 0)
    {
      logger(LOG_ERROR, "epoll_ctl ADD notif_fd failed: %s", strerror(errno));
      notif_fd = -1;
    }
  }

  /* Register signal handlers */
  signal(SIGTERM, &term_handler);
  signal(SIGINT, &term_handler);

  /* Unified event loop: accept + clients + stream fds */
  int64_t last_tick = get_time_ms();
  int64_t last_flush_check = get_time_ms();

  while (!stop_flag)
  {
    worker_drain_write_queue();

    /* Use shorter timeout to check for batched send timeouts
     * 5ms matches ZEROCOPY_BATCH_TIMEOUT_US for timely flushing
     */
    int timeout_ms = 100;
    int n = epoll_wait(epfd, events, (int)(sizeof(events) / sizeof(events[0])), timeout_ms);
    if (n < 0)
    {
      if (errno == EINTR)
        continue;
      logger(LOG_FATAL, "epoll_wait failed: %s", strerror(errno));
      break;
    }

    int64_t now = get_time_ms();

    /* 1) Handle all ready events */
    for (int e = 0; e < n; e++)
    {
      int fd_ready = events[e].data.fd;
      int is_listener = 0;
      for (i = 0; i < num_sockets; i++)
        if (fd_ready == listen_sockets[i])
        {
          is_listener = 1;
          break;
        }

      if (notif_fd >= 0 && fd_ready == notif_fd)
      {
        /* Read event notifications from pipe */
        uint8_t event_buf[256];
        ssize_t bytes_read;
        int has_sse_update = 0;
        int has_disconnect_request = 0;

        while ((bytes_read = read(notif_fd, event_buf, sizeof(event_buf))) > 0)
        {
          /* Check event types in the buffer */
          for (ssize_t j = 0; j < bytes_read; j++)
          {
            if (event_buf[j] == STATUS_EVENT_SSE_UPDATE)
              has_sse_update = 1;
            else if (event_buf[j] == STATUS_EVENT_DISCONNECT_REQUEST)
              has_disconnect_request = 1;
          }
        }

        /* Handle SSE updates */
        if (has_sse_update)
        {
          status_handle_sse_notification(conn_head);
        }

        /* Handle disconnect requests */
        if (has_disconnect_request && status_shared)
        {
          connection_t *c = conn_head;
          while (c)
          {
            connection_t *next = c->next;

            /* Check if disconnect was requested for this client */
            if (c->status_index >= 0 &&
                status_shared->clients[c->status_index].active &&
                status_shared->clients[c->status_index].disconnect_requested)
            {
              logger(LOG_INFO, "Disconnect requested for client %s:%s via API",
                     status_shared->clients[c->status_index].client_addr,
                     status_shared->clients[c->status_index].client_port);
              worker_close_and_free_connection(c);
            }

            c = next;
          }
        }

        continue;
      }

      if (is_listener)
      {
        /* Accept as many as possible */
        for (;;)
        {
          socklen_t alen = sizeof(client);
          int cfd = accept(fd_ready, (struct sockaddr *)&client, &alen);
          if (cfd < 0)
          {
            if (errno == EAGAIN || errno == EINTR)
              break;
            logger(LOG_ERROR, "accept failed: %s", strerror(errno));
            break;
          }
          connection_set_nonblocking(cfd);
          connection_set_tcp_nodelay(cfd);

          /* Create connection
           * status_index will be assigned later by status_register_client() if this is a streaming client */
          connection_t *c = connection_create(cfd, epfd, &client, alen);
          if (!c)
          {
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
          if (epoll_ctl(epfd, EPOLL_CTL_ADD, cfd, &cev) < 0)
          {
            logger(LOG_ERROR, "epoll_ctl ADD client failed: %s", strerror(errno));
            worker_close_and_free_connection(c);
          }
          else
          {
            fdmap_set(cfd, c);
          }
        }
        continue;
      }

      /* Non-listener: lookup by fd map */
      connection_t *c = fdmap_get(fd_ready);
      if (c)
      {
        if (fd_ready == c->fd)
        {
          /* Client socket events */

          /* First, handle EPOLLERR for MSG_ZEROCOPY completions before checking for real errors */
          if (events[e].events & EPOLLERR)
          {
            /* EPOLLERR can indicate either:
             * 1. MSG_ZEROCOPY completion notification (normal operation)
             * 2. Actual socket error
             * We need to check MSG_ERRQUEUE first to distinguish between them.
             */
            int had_zerocopy_completions = 0;
            if (c->zerocopy_enabled)
            {
              int completions = zerocopy_handle_completions(c->fd, &c->zc_queue);
              if (completions > 0)
              {
                had_zerocopy_completions = 1;
                if (c->state == CONN_CLOSING && !c->zc_queue.head && !c->zc_queue.pending_head)
                {
                  worker_close_and_free_connection(c);
                  continue; /* Skip further processing for this connection */
                }
              }
              else if (completions < 0)
              {
                /* Error reading MSG_ERRQUEUE - treat as real socket error */
                logger(LOG_DEBUG, "Failed to read MSG_ERRQUEUE: %s", strerror(errno));
                worker_close_and_free_connection(c);
                continue;
              }
              /* completions == 0: no zerocopy completions, check for real error below */
            }

            /* If EPOLLERR is set but we didn't get zerocopy completions,
             * check if it's a real socket error by trying to get SO_ERROR */
            if (!had_zerocopy_completions)
            {
              int socket_error = 0;
              socklen_t errlen = sizeof(socket_error);
              if (getsockopt(c->fd, SOL_SOCKET, SO_ERROR, &socket_error, &errlen) == 0 && socket_error != 0)
              {
                /* Real socket error */
                logger(LOG_DEBUG, "Client connection error: %s", strerror(socket_error));
                worker_close_and_free_connection(c);
                continue; /* Skip further processing for this connection */
              }
              /* Otherwise, EPOLLERR might be spurious or already handled by zerocopy */
            }
          }

          /* Handle disconnect events */
          if (events[e].events & (EPOLLHUP | EPOLLRDHUP))
          {
            logger(LOG_DEBUG, "Client disconnected");
            worker_close_and_free_connection(c);
            continue; /* Skip further processing for this connection */
          }

          /* Handle EPOLLIN and EPOLLOUT independently (not mutually exclusive) */
          if (events[e].events & EPOLLIN)
          {
            /* For streaming connections, client socket is monitored for disconnect detection */
            if (c->streaming)
            {
              /* Client sent data or disconnected during streaming */
              char discard_buffer[1024];
              int bytes = recv(c->fd, discard_buffer, sizeof(discard_buffer), MSG_DONTWAIT);
              if (bytes <= 0 && errno != EAGAIN)
              {
                /* Client disconnected (bytes == 0) or error (bytes < 0) */
                if (bytes == 0)
                  logger(LOG_DEBUG, "Client disconnected gracefully during streaming");
                else
                  logger(LOG_DEBUG, "Client socket error during streaming: %s", strerror(errno));
                worker_close_and_free_connection(c);
                continue; /* Skip further processing for this connection */
              }
              else
              {
                /* Client sent unexpected data (e.g., additional HTTP request) - discard */
                logger(LOG_DEBUG, "Client sent %d bytes during streaming (discarded)", bytes);
              }
            }
            else
            {
              /* Normal HTTP request handling */
              connection_handle_read(c);
              if (!c->zc_queue.head && !c->streaming)
              {
                worker_close_and_free_connection(c);
                continue; /* Skip further processing for this connection */
              }
            }
          }

          if (events[e].events & EPOLLOUT)
          {
            worker_enqueue_writable(c);
          }
        }
        else
        {
          int res = stream_handle_fd_event(&c->stream, fd_ready, events[e].events, now);
          if (res < 0)
          {
            worker_close_and_free_connection(c);
            continue; /* Skip further processing for this connection */
          }
        }
      }
    }

    worker_drain_write_queue();

    /* 2) Check for batched send timeouts */
    if (now - last_flush_check >= ZEROCOPY_BATCH_TIMEOUT_US / 1000)
    {
      last_flush_check = now;
      connection_t *c = conn_head;
      while (c)
      {
        connection_t *next = c->next;
        /* Check if zerocopy queue has timed out data waiting to be sent */
        if (c->zerocopy_enabled && zerocopy_should_flush(&c->zc_queue))
        {
          /* Enable EPOLLOUT to trigger flush */
          connection_epoll_update_events(c->epfd, c->fd, EPOLLIN | EPOLLOUT | EPOLLRDHUP | EPOLLHUP | EPOLLERR);
        }
        c = next;
      }
    }

    /* 3) Periodic tick (~1s): update streams and SSE heartbeats */
    if (now - last_tick >= 1000) /* Check if at least 1 second has passed */
    {
      last_tick = now;
      connection_t *c = conn_head;
      while (c)
      {
        connection_t *next = c->next; /* Save next pointer before potential cleanup */
        if (c->streaming)
        {
          if (stream_tick(&c->stream, now) < 0)
          {
            /* Stream timeout or error - close connection */
            worker_close_and_free_connection(c);
            c = next;
            continue;
          }
        }
        status_handle_sse_heartbeat(c, now);
        c = next;
      }
    }
  }

  /* Cleanup: close all active connections */
  while (conn_head)
    worker_close_and_free_connection(conn_head);

  /* Close notification pipe read end */
  if (notif_fd >= 0)
  {
    close(notif_fd);
  }

  /* Close epoll and listeners */
  close(epfd);
  for (i = 0; i < num_sockets; i++)
    close(listen_sockets[i]);

  return 0;
}
