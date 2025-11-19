#include "http.h"
#include "connection.h"
#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>

static const char *response_codes[] = {
    "HTTP/1.1 200 OK\r\n",                    /* 0 */
    "HTTP/1.1 404 Not Found\r\n",             /* 1 */
    "HTTP/1.1 400 Bad Request\r\n",           /* 2 */
    "HTTP/1.1 501 Not Implemented\r\n",       /* 3 */
    "HTTP/1.1 503 Service Unavailable\r\n",   /* 4 */
    "HTTP/1.1 500 Internal Server Error\r\n", /* 5 */
    "HTTP/1.1 401 Unauthorized\r\n",          /* 6 */
    "HTTP/1.1 304 Not Modified\r\n",          /* 7 */
};

void send_http_headers(connection_t *c, http_status_t status,
                       const char *content_type, const char *extra_headers) {
  char headers[2048];
  int len = 0;

  /* Build complete header in one buffer */
  /* Status line */
  len += snprintf(headers + len, sizeof(headers) - len, "%s",
                  response_codes[status]);

  /* Content-Type (skip for 304 responses which have no body, or if NULL) */
  if (status != STATUS_304 && content_type && content_type[0]) {
    len += snprintf(headers + len, sizeof(headers) - len,
                    "Content-Type: %s\r\n", content_type);
  }

  /* Connection header */
  if (content_type && strcmp(content_type, "text/event-stream") == 0) {
    /* SSE needs keep-alive and cache control */
    len += snprintf(headers + len, sizeof(headers) - len,
                    "Cache-Control: no-cache\r\n"
                    "Connection: keep-alive\r\n");
  } else {
    /* For non-SSE responses, always close the connection (no keep-alive
     * support) */
    len +=
        snprintf(headers + len, sizeof(headers) - len, "Connection: close\r\n");
  }

  /* Extra headers if provided */
  if (extra_headers && extra_headers[0]) {
    len += snprintf(headers + len, sizeof(headers) - len, "%s", extra_headers);
  }

  /* Final CRLF */
  len += snprintf(headers + len, sizeof(headers) - len, "\r\n");

  connection_queue_output(c, (const uint8_t *)headers, len);
  c->headers_sent = 1;
}

int http_url_decode(char *str) {
  char *src = str;
  char *dst = str;
  unsigned int hex_value;

  if (!str)
    return -1;

  while (*src) {
    if (*src == '%') {
      if (strlen(src) >= 3 && sscanf(src + 1, "%2x", &hex_value) == 1) {
        *dst++ = (char)hex_value;
        src += 3;
      } else {
        return -1;
      }
    } else {
      *dst++ = *src++;
    }
  }

  *dst = '\0';
  return 0;
}

/**
 * URL encode a string (RFC 3986)
 * Allocates and returns a new string with encoded characters.
 * Unreserved characters (alphanumeric, -, _, ., ~, /) are not encoded.
 *
 * @param str String to encode
 * @return Newly allocated encoded string (caller must free), or NULL on error
 */
char *http_url_encode(const char *str) {
  static const char hex_chars[] = "0123456789ABCDEF";
  size_t len;
  size_t encoded_len = 0;
  char *encoded;
  size_t i, j;

  if (!str)
    return NULL;

  len = strlen(str);

  /* Calculate required buffer size */
  for (i = 0; i < len; i++) {
    unsigned char c = (unsigned char)str[i];
    if (isalnum(c) || c == '-' || c == '_' || c == '.' || c == '~' ||
        c == '/') {
      encoded_len++;
    } else {
      encoded_len += 3; /* %XX */
    }
  }

  encoded = malloc(encoded_len + 1);
  if (!encoded) {
    return NULL;
  }

  /* Encode the string */
  for (i = 0, j = 0; i < len; i++) {
    unsigned char c = (unsigned char)str[i];
    if (isalnum(c) || c == '-' || c == '_' || c == '.' || c == '~' ||
        c == '/') {
      encoded[j++] = c;
    } else {
      encoded[j++] = '%';
      encoded[j++] = hex_chars[c >> 4];
      encoded[j++] = hex_chars[c & 0x0F];
    }
  }
  encoded[j] = '\0';

  return encoded;
}

/**
 * Initialize HTTP request structure
 */
void http_request_init(http_request_t *req) {
  if (!req)
    return;
  memset(req, 0, sizeof(*req));
  req->parse_state = HTTP_PARSE_REQ_LINE;
  req->content_length = -1;
  req->body_len = 0;
}

/**
 * Parse HTTP request from buffer (incremental parsing)
 * Returns: 0 = need more data, 1 = request complete, -1 = parse error
 */
int http_parse_request(char *inbuf, int *in_len, http_request_t *req) {
  if (!inbuf || !in_len || !req)
    return -1;

  /* Parse HTTP request line */
  if (req->parse_state == HTTP_PARSE_REQ_LINE) {
    char *line_end = strstr(inbuf, "\r\n");
    if (!line_end)
      return 0; /* Need more data */

    size_t line_len = (size_t)(line_end - inbuf) + 2;
    *line_end = '\0';

    /* Parse: METHOD URL HTTP/1.x */
    char *sp1 = strchr(inbuf, ' ');
    if (sp1) {
      *sp1 = '\0';
      strncpy(req->method, inbuf, sizeof(req->method) - 1);
      req->method[sizeof(req->method) - 1] = '\0';

      char *sp2 = strchr(sp1 + 1, ' ');
      if (sp2) {
        *sp2 = '\0';
        strncpy(req->url, sp1 + 1, sizeof(req->url) - 1);
        req->url[sizeof(req->url) - 1] = '\0';
      }
    }

    /* Shift buffer */
    memmove(inbuf, inbuf + line_len, *in_len - (int)line_len);
    *in_len -= (int)line_len;
    req->parse_state = HTTP_PARSE_HEADERS;
  }

  /* Parse headers */
  if (req->parse_state == HTTP_PARSE_HEADERS) {
    for (;;) {
      char *line_end = strstr(inbuf, "\r\n");
      if (!line_end)
        return 0; /* Need more data */

      size_t line_len = (size_t)(line_end - inbuf) + 2;

      /* Empty line = end of headers */
      if (line_len == 2) {
        memmove(inbuf, inbuf + 2, *in_len - 2);
        *in_len -= 2;

        /* Check if we need to read body */
        if (req->content_length > 0) {
          req->parse_state = HTTP_PARSE_BODY;
          break; /* Exit header parsing loop to read body */
        } else {
          req->parse_state = HTTP_PARSE_COMPLETE;
          return 1; /* Request complete */
        }
      }

      *line_end = '\0';

      /* Parse header: Name: Value */
      char *colon = strchr(inbuf, ':');
      if (colon) {
        *colon = '\0';
        char *value = colon + 1;
        /* Skip leading whitespace */
        while (*value == ' ' || *value == '\t')
          value++;

        /* Trim trailing whitespace */
        char *value_end = value + strlen(value);
        while (value_end > value &&
               (value_end[-1] == ' ' || value_end[-1] == '\t')) {
          value_end--;
          *value_end = '\0';
        }

        /* Extract interesting headers */
        if (strcasecmp(inbuf, "Host") == 0) {
          strncpy(req->hostname, value, sizeof(req->hostname) - 1);
          req->hostname[sizeof(req->hostname) - 1] = '\0';
        } else if (strcasecmp(inbuf, "User-Agent") == 0) {
          strncpy(req->user_agent, value, sizeof(req->user_agent) - 1);
          req->user_agent[sizeof(req->user_agent) - 1] = '\0';
        } else if (strcasecmp(inbuf, "Accept") == 0) {
          strncpy(req->accept, value, sizeof(req->accept) - 1);
          req->accept[sizeof(req->accept) - 1] = '\0';
        } else if (strcasecmp(inbuf, "If-None-Match") == 0) {
          strncpy(req->if_none_match, value, sizeof(req->if_none_match) - 1);
          req->if_none_match[sizeof(req->if_none_match) - 1] = '\0';
        } else if (strcasecmp(inbuf, "X-Request-Snapshot") == 0) {
          req->x_request_snapshot = (value[0] == '1');
        } else if (strcasecmp(inbuf, "X-Forwarded-For") == 0) {
          /* Extract first IP from X-Forwarded-For (format: "ip1, ip2, ip3") */
          const char *comma = strchr(value, ',');
          size_t ip_len;
          if (comma) {
            ip_len = (size_t)(comma - value);
          } else {
            ip_len = strlen(value);
          }

          /* Copy first IP, limiting to buffer size */
          if (ip_len >= sizeof(req->x_forwarded_for)) {
            ip_len = sizeof(req->x_forwarded_for) - 1;
          }
          strncpy(req->x_forwarded_for, value, ip_len);
          req->x_forwarded_for[ip_len] = '\0';

          /* Trim trailing whitespace */
          char *end = req->x_forwarded_for + ip_len;
          while (end > req->x_forwarded_for &&
                 (end[-1] == ' ' || end[-1] == '\t')) {
            end--;
            *end = '\0';
          }
        } else if (strcasecmp(inbuf, "Content-Length") == 0) {
          req->content_length = atoi(value);
        }
      }

      /* Shift buffer */
      memmove(inbuf, inbuf + line_len, *in_len - (int)line_len);
      *in_len -= (int)line_len;
    }
  }

  /* Parse body if needed */
  if (req->parse_state == HTTP_PARSE_BODY) {
    int body_size = req->content_length;
    if (body_size > (int)sizeof(req->body) - 1)
      body_size = (int)sizeof(req->body) - 1; /* Truncate if too large */

    if (*in_len >= body_size) {
      /* We have the full body */
      memcpy(req->body, inbuf, body_size);
      req->body[body_size] = '\0';
      req->body_len = body_size;

      /* Shift buffer */
      memmove(inbuf, inbuf + body_size, *in_len - body_size);
      *in_len -= body_size;

      req->parse_state = HTTP_PARSE_COMPLETE;
      return 1; /* Request complete */
    } else {
      return 0; /* Need more data */
    }
  }

  return 0;
}

/**
 * Find parameter in query/form string (case-insensitive)
 * @param query_string Query or form data string
 * @param param_name Parameter name to search for
 * @param param_len Length of parameter name
 * @return Pointer to parameter start, or NULL if not found
 */
static const char *find_query_param(const char *query_string,
                                    const char *param_name, size_t param_len) {
  const char *pos = query_string;

  while (pos && *pos) {
    /* Check if this position matches our parameter */
    if (strncasecmp(pos, param_name, param_len) == 0 && pos[param_len] == '=') {
      return pos;
    }

    /* Move to next parameter (find next &) */
    pos = strchr(pos, '&');
    if (pos) {
      pos++; /* Skip the & */
    }
  }

  return NULL;
}

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
                           char *value_buf, size_t value_size) {
  const char *param_start, *value_start, *value_end;
  size_t param_len = strlen(param_name);
  size_t value_len;

  if (!query_string || !param_name || !value_buf) {
    return -1;
  }

  /* Find parameter in query string (case-insensitive) */
  param_start = find_query_param(query_string, param_name, param_len);
  if (!param_start) {
    return -1; /* Parameter not found */
  }

  /* Find value start */
  value_start = param_start + param_len + 1; /* Skip "param=" */

  /* Find value end (next & or end of string) */
  value_end = strchr(value_start, '&');
  if (!value_end) {
    value_end = value_start + strlen(value_start);
  }

  /* Check value length */
  value_len = value_end - value_start;
  if (value_len >= value_size) {
    return -1; /* Value too long */
  }

  /* Copy value */
  strncpy(value_buf, value_start, value_len);
  value_buf[value_len] = '\0';

  /* URL decode the value in-place */
  if (http_url_decode(value_buf) != 0) {
    return -1; /* Invalid URL encoding */
  }

  return 0;
}

/**
 * Send HTTP 400 Bad Request response
 * @param conn Connection object
 */
void http_send_400(connection_t *conn) {
  static const char body[] = "<!doctype html><title>400</title>Bad Request";

  /* Send headers */
  send_http_headers(conn, STATUS_400, "text/html; charset=utf-8", NULL);

  /* Send body and flush */
  connection_queue_output_and_flush(conn, (const uint8_t *)body,
                                    sizeof(body) - 1);
}

/**
 * Send HTTP 404 Not Found response
 * @param conn Connection object
 */
void http_send_404(connection_t *conn) {
  static const char body[] = "<!doctype html><title>404</title>Not Found";

  /* Send headers */
  send_http_headers(conn, STATUS_404, "text/html; charset=utf-8", NULL);

  /* Send body and flush */
  connection_queue_output_and_flush(conn, (const uint8_t *)body,
                                    sizeof(body) - 1);
}

/**
 * Send HTTP 500 Internal Server Error response
 * @param conn Connection object
 */
void http_send_500(connection_t *conn) {
  static const char body[] =
      "<!doctype html><title>500</title>Internal Server Error";

  /* Send headers */
  send_http_headers(conn, STATUS_500, "text/html; charset=utf-8", NULL);

  /* Send body and flush */
  connection_queue_output_and_flush(conn, (const uint8_t *)body,
                                    sizeof(body) - 1);
}

/**
 * Send HTTP 503 Service Unavailable response
 * @param conn Connection object
 */
void http_send_503(connection_t *conn) {
  static const char body[] =
      "<!doctype html><title>503</title>Service Unavailable";

  /* Send headers */
  send_http_headers(conn, STATUS_503, "text/html; charset=utf-8", NULL);

  /* Send body and flush */
  connection_queue_output_and_flush(conn, (const uint8_t *)body,
                                    sizeof(body) - 1);
}

/**
 * Send HTTP 401 Unauthorized response
 * @param conn Connection object
 */
void http_send_401(connection_t *conn) {
  static const char body[] = "<!doctype html><title>401</title>Unauthorized";

  /* Send headers with WWW-Authenticate */
  send_http_headers(conn, STATUS_401, "text/html; charset=utf-8",
                    "WWW-Authenticate: Bearer\r\n");

  /* Send body and flush */
  connection_queue_output_and_flush(conn, (const uint8_t *)body,
                                    sizeof(body) - 1);
}

/**
 * Parse URL and extract components (protocol, host, port, path)
 * @param url Input URL string
 * @param protocol Output buffer for protocol (can be NULL)
 * @param host Output buffer for host (can be NULL)
 * @param port Output buffer for port (can be NULL)
 * @param path Output buffer for path (can be NULL)
 * @return 0 on success, -1 on error
 */
int http_parse_url_components(const char *url, char *protocol, char *host,
                              char *port, char *path) {
  const char *p = url;
  size_t len;

  if (!url || !url[0])
    return -1;

  /* Initialize outputs */
  if (protocol)
    protocol[0] = '\0';
  if (host)
    host[0] = '\0';
  if (port)
    port[0] = '\0';
  if (path)
    path[0] = '\0';

  /* Check for protocol (http:// or https://) */
  const char *scheme_end = strstr(p, "://");
  if (scheme_end) {
    /* Extract protocol */
    len = scheme_end - p;
    if (protocol && len < 16) {
      strncpy(protocol, p, len);
      protocol[len] = '\0';
    }
    p = scheme_end + 3; /* Skip "://" */
  }

  /* Find end of host:port (either '/' or end of string) */
  const char *path_start = strchr(p, '/');
  const char *host_end = path_start ? path_start : (p + strlen(p));

  /* Extract path if present */
  if (path_start && path) {
    strncpy(path, path_start, 1023);
    path[1023] = '\0';
  }

  /* Parse host:port */
  const char *port_start = NULL;

  /* Handle IPv6 addresses [host]:port */
  if (*p == '[') {
    const char *bracket_end = strchr(p, ']');
    if (!bracket_end || bracket_end >= host_end)
      return -1;

    /* Extract IPv6 host */
    len = bracket_end - p - 1; /* Exclude brackets */
    if (host && len < 256) {
      strncpy(host, p + 1, len);
      host[len] = '\0';
    }

    /* Check for port after bracket */
    if (bracket_end + 1 < host_end && bracket_end[1] == ':') {
      port_start = bracket_end + 2;
    }
  } else {
    /* IPv4 or hostname - find last colon for port */
    /* But be careful: IPv6 without brackets has multiple colons */
    const char *first_colon = strchr(p, ':');
    const char *last_colon = NULL;

    if (first_colon && first_colon < host_end) {
      /* Check if there's another colon (IPv6 indicator) */
      const char *second_colon = strchr(first_colon + 1, ':');
      if (second_colon && second_colon < host_end) {
        /* Multiple colons = IPv6 without brackets, no port */
        len = host_end - p;
        if (host && len < 256) {
          strncpy(host, p, len);
          host[len] = '\0';
        }
      } else {
        /* Single colon = hostname:port or IPv4:port */
        last_colon = first_colon;
        len = last_colon - p;
        if (host && len < 256) {
          strncpy(host, p, len);
          host[len] = '\0';
        }
        port_start = last_colon + 1;
      }
    } else {
      /* No colon, just host */
      len = host_end - p;
      if (host && len < 256) {
        strncpy(host, p, len);
        host[len] = '\0';
      }
    }
  }

  /* Extract port if found */
  if (port_start && port) {
    len = host_end - port_start;
    if (len < 16) {
      strncpy(port, port_start, len);
      port[len] = '\0';
    }
  }

  return 0;
}

/**
 * Match Host header against expected hostname
 * @param request_host_header Host header from HTTP request
 * @param expected_host Expected hostname to match against (just the hostname
 * part)
 * @return 1 if match, 0 if not match, -1 on error
 */
int http_match_host_header(const char *request_host_header,
                           const char *expected_host) {
  char request_hostname[256];

  if (!request_host_header || !expected_host)
    return -1;

  /* Extract hostname from Host header (ignore port part) */
  const char *request_colon = strchr(request_host_header, ':');
  if (request_colon) {
    /* Host header has port, extract hostname part only */
    size_t host_len = (size_t)(request_colon - request_host_header);
    if (host_len >= sizeof(request_hostname))
      host_len = sizeof(request_hostname) - 1;
    strncpy(request_hostname, request_host_header, host_len);
    request_hostname[host_len] = '\0';
  } else {
    /* Host header has no port */
    strncpy(request_hostname, request_host_header,
            sizeof(request_hostname) - 1);
    request_hostname[sizeof(request_hostname) - 1] = '\0';
  }

  /* Compare only the hostname parts (case-insensitive) */
  return (strcasecmp(request_hostname, expected_host) == 0) ? 1 : 0;
}

/**
 * Check if client-provided ETag matches server ETag
 * Supports wildcards, weak ETags (W/"..."), and comma-separated lists
 * @param if_none_match The If-None-Match header value from client
 * @param etag The server's ETag value
 * @return 1 if matches, 0 otherwise
 */
static int etag_matches(const char *if_none_match, const char *etag) {
  const char *p;
  size_t etag_len;

  if (!if_none_match || !if_none_match[0] || !etag)
    return 0;

  /* Check for wildcard */
  if (if_none_match[0] == '*' && if_none_match[1] == '\0')
    return 1;

  /* Parse comma-separated ETag list */
  p = if_none_match;
  etag_len = strlen(etag);

  while (*p) {
    const char *token_start;
    const char *token_end;
    size_t token_len;
    const char *candidate;
    size_t candidate_len;

    /* Skip whitespace and commas */
    while (*p == ' ' || *p == '\t' || *p == ',')
      p++;

    if (*p == '\0')
      break;

    token_start = p;
    while (*p && *p != ',')
      p++;
    token_end = p;

    /* Trim trailing whitespace */
    while (token_end > token_start &&
           (token_end[-1] == ' ' || token_end[-1] == '\t'))
      token_end--;

    token_len = (size_t)(token_end - token_start);
    if (token_len == 0)
      continue;

    /* Check for wildcard */
    if (token_len == 1 && token_start[0] == '*')
      return 1;

    candidate = token_start;
    candidate_len = token_len;

    /* Handle weak ETags (W/) */
    if (candidate_len > 2 && candidate[0] == 'W' && candidate[1] == '/') {
      candidate += 2;
      candidate_len -= 2;

      while (candidate_len > 0 && (*candidate == ' ' || *candidate == '\t')) {
        candidate++;
        candidate_len--;
      }
    }

    /* Remove surrounding quotes from ETag if present */
    if (candidate_len > 2 && candidate[0] == '"' &&
        candidate[candidate_len - 1] == '"') {
      candidate++;
      candidate_len -= 2;
    }

    /* Compare ETags */
    if (candidate_len == etag_len && strncmp(candidate, etag, etag_len) == 0)
      return 1;
  }

  return 0;
}

int http_check_etag_and_send_304(connection_t *c, const char *etag,
                                 const char *content_type) {
  char extra_headers[256];

  /* If no ETag provided or no If-None-Match header, cannot use caching */
  if (!c || !etag || c->http_req.if_none_match[0] == '\0') {
    return 0;
  }

  /* Check if client's ETag matches server's current ETag */
  if (!etag_matches(c->http_req.if_none_match, etag)) {
    return 0; /* No match, content should be sent */
  }

  /* ETag matches - send 304 Not Modified response */
  snprintf(extra_headers, sizeof(extra_headers),
           "ETag: \"%s\"\r\n"
           "Content-Length: 0\r\n"
           "Cache-Control: no-cache\r\n",
           etag);

  send_http_headers(c, STATUS_304, content_type, extra_headers);
  connection_queue_output_and_flush(c, NULL, 0);

  return 1; /* 304 was sent */
}

int http_build_etag_headers(char *buffer, size_t buffer_size,
                            size_t content_length, const char *etag,
                            const char *additional_headers) {
  int written = 0;

  if (!buffer || buffer_size == 0) {
    return -1;
  }

  /* Start with Content-Length */
  written =
      snprintf(buffer, buffer_size, "Content-Length: %zu\r\n", content_length);
  if (written < 0 || (size_t)written >= buffer_size) {
    return -1;
  }

  /* Add ETag and Cache-Control if ETag is provided */
  if (etag) {
    int etag_written = snprintf(buffer + written, buffer_size - written,
                                "ETag: \"%s\"\r\n"
                                "Cache-Control: no-cache\r\n",
                                etag);
    if (etag_written < 0 || (size_t)(written + etag_written) >= buffer_size) {
      return -1;
    }
    written += etag_written;
  }

  /* Add any additional headers */
  if (additional_headers && additional_headers[0] != '\0') {
    int add_written = snprintf(buffer + written, buffer_size - written,
                               "%s\r\n", additional_headers);
    if (add_written < 0 || (size_t)(written + add_written) >= buffer_size) {
      return -1;
    }
    written += add_written;
  }

  return written;
}
