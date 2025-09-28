#ifndef __HTTP_H__
#define __HTTP_H__

#include <stdint.h>
#include <sys/types.h>
#include "rtp2httpd.h"
#include "buffer_config.h"

/* HTTP Status Codes */
typedef enum
{
  STATUS_200 = 0,
  STATUS_404 = 1,
  STATUS_400 = 2,
  STATUS_501 = 3,
  STATUS_503 = 4
} http_status_t;

/* Content Types */
typedef enum
{
  CONTENT_OSTREAM = 0,
  CONTENT_HTML = 1,
  CONTENT_HTMLUTF = 2,
  CONTENT_MPEGV = 3,
  CONTENT_MPEGA = 4
} content_type_t;

/**
 * Ensures that all data are written to the socket
 *
 * @param s Socket file descriptor
 * @param buf Buffer to write
 * @param buflen Buffer length
 */
void write_to_client(int s, const uint8_t *buf, const size_t buflen);

/**
 * Send HTTP response headers
 *
 * @param s Socket file descriptor
 * @param status Status code
 * @param type Content type
 */
void send_http_headers(int s, http_status_t status, content_type_t type);

/**
 * Parse UDPxy format URLs
 *
 * @param url URL string to parse
 * @return Pointer to service structure or NULL on failure
 */
struct services_s *parse_udpxy_url(char *url);

/**
 * Free service structure allocated by parse functions
 *
 * @param service Service structure to free
 */
void free_service(struct services_s *service);

/**
 * Signal handler for broken pipe
 *
 * @param signum Signal number
 */
void sigpipe_handler(int signum);

#endif /* __HTTP_H__ */
