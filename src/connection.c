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
#include <stdio.h>
#include <string.h>
#include <strings.h>
#include <unistd.h>
#include <errno.h>
#include <ctype.h>
#include <stdint.h>
#include <fcntl.h>
#include <netinet/tcp.h>
#include <sys/epoll.h>
#include <sys/socket.h>
#include <netinet/in.h>

#define CONNECTION_TCP_USER_TIMEOUT_MS 10000
#define CONN_QUEUE_MIN_BUFFERS 64
#define CONN_QUEUE_BURST_FACTOR 3.0
#define CONN_QUEUE_BURST_FACTOR_CONGESTED 1.5
#define CONN_QUEUE_BURST_FACTOR_DRAIN 1.0
#define CONN_QUEUE_EWMA_ALPHA 0.2
#define CONN_QUEUE_SLOW_FACTOR 1.5
#define CONN_QUEUE_SLOW_EXIT_FACTOR 1.1
#define CONN_QUEUE_SLOW_DEBOUNCE_MS 3000
#define CONN_QUEUE_HIGH_UTIL_THRESHOLD 0.85
#define CONN_QUEUE_DRAIN_UTIL_THRESHOLD 0.95
#define CONN_QUEUE_SLOW_LIMIT_RATIO 0.9
#define CONN_QUEUE_SLOW_EXIT_LIMIT_RATIO 0.75
#define CONN_QUEUE_SLOW_CLAMP_FACTOR 0.8

static size_t connection_compute_limit_bytes(buffer_pool_t *pool, size_t fair_bytes, double burst_factor)
{
  size_t limit_bytes = (size_t)((double)fair_bytes * burst_factor);

  if (pool->max_buffers > 0)
  {
    size_t global_cap = pool->max_buffers * pool->buffer_size;
    size_t reserve = CONN_QUEUE_MIN_BUFFERS * pool->buffer_size;
    if (global_cap > reserve)
    {
      size_t hard_cap = global_cap - reserve;
      if (limit_bytes > hard_cap)
        limit_bytes = hard_cap;
    }
    else
    {
      if (limit_bytes > global_cap)
        limit_bytes = global_cap;
    }
  }

  if (limit_bytes < pool->buffer_size * 4)
    limit_bytes = pool->buffer_size * 4;

  return limit_bytes;
}

static size_t connection_calculate_queue_limit(connection_t *c, int64_t now_ms)
{
  buffer_pool_t *pool = c->buffer_pool;
  size_t active = zerocopy_active_streams();

  if (active == 0)
    active = 1;

  size_t total_buffers = pool->num_buffers ? pool->num_buffers : BUFFER_POOL_INITIAL_SIZE;

  size_t share_buffers = total_buffers / active;
  if (share_buffers < CONN_QUEUE_MIN_BUFFERS)
    share_buffers = CONN_QUEUE_MIN_BUFFERS;

  double utilization = 0.0;
  if (pool->max_buffers > 0)
  {
    size_t used_buffers = (pool->num_buffers > pool->num_free) ? (pool->num_buffers - pool->num_free) : 0;
    utilization = (double)used_buffers / (double)pool->max_buffers;
  }

  double burst_factor = CONN_QUEUE_BURST_FACTOR;
  if (pool->num_buffers >= pool->max_buffers || utilization >= CONN_QUEUE_HIGH_UTIL_THRESHOLD)
    burst_factor = CONN_QUEUE_BURST_FACTOR_CONGESTED;
  if (pool->num_free < pool->low_watermark / 2 || utilization >= CONN_QUEUE_DRAIN_UTIL_THRESHOLD)
    burst_factor = CONN_QUEUE_BURST_FACTOR_DRAIN;

  size_t fair_bytes = share_buffers * pool->buffer_size;
  double queue_mem_bytes = (double)c->zc_queue.num_queued * (double)pool->buffer_size;

  if (c->queue_avg_bytes <= 0.0)
    c->queue_avg_bytes = queue_mem_bytes;
  else
    c->queue_avg_bytes = (1.0 - CONN_QUEUE_EWMA_ALPHA) * c->queue_avg_bytes + CONN_QUEUE_EWMA_ALPHA * queue_mem_bytes;

  size_t bursted_bytes = connection_compute_limit_bytes(pool, fair_bytes, burst_factor);

  double slow_threshold = (double)fair_bytes * CONN_QUEUE_SLOW_FACTOR;

  double limit_based_threshold = (double)bursted_bytes * CONN_QUEUE_SLOW_LIMIT_RATIO;
  if (slow_threshold > limit_based_threshold)
    slow_threshold = limit_based_threshold;

  double slow_exit_threshold = (double)fair_bytes * CONN_QUEUE_SLOW_EXIT_FACTOR;
  double limit_exit_threshold = (double)bursted_bytes * CONN_QUEUE_SLOW_EXIT_LIMIT_RATIO;
  if (slow_exit_threshold > limit_exit_threshold)
    slow_exit_threshold = limit_exit_threshold;

  if (slow_exit_threshold >= slow_threshold)
    slow_exit_threshold = slow_threshold * CONN_QUEUE_SLOW_EXIT_LIMIT_RATIO;

  if (c->queue_avg_bytes > slow_threshold)
  {
    if (c->slow_candidate_since == 0)
      c->slow_candidate_since = now_ms;
    else if (!c->slow_active && now_ms >= c->slow_candidate_since &&
             now_ms - c->slow_candidate_since >= CONN_QUEUE_SLOW_DEBOUNCE_MS)
      c->slow_active = 1;
  }
  else
  {
    c->slow_candidate_since = 0;
  }

  if (c->slow_active && c->queue_avg_bytes < slow_exit_threshold)
  {
    c->slow_active = 0;
    c->slow_candidate_since = 0;
  }

  if (c->slow_active && burst_factor > CONN_QUEUE_SLOW_CLAMP_FACTOR)
    burst_factor = CONN_QUEUE_SLOW_CLAMP_FACTOR;

  size_t limit_bytes = connection_compute_limit_bytes(pool, fair_bytes, burst_factor);

  return limit_bytes;
}

static inline void connection_record_drop(connection_t *c, size_t len)
{
  c->dropped_packets++;
  c->dropped_bytes += len;
  c->backpressure_events++;
}

static void connection_report_queue_stats(connection_t *c)
{
  if (c->status_index < 0)
    return;

  size_t queue_buffers = c->zc_queue.num_queued;
  size_t queue_bytes = c->zc_queue.num_queued * c->buffer_pool->buffer_size;

  status_update_client_queue(c->status_index,
                             queue_bytes,
                             queue_buffers,
                             c->queue_limit_bytes,
                             c->queue_bytes_highwater,
                             c->queue_buffers_highwater,
                             c->dropped_packets,
                             c->dropped_bytes,
                             c->backpressure_events,
                             c->slow_active);
}

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
  c->buffer_pool = &zerocopy_state.control_pool;
  c->write_queue_next = NULL;
  c->write_queue_pending = 0;
  c->queue_limit_bytes = 0;
  c->queue_bytes_highwater = 0;
  c->queue_buffers_highwater = 0;
  c->dropped_packets = 0;
  c->dropped_bytes = 0;
  c->backpressure_events = 0;
  c->stream_registered = 0;
  c->queue_avg_bytes = 0.0;
  c->slow_active = 0;
  c->slow_candidate_since = 0;

  /* Enforce TCP user timeout so unacknowledged data fails quickly */
#ifdef TCP_USER_TIMEOUT
  int tcp_user_timeout = CONNECTION_TCP_USER_TIMEOUT_MS;
  if (setsockopt(fd, IPPROTO_TCP, TCP_USER_TIMEOUT, &tcp_user_timeout, sizeof(tcp_user_timeout)) < 0)
  {
    logger(LOG_DEBUG, "connection_create: Failed to set TCP_USER_TIMEOUT: %s", strerror(errno));
  }
#endif

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

  if (c->stream_registered)
  {
    zerocopy_unregister_stream_client();
    c->stream_registered = 0;
  }

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

  /* Calculate how many buffers we need */
  size_t buffer_size = c->buffer_pool->buffer_size;
  size_t num_buffers_needed = (len + buffer_size - 1) / buffer_size;

  /* Allocate all buffers at once */
  size_t num_allocated = 0;
  buffer_ref_t *bufs_head = buffer_pool_alloc_from(c->buffer_pool, num_buffers_needed, &num_allocated);

  if (!bufs_head || num_allocated == 0)
  {
    /* Pool exhausted */
    logger(LOG_WARN, "connection_queue_output: Buffer pool exhausted, cannot queue %zu bytes", len);
    return -1;
  }

  /* If we got fewer buffers than requested, we can still use them */
  size_t remaining = len;
  const uint8_t *src = data;
  buffer_ref_t *current_buf = bufs_head;
  buffer_ref_t *list_tail = NULL;

  /* Fill buffers with data */
  while (remaining > 0 && current_buf)
  {
    /* Calculate how much data to copy into this buffer */
    size_t chunk_size = remaining;
    if (chunk_size > buffer_size)
      chunk_size = buffer_size;

    /* Copy data into the buffer */
    memcpy(current_buf->data, src, chunk_size);
    current_buf->data_len = chunk_size;

    /* Move to next chunk and buffer */
    src += chunk_size;
    remaining -= chunk_size;

    list_tail = current_buf;
    current_buf = current_buf->process_next;
  }

  /* Terminate the list at the last used buffer */
  if (list_tail)
  {
    list_tail->process_next = NULL;
  }

  /* If we couldn't fit all data, we still try to send what we have (partial send)
   * This is better than dropping everything */
  size_t bytes_to_queue = len - remaining;

  /* Queue the prepared list - connection_queue_zerocopy supports partial send */
  int num_queued = 0;
  connection_queue_zerocopy(c, bufs_head, &num_queued);

  /* Release our references for all buffers (queued or not)
   * - For queued buffers: the queue holds a reference, so buffer_ref_put decrements from 2->1
   * - For non-queued buffers (partial send or error): buffer_ref_put decrements from 1->0 and frees them
   */
  current_buf = bufs_head;
  while (current_buf)
  {
    buffer_ref_t *next_buf = current_buf->process_next;
    buffer_ref_put(current_buf);
    current_buf = next_buf;
  }

  /* Check if queueing failed */
  if (num_queued <= 0)
  {
    logger(LOG_WARN, "connection_queue_output: Zero-copy queue full, cannot queue any data");
    return -1;
  }

  /* Log if we couldn't queue all the data */
  if (remaining > 0)
  {
    logger(LOG_DEBUG, "connection_queue_output: Partial send - queued %zu bytes, %zu bytes not allocated due to buffer pool exhaustion",
           bytes_to_queue, remaining);
    return -1;
  }

  /* Return success if at least some data was queued, otherwise error */
  return (num_queued > 0) ? 0 : -1;
}

int connection_queue_output_and_flush(connection_t *c, const uint8_t *data, size_t len)
{
  int result = connection_queue_output(c, data, len);
  if (result < 0)
    return result;
  connection_epoll_update_events(c->epfd, c->fd, EPOLLIN | EPOLLOUT | EPOLLRDHUP | EPOLLHUP | EPOLLERR);
  return 0;
}

connection_write_status_t connection_handle_write(connection_t *c)
{
  if (!c)
    return CONNECTION_WRITE_IDLE;

  if (!c->zc_queue.head)
  {
    connection_report_queue_stats(c);
    if (c->state == CONN_CLOSING && !c->zc_queue.pending_head)
      return CONNECTION_WRITE_CLOSED;
    return CONNECTION_WRITE_IDLE;
  }

  size_t bytes_sent = 0;
  int ret = zerocopy_send(c->fd, &c->zc_queue, &bytes_sent);

  if (ret < 0 && ret != -2)
  {
    c->state = CONN_CLOSING;
    connection_report_queue_stats(c);
    return CONNECTION_WRITE_CLOSED;
  }

  if (ret == -2)
  {
    connection_report_queue_stats(c);
    return CONNECTION_WRITE_BLOCKED;
  }

  if (c->zc_queue.head)
  {
    connection_report_queue_stats(c);
    return CONNECTION_WRITE_PENDING;
  }

  connection_epoll_update_events(c->epfd, c->fd, EPOLLIN | EPOLLRDHUP | EPOLLHUP | EPOLLERR);
  connection_report_queue_stats(c);

  if (c->state == CONN_CLOSING && !c->zc_queue.pending_head)
    return CONNECTION_WRITE_CLOSED;

  return CONNECTION_WRITE_IDLE;
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

  /* Check r2h-token if configured */
  if (config.r2h_token != NULL && config.r2h_token[0] != '\0')
  {
    if (!query_start)
    {
      logger(LOG_WARN, "Client request rejected: missing r2h-token parameter");
      http_send_401(c);
      return 0;
    }

    /* Parse r2h-token parameter from query string */
    char token_value[256];
    if (http_parse_query_param(query_start + 1, "r2h-token", token_value, sizeof(token_value)) != 0)
    {
      logger(LOG_WARN, "Client request rejected: missing r2h-token parameter");
      http_send_401(c);
      return 0;
    }

    if (http_url_decode(token_value) != 0)
    {
      logger(LOG_WARN, "Client request rejected: invalid r2h-token encoding");
      http_send_401(c);
      return 0;
    }

    /* Compare token value with configured token */
    if (strcmp(token_value, config.r2h_token) != 0)
    {
      logger(LOG_WARN, "Client request rejected: invalid r2h-token (got: %s)", token_value);
      http_send_401(c);
      return 0;
    }

    logger(LOG_DEBUG, "r2h-token validated");
  }

  /* Adjust path_len to exclude trailing slash */
  if (path_len > 0 && service_path[path_len - 1] == '/')
    path_len--;

  const char *status_route = config.status_page_route ? config.status_page_route : "status";
  size_t status_route_len = strlen(status_route);
  char status_sse_route[HTTP_URL_BUFFER_SIZE];
  char status_api_prefix[HTTP_URL_BUFFER_SIZE];

  if (status_route_len > 0)
  {
    snprintf(status_sse_route, sizeof(status_sse_route), "%s/sse", status_route);
    snprintf(status_api_prefix, sizeof(status_api_prefix), "%s/api/", status_route);
  }
  else
  {
    strncpy(status_sse_route, "sse", sizeof(status_sse_route) - 1);
    status_sse_route[sizeof(status_sse_route) - 1] = '\0';
    strncpy(status_api_prefix, "api/", sizeof(status_api_prefix) - 1);
    status_api_prefix[sizeof(status_api_prefix) - 1] = '\0';
  }

  if (status_route_len == path_len && strncmp(service_path, status_route, path_len) == 0)
  {
    handle_status_page(c);
    c->state = CONN_CLOSING;
    return 0;
  }
  size_t status_sse_len = strlen(status_sse_route);
  if (status_sse_len == path_len && strncmp(service_path, status_sse_route, path_len) == 0)
  {
    /* Delegate SSE initialization to status module */
    return status_handle_sse_init(c);
  }
  size_t status_api_prefix_len = strlen(status_api_prefix);
  if (path_len >= status_api_prefix_len &&
      strncmp(service_path, status_api_prefix, status_api_prefix_len) == 0)
  {
    const char *api_name = service_path + status_api_prefix_len;
    size_t api_name_len = path_len - status_api_prefix_len;

    if (api_name_len == strlen("disconnect") && strncmp(api_name, "disconnect", api_name_len) == 0)
    {
      handle_disconnect_client(c);
      c->state = CONN_CLOSING;
      return 0;
    }
    if (api_name_len == strlen("log-level") && strncmp(api_name, "log-level", api_name_len) == 0)
    {
      handle_set_log_level(c);
      c->state = CONN_CLOSING;
      return 0;
    }

    http_send_404(c);
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

  /* Check if this is a snapshot request (X-Request-Snapshot, Accept: image/jpeg, or snapshot=1) */
  /* 1 = snapshot=1, 2 = X-Request-Snapshot or Accept: image/jpeg */
  int is_snapshot_request = 0;

  if (config.video_snapshot)
  {
    if (c->http_req.x_request_snapshot)
    {
      is_snapshot_request = 2;
      logger(LOG_INFO, "Snapshot request detected via X-Request-Snapshot header for URL: %s", c->http_req.url);
    }

    if (!is_snapshot_request && c->http_req.accept[0] != '\0')
    {
      /* Check if Accept header contains "image/jpeg" */
      if (strstr(c->http_req.accept, "image/jpeg") != NULL)
      {
        is_snapshot_request = 2;
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
  }

  /* Register streaming client in status tracking with service URL (skip for snapshots) */
  if (c->client_addr_len > 0)
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
    if (!is_snapshot_request && !c->stream_registered)
    {
      zerocopy_register_stream_client();
      c->stream_registered = 1;
    }

    c->streaming = 1;
    c->service = service;
    c->service_owned = owned;
    c->state = CONN_STREAMING;
    c->buffer_pool = &zerocopy_state.pool;
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

int connection_queue_zerocopy(connection_t *c, buffer_ref_t *buf_ref_list, int *out_num_queued)
{
  if (!c || !buf_ref_list)
  {
    if (out_num_queued)
      *out_num_queued = 0;
    return -2;
  }

  int64_t now_ms = get_time_ms();
  size_t limit_bytes = connection_calculate_queue_limit(c, now_ms);
  size_t queued_bytes = c->zc_queue.num_queued * c->buffer_pool->buffer_size;

  c->queue_limit_bytes = limit_bytes;

  /* Partial send implementation: queue as many buffers as possible until limit */
  size_t available_bytes = (limit_bytes > queued_bytes) ? (limit_bytes - queued_bytes) : 0;

  if (available_bytes == 0)
  {
    /* Queue completely full - drop everything */
    size_t list_bytes = 0;
    buffer_ref_t *current = buf_ref_list;
    while (current)
    {
      list_bytes += current->data_len;
      current = current->send_next;
    }

    connection_record_drop(c, list_bytes);

    if (c->backpressure_events == 1 || (c->backpressure_events % 200) == 0)
    {
      logger(LOG_DEBUG, "Backpressure: dropping %zu bytes for client fd=%d (queued=%zu limit=%zu drops=%llu)",
             list_bytes, c->fd, queued_bytes, limit_bytes, (unsigned long long)c->dropped_packets);
    }

    connection_report_queue_stats(c);
    if (out_num_queued)
      *out_num_queued = 0;
    return -1;
  }

  /* Walk the list and find how many buffers we can queue */
  buffer_ref_t *current = buf_ref_list;
  buffer_ref_t *last_accepted = NULL;
  size_t accumulated_bytes = 0;
  size_t dropped_bytes = 0;
  int num_accepted = 0;

  while (current)
  {
    if (accumulated_bytes + current->data_len <= available_bytes)
    {
      /* This buffer fits within limit */
      accumulated_bytes += current->data_len;
      last_accepted = current;
      num_accepted++;
    }
    else
    {
      /* This buffer and remaining buffers exceed limit - drop them */
      dropped_bytes += current->data_len;
    }
    current = current->send_next;
  }

  /* Split the list if we're doing partial send */
  buffer_ref_t *accepted_list = buf_ref_list;

  if (last_accepted && last_accepted->send_next)
  {
    /* Split: accepted_list ends at last_accepted, remainder will be dropped */
    /* We modified the chain by not including this buffer, so we take ownership and must release it */
    buffer_ref_t *drop_current = last_accepted->send_next;
    while (drop_current)
    {
      buffer_ref_t *drop_next = drop_current->send_next;
      buffer_ref_put(drop_current);
      drop_current = drop_next;
    }
    last_accepted->send_next = NULL;
  }
  else if (!last_accepted)
  {
    /* Nothing accepted - all dropped */
    /* We did not modify the original list, so no need to release references */
    accepted_list = NULL;
  }

  /* Queue accepted buffers if any */
  if (accepted_list)
  {
    int ret = zerocopy_queue_add(&c->zc_queue, accepted_list);
    if (ret < 0)
    {
      /* Queue add failed unexpectedly - should not happen but handle it */
      logger(LOG_ERROR, "connection_queue_zerocopy: zerocopy_queue_add failed unexpectedly");
      if (out_num_queued)
        *out_num_queued = 0;
      return -2;
    }

    if (queued_bytes > c->queue_bytes_highwater)
      c->queue_bytes_highwater = queued_bytes;

    if (c->zc_queue.num_queued > c->queue_buffers_highwater)
      c->queue_buffers_highwater = c->zc_queue.num_queued;
  }

  /* Record dropped buffers if any */
  if (dropped_bytes > 0)
  {
    connection_record_drop(c, dropped_bytes);

    if (c->backpressure_events == 1 || (c->backpressure_events % 200) == 0)
    {
      logger(LOG_DEBUG, "Backpressure: partial send - queued %d buffers (%zu bytes), dropped %zu bytes for client fd=%d (limit=%zu drops=%llu)",
             num_accepted, accumulated_bytes, dropped_bytes, c->fd, limit_bytes, (unsigned long long)c->dropped_packets);
    }
  }

  connection_report_queue_stats(c);

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

  /* Set output parameter */
  if (out_num_queued)
    *out_num_queued = num_accepted;

  /* Return status: 0 = all queued, -1 = partial (some dropped) */
  return (dropped_bytes > 0) ? -1 : 0;
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
