#ifndef __HTTP_H__
#define __HTTP_H__

#include <stdint.h>
#include <sys/types.h>
#include "rtp2httpd.h"

/* Forward declaration */
typedef struct connection_s connection_t;

/* HTTP Status Codes */
typedef enum
{
  STATUS_200 = 0,
  STATUS_404 = 1,
  STATUS_400 = 2,
  STATUS_501 = 3,
  STATUS_503 = 4,
  STATUS_500 = 5,
  STATUS_401 = 6,
  STATUS_304 = 7
} http_status_t;

/* Content Types */
typedef enum
{
  CONTENT_OSTREAM = 0,
  CONTENT_HTML = 1,
  CONTENT_HTMLUTF = 2,
  CONTENT_MPEGV = 3,
  CONTENT_MPEGA = 4,
  CONTENT_MP2T = 5,
  CONTENT_SSE = 6,
  CONTENT_JPEG = 7
} content_type_t;

/* HTTP request parsing state */
typedef enum
{
  HTTP_PARSE_REQ_LINE = 0,
  HTTP_PARSE_HEADERS,
  HTTP_PARSE_BODY,
  HTTP_PARSE_COMPLETE
} http_parse_state_t;

/* HTTP request structure */
typedef struct
{
  char method[16];
  char url[1024];
  char hostname[256];
  char user_agent[256];
  char accept[256];
  char if_none_match[256];
  int x_request_snapshot;
  int is_http_1_1;
  http_parse_state_t parse_state;
  int content_length;
  char body[1024];
  int body_len;
} http_request_t;

/**
 * Initialize HTTP request structure
 * @param req Request structure to initialize
 */
void http_request_init(http_request_t *req);

/**
 * Parse HTTP request from buffer (incremental parsing)
 * Modifies inbuf and in_len as data is consumed.
 *
 * @param inbuf Input buffer containing HTTP request data
 * @param in_len Pointer to current buffer length (updated as data is consumed)
 * @param req Request structure to fill (maintains state across calls)
 * @return 0 = need more data, 1 = request complete, -1 = parse error
 */
int http_parse_request(char *inbuf, int *in_len, http_request_t *req);

/**
 * Send HTTP response headers via connection output buffer
 * For SSE (Server-Sent Events), use CONTENT_SSE type which includes
 * Cache-Control and Connection headers automatically.
 *
 * @param c Connection object
 * @param status Status code
 * @param type Content type
 * @param extra_headers Optional extra headers to include (NULL or empty string if none)
 *                      Should NOT include trailing CRLF as it will be added automatically
 */
void send_http_headers(connection_t *c, http_status_t status, content_type_t type, const char *extra_headers);

/**
 * Decode percent-encoded sequences in-place within a URL component
 * @param str String to decode
 * @return 0 on success, -1 on invalid encoding
 */
int http_url_decode(char *str);

/**
 * Parse query parameter value from query/form string (case-insensitive parameter names)
 * Works for both URL query strings and application/x-www-form-urlencoded body data
 * @param query_string Query or form data string (without leading ?)
 * @param param_name Parameter name to search for (case-insensitive)
 * @param value_buf Buffer to store parameter value
 * @param value_size Size of value buffer
 * @return 0 if parameter found, -1 if not found or error
 */
int http_parse_query_param(const char *query_string, const char *param_name,
                           char *value_buf, size_t value_size);

/**
 * Send HTTP 400 Bad Request response
 * @param conn Connection object
 */
void http_send_400(connection_t *conn);

/**
 * Send HTTP 404 Not Found response
 * @param conn Connection object
 */
void http_send_404(connection_t *conn);

/**
 * Send HTTP 500 Internal Server Error response
 * @param conn Connection object
 */
void http_send_500(connection_t *conn);

/**
 * Send HTTP 503 Service Unavailable response
 * @param conn Connection object
 */
void http_send_503(connection_t *conn);

/**
 * Send HTTP 401 Unauthorized response
 * @param conn Connection object
 */
void http_send_401(connection_t *conn);

#endif /* __HTTP_H__ */
