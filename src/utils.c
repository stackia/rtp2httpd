#include "utils.h"
#include "configuration.h"
#include "http.h"
#include "m3u.h"
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
#include <sys/ioctl.h>
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
 * @returns Whatever printf returns
 */
int logger(loglevel_t level, const char *format, ...) {
  va_list ap;
  int r = 0;
  char message[1024];
  int prefix_len = 0;

  /* Check log level from shared memory if available, otherwise use config */
  loglevel_t current_level = config.verbosity;
  if (status_shared) {
    current_level = status_shared->current_log_level;
  }

  if (current_level >= level) {
    if (worker_id == SUPERVISOR_WORKER_ID) {
      prefix_len = snprintf(message, sizeof(message), "[Supervisor] ");
    } else {
      prefix_len =
          snprintf(message, sizeof(message), "[Worker %d] ", worker_id);
    }

    /* Format the actual message after the prefix (if any) */
    va_start(ap, format);
    vsnprintf(message + prefix_len, sizeof(message) - prefix_len, format, ap);
    va_end(ap);

    /* Output to stdout */
    r = fputs(message, stdout);

    /* Store in status log buffer */
    status_add_log_entry(level, message);

    // Automatically add newline if format doesn't end with one
    if (format && strlen(format) > 0 && format[strlen(format) - 1] != '\n') {
      fputc('\n', stdout);
    }
  }
  return r;
}

void bind_to_upstream_interface(int sock, const char *ifname) {
  if (ifname && ifname[0] != '\0') {
    struct ifreq ifr;
    memset(&ifr, 0, sizeof(struct ifreq));
    strncpy(ifr.ifr_name, ifname, IFNAMSIZ - 1);

    /* Get the latest interface index dynamically to handle interface restarts
     * (e.g., PPPoE reconnection) */
    unsigned int ifindex = if_nametoindex(ifr.ifr_name);
    if (ifindex > 0) {
      ifr.ifr_ifindex = (int)ifindex;
    } else {
      logger(LOG_WARN, "Failed to get interface index for %s: %s", ifr.ifr_name,
             strerror(errno));
    }

    if (setsockopt(sock, SOL_SOCKET, SO_BINDTODEVICE, &ifr,
                   sizeof(struct ifreq)) < 0) {
      logger(LOG_ERROR, "Failed to bind to upstream interface %s: %s",
             ifr.ifr_name, strerror(errno));
    }
  }
}

const char *get_upstream_interface_for_fcc(void) {
  /* Priority: upstream_interface_fcc > upstream_interface */
  if (config.upstream_interface_fcc[0] != '\0') {
    return config.upstream_interface_fcc;
  }
  if (config.upstream_interface[0] != '\0') {
    return config.upstream_interface;
  }
  return NULL;
}

const char *get_upstream_interface_for_rtsp(void) {
  /* Priority: upstream_interface_rtsp > upstream_interface */
  if (config.upstream_interface_rtsp[0] != '\0') {
    return config.upstream_interface_rtsp;
  }
  if (config.upstream_interface[0] != '\0') {
    return config.upstream_interface;
  }
  return NULL;
}

const char *get_upstream_interface_for_multicast(void) {
  /* Priority: upstream_interface_multicast > upstream_interface */
  if (config.upstream_interface_multicast[0] != '\0') {
    return config.upstream_interface_multicast;
  }
  if (config.upstream_interface[0] != '\0') {
    return config.upstream_interface;
  }
  return NULL;
}

const char *get_upstream_interface_for_http(void) {
  /* Priority: upstream_interface_http > upstream_interface */
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
uint32_t get_local_ip_for_fcc(void) {
  const char *ifname = get_upstream_interface_for_fcc();
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

      if (ifa->ifa_addr->sa_family == AF_INET &&
          strcmp(ifa->ifa_name, ifname) == 0) {
        struct sockaddr_in *addr =
            (struct sockaddr_in *)(uintptr_t)ifa->ifa_addr;
        local_ip = ntohl(addr->sin_addr.s_addr);
        logger(LOG_DEBUG, "FCC: Using local IP from interface %s: %u.%u.%u.%u",
               ifname, (local_ip >> 24) & 0xFF, (local_ip >> 16) & 0xFF,
               (local_ip >> 8) & 0xFF, local_ip & 0xFF);
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
        struct sockaddr_in *addr =
            (struct sockaddr_in *)(uintptr_t)ifa->ifa_addr;
        uint32_t ip = ntohl(addr->sin_addr.s_addr);

        /* Skip loopback (127.0.0.0/8) */
        if ((ip >> 24) != 127) {
          local_ip = ip;
          logger(
              LOG_DEBUG,
              "FCC: Using first non-loopback IP from interface %s: %u.%u.%u.%u",
              ifa->ifa_name, (local_ip >> 24) & 0xFF, (local_ip >> 16) & 0xFF,
              (local_ip >> 8) & 0xFF, local_ip & 0xFF);
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

char *build_proxy_base_url(const char *host_header, const char *x_forwarded_host,
                           const char *x_forwarded_proto) {
  const char *host = NULL;
  const char *proto = "http";
  char *base_url = NULL;

  /* Extract protocol from config.hostname if configured */
  char config_protocol[16] = {0};
  if (config.hostname && config.hostname[0] != '\0') {
    /* Parse URL components from config.hostname to extract protocol */
    if (http_parse_url_components(config.hostname, config_protocol, NULL, NULL,
                                  NULL) == 0) {
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
  }

  if (host) {
    /* Build base URL from host and proto */
    size_t url_len = strlen(proto) + 3 + strlen(host) + 2; /* proto://host/ */
    base_url = malloc(url_len);
    if (!base_url) {
      logger(LOG_ERROR, "Failed to allocate base URL");
      return NULL;
    }
    snprintf(base_url, url_len, "%s://%s/", proto, host);
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
