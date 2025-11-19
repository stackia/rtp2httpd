#include "connection.h"
#include "embedded_web.h"
#include "epg.h"
#include "http.h"
#include "m3u.h"
#include "service.h"
#include "status.h"
#include "utils.h"
#include "zerocopy.h"
#include <errno.h>
#include <fcntl.h>
#include <netdb.h>
#include <netinet/tcp.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/epoll.h>
#include <sys/socket.h>
#include <unistd.h>

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

/* Forward declarations */
static void handle_playlist_request(connection_t *c);
static void handle_epg_request(connection_t *c, int requested_gz);

static inline buffer_ref_t *connection_alloc_output_buffer(connection_t *c) {
  buffer_ref_t *buf_ref = NULL;

  if (c->buffer_class == CONNECTION_BUFFER_CONTROL) {
    buf_ref = buffer_pool_alloc_control();
    if (!buf_ref)
      buf_ref = buffer_pool_alloc();
  } else {
    buf_ref = buffer_pool_alloc();
  }

  return buf_ref;
}

static size_t connection_compute_limit_bytes(buffer_pool_t *pool,
                                             size_t fair_bytes,
                                             double burst_factor) {
  size_t limit_bytes = (size_t)((double)fair_bytes * burst_factor);

  if (pool->max_buffers > 0) {
    size_t global_cap = pool->max_buffers * BUFFER_POOL_BUFFER_SIZE;
    size_t reserve = CONN_QUEUE_MIN_BUFFERS * BUFFER_POOL_BUFFER_SIZE;
    if (global_cap > reserve) {
      size_t hard_cap = global_cap - reserve;
      if (limit_bytes > hard_cap)
        limit_bytes = hard_cap;
    } else {
      if (limit_bytes > global_cap)
        limit_bytes = global_cap;
    }
  }

  if (limit_bytes < BUFFER_POOL_BUFFER_SIZE * 4)
    limit_bytes = BUFFER_POOL_BUFFER_SIZE * 4;

  return limit_bytes;
}

static size_t connection_calculate_queue_limit(connection_t *c,
                                               int64_t now_ms) {
  buffer_pool_t *pool = &zerocopy_state.pool;
  size_t active = zerocopy_active_streams();

  if (active == 0)
    active = 1;

  size_t total_buffers =
      pool->num_buffers ? pool->num_buffers : BUFFER_POOL_INITIAL_SIZE;

  size_t share_buffers = total_buffers / active;
  if (share_buffers < CONN_QUEUE_MIN_BUFFERS)
    share_buffers = CONN_QUEUE_MIN_BUFFERS;

  double utilization = 0.0;
  if (pool->max_buffers > 0) {
    size_t used_buffers = (pool->num_buffers > pool->num_free)
                              ? (pool->num_buffers - pool->num_free)
                              : 0;
    utilization = (double)used_buffers / (double)pool->max_buffers;
  }

  double burst_factor = CONN_QUEUE_BURST_FACTOR;
  if (pool->num_buffers >= pool->max_buffers ||
      utilization >= CONN_QUEUE_HIGH_UTIL_THRESHOLD)
    burst_factor = CONN_QUEUE_BURST_FACTOR_CONGESTED;
  if (pool->num_free < pool->low_watermark / 2 ||
      utilization >= CONN_QUEUE_DRAIN_UTIL_THRESHOLD)
    burst_factor = CONN_QUEUE_BURST_FACTOR_DRAIN;

  size_t fair_bytes = share_buffers * BUFFER_POOL_BUFFER_SIZE;
  double queue_mem_bytes =
      (double)c->zc_queue.num_queued * (double)BUFFER_POOL_BUFFER_SIZE;

  if (c->queue_avg_bytes <= 0.0)
    c->queue_avg_bytes = queue_mem_bytes;
  else
    c->queue_avg_bytes = (1.0 - CONN_QUEUE_EWMA_ALPHA) * c->queue_avg_bytes +
                         CONN_QUEUE_EWMA_ALPHA * queue_mem_bytes;

  size_t bursted_bytes =
      connection_compute_limit_bytes(pool, fair_bytes, burst_factor);

  double slow_threshold = (double)fair_bytes * CONN_QUEUE_SLOW_FACTOR;

  double limit_based_threshold =
      (double)bursted_bytes * CONN_QUEUE_SLOW_LIMIT_RATIO;
  if (slow_threshold > limit_based_threshold)
    slow_threshold = limit_based_threshold;

  double slow_exit_threshold = (double)fair_bytes * CONN_QUEUE_SLOW_EXIT_FACTOR;
  double limit_exit_threshold =
      (double)bursted_bytes * CONN_QUEUE_SLOW_EXIT_LIMIT_RATIO;
  if (slow_exit_threshold > limit_exit_threshold)
    slow_exit_threshold = limit_exit_threshold;

  if (slow_exit_threshold >= slow_threshold)
    slow_exit_threshold = slow_threshold * CONN_QUEUE_SLOW_EXIT_LIMIT_RATIO;

  if (c->queue_avg_bytes > slow_threshold) {
    if (c->slow_candidate_since == 0)
      c->slow_candidate_since = now_ms;
    else if (!c->slow_active && now_ms >= c->slow_candidate_since &&
             now_ms - c->slow_candidate_since >= CONN_QUEUE_SLOW_DEBOUNCE_MS)
      c->slow_active = 1;
  } else {
    c->slow_candidate_since = 0;
  }

  if (c->slow_active && c->queue_avg_bytes < slow_exit_threshold) {
    c->slow_active = 0;
    c->slow_candidate_since = 0;
  }

  if (c->slow_active && burst_factor > CONN_QUEUE_SLOW_CLAMP_FACTOR)
    burst_factor = CONN_QUEUE_SLOW_CLAMP_FACTOR;

  size_t limit_bytes =
      connection_compute_limit_bytes(pool, fair_bytes, burst_factor);

  return limit_bytes;
}

static inline void connection_record_drop(connection_t *c, size_t len) {
  c->dropped_packets++;
  c->dropped_bytes += len;
  c->backpressure_events++;
}

static void connection_report_queue(connection_t *c) {
  if (c->status_index < 0)
    return;

  size_t queue_buffers = c->zc_queue.num_queued;
  size_t queue_bytes = c->zc_queue.num_queued * BUFFER_POOL_BUFFER_SIZE;

  status_update_client_queue(
      c->status_index, queue_bytes, queue_buffers, c->queue_limit_bytes,
      c->queue_bytes_highwater, c->queue_buffers_highwater, c->dropped_packets,
      c->dropped_bytes, c->backpressure_events, c->slow_active);
}
int connection_set_nonblocking(int fd) {
  int flags = fcntl(fd, F_GETFL, 0);
  if (flags < 0)
    return -1;
  return fcntl(fd, F_SETFL, flags | O_NONBLOCK);
}

int connection_set_tcp_nodelay(int fd) {
  int on = 1;
  return setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &on, sizeof(on));
}

void connection_epoll_update_events(int epfd, int fd, uint32_t events) {
  struct epoll_event ev;
  memset(&ev, 0, sizeof(ev));
  ev.events = events;
  ev.data.fd = fd;
  epoll_ctl(epfd, EPOLL_CTL_MOD, fd, &ev);
}

connection_t *connection_create(int fd, int epfd,
                                struct sockaddr_storage *client_addr,
                                socklen_t addr_len) {
  connection_t *c = calloc(1, sizeof(*c));
  if (!c)
    return NULL;
  c->fd = fd;
  c->epfd = epfd;
  c->state = CONN_READ_REQ_LINE;
  c->service = NULL;
  c->streaming = 0;
  c->status_index = -1; /* Not registered yet */
  c->next = NULL;

  if (client_addr && addr_len > 0) {
    memcpy(&c->client_addr, client_addr, addr_len);
    c->client_addr_len = addr_len;
  } else {
    c->client_addr_len = 0;
  }

  /* Initialize zero-copy queue */
  zerocopy_queue_init(&c->zc_queue);
  c->zerocopy_enabled = 0;
  c->buffer_class = CONNECTION_BUFFER_CONTROL;
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
  int tcp_user_timeout = CONNECTION_TCP_USER_TIMEOUT_MS;
  if (setsockopt(fd, IPPROTO_TCP, TCP_USER_TIMEOUT, &tcp_user_timeout,
                 sizeof(tcp_user_timeout)) < 0) {
    logger(LOG_DEBUG, "connection_create: Failed to set TCP_USER_TIMEOUT: %s",
           strerror(errno));
  }

  /* Enable SO_ZEROCOPY on socket if supported */
  if (config.zerocopy_on_send) {
    int one = 1;
    if (setsockopt(fd, SOL_SOCKET, SO_ZEROCOPY, &one, sizeof(one)) == 0) {
      c->zerocopy_enabled = 1;
    }
  }

  /* Initialize HTTP request parser */
  http_request_init(&c->http_req);
  return c;
}

void connection_free(connection_t *c) {
  if (!c)
    return;

  if (c->stream_registered) {
    zerocopy_unregister_stream_client();
    c->stream_registered = 0;
  }

  /* Clean up stream context if still marked as streaming
   * Note: worker_close_and_free_connection should have already called
   * stream_context_cleanup for streaming connections, so this is a safety
   * fallback */
  if (c->streaming) {
    logger(LOG_WARN,
           "connection_free: streaming flag still set, cleaning up stream");
    stream_context_cleanup(&c->stream);
  }

  /* Cleanup zero-copy queue - this releases all buffer references */
  zerocopy_queue_cleanup(&c->zc_queue);

  /* Try to shrink buffer pool after connection cleanup
   * This is an ideal time to reclaim memory as buffers are likely freed
   * The function is lightweight and only acts if conditions are met */
  buffer_pool_try_shrink();

  /* Free service if owned */
  if (c->service) {
    service_free(c->service);
    c->service = NULL;
  }

  /* Unregister from status (only if registered as streaming client) */
  if (c->status_index >= 0) {
    status_unregister_client(c->status_index);
  }

  /* Close socket */
  if (c->fd >= 0) {
    close(c->fd);
    c->fd = -1;
  }

  free(c);
}

/**
 * Queue data to connection output buffer
 */
int connection_queue_output(connection_t *c, const uint8_t *data, size_t len) {
  if (!c || !data || len == 0)
    return 0;

  size_t remaining = len;
  const uint8_t *src = data;

  /* Allocate multiple buffers until we satisfy the entire length */
  while (remaining > 0) {
    /* Allocate a buffer from the pool */
    buffer_ref_t *buf_ref = connection_alloc_output_buffer(c);
    if (!buf_ref) {
      /* Pool exhausted */
      logger(LOG_WARN,
             "connection_queue_output: Buffer pool exhausted, cannot queue %zu "
             "bytes",
             remaining);
      return -1;
    }

    /* Calculate how much data to copy into this buffer */
    size_t chunk_size = remaining;
    if (chunk_size > BUFFER_POOL_BUFFER_SIZE)
      chunk_size = BUFFER_POOL_BUFFER_SIZE;

    /* Copy data into the buffer */
    memcpy(buf_ref->data, src, chunk_size);
    buf_ref->data_size = chunk_size;

    /* Queue this buffer for zero-copy send */
    if (connection_queue_zerocopy(c, buf_ref) < 0) {
      /* Queue full - release the buffer and fail */
      buffer_ref_put(buf_ref);
      logger(LOG_WARN,
             "connection_queue_output: Zero-copy queue full, cannot queue %zu "
             "bytes",
             remaining);
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

int connection_queue_output_and_flush(connection_t *c, const uint8_t *data,
                                      size_t len) {
  int result = connection_queue_output(c, data, len);
  if (result < 0)
    return result;
  connection_epoll_update_events(
      c->epfd, c->fd, EPOLLIN | EPOLLOUT | EPOLLRDHUP | EPOLLHUP | EPOLLERR);

  if (c) {
    c->state = CONN_CLOSING;
  }

  return 0;
}

connection_write_status_t connection_handle_write(connection_t *c) {
  if (!c)
    return CONNECTION_WRITE_IDLE;

  if (!c->zc_queue.head) {
    connection_epoll_update_events(c->epfd, c->fd,
                                   EPOLLIN | EPOLLRDHUP | EPOLLHUP | EPOLLERR);
    connection_report_queue(c);
    if (c->state == CONN_CLOSING && !c->zc_queue.pending_head)
      return CONNECTION_WRITE_CLOSED;
    return CONNECTION_WRITE_IDLE;
  }

  size_t bytes_sent = 0;
  int ret = zerocopy_send(c->fd, &c->zc_queue, &bytes_sent);

  if (ret < 0 && ret != -2) {
    c->state = CONN_CLOSING;
    connection_epoll_update_events(c->epfd, c->fd,
                                   EPOLLIN | EPOLLRDHUP | EPOLLHUP | EPOLLERR);
    connection_report_queue(c);
    return CONNECTION_WRITE_CLOSED;
  }

  if (ret == -2) {
    connection_report_queue(c);
    return CONNECTION_WRITE_BLOCKED;
  }

  if (c->zc_queue.head) {
    connection_report_queue(c);
    return CONNECTION_WRITE_PENDING;
  }

  connection_epoll_update_events(c->epfd, c->fd,
                                 EPOLLIN | EPOLLRDHUP | EPOLLHUP | EPOLLERR);
  connection_report_queue(c);

  if (c->state == CONN_CLOSING && !c->zc_queue.pending_head)
    return CONNECTION_WRITE_CLOSED;

  return CONNECTION_WRITE_IDLE;
}

void connection_handle_read(connection_t *c) {
  if (!c)
    return;

  /* Read into input buffer */
  if (c->in_len < INBUF_SIZE) {
    int r = read(c->fd, c->inbuf + c->in_len, INBUF_SIZE - c->in_len);
    if (r > 0) {
      c->in_len += r;
    } else if (r == 0) {
      c->state = CONN_CLOSING;
      return;
    } else if (errno == EAGAIN) {
      return;
    } else {
      c->state = CONN_CLOSING;
      return;
    }
  }

  /* Parse HTTP request using http.c parser */
  if (c->state == CONN_READ_REQ_LINE || c->state == CONN_READ_HEADERS) {
    int parse_result = http_parse_request(c->inbuf, &c->in_len, &c->http_req);
    if (parse_result == 1) {
      /* Request complete, route it */
      c->state = CONN_ROUTE;
      connection_route_and_start(c);
      return;
    } else if (parse_result < 0) {
      /* Parse error */
      c->state = CONN_CLOSING;
      return;
    }
    /* else parse_result == 0: need more data, continue reading */
  }
}

int connection_route_and_start(connection_t *c) {
  /* Ensure URL begins with '/' */
  const char *url = c->http_req.url;

  logger(LOG_INFO, "New client requested URL: %s (method: %s)", url,
         c->http_req.method);

  if (url[0] != '/') {
    http_send_400(c);
    return 0;
  }

  /* Parse configured hostname once if needed (extract protocol and host) */
  char protocol[16] = {0};
  char expected_host[256] = {0};

  if (config.hostname != NULL && config.hostname[0] != '\0') {
    /* Parse URL components from config.hostname */
    if (http_parse_url_components(config.hostname, protocol, expected_host,
                                  NULL, NULL) != 0) {
      logger(LOG_ERROR, "Failed to parse configured hostname: %s",
             config.hostname);
      http_send_400(c);
      return 0;
    }

    /* If Host header is missing, reject the request */
    if (c->http_req.hostname[0] == '\0') {
      logger(LOG_WARN,
             "Client request rejected: missing Host header (expected: %s)",
             expected_host);
      http_send_400(c);
      return 0;
    }

    /* Match Host header against expected hostname */
    int match_result =
        http_match_host_header(c->http_req.hostname, expected_host);

    if (match_result < 0) {
      logger(LOG_ERROR, "Failed to match Host header");
      http_send_400(c);
      return 0;
    }

    if (match_result == 0) {
      logger(LOG_WARN,
             "Client request rejected: Host header mismatch (got: %s, "
             "expected: %s)",
             c->http_req.hostname, expected_host);
      http_send_400(c);
      return 0;
    }

    logger(LOG_DEBUG, "Host header validated: %s", c->http_req.hostname);
  }

  /* Extract service_path and query */
  const char *service_path = url + 1; /* skip leading '/' */
  const char *query_start = strchr(service_path, '?');
  size_t path_len =
      query_start ? (size_t)(query_start - service_path) : strlen(service_path);

  /* Adjust path_len to exclude trailing slash */
  if (path_len > 0 && service_path[path_len - 1] == '/')
    path_len--;

  /* Handle static assets first (bypass r2h-token validation for /assets/) */
  const char *assets_prefix = "assets/";
  size_t assets_prefix_len = strlen(assets_prefix);
  if (path_len >= assets_prefix_len &&
      strncmp(service_path, assets_prefix, assets_prefix_len) == 0) {
    /* Reconstruct full path with leading slash */
    char asset_path[HTTP_URL_BUFFER_SIZE];
    snprintf(asset_path, sizeof(asset_path), "/%.*s", (int)path_len,
             service_path);
    handle_embedded_file(c, asset_path);
    return 0;
  }

  /* Check r2h-token if configured */
  if (config.r2h_token != NULL && config.r2h_token[0] != '\0') {
    if (!query_start) {
      logger(LOG_WARN, "Client request rejected: missing r2h-token parameter");
      http_send_401(c);
      return 0;
    }

    /* Parse r2h-token parameter from query string (automatically URL-decoded)
     */
    char token_value[256];
    if (http_parse_query_param(query_start + 1, "r2h-token", token_value,
                               sizeof(token_value)) != 0) {
      logger(LOG_WARN,
             "Client request rejected: missing or invalid r2h-token parameter");
      http_send_401(c);
      return 0;
    }

    /* Compare token value with configured token */
    if (strcmp(token_value, config.r2h_token) != 0) {
      logger(LOG_WARN, "Client request rejected: invalid r2h-token (got: %s)",
             token_value);
      http_send_401(c);
      return 0;
    }

    logger(LOG_DEBUG, "r2h-token validated");
  }

  const char *status_route =
      config.status_page_route ? config.status_page_route : "status";
  size_t status_route_len = strlen(status_route);
  char status_sse_route[HTTP_URL_BUFFER_SIZE];
  char status_api_prefix[HTTP_URL_BUFFER_SIZE];

  if (status_route_len > 0) {
    snprintf(status_sse_route, sizeof(status_sse_route), "%s/sse",
             status_route);
    snprintf(status_api_prefix, sizeof(status_api_prefix), "%s/api/",
             status_route);
  } else {
    strncpy(status_sse_route, "sse", sizeof(status_sse_route) - 1);
    status_sse_route[sizeof(status_sse_route) - 1] = '\0';
    strncpy(status_api_prefix, "api/", sizeof(status_api_prefix) - 1);
    status_api_prefix[sizeof(status_api_prefix) - 1] = '\0';
  }

  if (status_route_len == path_len &&
      strncmp(service_path, status_route, path_len) == 0) {
    handle_embedded_file(c, "/status.html");
    return 0;
  }

  /* Handle player page */
  const char *player_route =
      config.player_page_route ? config.player_page_route : "player";
  size_t player_route_len = strlen(player_route);
  if (player_route_len == path_len &&
      strncmp(service_path, player_route, path_len) == 0) {
    handle_embedded_file(c, "/player.html");
    return 0;
  }

  /* Handle /playlist.m3u request */
  const char *playlist_route = "playlist.m3u";
  size_t playlist_route_len = strlen(playlist_route);
  if (playlist_route_len == path_len &&
      strncmp(service_path, playlist_route, path_len) == 0) {
    handle_playlist_request(c);
    return 0;
  }

  /* Handle /epg.xml and /epg.xml.gz requests */
  const char *epg_xml_route = "epg.xml";
  const char *epg_xml_gz_route = "epg.xml.gz";
  size_t epg_xml_route_len = strlen(epg_xml_route);
  size_t epg_xml_gz_route_len = strlen(epg_xml_gz_route);
  if (epg_xml_gz_route_len == path_len &&
      strncmp(service_path, epg_xml_gz_route, path_len) == 0) {
    handle_epg_request(c, 1);
    return 0;
  }
  if (epg_xml_route_len == path_len &&
      strncmp(service_path, epg_xml_route, path_len) == 0) {
    handle_epg_request(c, 0);
    return 0;
  }
  size_t status_sse_len = strlen(status_sse_route);
  if (status_sse_len == path_len &&
      strncmp(service_path, status_sse_route, path_len) == 0) {
    /* Delegate SSE initialization to status module */
    return status_handle_sse_init(c);
  }
  size_t status_api_prefix_len = strlen(status_api_prefix);
  if (path_len >= status_api_prefix_len &&
      strncmp(service_path, status_api_prefix, status_api_prefix_len) == 0) {
    const char *api_name = service_path + status_api_prefix_len;
    size_t api_name_len = path_len - status_api_prefix_len;

    if (api_name_len == strlen("disconnect") &&
        strncmp(api_name, "disconnect", api_name_len) == 0) {
      handle_disconnect_client(c);
      return 0;
    }
    if (api_name_len == strlen("log-level") &&
        strncmp(api_name, "log-level", api_name_len) == 0) {
      handle_set_log_level(c);
      return 0;
    }

    http_send_404(c);
    return 0;
  }

  /* Find configured service (with URL decoding support) */
  service_t *service = NULL;
  char decoded_path[HTTP_URL_BUFFER_SIZE];

  /* Copy service_path to buffer for decoding */
  if (path_len >= sizeof(decoded_path)) {
    logger(LOG_ERROR, "Service path too long: %zu bytes", path_len);
    http_send_400(c);
    return 0;
  }

  memcpy(decoded_path, service_path, path_len);
  decoded_path[path_len] = '\0';

  /* URL decode the path */
  if (http_url_decode(decoded_path) != 0) {
    logger(LOG_WARN, "Failed to URL decode service path");
    http_send_400(c);
    return 0;
  }

  /* Match against configured services using O(1) hashmap lookup */
  service = service_hashmap_get(decoded_path);

  /* Dynamic parsing for RTSP and UDPxy if needed */
  if (service == NULL) {
    if (config.udpxy) {
      service = service_create_from_udpxy_url(c->http_req.url);
    }
  } else {
    /* Found configured service (RTP or RTSP) - try to merge query params if
     * present */
    logger(LOG_INFO, "Service matched: %s", service->url);
    service_t *merged_service = service_create_with_query_merge(
        service, c->http_req.url, service->service_type);
    if (merged_service) {
      service = merged_service;
    } else {
      /* No query params to merge - clone the configured service so connection
       * owns its copy */
      service = service_clone(service);
      if (!service) {
        logger(LOG_ERROR, "Failed to clone service for connection");
        http_send_500(c);
        return 0;
      }
    }
  }

  if (!service) {
    http_send_404(c);
    return 0;
  }

  /* Handle HEAD requests for media streams - return success without connecting
   * upstream */
  if (strcasecmp(c->http_req.method, "HEAD") == 0) {
    logger(
        LOG_INFO,
        "HEAD request detected, returning success without upstream connection");
    send_http_headers(c, STATUS_200, "video/mp2t", NULL);
    connection_queue_output_and_flush(c, NULL, 0);
    service_free(service);
    return 0;
  }

  if (c->http_req.user_agent[0]) {
    service->user_agent = strdup(c->http_req.user_agent);
  }

  /* Capacity check */
  if (status_shared && status_shared->total_clients >= config.maxclients) {
    http_send_503(c);
    service_free(service);
    return 0;
  }

  /* Check if this is a snapshot request (X-Request-Snapshot, Accept:
   * image/jpeg, or snapshot=1) */
  /* 1 = snapshot=1, 2 = X-Request-Snapshot or Accept: image/jpeg */
  int is_snapshot_request = 0;

  if (config.video_snapshot) {
    if (c->http_req.x_request_snapshot) {
      is_snapshot_request = 2;
      logger(
          LOG_INFO,
          "Snapshot request detected via X-Request-Snapshot header for URL: %s",
          c->http_req.url);
    }

    if (!is_snapshot_request && c->http_req.accept[0] != '\0') {
      /* Check if Accept header contains "image/jpeg" */
      if (strstr(c->http_req.accept, "image/jpeg") != NULL) {
        is_snapshot_request = 2;
        logger(LOG_INFO,
               "Snapshot request detected via Accept header for URL: %s",
               c->http_req.url);
      }
    }

    /* Also check for snapshot=1 query parameter */
    if (!is_snapshot_request && query_start != NULL) {
      char snapshot_value[16];
      if (http_parse_query_param(query_start + 1, "snapshot", snapshot_value,
                                 sizeof(snapshot_value)) == 0) {
        if (strcmp(snapshot_value, "1") == 0) {
          is_snapshot_request = 1;
          logger(LOG_INFO,
                 "Snapshot request detected via query parameter for URL: %s",
                 c->http_req.url);
        }
      }
    }
  }

  /* Register streaming client in status tracking with service URL (skip for
   * snapshots) */
  if (c->client_addr_len > 0) {
    /* Build display URL with decoded service name and query parameters */
    char display_url[HTTP_URL_BUFFER_SIZE];
    size_t url_len = 0;

    /* Add leading slash */
    display_url[url_len++] = '/';

    /* Add decoded service name */
    size_t decoded_len = strlen(decoded_path);
    if (url_len + decoded_len < sizeof(display_url)) {
      memcpy(display_url + url_len, decoded_path, decoded_len);
      url_len += decoded_len;
    }

    /* Add query parameters if present */
    if (query_start && url_len < sizeof(display_url)) {
      size_t query_len = strlen(query_start);
      if (url_len + query_len < sizeof(display_url)) {
        memcpy(display_url + url_len, query_start, query_len);
        url_len += query_len;
      }
    }

    display_url[url_len] = '\0';

    /* Format client address string
     * If protocol was detected (http/https), use X-Forwarded-For if present
     * Otherwise format real client address from sockaddr */
    char client_addr_str[NI_MAXHOST + NI_MAXSERV + 4];
    if ((protocol[0] != '\0' || config.xff) &&
        c->http_req.x_forwarded_for[0] != '\0') {
      /* Behind proxy with X-Forwarded-For - use it directly (already formatted)
       */
      logger(LOG_DEBUG, "X-Forwarded-For accepted: %s",
             c->http_req.x_forwarded_for);
      snprintf(client_addr_str, sizeof(client_addr_str), "%s",
               c->http_req.x_forwarded_for);
    } else {
      /* Format real client address from sockaddr */
      char hbuf[NI_MAXHOST], sbuf[NI_MAXSERV];
      int r = getnameinfo((struct sockaddr *)&c->client_addr,
                          c->client_addr_len, hbuf, sizeof(hbuf), sbuf,
                          sizeof(sbuf), NI_NUMERICHOST | NI_NUMERICSERV);
      if (r != 0) {
        snprintf(client_addr_str, sizeof(client_addr_str), "unknown");
      } else {
        /* Check if IPv6 address needs brackets */
        if (strchr(hbuf, ':') != NULL) {
          /* IPv6 - wrap in brackets */
          snprintf(client_addr_str, sizeof(client_addr_str), "[%s]:%s", hbuf,
                   sbuf);
        } else {
          /* IPv4 - simple format */
          snprintf(client_addr_str, sizeof(client_addr_str), "%s:%s", hbuf,
                   sbuf);
        }
      }
    }

    c->status_index = status_register_client(client_addr_str, display_url);
    if (c->status_index < 0) {
      logger(LOG_ERROR,
             "Failed to register streaming client in status tracking");
    }
  } else {
    c->status_index = -1;
  }

  /* Headers will be sent lazily when first data is ready (or 503 on timeout) */
  /* Snapshots send JPEG headers after conversion */

  /* Initialize stream in unified epoll (works for both streaming and snapshot)
   */
  if (stream_context_init_for_worker(&c->stream, c, service, c->epfd,
                                     c->status_index,
                                     is_snapshot_request) == 0) {
    if (!is_snapshot_request && !c->stream_registered) {
      zerocopy_register_stream_client();
      c->stream_registered = 1;
    }

    c->streaming = 1;
    c->service = service;
    c->state = CONN_STREAMING;
    c->buffer_class = CONNECTION_BUFFER_MEDIA;
    return 0;
  } else {
    /* Stream initialization failed - send 503 if headers not sent yet */
    if (!c->headers_sent) {
      http_send_503(c);
    }
    service_free(service);
    c->state = CONN_CLOSING;
    return -1;
  }
}

int connection_queue_zerocopy(connection_t *c, buffer_ref_t *buf_ref) {
  if (!c || !buf_ref || buf_ref->data_size == 0)
    return 0;

  int64_t now_ms = get_time_ms();
  size_t limit_bytes = connection_calculate_queue_limit(c, now_ms);
  size_t queued_bytes = c->zc_queue.num_queued * BUFFER_POOL_BUFFER_SIZE;
  size_t projected_bytes = queued_bytes + buf_ref->data_size;

  c->queue_limit_bytes = limit_bytes;

  if (projected_bytes > limit_bytes) {
    connection_record_drop(c, buf_ref->data_size);

    if (c->backpressure_events == 1 || (c->backpressure_events % 200) == 0) {
      logger(LOG_DEBUG,
             "Backpressure: dropping %zu bytes for client fd=%d (queued=%zu "
             "limit=%zu drops=%llu)",
             buf_ref->data_size, c->fd, queued_bytes, limit_bytes,
             (unsigned long long)c->dropped_packets);
    }

    connection_report_queue(c);
    return -1;
  }

  /* Add to zero-copy queue with offset information */
  int ret = zerocopy_queue_add(&c->zc_queue, buf_ref);
  if (ret < 0)
    return -1; /* Queue full */

  if (queued_bytes > c->queue_bytes_highwater)
    c->queue_bytes_highwater = queued_bytes;

  if (c->zc_queue.num_queued > c->queue_buffers_highwater)
    c->queue_buffers_highwater = c->zc_queue.num_queued;

  connection_report_queue(c);

  /* Batching optimization: Only enable EPOLLOUT when flush threshold is reached
   * Benefits:
   * - Reduces sendmsg() syscall overhead (fewer calls)
   * - Reduces MSG_ZEROCOPY optmem consumption (fewer operations)
   * - Better batching with iovec (up to 64 packets per sendmsg)
   * - Lower latency impact (100ms is acceptable for streaming)
   */
  if (zerocopy_should_flush(&c->zc_queue)) {
    connection_epoll_update_events(
        c->epfd, c->fd, EPOLLIN | EPOLLOUT | EPOLLRDHUP | EPOLLHUP | EPOLLERR);
  }

  return 0;
}

int connection_queue_file(connection_t *c, int file_fd, off_t file_offset,
                          size_t file_size) {
  if (!c || file_fd < 0 || file_size == 0)
    return -1;

  /* Add file to zero-copy queue */
  int ret =
      zerocopy_queue_add_file(&c->zc_queue, file_fd, file_offset, file_size);
  if (ret < 0)
    return -1;

  /* Always flush immediately for file sends (no batching) */
  connection_epoll_update_events(
      c->epfd, c->fd, EPOLLIN | EPOLLOUT | EPOLLRDHUP | EPOLLHUP | EPOLLERR);

  /* Set connection to closing state after file transfer */
  c->state = CONN_CLOSING;

  return 0;
}

/* Handle /playlist.m3u request - serve transformed M3U playlist */
static void handle_playlist_request(connection_t *c) {
  if (!c)
    return;

  const char *playlist = m3u_get_transformed_playlist();

  if (!playlist) {
    /* No playlist available */
    http_send_404(c);
    return;
  }

  /* Get ETag for the playlist */
  const char *etag = m3u_get_etag();

  /* Check ETag and send 304 if it matches */
  if (http_check_etag_and_send_304(c, etag, "audio/x-mpegurl")) {
    return;
  }

  /* ETag doesn't match or not provided - send full playlist */
  size_t playlist_len = strlen(playlist);
  char *server_addr = get_server_address();
  char extra_headers[512];
  char server_addr_header[512] = {0};

  /* Build X-Server-Address header if available */
  if (server_addr) {
    snprintf(server_addr_header, sizeof(server_addr_header),
             "X-Server-Address: %s", server_addr);
    free(server_addr);
  }

  /* Build headers with ETag support */
  http_build_etag_headers(extra_headers, sizeof(extra_headers), playlist_len,
                          etag,
                          server_addr_header[0] ? server_addr_header : NULL);

  send_http_headers(c, STATUS_200, "audio/x-mpegurl", extra_headers);
  connection_queue_output_and_flush(c, (const uint8_t *)playlist, playlist_len);
}

/* Handle /epg.xml or /epg.xml.gz request - serve cached EPG data
 * requested_gz: 1 if client requested .gz version, 0 for .xml version
 */
static void handle_epg_request(connection_t *c, int requested_gz) {
  if (!c)
    return;

  /* Get EPG cache */
  epg_cache_t *epg = epg_get_cache();

  /* Check if EPG data is available */
  if (epg->data_fd < 0 || epg->data_size == 0) {
    /* No EPG data available */
    http_send_404(c);
    return;
  }

  int epg_fd = epg->data_fd;
  size_t epg_size = epg->data_size;
  int is_gzipped = epg->is_gzipped;

  /* Get ETag for the EPG data */
  const char *etag = epg->etag_valid ? epg->etag : NULL;

  /* Determine content type and encoding based on request and cache state
   * Logic:
   * - If requested epg.xml.gz:
   *   - If cache is_gzipped: send as application/gzip (no Content-Encoding)
   *   - If cache is NOT gzipped: send 404
   * - If requested epg.xml:
   *   - If cache is_gzipped: send as application/xml with Content-Encoding:
   * gzip
   *   - If cache is NOT gzipped: send as application/xml (no Content-Encoding)
   */
  const char *content_type;
  const char *content_encoding = NULL;

  if (requested_gz) {
    /* Client requested .gz file */
    if (!is_gzipped) {
      /* Cache is not gzipped, cannot serve .gz request */
      http_send_404(c);
      return;
    }
    /* Cache is gzipped - serve as application/gzip */
    content_type = "application/gzip";
  } else {
    /* Client requested .xml file */
    content_type = "application/xml";
    if (is_gzipped) {
      /* Cache is gzipped - add Content-Encoding to let browser decompress */
      content_encoding = "Content-Encoding: gzip";
    }
  }

  /* Check ETag and send 304 if it matches */
  if (http_check_etag_and_send_304(c, etag, content_type)) {
    return;
  }

  /* ETag doesn't match or not provided - send full EPG data */
  char extra_headers[256];

  /* Build headers with ETag support */
  http_build_etag_headers(extra_headers, sizeof(extra_headers), epg_size, etag,
                          content_encoding);

  send_http_headers(c, STATUS_200, content_type, extra_headers);

  /* Use zero-copy transmission via sendfile
   * Note: epg_fd is owned by EPG cache, so we need to dup it
   * zerocopy_queue_add_file will close the fd when done */
  int dup_fd = dup(epg_fd);
  if (dup_fd < 0) {
    logger(LOG_ERROR, "Failed to dup EPG fd for zero-copy transmission: %s",
           strerror(errno));
    c->state = CONN_CLOSING;
    return;
  }

  /* Queue the file for zero-copy transmission */
  if (connection_queue_file(c, dup_fd, 0, epg_size) < 0) {
    logger(LOG_ERROR, "Failed to queue EPG file for zero-copy transmission");
    close(dup_fd);
    c->state = CONN_CLOSING;
    return;
  }
}
