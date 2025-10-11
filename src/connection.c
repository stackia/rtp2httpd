#ifdef HAVE_CONFIG_H
#include "config.h"
#endif

#include "connection.h"
#include "worker.h"
#include "rtp2httpd.h"
#include "http.h"
#include "service.h"
#include "snapshot.h"
#include "status.h"
#include "zerocopy.h"
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/tcp.h>
#include <sys/epoll.h>
#include <sys/socket.h>

#ifndef SO_ZEROCOPY
#define SO_ZEROCOPY 60
#endif

int connection_set_nonblocking(int fd)
{
  int flags = fcntl(fd, F_GETFL, 0);
  if (flags < 0)
    return -1;
  return fcntl(fd, F_SETFL, flags | O_NONBLOCK);
}

int connection_set_tcp_nodelay(int fd)
{
  int on = 1;
  return setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &on, sizeof(on));
}

void connection_epoll_update_events(int epfd, int fd, uint32_t events)
{
  struct epoll_event ev;
  memset(&ev, 0, sizeof(ev));
  ev.events = events;
  ev.data.fd = fd;
  epoll_ctl(epfd, EPOLL_CTL_MOD, fd, &ev);
}

connection_t *connection_create(int fd, int epfd,
                                struct sockaddr_storage *client_addr, socklen_t addr_len)
{
  connection_t *c = calloc(1, sizeof(*c));
  if (!c)
    return NULL;
  c->fd = fd;
  c->epfd = epfd;
  c->state = CONN_READ_REQ_LINE;
  c->service = NULL;
  c->service_owned = 0;
  c->streaming = 0;
  c->sse_active = 0;
  c->status_index = -1; /* Not registered yet */
  c->next = NULL;

  if (client_addr && addr_len > 0)
  {
    memcpy(&c->client_addr, client_addr, addr_len);
    c->client_addr_len = addr_len;
  }
  else
  {
    c->client_addr_len = 0;
  }

  /* Initialize zero-copy queue */
  zerocopy_queue_init(&c->zc_queue);
  c->zerocopy_enabled = 0;

  /* Enable SO_ZEROCOPY on socket if supported */
  if (zerocopy_state.features & ZEROCOPY_MSG_ZEROCOPY)
  {
    int one = 1;
    if (setsockopt(fd, SOL_SOCKET, SO_ZEROCOPY, &one, sizeof(one)) == 0)
    {
      c->zerocopy_enabled = 1;
    }
  }

  /* Initialize HTTP request parser */
  http_request_init(&c->http_req);
  return c;
}

void connection_free(connection_t *c)
{
  if (!c)
    return;

  /* Clean up stream context if still marked as streaming
   * Note: worker_close_and_free_connection should have already called stream_context_cleanup
   * for streaming connections, so this is a safety fallback */
  if (c->streaming)
  {
    logger(LOG_WARN, "connection_free: streaming flag still set, cleaning up stream");
    stream_context_cleanup(&c->stream);
  }

  /* Cleanup zero-copy queue - this releases all buffer references */
  zerocopy_queue_cleanup(&c->zc_queue);

  /* Try to shrink buffer pool after connection cleanup
   * This is an ideal time to reclaim memory as buffers are likely freed
   * The function is lightweight and only acts if conditions are met */
  buffer_pool_try_shrink();

  /* Free service if owned */
  if (c->service_owned && c->service)
  {
    service_free(c->service);
    c->service = NULL;
  }

  /* Unregister from status (only if registered as streaming client) */
  if (c->status_index >= 0)
  {
    status_unregister_client(c->status_index);
  }

  /* Close socket */
  if (c->fd >= 0)
  {
    close(c->fd);
    c->fd = -1;
  }

  free(c);
}

/**
 * Queue data to connection output buffer
 */
int connection_queue_output(connection_t *c, const uint8_t *data, size_t len)
{
  if (!c || !data || len == 0)
    return 0;

  size_t remaining = len;
  const uint8_t *src = data;

  /* Allocate multiple buffers until we satisfy the entire length */
  while (remaining > 0)
  {
    /* Allocate a buffer from the pool */
    buffer_ref_t *buf_ref = buffer_pool_alloc(BUFFER_POOL_BUFFER_SIZE);
    if (!buf_ref)
    {
      /* Pool exhausted */
      logger(LOG_WARN, "connection_queue_output: Buffer pool exhausted, cannot queue %zu bytes", remaining);
      return -1;
    }

    /* Calculate how much data to copy into this buffer */
    size_t chunk_size = remaining;
    if (chunk_size > BUFFER_POOL_BUFFER_SIZE)
      chunk_size = BUFFER_POOL_BUFFER_SIZE;

    /* Copy data into the buffer */
    memcpy(buf_ref->data, src, chunk_size);

    /* Queue this buffer for zero-copy send */
    if (connection_queue_zerocopy(c, buf_ref->data, chunk_size, buf_ref, 0) < 0)
    {
      /* Queue full - release the buffer and fail */
      buffer_ref_put(buf_ref);
      logger(LOG_ERROR, "connection_queue_output: Zero-copy queue full, cannot queue %zu bytes", remaining);
      return -1;
    }

    /* Release our reference - the queue now owns it */
    buffer_ref_put(buf_ref);

    /* Move to next chunk */
    src += chunk_size;
    remaining -= chunk_size;
  }

  return 0;
}

int connection_queue_output_and_flush(connection_t *c, const uint8_t *data, size_t len)
{
  int result = connection_queue_output(c, data, len);
  if (result < 0)
    return result;
  connection_epoll_update_events(c->epfd, c->fd, EPOLLIN | EPOLLOUT | EPOLLRDHUP | EPOLLHUP | EPOLLERR);
  return 0;
}

void connection_handle_write(connection_t *c)
{
  if (!c)
    return;

  /* Send from zero-copy queue */
  if (c->zc_queue.head)
  {
    size_t bytes_sent = 0;
    int ret = zerocopy_send(c->fd, &c->zc_queue, &bytes_sent);

    if (ret < 0 && ret != -2)
    {
      /* Error (not EAGAIN/ENOBUFS) */
      c->state = CONN_CLOSING;
      return;
    }

    /* If queue still has data, keep EPOLLOUT enabled */
    if (c->zc_queue.head)
      return;
  }

  /* If queue is empty, stop EPOLLOUT */
  if (!c->zc_queue.head)
  {
    connection_epoll_update_events(c->epfd, c->fd, EPOLLIN | EPOLLRDHUP | EPOLLHUP | EPOLLERR);
  }
}

void connection_handle_read(connection_t *c)
{
  if (!c)
    return;

  /* Read into input buffer */
  if (c->in_len < INBUF_SIZE)
  {
    int r = read(c->fd, c->inbuf + c->in_len, INBUF_SIZE - c->in_len);
    if (r > 0)
    {
      c->in_len += r;
    }
    else if (r == 0)
    {
      c->state = CONN_CLOSING;
      return;
    }
    else if (errno == EAGAIN)
    {
      return;
    }
    else
    {
      c->state = CONN_CLOSING;
      return;
    }
  }

  /* Parse HTTP request using http.c parser */
  if (c->state == CONN_READ_REQ_LINE || c->state == CONN_READ_HEADERS)
  {
    int parse_result = http_parse_request(c->inbuf, &c->in_len, &c->http_req);
    if (parse_result == 1)
    {
      /* Request complete, route it */
      c->state = CONN_ROUTE;
      connection_route_and_start(c);
      return;
    }
    else if (parse_result < 0)
    {
      /* Parse error */
      c->state = CONN_CLOSING;
      return;
    }
    /* else parse_result == 0: need more data, continue reading */
  }
}

int connection_route_and_start(connection_t *c)
{
  /* Ensure URL begins with '/' */
  const char *url = c->http_req.url;

  logger(LOG_INFO, "New client requested URL: %s", url);

  if (url[0] != '/')
  {
    http_send_400(c);
    return 0;
  }

  /* Check hostname if configured */
  if (config.hostname != NULL && config.hostname[0] != '\0')
  {
    /* If Host header is missing, reject the request */
    if (c->http_req.hostname[0] == '\0')
    {
      logger(LOG_WARN, "Client request rejected: missing Host header (expected: %s)", config.hostname);
      http_send_400(c);
      return 0;
    }

    /* Check if Host header matches configured hostname (case-insensitive) */
    /* Also handle Host header with port (e.g., "example.com:8080") */
    char host_without_port[256];
    const char *colon = strchr(c->http_req.hostname, ':');
    if (colon)
    {
      /* Extract hostname without port */
      size_t host_len = (size_t)(colon - c->http_req.hostname);
      if (host_len >= sizeof(host_without_port))
        host_len = sizeof(host_without_port) - 1;
      strncpy(host_without_port, c->http_req.hostname, host_len);
      host_without_port[host_len] = '\0';
    }
    else
    {
      strncpy(host_without_port, c->http_req.hostname, sizeof(host_without_port) - 1);
      host_without_port[sizeof(host_without_port) - 1] = '\0';
    }

    if (strcasecmp(host_without_port, config.hostname) != 0)
    {
      logger(LOG_WARN, "Client request rejected: Host header mismatch (got: %s, expected: %s)",
             host_without_port, config.hostname);
      http_send_400(c);
      return 0;
    }

    logger(LOG_DEBUG, "Host header validated: %s", host_without_port);
  }

  /* Extract service_path and query */
  const char *service_path = url + 1; /* skip leading '/' */
  const char *query_start = strchr(service_path, '?');
  size_t path_len = query_start ? (size_t)(query_start - service_path) : strlen(service_path);
  if (path_len > 0 && service_path[path_len - 1] == '/')
    path_len--;

  /* Route status endpoints */
  if (path_len == 0 || (strncmp(service_path, "status", 6) == 0 && path_len == 6))
  {
    handle_status_page(c);
    c->state = CONN_CLOSING;
    return 0;
  }
  if (strncmp(service_path, "status/sse", 10) == 0 && path_len == 10)
  {
    /* Delegate SSE initialization to status module */
    return status_handle_sse_init(c);
  }
  if (strncmp(service_path, "api/disconnect", 14) == 0 && path_len == 14)
  {
    handle_disconnect_client(c);
    c->state = CONN_CLOSING;
    return 0;
  }
  if (strncmp(service_path, "api/loglevel", 12) == 0 && path_len == 12)
  {
    handle_set_log_level(c);
    c->state = CONN_CLOSING;
    return 0;
  }

  /* Find configured service */
  service_t *service = NULL;
  for (service = services; service; service = service->next)
  {
    if (strncmp(service_path, service->url, path_len) == 0 && strlen(service->url) == path_len)
      break;
  }

  /* Dynamic parsing for RTSP and UDPxy if needed */
  int owned = 0;
  if (service == NULL)
  {
    if (config.udpxy)
    {
      service = service_create_from_udpxy_url(c->http_req.url);
      if (service)
        owned = 1;
    }
  }
  else if (service->service_type == SERVICE_RTSP)
  {
    /* Found configured RTSP service - try to merge query params if present */
    service_t *merged_service = service_create_from_rtsp_with_query_merge(service, c->http_req.url);
    if (merged_service)
    {
      service = merged_service;
      owned = 1;
    }
    /* If merge returns NULL (no query params), use configured service as-is (owned = 0) */
  }

  if (!service)
  {
    http_send_404(c);
    return 0;
  }

  if (owned && c->http_req.user_agent[0])
  {
    service->user_agent = strdup(c->http_req.user_agent);
  }

  /* Capacity check */
  if (status_shared && status_shared->total_clients >= config.maxclients)
  {
    http_send_503(c);
    if (owned)
      service_free(service);
    return 0;
  }

  /* Check if this is a snapshot request (Accept: image/jpeg or snapshot=1 query param) */
  int is_snapshot_request = 0;
  if (c->http_req.accept[0] != '\0')
  {
    /* Check if Accept header contains "image/jpeg" */
    if (strstr(c->http_req.accept, "image/jpeg") != NULL)
    {
      is_snapshot_request = 1;
      logger(LOG_INFO, "Snapshot request detected via Accept header for URL: %s", c->http_req.url);
    }
  }

  /* Also check for snapshot=1 query parameter */
  if (!is_snapshot_request && query_start != NULL)
  {
    char snapshot_value[16];
    if (http_parse_query_param(query_start + 1, "snapshot", snapshot_value, sizeof(snapshot_value)) == 0)
    {
      if (strcmp(snapshot_value, "1") == 0)
      {
        is_snapshot_request = 1;
        logger(LOG_INFO, "Snapshot request detected via query parameter for URL: %s", c->http_req.url);
      }
    }
  }

  /* Register streaming client in status tracking with service URL (skip for snapshots) */
  if (!is_snapshot_request && c->client_addr_len > 0)
  {
    c->status_index = status_register_client(&c->client_addr, c->client_addr_len, c->http_req.url);
    if (c->status_index < 0)
    {
      logger(LOG_ERROR, "Failed to register streaming client in status tracking");
    }
  }
  else
  {
    c->status_index = -1;
  }

  /* Send success headers (skip for snapshots - will send after JPEG conversion) */
  if (!is_snapshot_request)
    send_http_headers(c, STATUS_200, CONTENT_MP2T, NULL);

  /* Initialize stream in unified epoll (works for both streaming and snapshot) */
  if (stream_context_init_for_worker(&c->stream, c, service, c->epfd, c->status_index, is_snapshot_request) == 0)
  {
    c->streaming = 1;
    c->service = service;
    c->service_owned = owned;
    c->state = CONN_STREAMING;
    return 0;
  }
  else
  {
    if (owned)
      service_free(service);
    c->state = CONN_CLOSING;
    return -1;
  }
}

int connection_queue_zerocopy(connection_t *c, void *data, size_t len, buffer_ref_t *buf_ref, size_t offset)
{
  if (!c || !data || len == 0)
    return 0;

  /* Add to zero-copy queue with offset information */
  int ret = zerocopy_queue_add(&c->zc_queue, data, len, buf_ref, offset);
  if (ret < 0)
    return -1; /* Queue full */

  /* Batching optimization: Only enable EPOLLOUT when flush threshold is reached
   * This accumulates small RTP packets (200-1400 bytes) before sending:
   * - Flush when accumulated >= 10KB (ZEROCOPY_BATCH_BYTES)
   * - Flush when timeout >= 5ms (ZEROCOPY_BATCH_TIMEOUT_US)
   * Benefits:
   * - Reduces sendmsg() syscall overhead (fewer calls)
   * - Reduces MSG_ZEROCOPY optmem consumption (fewer operations)
   * - Better batching with iovec (up to 64 packets per sendmsg)
   * - Lower latency impact (5ms is acceptable for streaming)
   */
  if (zerocopy_should_flush(&c->zc_queue))
  {
    connection_epoll_update_events(c->epfd, c->fd, EPOLLIN | EPOLLOUT | EPOLLRDHUP | EPOLLHUP | EPOLLERR);
  }

  return 0;
}

int connection_queue_file(connection_t *c, int file_fd, off_t file_offset, size_t file_size)
{
  if (!c || file_fd < 0 || file_size == 0)
    return -1;

  /* Add file to zero-copy queue */
  int ret = zerocopy_queue_add_file(&c->zc_queue, file_fd, file_offset, file_size);
  if (ret < 0)
    return -1;

  /* Always flush immediately for file sends (no batching) */
  connection_epoll_update_events(c->epfd, c->fd, EPOLLIN | EPOLLOUT | EPOLLRDHUP | EPOLLHUP | EPOLLERR);

  return 0;
}
