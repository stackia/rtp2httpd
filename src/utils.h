#ifndef __UTILS_H__
#define __UTILS_H__

#include "configuration.h"
#include <stddef.h>
#include <stdint.h>
#include <sys/socket.h>

/**
 * Logger function. Show the message if current verbosity is above
 * logged level.
 *
 * @param levem Message log level
 * @param format printf style format string
 * @returns Whatever printf returns
 */
int logger(loglevel_t level, const char *format, ...) __attribute__((format(printf, 2, 3)));

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
#define strndupa(s, n)                                                                                                 \
  (__extension__({                                                                                                     \
    const char *__in = (s);                                                                                            \
    size_t __len = strnlen(__in, (n)) + 1;                                                                             \
    char *__out = (char *)alloca(__len);                                                                               \
    __out[__len - 1] = '\0';                                                                                           \
    (char *)memcpy(__out, __in, __len - 1);                                                                            \
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
 * Priority: override_fcc > override > upstream_interface_fcc >
 * upstream_interface
 *
 * @param override Per-service ifname override (from r2h-ifname), or NULL
 * @param override_fcc Per-service ifname_fcc override (from r2h-ifname-fcc),
 * or NULL
 * @return Pointer to the interface name to use (may be NULL if none configured)
 */
const char *get_upstream_interface_for_fcc(const char *override, const char *override_fcc);

/**
 * Select the appropriate upstream interface for RTSP with priority logic
 * Priority: override > upstream_interface_rtsp > upstream_interface
 *
 * @param override Per-service ifname override (from r2h-ifname), or NULL
 * @return Pointer to the interface name to use (may be NULL if none configured)
 */
const char *get_upstream_interface_for_rtsp(const char *override);

/**
 * Select the appropriate upstream interface for multicast with priority logic
 * Priority: override > upstream_interface_multicast > upstream_interface
 *
 * @param override Per-service ifname override (from r2h-ifname), or NULL
 * @return Pointer to the interface name to use (may be NULL if none configured)
 */
const char *get_upstream_interface_for_multicast(const char *override);

/**
 * Select the appropriate upstream interface for HTTP proxy with priority logic
 * Priority: override > upstream_interface_http > upstream_interface
 *
 * @param override Per-service ifname override (from r2h-ifname), or NULL
 * @return Pointer to the interface name to use (may be NULL if none configured)
 */
const char *get_upstream_interface_for_http(const char *override);

/**
 * Build base URL for proxy based on request headers and config
 * Priority: XFF headers (if enabled) > Host header > get_server_address()
 *
 * @param host_header HTTP Host header (can be NULL)
 * @param x_forwarded_host X-Forwarded-Host header (can be NULL)
 * @param x_forwarded_proto X-Forwarded-Proto header (can be NULL)
 * @return malloc'd base URL string (caller must free), or NULL on error
 */
char *build_proxy_base_url(const char *host_header, const char *x_forwarded_host, const char *x_forwarded_proto);

/**
 * Get local IP address for FCC packets
 * Uses the configured upstream interface for FCC, or falls back to first
 * non-loopback address
 *
 * @param override Per-service ifname override (from r2h-ifname), or NULL
 * @param override_fcc Per-service ifname_fcc override (from r2h-ifname-fcc),
 * or NULL
 * @return Local IP address in host byte order, or 0 if unable to determine
 */
uint32_t get_local_ip_for_fcc(const char *override, const char *override_fcc);

/**
 * Check if a host string is a bare IPv6 literal that needs brackets when
 * embedded into a URL authority or Host header (contains ':' and is not
 * already bracketed).
 *
 * @param host Host string (hostname, IPv4, or IPv6 literal)
 * @return 1 if brackets are needed, 0 otherwise
 */
int host_needs_brackets(const char *host);

/**
 * Format a host for use inside a URL authority or Host header.
 * Bare IPv6 literals are wrapped in brackets; everything else is copied
 * verbatim.
 *
 * @param host Input host (without brackets)
 * @param out Output buffer
 * @param out_size Output buffer size
 * @return 0 on success, -1 if the output buffer is too small
 */
int format_host_for_url(const char *host, char *out, size_t out_size);

/**
 * Format a host[:port] authority for URLs / Host headers.
 * Bare IPv6 literals are bracketed.  The port is omitted when it equals
 * default_port (pass 0 / negative default_port to always include the port).
 *
 * @param host Input host (without brackets)
 * @param port Port number
 * @param default_port Port to omit from output (e.g. 80 for HTTP), or 0
 * @param out Output buffer
 * @param out_size Output buffer size
 * @return 0 on success, -1 if the output buffer is too small
 */
int format_host_port_for_url(const char *host, int port, int default_port, char *out, size_t out_size);

/**
 * Calculate the escaped length of a string when encoded as JSON string content.
 * The returned size does not include the terminating NUL byte.
 *
 * @param value Input string (may be NULL)
 * @return Escaped string length in bytes
 */
size_t json_escaped_len(const char *value);

/**
 * Escape a string for use inside JSON string quotes.
 *
 * @param value Input string (may be NULL)
 * @return malloc'd escaped string (caller must free), or NULL on allocation error
 */
char *json_escape_string(const char *value);

/**
 * Escape a string for JSON into a fixed-size output buffer. The output is
 * always NUL-terminated when out_size is greater than zero. If the buffer is
 * too small, output is truncated at a complete escape sequence boundary.
 *
 * @param value Input string (may be NULL)
 * @param out Output buffer
 * @param out_size Output buffer size
 */
void json_escape_string_to_buffer(const char *value, char *out, size_t out_size);

/**
 * Parse a "host[:port]" string supporting "[IPv6]:port", bracketed and bare
 * IPv6 literals, hostnames, and IPv4.  A bare string with more than one ':'
 * is treated as an IPv6 literal without port.
 *
 * @param input Input string
 * @param host Output host buffer (brackets stripped)
 * @param host_size Output host buffer size
 * @param port Output port (untouched when no port is present)
 * @return 0 on success, -1 on parse error / overflow
 */
int parse_host_port(const char *input, char *host, size_t host_size, int *port);

/**
 * Set the port on a sockaddr (AF_INET or AF_INET6).
 *
 * @param sa Socket address
 * @param port Port number (host byte order)
 */
void sockaddr_set_port(struct sockaddr *sa, uint16_t port);

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
