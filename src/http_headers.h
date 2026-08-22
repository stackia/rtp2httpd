#ifndef __HTTP_HEADERS_H__
#define __HTTP_HEADERS_H__

#include <stddef.h>

/* Maximum number of headers accepted by the shared picohttpparser front-end.
 * Overflow is treated as a parse error. */
#ifndef HTTP_HEADERS_MAX
#define HTTP_HEADERS_MAX 128
#endif

/**
 * One header field. Pointers alias the caller's buffer and are only valid
 * until that buffer is overwritten. name is NULL for obsolete folded
 * continuation lines (those should be skipped).
 */
typedef struct {
  const char *name;
  size_t name_len;
  const char *value;
  size_t value_len;
} http_header_t;

typedef struct {
  http_header_t headers[HTTP_HEADERS_MAX];
  size_t num_headers;
  size_t consumed; /* bytes consumed through the end of the header block */
} http_headers_t;

typedef struct {
  const char *method;
  size_t method_len;
  const char *path;
  size_t path_len;
  int minor_version;
  http_headers_t headers;
} http_req_headers_t;

typedef struct {
  int minor_version;
  int status;
  const char *msg;
  size_t msg_len;
  http_headers_t headers;
} http_resp_headers_t;

typedef struct {
  int status;
  http_headers_t headers;
} rtsp_resp_headers_t;

/**
 * Parse an HTTP/1.x request line plus headers.
 * @return 1 complete, 0 need more data, -1 parse error
 */
int http_headers_parse_request(const char *buf, size_t len, size_t last_len, http_req_headers_t *out);

/**
 * Parse an HTTP/1.x response status line plus headers.
 * @return 1 complete, 0 need more data, -1 parse error
 */
int http_headers_parse_response(const char *buf, size_t len, size_t last_len, http_resp_headers_t *out);

/**
 * Parse an RTSP/1.0 status line plus headers. buf must start at "RTSP/1.0".
 * @return 1 complete, 0 need more data, -1 parse error
 */
int http_headers_parse_rtsp_response(const char *buf, size_t len, size_t last_len, rtsp_resp_headers_t *out);

/**
 * Last header whose name matches (case-insensitive). Skips folded lines.
 */
const http_header_t *http_headers_find(const http_headers_t *headers, const char *name);

/**
 * Copy a header value into dest (NUL-terminated). Last match wins.
 * @return 0 if found, -1 if missing or dest_size is 0
 */
int http_headers_copy(const http_headers_t *headers, const char *name, char *dest, size_t dest_size);

/**
 * Heap-allocate a NUL-terminated copy of a header value. Caller frees.
 * @return NULL if missing or allocation fails
 */
char *http_headers_dup(const http_headers_t *headers, const char *name);

/**
 * Parse a header as a base-10 long. Last match wins.
 * @return 0 on success, -1 if missing or not a number
 */
int http_headers_get_long(const http_headers_t *headers, const char *name, long *out);

int http_header_name_is(const http_header_t *header, const char *name);

void http_headers_copy_token(char *dest, size_t dest_size, const char *src, size_t src_len);

/**
 * Length of the header block excluding the final blank line terminator
 * (CRLF or LF). Used when injecting extra headers before the empty line.
 */
size_t http_headers_without_final_blank_line(const char *buf, size_t consumed);

#endif /* __HTTP_HEADERS_H__ */
