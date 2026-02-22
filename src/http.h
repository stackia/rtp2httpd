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
  STATUS_304 = 7,
  STATUS_204 = 8
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
  char x_forwarded_host[256];
  char x_forwarded_proto[16];
  int x_request_snapshot;
  char cookie[1024];  /* Cookie header value for r2h-token extraction */
  char access_control_request_method[64];   /* CORS preflight method */
  char access_control_request_headers[512]; /* CORS preflight headers */
  http_parse_state_t parse_state;
  int content_length;
  char *body;         /* Dynamically allocated based on Content-Length */
  size_t body_len;    /* Current body length */
  size_t body_alloc;  /* Allocated size of body buffer */
  /* Raw headers for proxying - stores all headers except Host, Connection */
  char raw_headers[4096];
  size_t raw_headers_len;
} http_request_t;

/**
 * Initialize HTTP request structure
 * @param req Request structure to initialize
 */
void http_request_init(http_request_t *req);

/**
 * Cleanup HTTP request structure (free dynamically allocated memory)
 * @param req Request structure to cleanup
 */
void http_request_cleanup(http_request_t *req);

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
 * Copy query string excluding a specific parameter (case-insensitive)
 * @param query_string Input query string (without leading '?')
 * @param exclude_param Parameter name to exclude (case-insensitive)
 * @param output Output buffer
 * @param output_size Output buffer size
 * @return Length of output string, or -1 on error
 */
int http_filter_query_param(const char *query_string, const char *exclude_param,
                            char *output, size_t output_size);

/**
 * Find $label suffix at the end of a URL.
 * A $label is a trailing "$..." at the very end of the URL, used for UI display
 * in frontend players. The '$' must NOT be followed by '{' (to avoid matching
 * ${placeholder} patterns used in dynamic parameters).
 *
 * @param url Input URL string
 * @return Pointer to the '$' within the url string, or NULL if no label found
 */
const char *http_find_url_label(const char *url);

/**
 * Strip $label suffix from the end of a URL in-place.
 * Uses http_find_url_label() to locate the label, then truncates the string.
 *
 * @param url URL string to modify in-place
 */
void http_strip_url_label(char *url);

/**
 * Filter Cookie header to remove a specific cookie (case-insensitive name)
 * Cookie format: "name1=value1; name2=value2; ..."
 * @param cookie_header Input cookie header value
 * @param exclude_name Cookie name to exclude (case-insensitive)
 * @param output Output buffer
 * @param output_size Output buffer size
 * @return Length of output string, or -1 on error
 */
int http_filter_cookie(const char *cookie_header, const char *exclude_name,
                       char *output, size_t output_size);

/**
 * Filter User-Agent header to remove R2HTOKEN/xxx pattern
 * Format: "... R2HTOKEN/value ..." or "... R2HTOKEN/value"
 * @param user_agent Input User-Agent header value
 * @param output Output buffer
 * @param output_size Output buffer size
 * @return Length of output string, or -1 on error
 */
int http_filter_user_agent_token(const char *user_agent, char *output,
                                 size_t output_size);

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
