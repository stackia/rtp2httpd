#ifndef __HTTP_PROXY_H__
#define __HTTP_PROXY_H__

#include <stdint.h>
#include <sys/types.h>

/* Forward declaration */
struct connection_s;

/* ========== HTTP PROXY BUFFER SIZE CONFIGURATION ========== */

/* HTTP proxy response buffer - for receiving upstream response headers */
#define HTTP_PROXY_RESPONSE_BUFFER_SIZE 8192

/* HTTP proxy request buffer - for building outgoing requests */
#define HTTP_PROXY_REQUEST_BUFFER_SIZE 4096

/* HTTP proxy host buffer - for target hostname */
#define HTTP_PROXY_HOST_SIZE 256

/* HTTP proxy path buffer - for target path with query string */
#define HTTP_PROXY_PATH_SIZE 2048

/* HTTP proxy content type buffer */
#define HTTP_PROXY_CONTENT_TYPE_SIZE 256

/* ========== HTTP PROXY STATES ========== */

/* HTTP proxy protocol states - async state machine */
typedef enum {
  HTTP_PROXY_STATE_INIT = 0,
  HTTP_PROXY_STATE_CONNECTING,       /* Async TCP connection in progress */
  HTTP_PROXY_STATE_CONNECTED,        /* Connected, ready to send request */
  HTTP_PROXY_STATE_SENDING_REQUEST,  /* Sending HTTP request */
  HTTP_PROXY_STATE_AWAITING_HEADERS, /* Waiting for response headers */
  HTTP_PROXY_STATE_STREAMING,        /* Streaming response body */
  HTTP_PROXY_STATE_COMPLETE,         /* Response complete (Content-Length reached
                                        or connection closed) */
  HTTP_PROXY_STATE_CLOSING,          /* Connection closing */
  HTTP_PROXY_STATE_ERROR
} http_proxy_state_t;

/* HTTP proxy session structure */
typedef struct {
  int initialized; /* Flag: session has been initialized with resources */
  int socket;                        /* TCP socket to upstream server */
  int epoll_fd;                      /* Epoll file descriptor for socket
                                        registration */
  struct connection_s *conn;         /* Connection pointer for fdmap registration
                                        and output */
  http_proxy_state_t state;          /* Current state */
  int status_index;                  /* Index in status_shared->clients array */

  /* Target server info */
  char target_host[HTTP_PROXY_HOST_SIZE];
  int target_port;
  char target_path[HTTP_PROXY_PATH_SIZE];

  /* Request method from client (GET, POST, PUT, DELETE, etc.) */
  char method[16];

  /* Response parsing state */
  int response_status_code;                          /* HTTP status code */
  char response_content_type[HTTP_PROXY_CONTENT_TYPE_SIZE]; /* Content-Type */
  ssize_t content_length;   /* Content-Length (-1 if chunked or unknown) */
  ssize_t bytes_received;   /* Bytes of body received so far */
  int headers_received;     /* Flag: headers fully received */
  int headers_forwarded;    /* Flag: headers forwarded to client */

  /* Non-blocking I/O state */
  char pending_request[HTTP_PROXY_REQUEST_BUFFER_SIZE]; /* Request being sent */
  size_t pending_request_len;                           /* Total length */
  size_t pending_request_sent;                          /* Bytes already sent */
  uint8_t response_buffer[HTTP_PROXY_RESPONSE_BUFFER_SIZE]; /* Receive buffer */
  size_t response_buffer_pos; /* Current position in response buffer */

  /* Raw headers from client request for full passthrough (pointer to avoid copy)
   */
  const char *raw_headers; /* Points to http_request_t.raw_headers, no ownership
                            */
  size_t raw_headers_len;

  /* Request body from client (pointer to avoid copy) */
  const char *request_body; /* Points to http_request_t.body, no ownership */
  size_t request_body_len;
  size_t request_body_sent; /* Bytes of request body already sent */

  /* Body rewriting state (for M3U, HTML, etc.) */
  int needs_body_rewrite;          /* Flag: response needs body rewriting */
  char *rewrite_body_buffer;       /* Dynamically allocated body buffer */
  size_t rewrite_body_buffer_size; /* Allocated buffer size */
  size_t rewrite_body_buffer_used; /* Bytes used in buffer */

  /* Saved response headers for passthrough during body rewrite */
  char *saved_response_headers;    /* malloc'd copy of original response headers */
  size_t saved_response_headers_len;

  /* Request headers for base URL construction */
  char host_header[HTTP_PROXY_HOST_SIZE];           /* Host header from client */
  char x_forwarded_host[HTTP_PROXY_HOST_SIZE];      /* X-Forwarded-Host header */
  char x_forwarded_proto[16];                       /* X-Forwarded-Proto header */

  /* Cleanup state */
  int cleanup_done; /* Flag: cleanup has been completed */
} http_proxy_session_t;

/* ========== FUNCTION PROTOTYPES ========== */

/**
 * Initialize HTTP proxy session structure
 * @param session HTTP proxy session to initialize
 */
void http_proxy_session_init(http_proxy_session_t *session);

/**
 * Parse HTTP proxy target URL
 * Accepts format: /http/host:port/path?query
 *
 * @param session HTTP proxy session to populate
 * @param url URL string to parse
 * @return 0 on success, -1 on error
 */
int http_proxy_parse_url(http_proxy_session_t *session, const char *url);

/**
 * Set HTTP method for the proxy request
 * @param session HTTP proxy session
 * @param method HTTP method string (GET, POST, PUT, DELETE, etc.)
 */
void http_proxy_set_method(http_proxy_session_t *session, const char *method);

/**
 * Set raw headers for full passthrough from client request
 * These headers will be forwarded as-is to upstream (except Host, Connection)
 * @param session HTTP proxy session
 * @param raw_headers Raw header string in "Name: Value\r\n" format
 * @param raw_headers_len Length of raw headers string
 */
void http_proxy_set_raw_headers(http_proxy_session_t *session,
                                const char *raw_headers, size_t raw_headers_len);

/**
 * Set request body for passthrough from client request
 * @param session HTTP proxy session
 * @param body Request body data
 * @param body_len Length of request body
 */
void http_proxy_set_request_body(http_proxy_session_t *session,
                                 const char *body, size_t body_len);

/**
 * Set request headers for base URL construction during content rewriting
 * @param session HTTP proxy session
 * @param host_header Host header value (can be NULL)
 * @param x_forwarded_host X-Forwarded-Host header value (can be NULL)
 * @param x_forwarded_proto X-Forwarded-Proto header value (can be NULL)
 */
void http_proxy_set_request_headers(http_proxy_session_t *session,
                                    const char *host_header,
                                    const char *x_forwarded_host,
                                    const char *x_forwarded_proto);

/**
 * Connect to upstream HTTP server (non-blocking)
 * @param session HTTP proxy session (must have epoll_fd set)
 * @return 0 on success (connection in progress), -1 on error
 */
int http_proxy_connect(http_proxy_session_t *session);

/**
 * Handle socket events (readable/writable) for async I/O state machine
 * Called when socket has EPOLLIN or EPOLLOUT events
 * @param session HTTP proxy session
 * @param events Epoll events (EPOLLIN, EPOLLOUT, etc.)
 * @return Number of bytes forwarded to client (>0), 0 if no data forwarded, -1
 * on error
 */
int http_proxy_handle_socket_event(http_proxy_session_t *session,
                                   uint32_t events);

/**
 * Cleanup HTTP proxy session
 * Closes socket and cleans up resources
 * @param session HTTP proxy session
 * @return 0 if cleanup completed
 */
int http_proxy_session_cleanup(http_proxy_session_t *session);

/**
 * Build HTTP proxy URL for transformed M3U
 * Converts http://host:port/path to {BASE_URL}http/host:port/path
 *
 * @param http_url Original HTTP URL (must start with http://)
 * @param base_url_placeholder Placeholder string for base URL (e.g.,
 * "{BASE_URL}")
 * @param output Buffer to store transformed URL
 * @param output_size Size of output buffer
 * @return 0 on success, -1 on error
 */
int http_proxy_build_url(const char *http_url, const char *base_url_placeholder,
                         char *output, size_t output_size);

#endif /* __HTTP_PROXY_H__ */
