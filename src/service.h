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
typedef enum
{
  SERVICE_MRTP = 0,
  SERVICE_MUDP,
  SERVICE_RTSP
} service_type_t;

/**
 * Service configuration structure
 * Represents a single media service (multicast RTP/UDP or RTSP stream)
 */
typedef struct service_s
{
  char *url;
  char *msrc;
  service_type_t service_type;
  struct addrinfo *addr;
  struct addrinfo *msrc_addr;
  struct addrinfo *fcc_addr;
  char *rtsp_url;       /* Full RTSP URL for SERVICE_RTSP */
  char *playseek_param; /* playseek parameter for time range */
  char *user_agent;     /* User-Agent header for timezone detection */
  struct service_s *next;
} service_t;

/**
 * Create service from UDPxy format URL
 * Format: /udp/multicast_addr:port or /rtp/multicast_addr:port[@source_addr:port]
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
 * Create service from configured RTSP service with query parameter merging
 * If the request URL contains query parameters, they are merged with the
 * configured service's rtsp_url and a new service is created.
 * If no query parameters in request, returns NULL (use original service).
 *
 * @param configured_service The configured RTSP service
 * @param request_url The HTTP request URL (may contain query params)
 * @return Pointer to newly allocated service structure or NULL if no merge needed/on failure
 */
service_t *service_create_from_rtsp_with_query_merge(const service_t *configured_service,
                                                     const char *request_url);

/**
 * Free service structure allocated by service creation functions
 *
 * @param service Service structure to free
 */
void service_free(service_t *service);

#endif /* SERVICE_H */
