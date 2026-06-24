#include "utils.h"
#include "configuration.h"
#include "http.h"
#include "m3u.h"
#include "platform_compat.h"
#include "rtp2httpd.h"
#include "status.h"
#include "supervisor.h"
#include <arpa/inet.h>
#include <errno.h>
#include <ifaddrs.h>
#include <net/if.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <time.h>

/**
 * Get current monotonic time in milliseconds.
 * Uses CLOCK_MONOTONIC for high precision and immunity to system clock changes.
 * Thread-safe.
 *
 * @return Current time in milliseconds since an unspecified starting point
 */
int64_t get_time_ms(void) {
  struct timespec ts;
  if (clock_gettime(CLOCK_MONOTONIC, &ts) != 0) {
    /* Fallback to CLOCK_REALTIME if MONOTONIC is not available */
    if (clock_gettime(CLOCK_REALTIME, &ts) != 0) {
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
 * @return Current time in milliseconds since Unix epoch (1970-01-01 00:00:00
 * UTC)
 */
int64_t get_realtime_ms(void) {
  struct timespec ts;
  if (clock_gettime(CLOCK_REALTIME, &ts) != 0) {
    return 0;
  }
  return (int64_t)ts.tv_sec * 1000LL + ts.tv_nsec / 1000000LL;
}

size_t json_escaped_len(const char *value) {
  size_t len = 0;

  if (!value)
    return 0;

  for (const unsigned char *p = (const unsigned char *)value; *p; p++) {
    switch (*p) {
    case '"':
    case '\\':
      len += 2;
      break;
    case '\b':
    case '\f':
    case '\n':
    case '\r':
    case '\t':
      len += 2;
      break;
    case '<':
    case '>':
    case '&':
      len += 6;
      break;
    default:
      len += (*p < 0x20) ? 6 : 1;
      break;
    }
  }

  return len;
}

static size_t json_escape_char(unsigned char c, char *out, size_t out_size) {
  static const char hex[] = "0123456789abcdef";

  switch (c) {
  case '"':
  case '\\':
    if (out_size < 2)
      return 0;
    out[0] = '\\';
    out[1] = (char)c;
    return 2;
  case '\b':
    if (out_size < 2)
      return 0;
    out[0] = '\\';
    out[1] = 'b';
    return 2;
  case '\f':
    if (out_size < 2)
      return 0;
    out[0] = '\\';
    out[1] = 'f';
    return 2;
  case '\n':
    if (out_size < 2)
      return 0;
    out[0] = '\\';
    out[1] = 'n';
    return 2;
  case '\r':
    if (out_size < 2)
      return 0;
    out[0] = '\\';
    out[1] = 'r';
    return 2;
  case '\t':
    if (out_size < 2)
      return 0;
    out[0] = '\\';
    out[1] = 't';
    return 2;
  case '<':
    if (out_size < 6)
      return 0;
    memcpy(out, "\\u003c", 6);
    return 6;
  case '>':
    if (out_size < 6)
      return 0;
    memcpy(out, "\\u003e", 6);
    return 6;
  case '&':
    if (out_size < 6)
      return 0;
    memcpy(out, "\\u0026", 6);
    return 6;
  default:
    if (c < 0x20) {
      if (out_size < 6)
        return 0;
      memcpy(out, "\\u00", 4);
      out[4] = hex[c >> 4];
      out[5] = hex[c & 0x0f];
      return 6;
    }

    if (out_size < 1)
      return 0;
    out[0] = (char)c;
    return 1;
  }
}

char *json_escape_string(const char *value) {
  size_t len = json_escaped_len(value);
  char *result = malloc(len + 1);
  char *out = result;

  if (!result)
    return NULL;

  for (const unsigned char *p = (const unsigned char *)value; value && *p; p++) {
    size_t written = json_escape_char(*p, out, len - (size_t)(out - result));
    out += written;
  }
  *out = '\0';

  return result;
}

void json_escape_string_to_buffer(const char *value, char *out, size_t out_size) {
  char *dst = out;

  if (!out || out_size == 0)
    return;

  for (const unsigned char *p = (const unsigned char *)value; value && *p; p++) {
    size_t used = (size_t)(dst - out);
    size_t remaining = out_size - used - 1;
    size_t written = json_escape_char(*p, dst, remaining);
    if (written == 0)
      break;
    dst += written;
  }
  *dst = '\0';
}

/**
 * Set socket receive buffer size, trying SO_RCVBUFFORCE first.
 * SO_RCVBUFFORCE can exceed system limits but requires CAP_NET_ADMIN.
 * Falls back to SO_RCVBUF if SO_RCVBUFFORCE fails.
 *
 * @param fd Socket file descriptor
 * @param size Desired receive buffer size in bytes
 * @return 0 on success, -1 on failure
 */
int set_socket_rcvbuf(int fd, int size) {
  int r;

  /* Try SO_RCVBUFFORCE first (requires CAP_NET_ADMIN, can exceed rmem_max) */
  r = setsockopt(fd, SOL_SOCKET, SO_RCVBUFFORCE, &size, sizeof(size));
  if (r == 0) {
    return 0;
  }

  /* Fall back to SO_RCVBUF (limited by rmem_max) */
  r = setsockopt(fd, SOL_SOCKET, SO_RCVBUF, &size, sizeof(size));
  if (r < 0) {
    return -1;
  }

  return 0;
}

/**
 * Logger function. Show the message if current verbosity is above
 * logged level.
 *
 * @param level Message log level
 * @param format printf style format string
 * @return errno or return of fputs
 */
int logger(loglevel_t level, const char *format, ...) {
  va_list ap;
  char message[1024];
  int prefix_len, body_written, ret;
  size_t avail, body_len;
  loglevel_t current_level;

  current_level = status_shared ? status_shared->current_log_level : config.verbosity;
  if (current_level < level) {
    return 0;
  }

  if (worker_id == SUPERVISOR_WORKER_ID) {
    prefix_len = snprintf(message, sizeof(message), "[Supervisor] ");
  } else {
    prefix_len = snprintf(message, sizeof(message), "[Worker %d] ", worker_id);
  }
  if (prefix_len < 0 || (size_t)prefix_len >= sizeof(message) - 2) {
    return -1;
  }
  avail = sizeof(message) - (size_t)prefix_len;

  va_start(ap, format);
  body_written = vsnprintf(message + prefix_len, avail, format, ap);
  va_end(ap);
  if (body_written < 0) {
    return body_written;
  }

  /* Clamp on truncation: vsnprintf returns the length it *would* have written. */
  body_len = ((size_t)body_written >= avail) ? avail - 1 : (size_t)body_written;

  /* Ensure the buffer ends with '\n'. Decision is based on the actual buffer
   * content (not the format string), so a trailing '\n' lost to truncation is
   * still appended back, while a '\n' already present is not duplicated. */
  if (body_len == 0 || message[prefix_len + body_len - 1] != '\n') {
    if ((size_t)prefix_len + body_len + 2 > sizeof(message)) {
      body_len--; /* No room — sacrifice the last body char to fit '\n\0'. */
    }
    message[prefix_len + body_len++] = '\n';
    message[prefix_len + body_len] = '\0';
  }

  /* Flush immediately, otherwise syslogd/journald timestamps drift and
   * startup-time logs may not appear at all. */
  ret = fputs(message, stdout);
  fflush(stdout);

  status_add_log_entry(level, message);

  return ret;
}

void bind_to_upstream_interface(int sock, const char *ifname) {
  if (ifname && ifname[0] != '\0') {
    if (platform_bind_to_device(sock, ifname) < 0) {
      logger(LOG_ERROR, "Failed to bind to upstream interface %s: %s", ifname, strerror(errno));
    }
  }
}

const char *get_upstream_interface_for_fcc(const char *override, const char *override_fcc) {
  /* Priority: override_fcc > override > upstream_interface_fcc >
   * upstream_interface */
  if (override_fcc && override_fcc[0] != '\0') {
    return override_fcc;
  }
  if (override && override[0] != '\0') {
    return override;
  }
  if (config.upstream_interface_fcc[0] != '\0') {
    return config.upstream_interface_fcc;
  }
  if (config.upstream_interface[0] != '\0') {
    return config.upstream_interface;
  }
  return NULL;
}

const char *get_upstream_interface_for_rtsp(const char *override) {
  /* Priority: override > upstream_interface_rtsp > upstream_interface */
  if (override && override[0] != '\0') {
    return override;
  }
  if (config.upstream_interface_rtsp[0] != '\0') {
    return config.upstream_interface_rtsp;
  }
  if (config.upstream_interface[0] != '\0') {
    return config.upstream_interface;
  }
  return NULL;
}

const char *get_upstream_interface_for_multicast(const char *override) {
  /* Priority: override > upstream_interface_multicast > upstream_interface */
  if (override && override[0] != '\0') {
    return override;
  }
  if (config.upstream_interface_multicast[0] != '\0') {
    return config.upstream_interface_multicast;
  }
  if (config.upstream_interface[0] != '\0') {
    return config.upstream_interface;
  }
  return NULL;
}

const char *get_upstream_interface_for_http(const char *override) {
  /* Priority: override > upstream_interface_http > upstream_interface */
  if (override && override[0] != '\0') {
    return override;
  }
  if (config.upstream_interface_http[0] != '\0') {
    return config.upstream_interface_http;
  }
  if (config.upstream_interface[0] != '\0') {
    return config.upstream_interface;
  }
  return NULL;
}

/**
 * Get local IP address for FCC packets
 * Priority: upstream_interface_fcc > upstream_interface > first non-loopback IP
 */
uint32_t get_local_ip_for_fcc(const char *override, const char *override_fcc) {
  const char *ifname = get_upstream_interface_for_fcc(override, override_fcc);
  struct ifaddrs *ifaddr, *ifa;
  uint32_t local_ip = 0;

  if (getifaddrs(&ifaddr) == -1) {
    logger(LOG_ERROR, "getifaddrs failed: %s", strerror(errno));
    return 0;
  }

  /* If specific interface is configured, get its IP */
  if (ifname && ifname[0] != '\0') {
    for (ifa = ifaddr; ifa != NULL; ifa = ifa->ifa_next) {
      if (ifa->ifa_addr == NULL)
        continue;

      if (ifa->ifa_addr->sa_family == AF_INET && strcmp(ifa->ifa_name, ifname) == 0) {
        struct sockaddr_in *addr = (struct sockaddr_in *)(uintptr_t)ifa->ifa_addr;
        local_ip = ntohl(addr->sin_addr.s_addr);
        logger(LOG_DEBUG, "FCC: Using local IP from interface %s: %u.%u.%u.%u", ifname, (local_ip >> 24) & 0xFF,
               (local_ip >> 16) & 0xFF, (local_ip >> 8) & 0xFF, local_ip & 0xFF);
        break;
      }
    }
  }

  /* Fallback: Get first non-loopback IPv4 address */
  if (local_ip == 0) {
    for (ifa = ifaddr; ifa != NULL; ifa = ifa->ifa_next) {
      if (ifa->ifa_addr == NULL)
        continue;

      if (ifa->ifa_addr->sa_family == AF_INET) {
        struct sockaddr_in *addr = (struct sockaddr_in *)(uintptr_t)ifa->ifa_addr;
        uint32_t ip = ntohl(addr->sin_addr.s_addr);

        /* Skip loopback (127.0.0.0/8) */
        if ((ip >> 24) != 127) {
          local_ip = ip;
          logger(LOG_DEBUG, "FCC: Using first non-loopback IP from interface %s: %u.%u.%u.%u", ifa->ifa_name,
                 (local_ip >> 24) & 0xFF, (local_ip >> 16) & 0xFF, (local_ip >> 8) & 0xFF, local_ip & 0xFF);
          break;
        }
      }
    }
  }

  freeifaddrs(ifaddr);

  if (local_ip == 0) {
    logger(LOG_WARN, "FCC: Could not determine local IP address");
  }

  return local_ip;
}

int host_needs_brackets(const char *host) {
  if (!host || host[0] == '\0' || host[0] == '[')
    return 0;
  return strchr(host, ':') != NULL;
}

int format_host_for_url(const char *host, char *out, size_t out_size) {
  int written;

  if (!host || !out || out_size == 0)
    return -1;

  if (host_needs_brackets(host)) {
    written = snprintf(out, out_size, "[%s]", host);
  } else {
    written = snprintf(out, out_size, "%s", host);
  }

  return (written < 0 || (size_t)written >= out_size) ? -1 : 0;
}

int format_host_port_for_url(const char *host, int port, int default_port, char *out, size_t out_size) {
  char bracketed[512];
  int written;

  if (!host || !out || out_size == 0)
    return -1;

  if (format_host_for_url(host, bracketed, sizeof(bracketed)) < 0)
    return -1;

  if (default_port > 0 && port == default_port) {
    written = snprintf(out, out_size, "%s", bracketed);
  } else {
    written = snprintf(out, out_size, "%s:%d", bracketed, port);
  }

  return (written < 0 || (size_t)written >= out_size) ? -1 : 0;
}

int parse_host_port(const char *input, char *host, size_t host_size, int *port) {
  size_t host_len;
  const char *port_str = NULL;

  if (!input || !host || host_size == 0)
    return -1;

  if (input[0] == '[') {
    /* Bracketed IPv6 literal: [addr][:port] */
    const char *closing = strchr(input, ']');
    if (!closing)
      return -1;
    host_len = (size_t)(closing - input - 1);
    if (host_len == 0 || host_len >= host_size)
      return -1;
    memcpy(host, input + 1, host_len);
    host[host_len] = '\0';
    if (closing[1] == ':') {
      port_str = closing + 2;
    } else if (closing[1] != '\0') {
      return -1;
    }
  } else {
    const char *first_colon = strchr(input, ':');
    if (first_colon && strchr(first_colon + 1, ':')) {
      /* Multiple colons: bare IPv6 literal without port */
      host_len = strlen(input);
      if (host_len >= host_size)
        return -1;
      memcpy(host, input, host_len + 1);
    } else if (first_colon) {
      /* hostname:port or IPv4:port */
      host_len = (size_t)(first_colon - input);
      if (host_len == 0 || host_len >= host_size)
        return -1;
      memcpy(host, input, host_len);
      host[host_len] = '\0';
      port_str = first_colon + 1;
    } else {
      host_len = strlen(input);
      if (host_len == 0 || host_len >= host_size)
        return -1;
      memcpy(host, input, host_len + 1);
    }
  }

  if (port_str && *port_str && port) {
    char *end = NULL;
    long parsed = strtol(port_str, &end, 10);
    if (end == port_str || *end != '\0' || parsed <= 0 || parsed > 65535)
      return -1;
    *port = (int)parsed;
  }

  return 0;
}

void sockaddr_set_port(struct sockaddr *sa, uint16_t port) {
  if (!sa)
    return;
  if (sa->sa_family == AF_INET) {
    ((struct sockaddr_in *)(uintptr_t)sa)->sin_port = htons(port);
  } else if (sa->sa_family == AF_INET6) {
    ((struct sockaddr_in6 *)(uintptr_t)sa)->sin6_port = htons(port);
  }
}

char *build_proxy_base_url(const char *host_header, const char *x_forwarded_host, const char *x_forwarded_proto) {
  const char *host = NULL;
  const char *proto = "http";
  char *base_url = NULL;

  /* Extract protocol from config.hostname if configured */
  char config_protocol[16] = {0};
  if (config.hostname && config.hostname[0] != '\0') {
    /* Parse URL components from config.hostname to extract protocol */
    if (http_parse_url_components(config.hostname, config_protocol, NULL, NULL, NULL) == 0) {
      /* Successfully parsed - use protocol from config.hostname if present */
      if (config_protocol[0] != '\0') {
        proto = config_protocol;
      }
    }
  }

  if (config.xff && x_forwarded_host && x_forwarded_host[0]) {
    /* Use X-Forwarded-Host when xff is enabled */
    host = x_forwarded_host;
    if (x_forwarded_proto && x_forwarded_proto[0]) {
      /* X-Forwarded-Proto overrides config.hostname protocol */
      proto = x_forwarded_proto;
    }
  } else if (host_header && host_header[0]) {
    /* Use Host header */
    host = host_header;
    /* Apply X-Forwarded-Proto even without X-Forwarded-Host */
    if (config.xff && x_forwarded_proto && x_forwarded_proto[0]) {
      proto = x_forwarded_proto;
    }
  }

  if (host) {
    /* Normalize host: a bare IPv6 literal (no brackets) must be bracketed
     * before being embedded in a URL.  "host:port" with a single colon is
     * left untouched. */
    char normalized_host[512];
    const char *first_colon = strchr(host, ':');
    if (host[0] != '[' && first_colon && strchr(first_colon + 1, ':')) {
      if (format_host_for_url(host, normalized_host, sizeof(normalized_host)) == 0) {
        host = normalized_host;
      }
    }

    const char *prefix = (config.app_path_prefix && config.app_path_prefix[0] != '\0') ? config.app_path_prefix : "";

    /* Build base URL from host, proto, and public app path prefix */
    size_t url_len = strlen(proto) + 3 + strlen(host) + strlen(prefix) + 2; /* proto://host[/prefix]/ */
    base_url = malloc(url_len);
    if (!base_url) {
      logger(LOG_ERROR, "Failed to allocate base URL");
      return NULL;
    }
    snprintf(base_url, url_len, "%s://%s%s/", proto, host, prefix);
  } else {
    /* Fallback to get_server_address */
    base_url = get_server_address();
    if (!base_url) {
      logger(LOG_ERROR, "Failed to get server address for base URL");
      return NULL;
    }
  }

  return base_url;
}
