#include "connection.h"
#include "access_log.h"
#include "embedded_web.h"
#include "epg.h"
#include "http.h"
#include "m3u.h"
#include "platform_compat.h"
#include "poller.h"
#include "send_queue.h"
#include "service.h"
#include "status.h"
#include "utils.h"
#include "worker.h"
#include <errno.h>
#include <fcntl.h>
#include <netdb.h>
#include <netinet/tcp.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/mman.h>
#include <sys/socket.h>
#include <unistd.h>

#define CONNECTION_TCP_USER_TIMEOUT_MS 10000
#define CONNECTION_TCP_KEEPALIVE_IDLE_SEC 30
#define CONNECTION_TCP_KEEPALIVE_INTVL_SEC 5
#define CONNECTION_TCP_KEEPALIVE_CNT 3
#define CONN_QUEUE_MIN_BUFFERS 64
/* Logical queue budget is independent of eagerly allocated packet buffers. */
#define CONN_QUEUE_BASE_BUFFERS 1024
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

static int strip_app_path_prefix(const char *url, char *out, size_t out_size) {
  const char *prefix = config.app_path_prefix;
  const char *query_start;
  size_t prefix_len;
  size_t path_len;

  if (!url || !out || out_size == 0)
    return -1;

  if (!prefix || prefix[0] == '\0') {
    int written;
    if (strlen(url) >= out_size)
      return -1;
    written = snprintf(out, out_size, "%s", url);
    return (written >= 0 && (size_t)written < out_size) ? 0 : -1;
  }

  prefix_len = strlen(prefix);
  query_start = strchr(url, '?');
  path_len = query_start ? (size_t)(query_start - url) : strlen(url);

  if (path_len < prefix_len || strncmp(url, prefix, prefix_len) != 0)
    return -1;

  if (path_len == prefix_len) {
    int written = snprintf(out, out_size, "/%s", query_start ? query_start : "");
    return (written >= 0 && (size_t)written < out_size) ? 0 : -1;
  }

  if (url[prefix_len] != '/')
    return -1;

  if (strlen(url + prefix_len) >= out_size)
    return -1;

  int written = snprintf(out, out_size, "%s", url + prefix_len);
  return (written >= 0 && (size_t)written < out_size) ? 0 : -1;
}

/* Token source for r2h-token validation */
typedef enum {
  TOKEN_SOURCE_NONE = 0,
  TOKEN_SOURCE_QUERY,  /* From URL query parameter */
  TOKEN_SOURCE_COOKIE, /* From Cookie header */
  TOKEN_SOURCE_UA      /* From User-Agent R2HTOKEN/xxx */
} token_source_t;

static int connection_client_is_tcp(const connection_t *c) {
  if (!c || c->client_addr_len == 0)
    return 0;
  return c->client_addr.ss_family == AF_INET || c->client_addr.ss_family == AF_INET6;
}

/**
 * Parse cookie value from Cookie header string
 * Format: "name1=value1; name2=value2"
 * @param cookie_header Cookie header value
 * @param name Cookie name to search for
 * @param value_buf Buffer to store cookie value
 * @param value_size Size of value buffer
 * @return 0 if found, -1 if not found
 */
static int parse_cookie_value(const char *cookie_header, const char *name, char *value_buf, size_t value_size) {
  if (!cookie_header || !name || !value_buf || value_size == 0)
    return -1;

  size_t name_len = strlen(name);
  const char *p = cookie_header;

  while (*p) {
    /* Skip leading whitespace */
    while (*p == ' ' || *p == '\t')
      p++;

    /* Check if this cookie matches the name */
    if (strncasecmp(p, name, name_len) == 0 && p[name_len] == '=') {
      /* Found the cookie, extract value */
      const char *value_start = p + name_len + 1;
      const char *value_end = value_start;

      /* Find end of value (semicolon or end of string) */
      while (*value_end && *value_end != ';')
        value_end++;

      size_t value_len = (size_t)(value_end - value_start);
      if (value_len >= value_size)
        value_len = value_size - 1;

      if (value_len > 0)
        memcpy(value_buf, value_start, value_len);
      value_buf[value_len] = '\0';

      /* Trim trailing whitespace */
      while (value_len > 0 && (value_buf[value_len - 1] == ' ' || value_buf[value_len - 1] == '\t')) {
        value_buf[--value_len] = '\0';
      }

      return 0;
    }

    /* Move to next cookie */
    while (*p && *p != ';')
      p++;
    if (*p == ';')
      p++;
  }

  return -1;
}

/**
 * Extract R2HTOKEN from User-Agent
 * Format: "... R2HTOKEN/tokenvalue ..." or "... R2HTOKEN/tokenvalue"
 * @param user_agent User-Agent header value
 * @param value_buf Buffer to store token value
 * @param value_size Size of value buffer
 * @return 0 if found, -1 if not found
 */
static int extract_r2h_token_from_ua(const char *user_agent, char *value_buf, size_t value_size) {
  if (!user_agent || !value_buf || value_size == 0)
    return -1;

  const char *prefix = "R2HTOKEN/";
  size_t prefix_len = strlen(prefix);

  const char *p = strstr(user_agent, prefix);
  if (!p)
    return -1;

  /* Extract value after R2HTOKEN/ until space or end of string */
  const char *value_start = p + prefix_len;
  const char *value_end = value_start;

  while (*value_end && *value_end != ' ' && *value_end != '\t')
    value_end++;

  size_t value_len = (size_t)(value_end - value_start);
  if (value_len == 0)
    return -1;

  if (value_len >= value_size)
    value_len = value_size - 1;

  strncpy(value_buf, value_start, value_len);
  value_buf[value_len] = '\0';

  return 0;
}

/**
 * Extract and validate r2h-token from multiple sources (priority order):
 * 1. URL query parameter: ?r2h-token=xxx
 * 2. Cookie: r2h-token=xxx
 * 3. User-Agent: R2HTOKEN/xxx
 *
 * @param c Connection
 * @param query_start Pointer to '?' in URL or NULL
 * @return Token source if valid, TOKEN_SOURCE_NONE if not found or invalid
 */
static token_source_t validate_r2h_token(connection_t *c, const char *query_start, const char *raw_query_start) {
  char token_value[256] = {0};

  /* Source 1: URL query parameter (highest priority)
   * Try stripped URL first, then raw URL as fallback in case the configured
   * token itself contains '$' which would be incorrectly stripped */
  if (query_start) {
    if (http_parse_query_param(query_start + 1, "r2h-token", token_value, sizeof(token_value)) == 0) {
      if (strcmp(token_value, config.r2h_token) == 0) {
        logger(LOG_DEBUG, "r2h-token validated (source: query)");
        return TOKEN_SOURCE_QUERY;
      }
      /* Retry with raw (unstripped) query in case token contains '$' */
      if (raw_query_start && strchr(config.r2h_token, '$')) {
        char raw_token[256] = {0};
        if (http_parse_query_param(raw_query_start + 1, "r2h-token", raw_token, sizeof(raw_token)) == 0 &&
            strcmp(raw_token, config.r2h_token) == 0) {
          logger(LOG_DEBUG, "r2h-token validated (source: query, raw)");
          return TOKEN_SOURCE_QUERY;
        }
      }
      logger(LOG_WARN, "r2h-token mismatch (source: query)");
      return TOKEN_SOURCE_NONE;
    }
  }

  /* Source 2: Cookie header */
  if (c->http_req->cookie[0] != '\0') {
    if (parse_cookie_value(c->http_req->cookie, "r2h-token", token_value, sizeof(token_value)) == 0) {
      if (http_url_decode(token_value) != 0) {
        logger(LOG_WARN, "r2h-token invalid URL encoding (source: cookie)");
        return TOKEN_SOURCE_NONE;
      }
      if (strcmp(token_value, config.r2h_token) == 0) {
        logger(LOG_DEBUG, "r2h-token validated (source: cookie)");
        return TOKEN_SOURCE_COOKIE;
      }
      logger(LOG_WARN, "r2h-token mismatch (source: cookie)");
      return TOKEN_SOURCE_NONE;
    }
  }

  /* Source 3: User-Agent with R2HTOKEN/xxx format */
  if (c->http_req->user_agent[0] != '\0') {
    if (extract_r2h_token_from_ua(c->http_req->user_agent, token_value, sizeof(token_value)) == 0) {
      if (strcmp(token_value, config.r2h_token) == 0) {
        logger(LOG_DEBUG, "r2h-token validated (source: user-agent)");
        return TOKEN_SOURCE_UA;
      }
      logger(LOG_WARN, "r2h-token mismatch (source: user-agent)");
      return TOKEN_SOURCE_NONE;
    }
  }

  /* Token not found in any source */
  logger(LOG_WARN, "Client request rejected: r2h-token not found");
  return TOKEN_SOURCE_NONE;
}

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

static size_t connection_compute_limit_bytes(buffer_pool_t *pool, size_t fair_bytes, double burst_factor) {
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

/* Side-effect-free inputs into the queue-limit calculation. */
typedef struct {
  buffer_pool_t *pool;
  size_t fair_bytes;
  double burst_factor; /* before slow_active clamp */
} queue_limit_inputs_t;

static void connection_prepare_queue_limit_inputs(queue_limit_inputs_t *out) {
  buffer_pool_t *pool = &send_buffer_state.pool;
  out->pool = pool;

  size_t active = send_buffer_active_streams();
  if (active == 0)
    active = 1;

  size_t total_buffers = pool->num_buffers;
  size_t base_buffers = CONN_QUEUE_BASE_BUFFERS;
  if (pool->max_buffers && base_buffers > pool->max_buffers)
    base_buffers = pool->max_buffers;
  if (total_buffers < base_buffers)
    total_buffers = base_buffers;
  size_t share_buffers = total_buffers / active;
  if (share_buffers < CONN_QUEUE_MIN_BUFFERS)
    share_buffers = CONN_QUEUE_MIN_BUFFERS;
  out->fair_bytes = share_buffers * BUFFER_POOL_BUFFER_SIZE;

  double utilization = 0.0;
  if (pool->max_buffers > 0) {
    size_t used_buffers = (pool->num_buffers > pool->num_free) ? (pool->num_buffers - pool->num_free) : 0;
    utilization = (double)used_buffers / (double)pool->max_buffers;
  }

  out->burst_factor = CONN_QUEUE_BURST_FACTOR;
  if (pool->num_buffers >= pool->max_buffers || utilization >= CONN_QUEUE_HIGH_UTIL_THRESHOLD)
    out->burst_factor = CONN_QUEUE_BURST_FACTOR_CONGESTED;
  if (pool->num_free < pool->low_watermark / 2 || utilization >= CONN_QUEUE_DRAIN_UTIL_THRESHOLD)
    out->burst_factor = CONN_QUEUE_BURST_FACTOR_DRAIN;
}

static inline double connection_apply_slow_clamp(double burst_factor, int slow_active) {
  return (slow_active && burst_factor > CONN_QUEUE_SLOW_CLAMP_FACTOR) ? CONN_QUEUE_SLOW_CLAMP_FACTOR : burst_factor;
}

/* Pure (no side effect) limit computation.  Reads current pool state and the
 * connection's existing slow_active flag, but does NOT update the EWMA or the
 * slow-state debounce machine.  Safe to call from hot-path checks where
 * sampling EWMA at the wrong cadence would distort slow detection. */
static inline size_t connection_compute_queue_limit(const connection_t *c) {
  queue_limit_inputs_t in;
  connection_prepare_queue_limit_inputs(&in);
  double burst_factor = connection_apply_slow_clamp(in.burst_factor, c->slow_active);
  return connection_compute_limit_bytes(in.pool, in.fair_bytes, burst_factor);
}

static size_t connection_update_queue_limit(connection_t *c, int64_t now_ms) {
  queue_limit_inputs_t in;
  connection_prepare_queue_limit_inputs(&in);

  double queue_mem_bytes = (double)connection_queue_bytes(c);
  if (c->queue_avg_bytes <= 0.0)
    c->queue_avg_bytes = queue_mem_bytes;
  else
    c->queue_avg_bytes = (1.0 - CONN_QUEUE_EWMA_ALPHA) * c->queue_avg_bytes + CONN_QUEUE_EWMA_ALPHA * queue_mem_bytes;

  /* Use unclamped burst_factor for slow thresholds — the "ideal" reference
   * the slow-state machine compares the EWMA against. */
  size_t bursted_bytes = connection_compute_limit_bytes(in.pool, in.fair_bytes, in.burst_factor);

  double slow_threshold = (double)in.fair_bytes * CONN_QUEUE_SLOW_FACTOR;
  double limit_based_threshold = (double)bursted_bytes * CONN_QUEUE_SLOW_LIMIT_RATIO;
  if (slow_threshold > limit_based_threshold)
    slow_threshold = limit_based_threshold;

  double slow_exit_threshold = (double)in.fair_bytes * CONN_QUEUE_SLOW_EXIT_FACTOR;
  double limit_exit_threshold = (double)bursted_bytes * CONN_QUEUE_SLOW_EXIT_LIMIT_RATIO;
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

  double burst_factor = connection_apply_slow_clamp(in.burst_factor, c->slow_active);
  return connection_compute_limit_bytes(in.pool, in.fair_bytes, burst_factor);
}

static inline void connection_record_drop(connection_t *c, size_t len) {
  c->dropped_packets++;
  c->dropped_bytes += len;
}

void connection_report_queue(connection_t *c) {
  if (c->status_index < 0)
    return;

  size_t queue_buffers = c->send_queue.num_queued;
  size_t queue_bytes = connection_queue_bytes(c);

  status_update_client_queue(c->status_index, queue_bytes, queue_buffers, c->queue_limit_bytes,
                             c->queue_bytes_highwater, c->queue_buffers_highwater, c->dropped_packets, c->dropped_bytes,
                             c->backpressure_events, c->slow_active);
}

/* Backpressure watermarks for TCP-to-TCP relay flow control.  Upstream modules
 * (HTTP proxy, RTSP TCP) pause reads when the client send queue exceeds HWM
 * and resume when it falls back below LWM.  The 25% hysteresis band prevents
 * thrash. */
#define CONN_FLOW_CONTROL_HWM_NUM 3
#define CONN_FLOW_CONTROL_HWM_DEN 4 /* HWM = 75% of queue_limit_bytes */
#define CONN_FLOW_CONTROL_LWM_NUM 1
#define CONN_FLOW_CONTROL_LWM_DEN 2 /* LWM = 50% of queue_limit_bytes */

#define CONN_HWM(limit) (((limit) * CONN_FLOW_CONTROL_HWM_NUM) / CONN_FLOW_CONTROL_HWM_DEN)
#define CONN_LWM(limit) (((limit) * CONN_FLOW_CONTROL_LWM_NUM) / CONN_FLOW_CONTROL_LWM_DEN)

/* Lower bound on the dynamic queue limit (in slot-equivalent bytes).  Derived
 * from the CONN_QUEUE_MIN_BUFFERS clamp on share_buffers and the DRAIN burst
 * factor floor of 1.0 — the dynamic limit can never drop below this value
 * regardless of active_streams or pool utilization shifts.  Used to gate a
 * fast-path early-out in the HWM/LWM hot-path checks. */
#define CONN_FLOW_CONTROL_MIN_LIMIT_BYTES ((size_t)CONN_QUEUE_MIN_BUFFERS * (size_t)BUFFER_POOL_BUFFER_SIZE)
#define CONN_FLOW_CONTROL_MIN_HWM_BYTES CONN_HWM(CONN_FLOW_CONTROL_MIN_LIMIT_BYTES)
#define CONN_FLOW_CONTROL_MIN_LWM_BYTES CONN_LWM(CONN_FLOW_CONTROL_MIN_LIMIT_BYTES)

int connection_should_pause_upstream(connection_t *c) {
  if (!c)
    return 0;
  size_t queued = connection_queue_bytes(c);
  /* Fast path: queue is below the HWM of the absolute-minimum dynamic limit.
   * No pause possible regardless of how active_streams / pool utilization /
   * slow_active have shifted since the last enqueue. */
  if (queued < CONN_FLOW_CONTROL_MIN_HWM_BYTES)
    return 0;
  /* Slow path: refresh limit so the decision uses current inputs. */
  c->queue_limit_bytes = connection_compute_queue_limit(c);
  return queued >= CONN_HWM(c->queue_limit_bytes);
}

int connection_can_resume_upstream(connection_t *c) {
  if (!c)
    return 0;
  size_t queued = connection_queue_bytes(c);
  /* Fast path: queue is below the LWM of the absolute-minimum dynamic limit.
   * Always resumable regardless of input shifts. */
  if (queued <= CONN_FLOW_CONTROL_MIN_LWM_BYTES)
    return 1;
  /* Slow path: refresh limit so the decision uses current inputs. */
  c->queue_limit_bytes = connection_compute_queue_limit(c);
  return queued <= CONN_LWM(c->queue_limit_bytes);
}

void connection_recompute_any_upstream_paused(connection_t *c) {
  if (!c)
    return;
  c->any_upstream_paused =
      ((c->stream.http_proxy && c->stream.http_proxy->initialized) && c->stream.http_proxy->upstream_paused) ||
      ((c->stream.rtsp && c->stream.rtsp->initialized) && c->stream.rtsp->upstream_paused);
}

void connection_begin_drain_close(connection_t *c) {
  if (!c || c->state == CONN_CLOSING)
    return;
  c->state = CONN_CLOSING;
  connection_schedule_write(c);
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

static void connection_watch_writable(connection_t *c, int enabled) {
  if (c->write_poll_armed == enabled)
    return;
  uint32_t mask = POLLER_IN | POLLER_RDHUP | POLLER_HUP | POLLER_ERR;
  if (enabled)
    mask |= POLLER_OUT;
  if (poller_mod(c->epfd, c->fd, mask) == 0)
    c->write_poll_armed = enabled;
}

void connection_schedule_write(connection_t *c) {
  if (c && !c->write_poll_armed)
    worker_queue_write(c);
}

connection_t *connection_create(int fd, int epfd, struct sockaddr_storage *client_addr, socklen_t addr_len) {
  connection_t *c = calloc(1, sizeof(*c));
  if (!c)
    return NULL;
  c->fd = fd;
  c->epfd = epfd;
  c->state = CONN_READ_REQ_LINE;
  platform_set_nosigpipe(fd);
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

  /* Initialize buffered output queue */
  send_queue_init(&c->send_queue);
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
#ifdef TCP_USER_TIMEOUT
  if (connection_client_is_tcp(c)) {
    int tcp_user_timeout = CONNECTION_TCP_USER_TIMEOUT_MS;
    if (setsockopt(fd, IPPROTO_TCP, TCP_USER_TIMEOUT, &tcp_user_timeout, sizeof(tcp_user_timeout)) < 0) {
      logger(LOG_DEBUG, "connection_create: Failed to set TCP_USER_TIMEOUT: %s", strerror(errno));
    }
  }
#endif

  /* Enable TCP keepalive for early dead-peer detection on idle
   * connections.  Combined with the TCP_USER_TIMEOUT above this
   * covers both the data-pending and idle cases:
   *   - Data in-flight & ACK'd but peer gone → TCP_USER_TIMEOUT
   *   - Socket idle (no data to send)      → keepalive probes
   *
   * Total detection window ≈ KEEPALIVE_IDLE_SEC + KEEPALIVE_INTVL_SEC ×
   * KEEPALIVE_CNT  (30 + 5×3 = 45 seconds with the defaults below). */
  if (connection_client_is_tcp(c)) {
    platform_set_tcp_keepalive(c->fd, CONNECTION_TCP_KEEPALIVE_IDLE_SEC, CONNECTION_TCP_KEEPALIVE_INTVL_SEC,
                               CONNECTION_TCP_KEEPALIVE_CNT);
  }

  return c;
}

/* Temporary request parsing buffers have a different lifetime from the small
 * connection record. Separate mappings let the OS reclaim these pages even
 * while adjacent, long-lived stream allocations remain in the heap. */
static size_t request_mapping_size;

static int connection_allocate_request(connection_t *c) {
  if (!request_mapping_size) {
    long page_size = sysconf(_SC_PAGESIZE);
    if (page_size <= 0)
      return -1;
    request_mapping_size = (sizeof(*c->http_req) + (size_t)page_size - 1) / (size_t)page_size * (size_t)page_size;
  }
  void *storage =
      mmap(NULL, request_mapping_size + INBUF_SIZE, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
  if (storage == MAP_FAILED)
    return -1;
  c->http_req = storage;
  c->inbuf = (char *)storage + request_mapping_size;
  http_request_init(c->http_req);
  return 0;
}

static void connection_release_input(connection_t *c) {
  if (c->inbuf) {
    munmap(c->inbuf, INBUF_SIZE);
    c->inbuf = NULL;
  }
}

void connection_release_request(connection_t *c) {
  if (!c || !c->http_req)
    return;
  c->request_is_head = strcasecmp(c->http_req->method, "HEAD") == 0;
  http_request_cleanup(c->http_req);
  munmap(c->http_req, request_mapping_size);
  c->http_req = NULL;
}

void connection_cleanup(connection_t *c) {
  if (!c)
    return;

  if (c->stream_registered) {
    send_buffer_unregister_stream_client();
    c->stream_registered = 0;
  }

  /* The streaming flag is cleared when async TEARDOWN starts. Always destroy
   * the context here, whether teardown completed, timed out, or was cancelled
   * by worker shutdown. This also handles partially initialized streams. */
  stream_context_destroy(&c->stream);

  /* Cleanup buffered output queue - this releases all buffer references */
  send_queue_cleanup(&c->send_queue);

  /* Try to shrink buffer pool after connection cleanup
   * This is an ideal time to reclaim memory as buffers are likely freed
   * The function is lightweight and only acts if conditions are met */
  buffer_pool_try_shrink();

  /* Free the per-connection service instance */
  if (c->service) {
    service_free(c->service);
    c->service = NULL;
  }

  /* Unregister from status (only if registered as streaming client) */
  if (c->status_index >= 0) {
    status_unregister_client(c->status_index);
    c->status_index = -1;
  }

  /* Close socket */
  if (c->fd >= 0) {
    close(c->fd);
    c->fd = -1;
  }

  connection_release_request(c);
  connection_release_input(c);

  free(c);
}

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

    /* Queue this buffer for sending */
    if (connection_queue_buffer(c, buf_ref) < 0) {
      /* Queue full - release the buffer and fail */
      buffer_ref_put(buf_ref);
      logger(LOG_WARN,
             "connection_queue_output: Send queue full, cannot queue %zu "
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

int connection_queue_output_and_flush(connection_t *c, const uint8_t *data, size_t len) {
  int result = connection_queue_output(c, data, len);
  if (result < 0)
    return result;
  connection_schedule_write(c);

  if (c) {
    c->state = CONN_CLOSING;
  }

  return 0;
}

connection_write_status_t connection_handle_write(connection_t *c) {
  if (!c)
    return CONNECTION_WRITE_IDLE;

  if (!c->send_queue.head) {
    connection_watch_writable(c, 0);
    if (c->state == CONN_CLOSING)
      return CONNECTION_WRITE_CLOSED;
    return CONNECTION_WRITE_IDLE;
  }

  size_t total_sent = 0;

  /* Loop to drain all writable data for edge-triggered pollers where
   * EPOLLOUT / EV_CLEAR fires only once when the socket becomes writable. */
  for (;;) {
    size_t bytes_sent = 0;
    int ret = send_queue_send(c->fd, &c->send_queue, 256 * 1024 - total_sent, &bytes_sent);
    total_sent += bytes_sent;
    /* Count post-send so per-client bandwidth reflects actual receive rate, not enqueue rate. */
    c->stream.total_bytes_sent += (uint64_t)bytes_sent;

    if (ret < 0 && ret != -2) {
      c->state = CONN_CLOSING;
      connection_watch_writable(c, 0);
      return CONNECTION_WRITE_CLOSED;
    }

    if (ret == -2) {
      /* Subscribe only when a real send needs to wait for the socket. */
      connection_watch_writable(c, 1);
      if (total_sent > 0)
        stream_on_client_drain(&c->stream);
      return CONNECTION_WRITE_BLOCKED;
    }

    if (!c->send_queue.head) {
      if (c->state == CONN_CLOSING) {
        connection_watch_writable(c, 0);
        return CONNECTION_WRITE_CLOSED;
      }
      /* resume() may synchronously queue more output. Schedule it locally. */
      connection_watch_writable(c, 0);
      if (total_sent > 0)
        stream_on_client_drain(&c->stream);
      if (c->send_queue.head)
        connection_schedule_write(c);
      return CONNECTION_WRITE_IDLE;
    }

    /* Keep one writable client from starving input, timers and other clients. */
    if (total_sent >= 256 * 1024) {
      connection_watch_writable(c, 0);
      stream_on_client_drain(&c->stream);
      return CONNECTION_WRITE_PENDING;
    }

    /* Guard against spinning if send_queue_send sent 0 bytes without EAGAIN */
    if (bytes_sent == 0)
      break;
  }

  /* Queue still has data but we could not make progress. Wait for readiness. */
  connection_watch_writable(c, 1);
  if (total_sent > 0)
    stream_on_client_drain(&c->stream);
  return CONNECTION_WRITE_BLOCKED;
}

void connection_handle_read(connection_t *c) {
  if (!c)
    return;

  /* Read into input buffer.  Loop to drain all available data for
   * edge-triggered pollers (epoll EPOLLET / kqueue EV_CLEAR) where the read event fires
   * only once per data arrival.  This is important for POST requests
   * with bodies larger than INBUF_SIZE. */
  for (;;) {
    if (c->in_len < INBUF_SIZE) {
      if (!c->http_req && connection_allocate_request(c) < 0) {
        c->state = CONN_CLOSING;
        return;
      }
      int r = read(c->fd, c->inbuf + c->in_len, INBUF_SIZE - c->in_len);
      if (r > 0) {
        c->in_len += r;
      } else if (r == 0) {
        c->state = CONN_CLOSING;
        return;
      } else if (errno == EAGAIN) {
        return; /* No more data available */
      } else {
        c->state = CONN_CLOSING;
        return;
      }
    }

    /* Parse HTTP request using http.c parser */
    if (c->state == CONN_READ_REQ_LINE || c->state == CONN_READ_HEADERS) {
      int parse_result = http_parse_request(c->inbuf, &c->in_len, c->http_req);
      if (parse_result == 1) {
        /* Request complete, route it */
        c->state = CONN_ROUTE;
        connection_route_and_start(c);
        connection_release_input(c);
        if (c->headers_sent && !c->stream.http_proxy)
          connection_release_request(c);
        return;
      } else if (parse_result < 0) {
        /* Parse error */
        c->state = CONN_CLOSING;
        return;
      }
      /* else parse_result == 0: need more data, keep reading */
    } else {
      return; /* Not in a request-reading state */
    }
  }
}

int connection_route_and_start(connection_t *c) {
  /* Copy URL and strip $label suffix (UI display tag at URL end) */
  char url_buf[HTTP_URL_BUFFER_SIZE];
  char internal_url_buf[HTTP_URL_BUFFER_SIZE];
  strncpy(url_buf, c->http_req->url, sizeof(url_buf) - 1);
  url_buf[sizeof(url_buf) - 1] = '\0';
  http_strip_url_label(url_buf);
  const char *url = url_buf;

  /* Format client address string (will be overridden by X-Forwarded-For if
   * present later) */
  char client_addr_str[NI_MAXHOST + NI_MAXSERV + 4] = "unknown";
  if (c->client_addr_len > 0 && c->client_addr.ss_family == AF_UNIX) {
    snprintf(client_addr_str, sizeof(client_addr_str), "localhost");
  } else if (c->client_addr_len > 0) {
    char hbuf[NI_MAXHOST], sbuf[NI_MAXSERV];
    int r = getnameinfo((struct sockaddr *)&c->client_addr, c->client_addr_len, hbuf, sizeof(hbuf), sbuf, sizeof(sbuf),
                        NI_NUMERICHOST | NI_NUMERICSERV);
    if (r == 0) {
      /* Check if IPv6 address needs brackets */
      if (strchr(hbuf, ':') != NULL) {
        /* IPv6 - wrap in brackets */
        snprintf(client_addr_str, sizeof(client_addr_str), "[%s]:%s", hbuf, sbuf);
      } else {
        /* IPv4 - simple format */
        snprintf(client_addr_str, sizeof(client_addr_str), "%s:%s", hbuf, sbuf);
      }
    }
  }

  logger(LOG_INFO, "New client %s requested URL: %s (method: %s)", client_addr_str, url, c->http_req->method);

  if (url[0] != '/') {
    http_send_400(c);
    return 0;
  }

  /* Parse configured hostname once if needed (extract protocol and host) */
  char protocol[16] = {0};
  char expected_host[256] = {0};

  if (config.hostname != NULL && config.hostname[0] != '\0') {
    /* Parse URL components from config.hostname */
    if (http_parse_url_components(config.hostname, protocol, expected_host, NULL, NULL) != 0) {
      logger(LOG_ERROR, "Failed to parse configured hostname: %s", config.hostname);
      http_send_400(c);
      return 0;
    }

    /* If Host header is missing, reject the request */
    if (c->http_req->hostname[0] == '\0') {
      logger(LOG_WARN, "Client request rejected: missing Host header (expected: %s)", expected_host);
      http_send_400(c);
      return 0;
    }

    /* Match Host header against expected hostname */
    int match_result = http_match_host_header(c->http_req->hostname, expected_host);

    if (match_result < 0) {
      logger(LOG_ERROR, "Failed to match Host header");
      http_send_400(c);
      return 0;
    }

    if (match_result == 0) {
      logger(LOG_WARN,
             "Client request rejected: Host header mismatch (got: %s, "
             "expected: %s)",
             c->http_req->hostname, expected_host);
      http_send_400(c);
      return 0;
    }

    logger(LOG_DEBUG, "Host header validated: %s", c->http_req->hostname);
  }

  /* Override client address with X-Forwarded-For if present and enabled */
  if ((protocol[0] != '\0' || config.xff) && c->http_req->x_forwarded_for[0] != '\0') {
    logger(LOG_INFO, "X-Forwarded-For accepted: %s", c->http_req->x_forwarded_for);
    snprintf(client_addr_str, sizeof(client_addr_str), "%s", c->http_req->x_forwarded_for);
  }

  /* Reject reconnects from an IP that was just force-disconnected */
  {
    int retry_after_sec = 0;
    if (status_client_addr_is_blocked(client_addr_str, &retry_after_sec)) {
      logger(LOG_INFO, "Rejecting client %s: IP temporarily blocked after disconnect", client_addr_str);
      http_send_429(c, retry_after_sec);
      return 0;
    }
  }

  if (strip_app_path_prefix(url, internal_url_buf, sizeof(internal_url_buf)) != 0) {
    http_send_404(c);
    return 0;
  }
  url = internal_url_buf;

  /* Handle CORS preflight (OPTIONS) before r2h-token check */
  if (config.cors_allow_origin && config.cors_allow_origin[0] && strcasecmp(c->http_req->method, "OPTIONS") == 0) {
    char cors_headers[1024];
    int clen = 0;

    clen += snprintf(cors_headers + clen, sizeof(cors_headers) - clen, "Access-Control-Allow-Methods: %s\r\n",
                     c->http_req->access_control_request_method[0] ? c->http_req->access_control_request_method
                                                                   : "GET, HEAD, OPTIONS");
    if (c->http_req->access_control_request_headers[0]) {
      clen += snprintf(cors_headers + clen, sizeof(cors_headers) - clen, "Access-Control-Allow-Headers: %s\r\n",
                       c->http_req->access_control_request_headers);
    }
    clen += snprintf(cors_headers + clen, sizeof(cors_headers) - clen,
                     "Access-Control-Max-Age: 86400\r\n"
                     "Content-Length: 0\r\n");

    send_http_headers(c, STATUS_204, NULL, cors_headers);
    connection_queue_output_and_flush(c, NULL, 0);
    return 0;
  }

  /* Extract service_path and query */
  const char *service_path = url + 1; /* skip leading '/' */
  const char *query_start = strchr(service_path, '?');
  size_t path_len = query_start ? (size_t)(query_start - service_path) : strlen(service_path);

  /* Adjust path_len to exclude trailing slash */
  if (path_len > 0 && service_path[path_len - 1] == '/')
    path_len--;

  /* Handle static assets first (bypass r2h-token validation for /assets/) */
  const char *assets_prefix = "assets/";
  size_t assets_prefix_len = strlen(assets_prefix);
  if (path_len >= assets_prefix_len && strncmp(service_path, assets_prefix, assets_prefix_len) == 0) {
    /* Reconstruct full path with leading slash */
    char asset_path[HTTP_URL_BUFFER_SIZE];
    snprintf(asset_path, sizeof(asset_path), "/%.*s", (int)path_len, service_path);
    handle_embedded_file(c, asset_path);
    return 0;
  }

  /* Check r2h-token if configured (supports URL query, Cookie, User-Agent) */
  if (config.r2h_token != NULL && config.r2h_token[0] != '\0') {
    const char *raw_query_start = strchr(c->http_req->url, '?');
    token_source_t source = validate_r2h_token(c, query_start, raw_query_start);
    if (source == TOKEN_SOURCE_NONE) {
      http_send_401(c);
      return 0;
    }
    /* Set cookie only when token was provided via URL query (first visit) */
    c->should_set_r2h_cookie = (source == TOKEN_SOURCE_QUERY);
  }

  const char *status_manifest_route = "status.webmanifest";
  size_t status_manifest_route_len = strlen(status_manifest_route);
  if (status_manifest_route_len == path_len && strncmp(service_path, status_manifest_route, path_len) == 0) {
    handle_web_app_manifest(c, false);
    return 0;
  }

  const char *player_manifest_route = "player.webmanifest";
  size_t player_manifest_route_len = strlen(player_manifest_route);
  if (player_manifest_route_len == path_len && strncmp(service_path, player_manifest_route, path_len) == 0) {
    handle_web_app_manifest(c, true);
    return 0;
  }

  const char *status_route = config.status_page_route ? config.status_page_route : "status";
  size_t status_route_len = strlen(status_route);
  char status_sse_route[HTTP_URL_BUFFER_SIZE];
  char status_api_prefix[HTTP_URL_BUFFER_SIZE];

  if (status_route_len > 0) {
    snprintf(status_sse_route, sizeof(status_sse_route), "%s/sse", status_route);
    snprintf(status_api_prefix, sizeof(status_api_prefix), "%s/api/", status_route);
  } else {
    strncpy(status_sse_route, "sse", sizeof(status_sse_route) - 1);
    status_sse_route[sizeof(status_sse_route) - 1] = '\0';
    strncpy(status_api_prefix, "api/", sizeof(status_api_prefix) - 1);
    status_api_prefix[sizeof(status_api_prefix) - 1] = '\0';
  }

  if (status_route_len == path_len && strncmp(service_path, status_route, path_len) == 0) {
    handle_embedded_file(c, "/status.html");
    return 0;
  }

  /* Handle player page */
  const char *player_route = config.player_page_route ? config.player_page_route : "player";
  size_t player_route_len = strlen(player_route);
  if (player_route_len == path_len && strncmp(service_path, player_route, path_len) == 0) {
    handle_embedded_file(c, "/player.html");
    return 0;
  }

  /* Handle /playlist.m3u request */
  const char *playlist_route = "playlist.m3u";
  size_t playlist_route_len = strlen(playlist_route);
  if (playlist_route_len == path_len && strncmp(service_path, playlist_route, path_len) == 0) {
    handle_playlist_request(c);
    return 0;
  }

  /* Handle /epg.xml and /epg.xml.gz requests */
  const char *epg_xml_route = "epg.xml";
  const char *epg_xml_gz_route = "epg.xml.gz";
  size_t epg_xml_route_len = strlen(epg_xml_route);
  size_t epg_xml_gz_route_len = strlen(epg_xml_gz_route);
  if (epg_xml_gz_route_len == path_len && strncmp(service_path, epg_xml_gz_route, path_len) == 0) {
    handle_epg_request(c, 1);
    return 0;
  }
  if (epg_xml_route_len == path_len && strncmp(service_path, epg_xml_route, path_len) == 0) {
    handle_epg_request(c, 0);
    return 0;
  }
  size_t status_sse_len = strlen(status_sse_route);
  if (status_sse_len == path_len && strncmp(service_path, status_sse_route, path_len) == 0) {
    /* Delegate SSE initialization to status module */
    return status_handle_sse_init(c);
  }
  size_t status_api_prefix_len = strlen(status_api_prefix);
  if (path_len >= status_api_prefix_len && strncmp(service_path, status_api_prefix, status_api_prefix_len) == 0) {
    const char *api_name = service_path + status_api_prefix_len;
    size_t api_name_len = path_len - status_api_prefix_len;

    if (api_name_len == strlen("disconnect") && strncmp(api_name, "disconnect", api_name_len) == 0) {
      handle_disconnect_client(c);
      return 0;
    }
    if (api_name_len == strlen("log-level") && strncmp(api_name, "log-level", api_name_len) == 0) {
      handle_set_log_level(c);
      return 0;
    }
    if (api_name_len == strlen("clear-logs") && strncmp(api_name, "clear-logs", api_name_len) == 0) {
      handle_clear_logs(c);
      return 0;
    }
    if (api_name_len == strlen("reload-config") && strncmp(api_name, "reload-config", api_name_len) == 0) {
      handle_reload_config(c);
      return 0;
    }
    if (api_name_len == strlen("restart-workers") && strncmp(api_name, "restart-workers", api_name_len) == 0) {
      handle_restart_workers(c);
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

  /* Strip $label suffix from decoded path (used for UI display only) */
  http_strip_url_label(decoded_path);

  /* Match against configured services using O(1) hashmap lookup */
  service = service_hashmap_get(decoded_path);

  /* Dynamic parsing for RTSP and UDPxy if needed */
  if (service == NULL) {
    if (config.udpxy) {
      service = service_create_from_udpxy_url(internal_url_buf);
    }
  } else {
    /* Found configured service (RTP or RTSP) - merge with request query (or
     * just clone the configured service if the request has no query params).
     * service_create_with_query_merge returns NULL strictly on failure (e.g.
     * merged URL too long); silently dropping a failure here would let the
     * connection proceed with the configured service while the user's
     * overrides are discarded, so we treat NULL as a hard error. */
    logger(LOG_INFO, "Service matched: %s", service->url);
    service = service_create_with_query_merge(service, url, service->service_type);
    if (!service) {
      logger(LOG_ERROR, "Failed to merge query params for service");
      http_send_500(c);
      return 0;
    }
  }

  if (!service) {
    http_send_404(c);
    return 0;
  }

  if (c->http_req->user_agent[0]) {
    service->user_agent = strdup(c->http_req->user_agent);
  }

  /* HTTP services forward HEAD upstream unchanged. Multicast HEAD requests
   * return only static metadata. RTSP HEAD performs an asynchronous
   * OPTIONS/DESCRIBE probe without opening media resources. */
  if (strcasecmp(c->http_req->method, "HEAD") == 0 && service->service_type != SERVICE_HTTP) {
    if (service->service_type == SERVICE_RTSP) {
      logger(LOG_INFO, "RTSP HEAD request detected, starting metadata probe");
      if (stream_context_init_rtsp_metadata_probe(&c->stream, c, service, c->epfd) == 0) {
        c->streaming = 1;
        c->service = service;
        c->state = CONN_STREAMING;
        return 0;
      }

      stream_context_cleanup(&c->stream);
      http_send_503(c);
      service_free(service);
      return 0;
    }

    logger(LOG_INFO, "Multicast HEAD request detected, returning static metadata");
    stream_metadata_init(&c->stream.metadata, service);
    stream_send_http_headers(c, "video/mp2t", NULL);
    connection_queue_output_and_flush(c, NULL, 0);
    service_free(service);
    return 0;
  }

  /* Check if this is a snapshot request (X-Request-Snapshot, Accept:
   * image/jpeg, or snapshot=1) */
  /* 1 = snapshot=1, 2 = X-Request-Snapshot or Accept: image/jpeg */
  int is_snapshot_request = 0;

  if (config.video_snapshot) {
    if (c->http_req->x_request_snapshot) {
      is_snapshot_request = 2;
      logger(LOG_INFO, "Snapshot request detected via X-Request-Snapshot header for URL: %s", c->http_req->url);
    }

    if (!is_snapshot_request && c->http_req->accept[0] != '\0') {
      /* Check if Accept header contains "image/jpeg" */
      if (strstr(c->http_req->accept, "image/jpeg") != NULL) {
        is_snapshot_request = 2;
        logger(LOG_INFO, "Snapshot request detected via Accept header for URL: %s", c->http_req->url);
      }
    }

    /* Also check for snapshot=1 query parameter */
    if (!is_snapshot_request && query_start != NULL) {
      char snapshot_value[16];
      if (http_parse_query_param(query_start + 1, "snapshot", snapshot_value, sizeof(snapshot_value)) == 0) {
        if (strcmp(snapshot_value, "1") == 0) {
          is_snapshot_request = 1;
          logger(LOG_INFO, "Snapshot request detected via query parameter for URL: %s", c->http_req->url);
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

    /* Add query parameters if present, excluding r2h-token */
    if (query_start && url_len < sizeof(display_url)) {
      char filtered_query[HTTP_URL_BUFFER_SIZE];
      int filtered_len = http_filter_query_param(query_start + 1, "r2h-token", filtered_query, sizeof(filtered_query));
      if (filtered_len > 0) {
        if (url_len + (size_t)filtered_len + 1 < sizeof(display_url)) {
          display_url[url_len++] = '?';
          memcpy(display_url + url_len, filtered_query, (size_t)filtered_len);
          url_len += (size_t)filtered_len;
        }
      }
    }

    display_url[url_len] = '\0';

    c->status_index = status_register_client(client_addr_str, display_url);
    if (c->status_index < 0) {
      http_send_503(c);
      service_free(service);
      return 0;
    } else {
      access_log_write_connection(c, service, c->status_index);
    }
  } else {
    c->status_index = -1;
  }

  /* Headers will be sent lazily when first data is ready (or 503 on timeout) */
  /* Snapshots send JPEG headers after conversion */

  /* Initialize stream in unified epoll (works for both streaming and snapshot)
   */
  if (stream_context_init_for_worker(&c->stream, c, service, c->epfd, c->status_index, is_snapshot_request) == 0) {
    if (!is_snapshot_request && !c->stream_registered) {
      send_buffer_register_stream_client();
      c->stream_registered = 1;
    }

    c->streaming = 1;
    c->service = service;
    c->state = CONN_STREAMING;
    c->buffer_class = CONNECTION_BUFFER_MEDIA;
    return 0;
  } else {
    /* Initialization can allocate protocol state before failing. */
    stream_context_cleanup(&c->stream);
    /* Stream initialization failed - send 503 if headers not sent yet */
    if (!c->headers_sent) {
      http_send_503(c);
    }
    service_free(service);
    c->state = CONN_CLOSING;
    return -1;
  }
}

int connection_queue_buffer(connection_t *c, buffer_ref_t *buf_ref) {
  if (!c || !buf_ref || buf_ref->data_size == 0)
    return 0;

  int64_t now_ms = get_time_ms();
  size_t limit_bytes = connection_update_queue_limit(c, now_ms);
  size_t queued_bytes = connection_queue_bytes(c);
  size_t projected_bytes = queued_bytes + buffer_ref_capacity(buf_ref);

  c->queue_limit_bytes = limit_bytes;

  if (projected_bytes > limit_bytes) {
    connection_record_drop(c, buf_ref->data_size);

    if (c->dropped_packets == 1 || (c->dropped_packets % 200) == 0) {
      logger(LOG_DEBUG,
             "Backpressure: dropping %zu bytes for client fd=%d (queued=%zu "
             "limit=%zu drops=%llu)",
             buf_ref->data_size, c->fd, queued_bytes, limit_bytes, (unsigned long long)c->dropped_packets);
    }

    return -1;
  }

  /* Add to buffered output queue with offset information */
  int ret = send_queue_add(&c->send_queue, buf_ref);
  if (ret < 0)
    return -1; /* Queue full */

  if (queued_bytes > c->queue_bytes_highwater)
    c->queue_bytes_highwater = queued_bytes;

  if (c->send_queue.num_queued > c->queue_buffers_highwater)
    c->queue_buffers_highwater = c->send_queue.num_queued;

  /* Batching optimization: Only enable EPOLLOUT when flush threshold is reached
   * Benefits:
   * - Reduces sendmsg() syscall overhead (fewer calls)
   * - Better batching with iovec (up to 64 packets per sendmsg)
   * - Lower latency impact (100ms is acceptable for streaming)
   */
  if (send_queue_should_flush(&c->send_queue)) {
    connection_schedule_write(c);
  }

  return 0;
}

int connection_queue_file(connection_t *c, int file_fd, off_t file_offset, size_t file_size) {
  if (!c || file_fd < 0 || file_size == 0)
    return -1;

  /* Add file to buffered output queue */
  int ret = send_queue_add_file(&c->send_queue, file_fd, file_offset, file_size);
  if (ret < 0)
    return -1;

  /* Always flush immediately for file sends (no batching) */
  connection_schedule_write(c);

  /* Set connection to closing state after file transfer */
  c->state = CONN_CLOSING;

  return 0;
}

/* Handle /playlist.m3u request - serve dynamically generated M3U playlist */
static void handle_playlist_request(connection_t *c) {
  char *playlist = NULL;
  size_t playlist_len;
  char extra_headers[512];
  const char *etag;

  if (!c)
    return;

  /* Get ETag for the half-transformed playlist (for caching) */
  etag = m3u_get_etag();

  /* Check ETag and send 304 if it matches */
  if (http_check_etag_and_send_304(c, etag, "audio/x-mpegurl")) {
    return;
  }

  /* Generate complete playlist dynamically */
  playlist =
      m3u_generate_playlist(c->http_req->hostname, c->http_req->x_forwarded_host, c->http_req->x_forwarded_proto);

  if (!playlist) {
    /* No playlist available or generation failed */
    http_send_404(c);
    return;
  }

  playlist_len = strlen(playlist);

  /* Build headers with ETag support */
  http_build_etag_headers(extra_headers, sizeof(extra_headers), playlist_len, etag, NULL);

  send_http_headers(c, STATUS_200, "audio/x-mpegurl", extra_headers);
  connection_queue_output_and_flush(c, (const uint8_t *)playlist, playlist_len);

  /* Free the dynamically generated playlist */
  free(playlist);
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
  http_build_etag_headers(extra_headers, sizeof(extra_headers), epg_size, etag, content_encoding);

  send_http_headers(c, STATUS_200, content_type, extra_headers);

  /* Use sendfile to transmit cached data
   * Note: epg_fd is owned by EPG cache, so we need to dup it
   * send_queue_add_file will close the fd when done */
  int dup_fd = dup(epg_fd);
  if (dup_fd < 0) {
    logger(LOG_ERROR, "Failed to dup EPG fd for file transmission: %s", strerror(errno));
    c->state = CONN_CLOSING;
    return;
  }

  /* Queue the file for file transmission */
  if (connection_queue_file(c, dup_fd, 0, epg_size) < 0) {
    logger(LOG_ERROR, "Failed to queue EPG file for file transmission");
    close(dup_fd);
    c->state = CONN_CLOSING;
    return;
  }
}
