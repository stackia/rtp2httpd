#include "http_headers.h"
#include <errno.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>

int http_header_name_is(const struct phr_header *header, const char *name) {
  size_t name_len;

  if (!header || !header->name || !name)
    return 0;

  name_len = strlen(name);
  return header->name_len == name_len && strncasecmp(header->name, name, name_len) == 0;
}

void http_headers_copy_token(char *dest, size_t dest_size, const char *src, size_t src_len) {
  if (!dest || dest_size == 0)
    return;
  if (!src) {
    dest[0] = '\0';
    return;
  }
  if (src_len >= dest_size)
    src_len = dest_size - 1;
  memcpy(dest, src, src_len);
  dest[src_len] = '\0';
}

const struct phr_header *http_headers_find(const struct phr_header *headers, size_t num_headers, const char *name) {
  const struct phr_header *found = NULL;

  if (!headers || !name)
    return NULL;

  for (size_t i = 0; i < num_headers; i++) {
    if (http_header_name_is(&headers[i], name))
      found = &headers[i];
  }
  return found;
}

int http_headers_copy(const struct phr_header *headers, size_t num_headers, const char *name, char *dest,
                      size_t dest_size) {
  const struct phr_header *header = http_headers_find(headers, num_headers, name);

  if (!header || !dest || dest_size == 0)
    return -1;

  http_headers_copy_token(dest, dest_size, header->value, header->value_len);
  return 0;
}

char *http_headers_dup(const struct phr_header *headers, size_t num_headers, const char *name) {
  const struct phr_header *header = http_headers_find(headers, num_headers, name);
  char *copy;

  if (!header)
    return NULL;

  copy = malloc(header->value_len + 1);
  if (!copy)
    return NULL;

  http_headers_copy_token(copy, header->value_len + 1, header->value, header->value_len);
  return copy;
}

int http_header_value_long(const struct phr_header *header, long *out) {
  char tmp[32];
  char *endptr = NULL;
  long value;

  if (!header || !header->value || !out || header->value_len == 0 || header->value_len >= sizeof(tmp))
    return -1;

  http_headers_copy_token(tmp, sizeof(tmp), header->value, header->value_len);

  errno = 0;
  value = strtol(tmp, &endptr, 10);
  if (endptr == tmp || *endptr != '\0' || errno == ERANGE)
    return -1;

  *out = value;
  return 0;
}

int http_headers_get_long(const struct phr_header *headers, size_t num_headers, const char *name, long *out) {
  return http_header_value_long(http_headers_find(headers, num_headers, name), out);
}

size_t http_headers_without_final_blank_line(const char *buf, size_t consumed) {
  if (!buf || consumed == 0)
    return consumed;
  if (consumed >= 2 && buf[consumed - 2] == '\r' && buf[consumed - 1] == '\n')
    return consumed - 2;
  if (buf[consumed - 1] == '\n')
    return consumed - 1;
  return consumed;
}
