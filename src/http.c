#include "http.h"
#include "configuration.h"
#include "connection.h"
#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>

/* Maximum allowed request body size (4MB) to prevent OOM from malicious
 * requests */
#define HTTP_REQUEST_BODY_MAX_SIZE (4 * 1024 * 1024)

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

  /* Set-Cookie for r2h-token if needed (token was provided via URL query) */
  if (c->should_set_r2h_cookie && config.r2h_token &&
      config.r2h_token[0] != '\0') {
    len += snprintf(headers + len, sizeof(headers) - len,
                    "Set-Cookie: r2h-token=%s; Path=/; HttpOnly; "
                    "SameSite=Strict\r\n",
                    config.r2h_token);
    c->should_set_r2h_cookie = 0; /* Only set once */
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

void http_request_init(http_request_t *req) {
  if (!req)
    return;
  memset(req, 0, sizeof(*req));
  req->parse_state = HTTP_PARSE_REQ_LINE;
  req->content_length = -1;
  req->body = NULL;
  req->body_len = 0;
  req->body_alloc = 0;
}

void http_request_cleanup(http_request_t *req) {
  if (!req)
    return;
  if (req->body) {
    free(req->body);
    req->body = NULL;
  }
  req->body_len = 0;
  req->body_alloc = 0;
}

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

        /* Save raw headers for proxy forwarding (exclude Host, Connection,
         * Content-Length, Transfer-Encoding which are handled specially,
         * and X-Forwarded-* headers which should not be forwarded to upstream).
         * Cookie and User-Agent are filtered to remove r2h-token before forwarding. */
        if (strcasecmp(inbuf, "Host") != 0 &&
            strcasecmp(inbuf, "Connection") != 0 &&
            strcasecmp(inbuf, "Content-Length") != 0 &&
            strcasecmp(inbuf, "Transfer-Encoding") != 0 &&
            strcasecmp(inbuf, "X-Forwarded-For") != 0 &&
            strcasecmp(inbuf, "X-Forwarded-Host") != 0 &&
            strcasecmp(inbuf, "X-Forwarded-Proto") != 0) {
          const char *filtered_value = value;
          char filter_buf[2048];

          /* Filter r2h-token from Cookie header */
          if (strcasecmp(inbuf, "Cookie") == 0 && config.r2h_token &&
              config.r2h_token[0] != '\0') {
            int flen = http_filter_cookie(value, "r2h-token", filter_buf,
                                          sizeof(filter_buf));
            if (flen > 0) {
              filtered_value = filter_buf;
            } else if (flen == 0) {
              /* Cookie is empty after filtering, skip this header */
              filtered_value = NULL;
            }
          }
          /* Filter R2HTOKEN/xxx from User-Agent header */
          else if (strcasecmp(inbuf, "User-Agent") == 0 && config.r2h_token &&
                   config.r2h_token[0] != '\0') {
            int flen = http_filter_user_agent_token(value, filter_buf,
                                                    sizeof(filter_buf));
            if (flen > 0) {
              filtered_value = filter_buf;
            }
          }

          if (filtered_value && filtered_value[0]) {
            size_t header_line_len = strlen(inbuf) + 2 + strlen(filtered_value) +
                                     2; /* "Name: Value\r\n" */
            if (req->raw_headers_len + header_line_len <
                sizeof(req->raw_headers) - 1) {
              int added =
                  snprintf(req->raw_headers + req->raw_headers_len,
                           sizeof(req->raw_headers) - req->raw_headers_len,
                           "%s: %s\r\n", inbuf, filtered_value);
              if (added > 0) {
                req->raw_headers_len += (size_t)added;
              }
            }
          }
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
        } else if (strcasecmp(inbuf, "X-Forwarded-Host") == 0) {
          strncpy(req->x_forwarded_host, value,
                  sizeof(req->x_forwarded_host) - 1);
          req->x_forwarded_host[sizeof(req->x_forwarded_host) - 1] = '\0';
        } else if (strcasecmp(inbuf, "X-Forwarded-Proto") == 0) {
          strncpy(req->x_forwarded_proto, value,
                  sizeof(req->x_forwarded_proto) - 1);
          req->x_forwarded_proto[sizeof(req->x_forwarded_proto) - 1] = '\0';
        } else if (strcasecmp(inbuf, "Content-Length") == 0) {
          req->content_length = atoi(value);
        } else if (strcasecmp(inbuf, "Cookie") == 0) {
          strncpy(req->cookie, value, sizeof(req->cookie) - 1);
          req->cookie[sizeof(req->cookie) - 1] = '\0';
        }
      }

      /* Shift buffer */
      memmove(inbuf, inbuf + line_len, *in_len - (int)line_len);
      *in_len -= (int)line_len;
    }
  }

  /* Parse body if needed */
  if (req->parse_state == HTTP_PARSE_BODY) {
    size_t body_size = (size_t)req->content_length;

    /* Check body size limit to prevent OOM from malicious requests */
    if (body_size > HTTP_REQUEST_BODY_MAX_SIZE) {
      return -1; /* Body too large */
    }

    /* Allocate body buffer if not already done */
    if (!req->body) {
      req->body = malloc(body_size + 1); /* +1 for null terminator */
      if (!req->body) {
        return -1; /* Allocation failed */
      }
      req->body_alloc = body_size + 1;
      req->body_len = 0;
    }

    /* Calculate how much more we need */
    size_t remaining = body_size - req->body_len;
    size_t available = (size_t)*in_len;
    size_t to_copy = (available < remaining) ? available : remaining;

    if (to_copy > 0) {
      memcpy(req->body + req->body_len, inbuf, to_copy);
      req->body_len += to_copy;

      /* Shift buffer */
      memmove(inbuf, inbuf + to_copy, *in_len - (int)to_copy);
      *in_len -= (int)to_copy;
    }

    if (req->body_len >= body_size) {
      /* We have the full body */
      req->body[req->body_len] = '\0';
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

const char *http_find_url_label(const char *url) {
  const char *p;
  size_t len;

  if (!url) {
    return NULL;
  }

  len = strlen(url);
  if (len == 0) {
    return NULL;
  }

  /* Search backwards for '$' */
  p = url + len;
  while (p > url) {
    p--;
    if (*p == '$') {
      /* '$' at the very end of string (no label text after it) - not a label */
      if (p[1] == '\0') {
        continue;
      }
      /* '${' is a placeholder pattern, not a label */
      if (p[1] == '{') {
        continue;
      }
      return p;
    }
  }

  return NULL;
}

void http_strip_url_label(char *url) {
  const char *label = http_find_url_label(url);
  if (label) {
    /* Truncate at the '$' position */
    url[label - url] = '\0';
  }
}

int http_filter_cookie(const char *cookie_header, const char *exclude_name,
                       char *output, size_t output_size) {
  if (!cookie_header || !exclude_name || !output || output_size == 0) {
    return -1;
  }

  size_t exclude_len = strlen(exclude_name);
  size_t out_len = 0;
  const char *pos = cookie_header;
  int first_cookie = 1;

  output[0] = '\0';

  while (*pos) {
    /* Skip leading whitespace */
    while (*pos == ' ' || *pos == '\t')
      pos++;

    if (*pos == '\0')
      break;

    /* Find end of current cookie (semicolon or end of string) */
    const char *cookie_end = strchr(pos, ';');
    size_t cookie_len = cookie_end ? (size_t)(cookie_end - pos) : strlen(pos);

    /* Check if this cookie matches the one to exclude */
    int should_exclude = 0;
    if (cookie_len > exclude_len && pos[exclude_len] == '=' &&
        strncasecmp(pos, exclude_name, exclude_len) == 0) {
      should_exclude = 1;
    }

    if (!should_exclude && cookie_len > 0) {
      /* Add separator if not first cookie */
      if (!first_cookie) {
        if (out_len + 2 >= output_size) {
          return -1; /* Buffer too small */
        }
        output[out_len++] = ';';
        output[out_len++] = ' ';
      }

      /* Copy cookie */
      if (out_len + cookie_len >= output_size) {
        return -1; /* Buffer too small */
      }
      memcpy(output + out_len, pos, cookie_len);
      out_len += cookie_len;
      first_cookie = 0;
    }

    /* Move to next cookie */
    if (cookie_end) {
      pos = cookie_end + 1;
    } else {
      break;
    }
  }

  output[out_len] = '\0';
  return (int)out_len;
}

int http_filter_user_agent_token(const char *user_agent, char *output,
                                 size_t output_size) {
  if (!user_agent || !output || output_size == 0) {
    return -1;
  }

  const char *token_start = strcasestr(user_agent, "R2HTOKEN/");
  if (!token_start) {
    /* No token found, copy as-is */
    size_t len = strlen(user_agent);
    if (len >= output_size) {
      return -1;
    }
    memcpy(output, user_agent, len + 1);
    return (int)len;
  }

  /* Find end of token (space or end of string) */
  const char *token_end = token_start + 9; /* Skip "R2HTOKEN/" */
  while (*token_end && *token_end != ' ' && *token_end != '\t')
    token_end++;

  /* Determine if there's a space before and after the token.
   * We want to remove exactly one space to avoid double spaces or missing spaces.
   * If token is at start: "R2HTOKEN/xxx suffix" -> "suffix"
   * If token is at end: "prefix R2HTOKEN/xxx" -> "prefix"
   * If token is in middle: "prefix R2HTOKEN/xxx suffix" -> "prefix suffix"
   */
  int has_leading_space =
      (token_start > user_agent &&
       (*(token_start - 1) == ' ' || *(token_start - 1) == '\t'));
  int has_trailing_space = (*token_end == ' ' || *token_end == '\t');

  /* Determine prefix end point */
  const char *prefix_end = token_start;
  if (has_leading_space && has_trailing_space) {
    /* Token in middle: remove leading space, keep trailing space */
    prefix_end--;
  } else if (has_leading_space) {
    /* Token at end: remove leading space */
    prefix_end--;
  }
  /* If only trailing space or no spaces: prefix_end stays at token_start */

  /* Determine suffix start point */
  const char *suffix_start = token_end;
  if (!has_leading_space && has_trailing_space) {
    /* Token at start: skip trailing space */
    suffix_start++;
  }
  /* If token in middle or at end: suffix_start stays at token_end */

  /* Calculate output: prefix + suffix */
  size_t prefix_len = (size_t)(prefix_end - user_agent);
  size_t suffix_len = strlen(suffix_start);
  size_t total_len = prefix_len + suffix_len;

  if (total_len >= output_size) {
    return -1;
  }

  /* Copy prefix */
  if (prefix_len > 0) {
    memcpy(output, user_agent, prefix_len);
  }

  /* Copy suffix */
  if (suffix_len > 0) {
    memcpy(output + prefix_len, suffix_start, suffix_len);
  }

  output[total_len] = '\0';
  return (int)total_len;
}

int http_filter_query_param(const char *query_string, const char *exclude_param,
                            char *output, size_t output_size) {
  if (!query_string || !exclude_param || !output || output_size == 0) {
    return -1;
  }

  size_t exclude_len = strlen(exclude_param);
  size_t out_len = 0;
  const char *pos = query_string;
  int first_param = 1;

  output[0] = '\0';

  while (pos && *pos) {
    /* Find end of current parameter */
    const char *param_end = strchr(pos, '&');
    size_t param_len = param_end ? (size_t)(param_end - pos) : strlen(pos);

    /* Check if this parameter matches the one to exclude */
    int should_exclude = 0;
    if (param_len > exclude_len && pos[exclude_len] == '=' &&
        strncasecmp(pos, exclude_param, exclude_len) == 0) {
      should_exclude = 1;
    }

    if (!should_exclude && param_len > 0) {
      /* Add separator if not first parameter */
      if (!first_param) {
        if (out_len + 1 >= output_size) {
          return -1; /* Buffer too small */
        }
        output[out_len++] = '&';
      }

      /* Copy parameter */
      if (out_len + param_len >= output_size) {
        return -1; /* Buffer too small */
      }
      memcpy(output + out_len, pos, param_len);
      out_len += param_len;
      first_param = 0;
    }

    /* Move to next parameter */
    if (param_end) {
      pos = param_end + 1;
    } else {
      break;
    }
  }

  output[out_len] = '\0';
  return (int)out_len;
}

void http_send_400(connection_t *conn) {
  static const char body[] = "<!doctype html><title>400</title>Bad Request";

  /* Send headers */
  send_http_headers(conn, STATUS_400, "text/html; charset=utf-8", NULL);

  /* Send body and flush */
  connection_queue_output_and_flush(conn, (const uint8_t *)body,
                                    sizeof(body) - 1);
}

void http_send_404(connection_t *conn) {
  static const char body[] = "<!doctype html><title>404</title>Not Found";

  /* Send headers */
  send_http_headers(conn, STATUS_404, "text/html; charset=utf-8", NULL);

  /* Send body and flush */
  connection_queue_output_and_flush(conn, (const uint8_t *)body,
                                    sizeof(body) - 1);
}

void http_send_500(connection_t *conn) {
  static const char body[] =
      "<!doctype html><title>500</title>Internal Server Error";

  /* Send headers */
  send_http_headers(conn, STATUS_500, "text/html; charset=utf-8", NULL);

  /* Send body and flush */
  connection_queue_output_and_flush(conn, (const uint8_t *)body,
                                    sizeof(body) - 1);
}

void http_send_503(connection_t *conn) {
  static const char body[] =
      "<!doctype html><title>503</title>Service Unavailable";

  /* Send headers */
  send_http_headers(conn, STATUS_503, "text/html; charset=utf-8", NULL);

  /* Send body and flush */
  connection_queue_output_and_flush(conn, (const uint8_t *)body,
                                    sizeof(body) - 1);
}

void http_send_401(connection_t *conn) {
  static const char body[] = "<!doctype html><title>401</title>Unauthorized";

  /* Send headers with WWW-Authenticate */
  send_http_headers(conn, STATUS_401, "text/html; charset=utf-8",
                    "WWW-Authenticate: Bearer\r\n");

  /* Send body and flush */
  connection_queue_output_and_flush(conn, (const uint8_t *)body,
                                    sizeof(body) - 1);
}

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
