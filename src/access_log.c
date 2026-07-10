#include "access_log.h"
#include "configuration.h"
#include "connection.h"
#include "service.h"
#include "status.h"
#include "utils.h"
#include <ctype.h>
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

#ifndef O_CLOEXEC
#define O_CLOEXEC 0
#endif

#define ACCESS_LOG_INITIAL_CAPACITY 512
#define ACCESS_LOG_MAX_LINE 8192

typedef struct {
  char *data;
  size_t len;
  size_t cap;
  int truncated;
} access_log_buffer_t;

static int access_log_fd = -1;
static char *access_log_open_path = NULL;
static char *access_log_last_failed_path = NULL;

static void access_log_close_fd(void) {
  if (access_log_fd >= 0) {
    close(access_log_fd);
    access_log_fd = -1;
  }
  if (access_log_open_path) {
    free(access_log_open_path);
    access_log_open_path = NULL;
  }
}

void access_log_cleanup(void) {
  access_log_close_fd();
  if (access_log_last_failed_path) {
    free(access_log_last_failed_path);
    access_log_last_failed_path = NULL;
  }
}

void access_log_reopen(void) { access_log_cleanup(); }

static int access_log_set_cloexec(int fd) {
#if O_CLOEXEC == 0 && defined(FD_CLOEXEC)
  int flags = fcntl(fd, F_GETFD);
  if (flags < 0)
    return -1;
  if (fcntl(fd, F_SETFD, flags | FD_CLOEXEC) < 0)
    return -1;
#else
  (void)fd;
#endif
  return 0;
}

static int access_log_ensure_fd(const char *path) {
  if (!path || path[0] == '\0')
    return -1;

  if (access_log_fd >= 0 && access_log_open_path && strcmp(access_log_open_path, path) == 0)
    return access_log_fd;

  access_log_close_fd();

  int fd = open(path, O_WRONLY | O_CREAT | O_APPEND | O_CLOEXEC, 0644);
  if (fd < 0) {
    if (!access_log_last_failed_path || strcmp(access_log_last_failed_path, path) != 0) {
      logger(LOG_ERROR, "Failed to open access log %s: %s", path, strerror(errno));
      free(access_log_last_failed_path);
      access_log_last_failed_path = strdup(path);
    }
    return -1;
  }

  if (access_log_set_cloexec(fd) < 0) {
    logger(LOG_ERROR, "Failed to set access log close-on-exec flag for %s: %s", path, strerror(errno));
    close(fd);
    return -1;
  }

  access_log_fd = fd;
  access_log_open_path = strdup(path);
  if (!access_log_open_path) {
    logger(LOG_ERROR, "Failed to store access log path");
    access_log_close_fd();
    return -1;
  }

  if (access_log_last_failed_path) {
    free(access_log_last_failed_path);
    access_log_last_failed_path = NULL;
  }

  return access_log_fd;
}

static int access_log_buffer_init(access_log_buffer_t *buf) {
  buf->data = malloc(ACCESS_LOG_INITIAL_CAPACITY);
  if (!buf->data)
    return -1;
  buf->len = 0;
  buf->cap = ACCESS_LOG_INITIAL_CAPACITY;
  buf->truncated = 0;
  buf->data[0] = '\0';
  return 0;
}

static void access_log_buffer_free(access_log_buffer_t *buf) {
  free(buf->data);
  buf->data = NULL;
  buf->len = 0;
  buf->cap = 0;
}

static int access_log_buffer_reserve(access_log_buffer_t *buf, size_t extra) {
  if (buf->truncated)
    return 0;

  if (extra > ACCESS_LOG_MAX_LINE - buf->len - 1) {
    extra = ACCESS_LOG_MAX_LINE - buf->len - 1;
    buf->truncated = 1;
  }

  size_t need = buf->len + extra + 1;
  if (need <= buf->cap)
    return 0;

  size_t next_cap = buf->cap;
  while (next_cap < need && next_cap < ACCESS_LOG_MAX_LINE)
    next_cap *= 2;
  if (next_cap > ACCESS_LOG_MAX_LINE)
    next_cap = ACCESS_LOG_MAX_LINE;

  char *next = realloc(buf->data, next_cap);
  if (!next)
    return -1;
  buf->data = next;
  buf->cap = next_cap;
  return 0;
}

static int access_log_append_mem(access_log_buffer_t *buf, const char *value, size_t len) {
  if (!value || len == 0 || buf->truncated)
    return 0;

  size_t writable = len;
  if (writable > ACCESS_LOG_MAX_LINE - buf->len - 1) {
    writable = ACCESS_LOG_MAX_LINE - buf->len - 1;
    buf->truncated = 1;
  }

  if (access_log_buffer_reserve(buf, writable) < 0)
    return -1;

  memcpy(buf->data + buf->len, value, writable);
  buf->len += writable;
  buf->data[buf->len] = '\0';
  return 0;
}

static int access_log_append_string(access_log_buffer_t *buf, const char *value) {
  if (!value)
    return 0;
  return access_log_append_mem(buf, value, strlen(value));
}

static int access_log_append_char(access_log_buffer_t *buf, char value) {
  return access_log_append_mem(buf, &value, 1);
}

static int access_log_append_escaped(access_log_buffer_t *buf, const char *value) {
  static const char hex[] = "0123456789ABCDEF";

  if (!value || value[0] == '\0')
    return access_log_append_char(buf, '-');

  for (const unsigned char *p = (const unsigned char *)value; *p; p++) {
    char tmp[4];

    switch (*p) {
    case '\\':
      if (access_log_append_string(buf, "\\\\") < 0)
        return -1;
      break;
    case '"':
      if (access_log_append_string(buf, "\\\"") < 0)
        return -1;
      break;
    case '\n':
      if (access_log_append_string(buf, "\\n") < 0)
        return -1;
      break;
    case '\r':
      if (access_log_append_string(buf, "\\r") < 0)
        return -1;
      break;
    case '\t':
      if (access_log_append_string(buf, "\\t") < 0)
        return -1;
      break;
    default:
      if (*p < 0x20 || *p == 0x7f) {
        tmp[0] = '\\';
        tmp[1] = 'x';
        tmp[2] = hex[*p >> 4];
        tmp[3] = hex[*p & 0x0f];
        if (access_log_append_mem(buf, tmp, sizeof(tmp)) < 0)
          return -1;
      } else {
        if (access_log_append_char(buf, (char)*p) < 0)
          return -1;
      }
      break;
    }
  }

  return 0;
}

static const char *access_log_service_type_name(service_t *service) {
  if (!service)
    return "-";

  switch (service->service_type) {
  case SERVICE_MRTP:
    return "rtp";
  case SERVICE_RTSP:
    return "rtsp";
  case SERVICE_HTTP:
    return "http";
  default:
    return "-";
  }
}

static const char *access_log_upstream_url(service_t *service) {
  if (!service)
    return NULL;

  switch (service->service_type) {
  case SERVICE_MRTP:
    return service->rtp_url ? service->rtp_url : service->url;
  case SERVICE_RTSP:
    return service->rtsp_url ? service->rtsp_url : service->url;
  case SERVICE_HTTP:
    return service->http_url ? service->http_url : service->url;
  default:
    return service->url;
  }
}

static long access_log_timezone_offset_seconds(const struct tm *local_tm) {
#if defined(__linux__) || defined(__APPLE__) || defined(__FreeBSD__)
  return local_tm->tm_gmtoff;
#else
  (void)local_tm;
  return 0;
#endif
}

static void access_log_format_times(int64_t now_ms, char *time_iso8601, size_t time_iso8601_size, char *time_local,
                                    size_t time_local_size, char *msec, size_t msec_size) {
  time_t now_sec = (time_t)(now_ms / 1000);
  int millis = (int)(now_ms % 1000);
  struct tm local_tm;
  long offset;
  char sign;
  long abs_offset;
  static const char month_names[] = "JanFebMarAprMayJunJulAugSepOctNovDec";

  if (millis < 0)
    millis = 0;

  if (!localtime_r(&now_sec, &local_tm)) {
    snprintf(time_iso8601, time_iso8601_size, "-");
    snprintf(time_local, time_local_size, "-");
    snprintf(msec, msec_size, "%lld.%03d", (long long)now_sec, millis);
    return;
  }

  offset = access_log_timezone_offset_seconds(&local_tm);
  sign = offset >= 0 ? '+' : '-';
  abs_offset = offset >= 0 ? offset : -offset;

  snprintf(time_iso8601, time_iso8601_size, "%04d-%02d-%02dT%02d:%02d:%02d%c%02ld:%02ld", local_tm.tm_year + 1900,
           local_tm.tm_mon + 1, local_tm.tm_mday, local_tm.tm_hour, local_tm.tm_min, local_tm.tm_sec, sign,
           abs_offset / 3600, (abs_offset % 3600) / 60);
  snprintf(time_local, time_local_size, "%02d/%.3s/%04d:%02d:%02d:%02d %c%02ld%02ld", local_tm.tm_mday,
           &month_names[local_tm.tm_mon * 3], local_tm.tm_year + 1900, local_tm.tm_hour, local_tm.tm_min,
           local_tm.tm_sec, sign, abs_offset / 3600, (abs_offset % 3600) / 60);
  snprintf(msec, msec_size, "%lld.%03d", (long long)now_sec, millis);
}

static void access_log_parse_remote_addr(const char *client_addr, char *remote_addr, size_t remote_addr_size,
                                         char *remote_port, size_t remote_port_size) {
  remote_addr[0] = '\0';
  remote_port[0] = '\0';

  if (!client_addr || client_addr[0] == '\0') {
    return;
  }

  if (client_addr[0] == '[') {
    const char *end = strchr(client_addr, ']');
    if (end) {
      size_t addr_len = (size_t)(end - client_addr - 1);
      if (addr_len >= remote_addr_size)
        addr_len = remote_addr_size - 1;
      memcpy(remote_addr, client_addr + 1, addr_len);
      remote_addr[addr_len] = '\0';
      if (end[1] == ':' && end[2] != '\0') {
        strncpy(remote_port, end + 2, remote_port_size - 1);
        remote_port[remote_port_size - 1] = '\0';
      }
      return;
    }
  }

  const char *last_colon = strrchr(client_addr, ':');
  if (last_colon && strchr(client_addr, ':') == last_colon) {
    size_t addr_len = (size_t)(last_colon - client_addr);
    if (addr_len >= remote_addr_size)
      addr_len = remote_addr_size - 1;
    memcpy(remote_addr, client_addr, addr_len);
    remote_addr[addr_len] = '\0';
    strncpy(remote_port, last_colon + 1, remote_port_size - 1);
    remote_port[remote_port_size - 1] = '\0';
  } else {
    strncpy(remote_addr, client_addr, remote_addr_size - 1);
    remote_addr[remote_addr_size - 1] = '\0';
  }
}

static int access_log_append_placeholder(access_log_buffer_t *buf, const char *name, size_t name_len, connection_t *c,
                                         service_t *service, const client_stats_payload_t *client, pid_t worker_pid,
                                         const char *time_iso8601, const char *time_local, const char *msec,
                                         const char *remote_addr, const char *remote_port, const char *request) {
  char numeric[64];
  char filtered_user_agent[sizeof(c->http_req.user_agent)];

#define MATCH(name_literal) (name_len == strlen(name_literal) && strncmp(name, name_literal, name_len) == 0)

  if (MATCH("time_iso8601"))
    return access_log_append_escaped(buf, time_iso8601);
  if (MATCH("time_local"))
    return access_log_append_escaped(buf, time_local);
  if (MATCH("msec"))
    return access_log_append_escaped(buf, msec);
  if (MATCH("client_addr"))
    return access_log_append_escaped(buf, client->client_addr);
  if (MATCH("remote_addr"))
    return access_log_append_escaped(buf, remote_addr);
  if (MATCH("remote_port"))
    return access_log_append_escaped(buf, remote_port);
  if (MATCH("worker_pid")) {
    snprintf(numeric, sizeof(numeric), "%d", (int)worker_pid);
    return access_log_append_escaped(buf, numeric);
  }
  if (MATCH("request"))
    return access_log_append_escaped(buf, request);
  if (MATCH("request_method"))
    return access_log_append_escaped(buf, c->http_req.method);
  if (MATCH("service_url"))
    return access_log_append_escaped(buf, client->service_url);
  if (MATCH("host"))
    return access_log_append_escaped(buf, c->http_req.hostname);
  if (MATCH("http_user_agent")) {
    if (http_filter_user_agent_token(c->http_req.user_agent, filtered_user_agent, sizeof(filtered_user_agent)) < 0)
      filtered_user_agent[0] = '\0';
    return access_log_append_escaped(buf, filtered_user_agent);
  }
  if (MATCH("http_x_forwarded_for"))
    return access_log_append_escaped(buf, c->http_req.x_forwarded_for);
  if (MATCH("service_type"))
    return access_log_append_escaped(buf, access_log_service_type_name(service));
  if (MATCH("upstream_url"))
    return access_log_append_escaped(buf, access_log_upstream_url(service));

  if (access_log_append_char(buf, '$') < 0)
    return -1;
  return access_log_append_mem(buf, name, name_len);

#undef MATCH
}

static int access_log_render(access_log_buffer_t *buf, connection_t *c, service_t *service,
                             const client_stats_payload_t *client, pid_t worker_pid, const char *format) {
  char time_iso8601[64];
  char time_local[64];
  char msec[32];
  char remote_addr[128];
  char remote_port[32];
  char request[HTTP_URL_BUFFER_SIZE + 32];
  int64_t now_ms = get_realtime_ms();

  access_log_format_times(now_ms, time_iso8601, sizeof(time_iso8601), time_local, sizeof(time_local), msec,
                          sizeof(msec));
  access_log_parse_remote_addr(client->client_addr, remote_addr, sizeof(remote_addr), remote_port, sizeof(remote_port));
  snprintf(request, sizeof(request), "%s %s", c->http_req.method[0] ? c->http_req.method : "-", client->service_url);

  for (const char *p = format; *p; p++) {
    if (*p != '$') {
      if (access_log_append_char(buf, *p) < 0)
        return -1;
      continue;
    }

    if (p[1] == '$') {
      if (access_log_append_char(buf, '$') < 0)
        return -1;
      p++;
      continue;
    }

    if (!(isalpha((unsigned char)p[1]) || p[1] == '_')) {
      if (access_log_append_char(buf, '$') < 0)
        return -1;
      continue;
    }

    const char *name = p + 1;
    const char *end = name;
    while (isalnum((unsigned char)*end) || *end == '_')
      end++;

    if (access_log_append_placeholder(buf, name, (size_t)(end - name), c, service, client, worker_pid, time_iso8601,
                                      time_local, msec, remote_addr, remote_port, request) < 0) {
      return -1;
    }
    p = end - 1;
  }

  if (access_log_append_char(buf, '\n') < 0)
    return -1;
  return 0;
}

static int access_log_write_line(int fd, const char *data, size_t len) {
  ssize_t written;

  do {
    written = write(fd, data, len);
  } while (written < 0 && errno == EINTR);

  if (written < 0)
    return -1;
  if ((size_t)written != len) {
    errno = EIO;
    return -1;
  }
  return 0;
}

void access_log_write_connection(connection_t *c, service_t *service, int status_index) {
  if (!c || !service || !config.access_log || config.access_log[0] == '\0' || !status_shared)
    return;

  if (status_index < 0 || status_index >= STATUS_MAX_CLIENTS)
    return;

  client_stats_t *client = &status_shared->clients[status_index];
  if (!atomic_load_explicit(&client->active, memory_order_acquire) || client->payload.service_url[0] == '\0')
    return;
  pid_t owner_pid = (pid_t)atomic_load_explicit(&client->owner_pid, memory_order_relaxed);

  int fd = access_log_ensure_fd(config.access_log);
  if (fd < 0)
    return;

  const char *format =
      (config.log_format && config.log_format[0] != '\0') ? config.log_format : DEFAULT_ACCESS_LOG_FORMAT;

  access_log_buffer_t buf;
  if (access_log_buffer_init(&buf) < 0) {
    logger(LOG_ERROR, "Failed to allocate access log buffer");
    return;
  }

  if (access_log_render(&buf, c, service, &client->payload, owner_pid, format) < 0) {
    logger(LOG_ERROR, "Failed to render access log line");
    access_log_buffer_free(&buf);
    return;
  }

  if (access_log_write_line(fd, buf.data, buf.len) < 0) {
    logger(LOG_ERROR, "Failed to write access log %s: %s", config.access_log, strerror(errno));
    access_log_close_fd();
  }

  access_log_buffer_free(&buf);
}
