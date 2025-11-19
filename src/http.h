#ifndef __HTTP_H__
#define __HTTP_H__

#include <sys/types.h>

/* Forward declaration */
typedef struct connection_s connection_t;

/* HTTP Status Codes */
typedef enum {
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
typedef enum {
  CONTENT_OSTREAM = 0,
  CONTENT_HTML = 1,
  CONTENT_MPEGV = 2,
  CONTENT_MPEGA = 3,
  CONTENT_MP2T = 4,
  CONTENT_SSE = 5,
  CONTENT_JPEG = 6
} content_type_t;

/* HTTP request parsing state */
typedef enum {
  HTTP_PARSE_REQ_LINE = 0,
  HTTP_PARSE_HEADERS,
  HTTP_PARSE_BODY,
  HTTP_PARSE_COMPLETE
} http_parse_state_t;

/* HTTP request structure */
typedef struct {
  char method[16];
  char url[1024];
  char hostname[256];
  char user_agent[256];
  char accept[256];
  char if_none_match[256];
  char x_forwarded_for[64];
  int x_request_snapshot;
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
 * For SSE (Server-Sent Events), pass "text/event-stream" as content_type which
 * includes Cache-Control and Connection headers automatically.
 *
 * @param c Connection object
 * @param status Status code
 * @param content_type Content-Type header value (e.g., "text/html;
 * charset=utf-8", "application/json", or NULL to skip)
 * @param extra_headers Optional extra headers to include (NULL or empty string
 * if none) Should NOT include trailing CRLF as it will be added automatically
 */
void send_http_headers(connection_t *c, http_status_t status,
                       const char *content_type, const char *extra_headers);

/**
 * Decode percent-encoded sequences in-place within a URL component
 * @param str String to decode
 * @return 0 on success, -1 on invalid encoding
 */
int http_url_decode(char *str);

/**
 * URL encode a string (RFC 3986)
 * Allocates and returns a new string with encoded characters.
 * Unreserved characters (alphanumeric, -, _, ., ~, /) are not encoded.
 *
 * @param str String to encode
 * @return Newly allocated encoded string (caller must free), or NULL on error
 */
char *http_url_encode(const char *str);

/**
 * Parse query parameter value from query/form string (case-insensitive
 * parameter names) Works for both URL query strings and
 * application/x-www-form-urlencoded body data The returned value is
 * automatically URL-decoded.
 * @param query_string Query or form data string (without leading ?)
 * @param param_name Parameter name to search for (case-insensitive)
 * @param value_buf Buffer to store parameter value (will be URL-decoded)
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

/**
 * Parse URL and extract components (protocol, host, port, path)
 * Supports various formats:
 *   - 10.0.0.1
 *   - example.org
 *   - example.org:8080
 *   - http://10.0.0.1
 *   - https://example.org
 *   - https://example.org:8443/prefix
 *
 * @param url Input URL string
 * @param protocol Output buffer for protocol (can be NULL), size should be at
 * least 16 bytes
 * @param host Output buffer for host (can be NULL), size should be at least 256
 * bytes
 * @param port Output buffer for port (can be NULL), size should be at least 16
 * bytes
 * @param path Output buffer for path (can be NULL), size should be at least
 * 1024 bytes
 * @return 0 on success, -1 on error
 */
int http_parse_url_components(const char *url, char *protocol, char *host,
                              char *port, char *path);

/**
 * Match Host header against expected hostname
 * Compares only the hostname parts (ignoring ports), case-insensitive.
 *
 * @param request_host_header Host header from HTTP request (e.g.,
 * "example.org:5140" or "example.org")
 * @param expected_host Expected hostname to match against (just the hostname
 * part, e.g., "example.org")
 * @return 1 if match, 0 if not match, -1 on error
 */
int http_match_host_header(const char *request_host_header,
                           const char *expected_host);

/**
 * Check ETag and send 304 Not Modified response if it matches
 * This is a helper function to reduce code duplication for ETag-based caching.
 *
 * @param c Connection object
 * @param etag Server's current ETag value (NULL if no ETag available)
 * @param content_type Content-Type header value (can be NULL)
 * @return 1 if 304 was sent (ETag matched), 0 if content should be sent (no
 * match or no ETag)
 */
int http_check_etag_and_send_304(connection_t *c, const char *etag,
                                 const char *content_type);

/**
 * Build extra headers string with ETag and Cache-Control
 * Helper function to format standard ETag caching headers with optional
 * additional headers.
 *
 * @param buffer Output buffer for headers
 * @param buffer_size Size of output buffer
 * @param content_length Content length to include in headers
 * @param etag ETag value (can be NULL if no ETag)
 * @param additional_headers Optional additional headers (can be NULL), should
 * NOT end with CRLF
 * @return Number of characters written to buffer
 */
int http_build_etag_headers(char *buffer, size_t buffer_size,
                            size_t content_length, const char *etag,
                            const char *additional_headers);

#endif /* __HTTP_H__ */
