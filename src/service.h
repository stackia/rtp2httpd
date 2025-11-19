#ifndef SERVICE_H
#define SERVICE_H

#include <netdb.h>

/* ========== HTTP/SERVICE BUFFER SIZE CONFIGURATION ========== */

/* HTTP URL working buffer - for URL manipulation */
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
typedef enum { SERVICE_MRTP = 0, SERVICE_RTSP } service_type_t;

/* Service source enumeration - tracks where the service was created from */
typedef enum {
  SERVICE_SOURCE_INLINE = 0,  /* From inline M3U in config file */
  SERVICE_SOURCE_EXTERNAL = 1 /* From external M3U URL */
} service_source_t;

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
  int fcc_type;          /* FCC protocol type */
  char *rtp_url;         /* Full RTP URL for SERVICE_MRTP */
  char *rtsp_url;        /* Full RTSP URL for SERVICE_RTSP */
  char *seek_param_name; /* Name of seek parameter (e.g., "playseek", "tvdr") */
  char *seek_param_value;  /* Value of seek parameter for time range */
  int seek_offset_seconds; /* Additional offset in seconds from r2h-seek-offset
                              parameter */
  char *user_agent;        /* User-Agent header for timezone detection */
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
 * Create service from configured service with query parameter merging
 * If the request URL contains query parameters, they are merged with the
 * configured service's URL and a new service is created.
 * If no query parameters in request, returns NULL (use original service).
 *
 * This function works for both RTP and RTSP services based on expected_type.
 * For RTSP services, it merges query params with rtsp_url.
 * For RTP services, it merges query params with url.
 *
 * @param configured_service The configured service (RTP or RTSP)
 * @param request_url The HTTP request URL (may contain query params)
 * @param expected_type Expected service type (SERVICE_MRTP or SERVICE_RTSP)
 * @return Pointer to newly allocated service structure or NULL if no merge
 * needed/on failure
 */
service_t *service_create_with_query_merge(service_t *configured_service,
                                           const char *request_url,
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

#endif /* SERVICE_H */
