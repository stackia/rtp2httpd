#ifndef __HTTP_HEADERS_H__
#define __HTTP_HEADERS_H__

#include "vendor/picohttpparser/picohttpparser.h"
#include <stddef.h>

/* Maximum number of headers accepted by picohttpparser. Overflow is a parse error. */
#ifndef HTTP_HEADERS_MAX
#define HTTP_HEADERS_MAX 128
#endif

int http_header_name_is(const struct phr_header *header, const char *name);

/**
 * Last header whose name matches (case-insensitive). Skips folded lines.
 */
const struct phr_header *http_headers_find(const struct phr_header *headers, size_t num_headers, const char *name);

/**
 * Copy a header value into dest (NUL-terminated). Last match wins.
 * @return 0 if found, -1 if missing or dest_size is 0
 */
int http_headers_copy(const struct phr_header *headers, size_t num_headers, const char *name, char *dest,
                      size_t dest_size);

/**
 * Heap-allocate a NUL-terminated copy of a header value. Caller frees.
 * Use only when a C string must outlive the parse buffer or exceed stack limits.
 * @return NULL if missing or allocation fails
 */
char *http_headers_dup(const struct phr_header *headers, size_t num_headers, const char *name);

/**
 * Parse one header value as a base-10 long.
 * @return 0 on success, -1 if missing or not a number
 */
int http_header_value_long(const struct phr_header *header, long *out);

/**
 * Parse a header as a base-10 long. Last match wins.
 * @return 0 on success, -1 if missing or not a number
 */
int http_headers_get_long(const struct phr_header *headers, size_t num_headers, const char *name, long *out);

void http_headers_copy_token(char *dest, size_t dest_size, const char *src, size_t src_len);

/**
 * Length of the header block excluding the final blank line terminator
 * (CRLF or LF). Used when injecting extra headers before the empty line.
 */
size_t http_headers_without_final_blank_line(const char *buf, size_t consumed);

#endif /* __HTTP_HEADERS_H__ */
