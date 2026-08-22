#include "http_headers.h"
#include "vendor/picohttpparser/picohttpparser.h"
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>

static int map_phr_result(int pret) {
  if (pret == -2)
    return 0;
  if (pret < 0)
    return -1;
  return 1;
}

static void copy_phr_headers(http_headers_t *out, const struct phr_header *phr, size_t num, size_t consumed) {
  out->num_headers = num;
  out->consumed = consumed;
  for (size_t i = 0; i < num; i++) {
    out->headers[i].name = phr[i].name;
    out->headers[i].name_len = phr[i].name_len;
    out->headers[i].value = phr[i].value;
    out->headers[i].value_len = phr[i].value_len;
  }
}

int http_header_name_is(const http_header_t *header, const char *name) {
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

const http_header_t *http_headers_find(const http_headers_t *headers, const char *name) {
  const http_header_t *found = NULL;

  if (!headers || !name)
    return NULL;

  for (size_t i = 0; i < headers->num_headers; i++) {
    if (http_header_name_is(&headers->headers[i], name))
      found = &headers->headers[i];
  }
  return found;
}

int http_headers_copy(const http_headers_t *headers, const char *name, char *dest, size_t dest_size) {
  const http_header_t *header = http_headers_find(headers, name);

  if (!header || !dest || dest_size == 0)
    return -1;

  http_headers_copy_token(dest, dest_size, header->value, header->value_len);
  return 0;
}

char *http_headers_dup(const http_headers_t *headers, const char *name) {
  const http_header_t *header = http_headers_find(headers, name);
  char *copy;

  if (!header)
    return NULL;

  copy = malloc(header->value_len + 1);
  if (!copy)
    return NULL;

  memcpy(copy, header->value, header->value_len);
  copy[header->value_len] = '\0';
  return copy;
}

int http_headers_get_long(const http_headers_t *headers, const char *name, long *out) {
  const http_header_t *header = http_headers_find(headers, name);
  char tmp[32];
  char *endptr = NULL;
  long value;

  if (!header || !out)
    return -1;

  http_headers_copy_token(tmp, sizeof(tmp), header->value, header->value_len);
  if (tmp[0] == '\0')
    return -1;

  errno = 0;
  value = strtol(tmp, &endptr, 10);
  if (endptr == tmp || *endptr != '\0' || errno == ERANGE)
    return -1;

  *out = value;
  return 0;
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

int http_headers_parse_request(const char *buf, size_t len, size_t last_len, http_req_headers_t *out) {
  struct phr_header phr[HTTP_HEADERS_MAX];
  size_t num_headers = HTTP_HEADERS_MAX;
  const char *method = NULL;
  const char *path = NULL;
  size_t method_len = 0;
  size_t path_len = 0;
  int minor_version = -1;
  int pret;

  if (!buf || !out)
    return -1;

  memset(out, 0, sizeof(*out));
  pret =
      phr_parse_request(buf, len, &method, &method_len, &path, &path_len, &minor_version, phr, &num_headers, last_len);
  if (pret < 0)
    return map_phr_result(pret);

  out->method = method;
  out->method_len = method_len;
  out->path = path;
  out->path_len = path_len;
  out->minor_version = minor_version;
  copy_phr_headers(&out->headers, phr, num_headers, (size_t)pret);
  return 1;
}

int http_headers_parse_response(const char *buf, size_t len, size_t last_len, http_resp_headers_t *out) {
  struct phr_header phr[HTTP_HEADERS_MAX];
  size_t num_headers = HTTP_HEADERS_MAX;
  const char *msg = NULL;
  size_t msg_len = 0;
  int minor_version = -1;
  int status = 0;
  int pret;

  if (!buf || !out)
    return -1;

  memset(out, 0, sizeof(*out));
  pret = phr_parse_response(buf, len, &minor_version, &status, &msg, &msg_len, phr, &num_headers, last_len);
  if (pret < 0)
    return map_phr_result(pret);

  out->minor_version = minor_version;
  out->status = status;
  out->msg = msg;
  out->msg_len = msg_len;
  copy_phr_headers(&out->headers, phr, num_headers, (size_t)pret);
  return 1;
}

int http_headers_parse_rtsp_response(const char *buf, size_t len, size_t last_len, rtsp_resp_headers_t *out) {
  struct phr_header phr[HTTP_HEADERS_MAX];
  size_t num_headers = HTTP_HEADERS_MAX;
  const char *newline;
  char status_line[128];
  size_t status_line_len;
  size_t copy_len;
  size_t header_last_len = 0;
  int status = 0;
  int pret;

  if (!buf || !out)
    return -1;

  memset(out, 0, sizeof(*out));

  if (len < 8)
    return 0;
  if (memcmp(buf, "RTSP/1.0", 8) != 0)
    return -1;

  newline = memchr(buf, '\n', len);
  if (!newline)
    return 0;

  status_line_len = (size_t)(newline - buf) + 1;
  copy_len = status_line_len < sizeof(status_line) ? status_line_len : sizeof(status_line) - 1;
  memcpy(status_line, buf, copy_len);
  status_line[copy_len] = '\0';
  if (sscanf(status_line, "RTSP/1.0 %d", &status) != 1 || status < 100 || status > 999)
    return -1;

  if (last_len > status_line_len)
    header_last_len = last_len - status_line_len;

  pret = phr_parse_headers(buf + status_line_len, len - status_line_len, phr, &num_headers, header_last_len);
  if (pret < 0)
    return map_phr_result(pret);

  out->status = status;
  copy_phr_headers(&out->headers, phr, num_headers, status_line_len + (size_t)pret);
  return 1;
}
