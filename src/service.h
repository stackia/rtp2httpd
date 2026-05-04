#ifndef SERVICE_H
#define SERVICE_H

#include <netdb.h>
#include <stdint.h>

#include "url_template.h"

/* ========== HTTP/SERVICE BUFFER SIZE CONFIGURATION ========== */

/* HTTP URL working buffer - for URL manipulation. The query-merge path in
 * service_create_with_query_merge() builds into this same buffer and then
 * re-parses through service_create_from_*_url(), and the RTSP layer
 * (RTSP_SERVER_URL_SIZE / RTSP_SERVER_PATH_SIZE / RTSP_URL_COPY_SIZE in
 * rtsp.h) is sized to match. Keep all four in sync to avoid silent
 * mid-pipeline truncation. */
#ifndef HTTP_URL_BUFFER_SIZE
#define HTTP_URL_BUFFER_SIZE 1024
#endif

/* HTTP URL component buffers - for parsing multicast URLs */
#ifndef HTTP_ADDR_COMPONENT_SIZE
#define HTTP_ADDR_COMPONENT_SIZE 256
#endif

#ifndef HTTP_PORT_COMPONENT_SIZE
#define HTTP_PORT_COMPONENT_SIZE 16
#endif

/* HTTP URL parsing buffers - for complex URL operations */
#ifndef HTTP_URL_MAIN_PART_SIZE
#define HTTP_URL_MAIN_PART_SIZE 512
#endif

#ifndef HTTP_URL_FCC_VALUE_SIZE
#define HTTP_URL_FCC_VALUE_SIZE 512
#endif

#ifndef HTTP_SOURCE_STRING_SIZE
#define HTTP_SOURCE_STRING_SIZE 300
#endif

/* Service type enumeration */
typedef enum { SERVICE_MRTP = 0, SERVICE_RTSP, SERVICE_HTTP } service_type_t;

/* Service source enumeration - tracks where the service was created from */
typedef enum {
  SERVICE_SOURCE_INLINE = 0,  /* From inline M3U in config file */
  SERVICE_SOURCE_EXTERNAL = 1 /* From external M3U URL */
} service_source_t;

/* Seek mode enumeration - controls RTSP recent-clock optimization opt-in */
typedef enum {
  SEEK_MODE_PASSTHROUGH = 0, /* Default: never use Range: clock= path */
  SEEK_MODE_RANGE = 1        /* Opt-in: enable Range: clock= path when in window */
} seek_mode_t;

/* Default recency window when r2h-seek-mode=range is given without seconds */
#define SEEK_MODE_DEFAULT_WINDOW_SECONDS 3600
/* Upper bound on a configurable window — 24 hours */
#define SEEK_MODE_MAX_WINDOW_SECONDS 86400

/**
 * Service configuration structure
 * Represents a single media service (multicast RTP/UDP or RTSP stream)
 */
typedef struct service_s {
  char *url;
  char *msrc;
  service_type_t service_type;
  service_source_t source; /* Source of this service (inline or external) */
  struct addrinfo *addr;
  struct addrinfo *msrc_addr;
  struct addrinfo *fcc_addr;
  int fcc_type;                    /* FCC protocol type */
  uint16_t fec_port;               /* FEC multicast port (0 if not configured) */
  char *rtp_url;                   /* Full RTP URL for SERVICE_MRTP */
  char *rtsp_url;                  /* Full RTSP URL for SERVICE_RTSP */
  char *http_url;                  /* Full HTTP URL for SERVICE_HTTP */
  char *seek_param_name;           /* Name of seek parameter (e.g., "playseek", "tvdr") */
  char *seek_param_value;          /* Value of seek parameter for time range */
  int seek_offset_seconds;         /* Additional offset in seconds from r2h-seek-offset
                                      parameter */
  seek_mode_t seek_mode;           /* Seek mode from r2h-seek-mode parameter */
  int seek_mode_tz_explicit;       /* 1 if range(...) explicitly specified a TZ */
  int seek_mode_tz_offset_seconds; /* TZ offset from range(TZ/...) when explicit */
  int seek_mode_window_seconds;    /* Recency window from range(.../seconds) */
  char *user_agent;                /* User-Agent header for timezone detection */
  char *ifname;                    /* Per-service upstream interface override (from r2h-ifname) */
  char *ifname_fcc;                /* Per-service FCC interface override (from r2h-ifname-fcc) */
  struct service_s *next;
} service_t;

/* GLOBALS */
extern service_t *services;

/**
 * Create service from UDPxy format URL
 * Format: /udp/multicast_addr:port or
 * /rtp/multicast_addr:port[@source_addr:port]
 *
 * @param url URL string to parse
 * @return Pointer to newly allocated service structure or NULL on failure
 */
service_t *service_create_from_udpxy_url(char *url);

/**
 * Create service from RTSP URL
 * Accepts both HTTP request format and direct RTSP URL format
 * Extracts playseek parameter from query string
 *
 * Supported formats:
 *   - HTTP request format: /rtsp/server:port/path?query&playseek=...
 *   - Direct RTSP format: rtsp://server:port/path?query&playseek=...
 *
 * @param http_url URL to parse (either format)
 * @return Pointer to newly allocated service structure or NULL on failure
 */
service_t *service_create_from_rtsp_url(const char *http_url);

/**
 * Create service from RTP/UDP URL
 * Accepts both HTTP request format and direct URL format for RTP and UDP
 * Parses multicast address, source address, and FCC parameter from URL
 * Both RTP and UDP URLs are treated as SERVICE_MRTP
 *
 * Supported formats:
 *   - HTTP RTP format: /rtp/multicast_addr:port[@source]?fcc=...
 *   - HTTP UDP format: /udp/multicast_addr:port[@source]?fcc=...
 *   - Direct RTP format: rtp://multicast_addr:port[@source]?fcc=...
 *   - Direct UDP format: udp://multicast_addr:port[@source]?fcc=...
 *
 * @param http_url URL to parse (any of the above formats)
 * @return Pointer to newly allocated service structure or NULL on failure
 */
service_t *service_create_from_rtp_url(const char *http_url);

/**
 * Create service from HTTP proxy URL
 * Accepts format: /http/host:port/path?query
 *
 * @param http_url URL to parse
 * @return Pointer to newly allocated service structure or NULL on failure
 */
service_t *service_create_from_http_url(const char *http_url);

/**
 * Extract seek parameters (r2h-seek-name, r2h-seek-offset, r2h-seek-mode, and
 * the seek parameter itself) from a URL query string, removing them in-place.
 *
 * @param query_start Pointer to the '?' in the URL (modified in-place)
 * @param out_seek_param_name Output: malloc'd seek parameter name (caller frees)
 * @param out_seek_param_value Output: malloc'd seek parameter value (caller
 * frees)
 * @param out_seek_offset_seconds Output: seek offset in seconds
 * @param out_seek_mode Output: parsed seek mode (default SEEK_MODE_PASSTHROUGH)
 * @param out_seek_mode_tz_explicit Output: 1 if range(...) explicitly gave a TZ
 * @param out_seek_mode_tz_offset_seconds Output: TZ offset when explicit
 * @param out_seek_mode_window_seconds Output: recency window in seconds
 * @return 0 on success, -1 on failure
 */
int service_extract_seek_params(char *query_start, char **out_seek_param_name, char **out_seek_param_value,
                                int *out_seek_offset_seconds, seek_mode_t *out_seek_mode,
                                int *out_seek_mode_tz_explicit, int *out_seek_mode_tz_offset_seconds,
                                int *out_seek_mode_window_seconds);

/**
 * Analyze a seek parameter once and reuse the result across RTSP/HTTP flows.
 *
 * @param seek_param_value Extracted seek parameter value
 * @param seek_offset_seconds Additional seek offset in seconds
 * @param user_agent User-Agent header for timezone detection
 * @param seek_mode Seek mode from r2h-seek-mode parameter
 * @param seek_mode_tz_explicit 1 if range(...) explicitly specified a TZ
 * @param seek_mode_tz_offset_seconds TZ offset when explicit
 * @param seek_mode_window_seconds Recency window in seconds (only meaningful for RANGE)
 * @param parse_result Output parse result structure
 * @return 0 on success, -1 on invalid parameters
 */
int service_parse_seek_value(const char *seek_param_value, int seek_offset_seconds, const char *user_agent,
                             seek_mode_t seek_mode, int seek_mode_tz_explicit, int seek_mode_tz_offset_seconds,
                             int seek_mode_window_seconds, seek_parse_result_t *parse_result);

/**
 * Convert a parsed seek value to upstream UTC query form.
 *
 * @param parse_result Parsed seek value
 * @param output Output buffer for converted value
 * @param output_size Size of output buffer
 * @return 0 on success, -1 on failure
 */
int service_convert_seek_value(const seek_parse_result_t *parse_result, char *output, size_t output_size);

/**
 * Format a recent seek begin time for RTSP PLAY Range clock headers.
 *
 * @param parse_result Parsed seek value
 * @param output Output buffer for formatted yyyyMMddTHHmmssZ value
 * @param output_size Size of output buffer
 * @return 1 if seek is recent and formatted, 0 if not applicable, -1 on error
 */
int service_format_recent_seek_range(const seek_parse_result_t *parse_result, char *output, size_t output_size);

/**
 * Create a new service derived from a configured service, applying any
 * request-side query parameters with request-wins precedence over
 * M3U-configured r2h-* control parameters.
 *
 * Always returns a freshly allocated service on success: a deep clone of the
 * configured service when the request carries no query string, otherwise a
 * service rebuilt from the merged URL. Works for RTP, RTSP, and HTTP services
 * based on expected_type, merging into rtsp_url / http_url / rtp_url
 * accordingly.
 *
 * @param configured_service The configured service (RTP, RTSP, or HTTP)
 * @param request_url The HTTP request URL (may contain query params)
 * @param expected_type Expected service type (SERVICE_MRTP, SERVICE_RTSP, or
 *                      SERVICE_HTTP)
 * @return Newly allocated service on success; NULL strictly on failure (e.g.
 *         merged URL exceeds HTTP_URL_BUFFER_SIZE, allocation failure, type
 *         mismatch). Callers must treat NULL as a hard error and must not fall
 *         back to the configured service, otherwise the user's overrides would
 *         be silently dropped.
 */
service_t *service_create_with_query_merge(service_t *configured_service, const char *request_url,
                                           service_type_t expected_type);

/**
 * Clone a service structure (deep copy)
 * Creates a completely independent copy of the service with all fields
 * duplicated The cloned service is not added to the global services list
 *
 * @param service Service structure to clone
 * @return Pointer to newly allocated cloned service structure or NULL on
 * failure
 */
service_t *service_clone(service_t *service);

/**
 * Free service structure allocated by service creation functions
 *
 * @param service Service structure to free
 */
void service_free(service_t *service);

/**
 * Free services from external M3U in the global services list
 * This preserves inline services from the configuration file
 * and only removes services loaded from external M3U URLs
 */
void service_free_external(void);

/**
 * Free all services in the global services list
 * Free hashmap, then frees all services (both inline and external)
 * Used during config reload
 */
void service_free_all(void);

/**
 * Initialize the service lookup hashmap
 * Must be called before any services are added
 */
void service_hashmap_init(void);

/**
 * Free the service lookup hashmap
 * Should be called during shutdown
 */
void service_hashmap_free(void);

/**
 * Add a service to the lookup hashmap
 * Should be called whenever a service is added to the global services list
 *
 * @param service Service to add to the hashmap
 */
void service_hashmap_add(service_t *service);

/**
 * Remove a service from the lookup hashmap
 * Should be called whenever a service is removed from the global services list
 *
 * @param service Service to remove from the hashmap
 */
void service_hashmap_remove(service_t *service);

/**
 * Lookup a service by URL in O(1) time using the hashmap
 *
 * @param url URL to lookup
 * @return Pointer to service structure or NULL if not found
 */
service_t *service_hashmap_get(const char *url);

/**
 * Resolve upstream URL by substituting template placeholders or appending
 * seek parameters (query-append mode).
 *
 * Template mode: if URL contains placeholders, substitute them using
 * begin/end times from parse_result.
 * Query-append mode: if no placeholders, append seek param as query parameter.
 *
 * @param url The upstream URL (may contain template placeholders)
 * @param seek_param_name Seek parameter name (e.g., "playseek")
 * @param parse_result Parsed seek value
 * @param output Output buffer for resolved URL
 * @param output_size Size of output buffer
 * @return 0 on success, -1 on error
 */
int service_resolve_upstream_url(const char *url, const char *seek_param_name, const seek_parse_result_t *parse_result,
                                 char *output, size_t output_size);

#endif /* SERVICE_H */
