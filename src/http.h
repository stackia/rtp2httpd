#ifndef __HTTP_H__
#define __HTTP_H__

#include <stdint.h>
#include <sys/types.h>
#include "rtp2httpd.h"

/* HTTP Status Codes */
#define STATUS_200 0
#define STATUS_404 1
#define STATUS_400 2
#define STATUS_501 3
#define STATUS_503 4

/* Content Types */
#define CONTENT_OSTREAM 0
#define CONTENT_HTML 1
#define CONTENT_HTMLUTF 2
#define CONTENT_MPEGV 3
#define CONTENT_MPEGA 4

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
 * @param status Status code index
 * @param type Content type index
 */
void send_http_headers(int s, int status, int type);

/**
 * Parse UDPxy format URLs
 *
 * @param url URL string to parse
 * @return Pointer to service structure or NULL on failure
 */
struct services_s *parse_udpxy_url(char *url);

/**
 * Signal handler for broken pipe
 *
 * @param signum Signal number
 */
void sigpipe_handler(int signum);

#endif /* __HTTP_H__ */
