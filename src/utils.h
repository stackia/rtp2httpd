#ifndef __UTILS_H__
#define __UTILS_H__

#include "configuration.h"
#include <stdint.h>

/* Return values used across multiple modules */
typedef enum {
  RETVAL_CLEAN = 0,
  RETVAL_WRITE_FAILED = 1,
  RETVAL_READ_FAILED = 2,
  RETVAL_UNKNOWN_METHOD = 3,
  RETVAL_BAD_REQUEST = 4,
  RETVAL_RTP_FAILED = 5,
  RETVAL_SOCK_READ_FAILED = 6
} retval_t;

/**
 * Logger function. Show the message if current verbosity is above
 * logged level.
 *
 * @param levem Message log level
 * @param format printf style format string
 * @returns Whatever printf returns
 */
int logger(loglevel_t level, const char *format, ...)
    __attribute__((format(printf, 2, 3)));

/**
 * Get current monotonic time in milliseconds.
 * Uses CLOCK_MONOTONIC for high precision and immunity to system clock changes.
 * Thread-safe.
 *
 * @return Current time in milliseconds since an unspecified starting point
 */
int64_t get_time_ms(void);

/**
 * Get current real time in milliseconds since Unix epoch.
 * Uses CLOCK_REALTIME for wall clock time.
 * Thread-safe.
 *
 * @return Current time in milliseconds since Unix epoch (1970-01-01 00:00:00
 * UTC)
 */
int64_t get_realtime_ms(void);

#ifndef strndupa
#define strndupa(s, n)                                                         \
  (__extension__({                                                             \
    const char *__in = (s);                                                    \
    size_t __len = strnlen(__in, (n)) + 1;                                     \
    char *__out = (char *)alloca(__len);                                       \
    __out[__len - 1] = '\0';                                                   \
    (char *)memcpy(__out, __in, __len - 1);                                    \
  }))
#endif

#define max(a, b) ((a) > (b) ? (a) : (b))
#define min(a, b) ((a) < (b) ? (a) : (b))

/**
 * Set socket receive buffer size, trying SO_RCVBUFFORCE first.
 * SO_RCVBUFFORCE can exceed system limits but requires CAP_NET_ADMIN.
 * Falls back to SO_RCVBUF if SO_RCVBUFFORCE fails.
 *
 * @param fd Socket file descriptor
 * @param size Desired receive buffer size in bytes
 * @return 0 on success, -1 on failure
 */
int set_socket_rcvbuf(int fd, int size);

/**
 * Bind socket to upstream interface if configured
 *
 * @param sock Socket file descriptor to bind
 * @param ifname Interface name for binding (may be NULL)
 */
void bind_to_upstream_interface(int sock, const char *ifname);

/**
 * Select the appropriate upstream interface for FCC with priority logic
 * Priority: upstream_interface_fcc > upstream_interface
 *
 * @return Pointer to the interface name to use (may be NULL if none configured)
 */
const char *get_upstream_interface_for_fcc(void);

/**
 * Select the appropriate upstream interface for RTSP with priority logic
 * Priority: upstream_interface_rtsp > upstream_interface
 *
 * @return Pointer to the interface name to use (may be NULL if none configured)
 */
const char *get_upstream_interface_for_rtsp(void);

/**
 * Select the appropriate upstream interface for multicast with priority logic
 * Priority: upstream_interface_multicast > upstream_interface
 *
 * @return Pointer to the interface name to use (may be NULL if none configured)
 */
const char *get_upstream_interface_for_multicast(void);

/**
 * Select the appropriate upstream interface for HTTP proxy with priority logic
 * Priority: upstream_interface_http > upstream_interface
 *
 * @return Pointer to the interface name to use (may be NULL if none configured)
 */
const char *get_upstream_interface_for_http(void);

/**
 * Build base URL for proxy based on request headers and config
 * Priority: XFF headers (if enabled) > Host header > get_server_address()
 *
 * @param host_header HTTP Host header (can be NULL)
 * @param x_forwarded_host X-Forwarded-Host header (can be NULL)
 * @param x_forwarded_proto X-Forwarded-Proto header (can be NULL)
 * @return malloc'd base URL string (caller must free), or NULL on error
 */
char *build_proxy_base_url(const char *host_header, const char *x_forwarded_host,
                           const char *x_forwarded_proto);

/**
 * Get local IP address for FCC packets
 * Uses the configured upstream interface for FCC, or falls back to first
 * non-loopback address
 *
 * @return Local IP address in host byte order, or 0 if unable to determine
 */
uint32_t get_local_ip_for_fcc(void);

/* Array size calculation macro */
#define ARRAY_SIZE(arr) (sizeof(arr) / sizeof((arr)[0]))

/* Branch prediction hints for compiler optimization */
#ifdef __GNUC__
#define likely(x) __builtin_expect(!!(x), 1)
#define unlikely(x) __builtin_expect(!!(x), 0)
#else
#define likely(x) (x)
#define unlikely(x) (x)
#endif

#endif /* __UTILS_H__ */
