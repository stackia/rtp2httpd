#include "http_proxy.h"
#include "buffer_pool.h"
#include "configuration.h"
#include "connection.h"
#include "http.h" /* For http_url_encode */
#include "http_proxy_rewrite.h"
#include "multicast.h"
#include "status.h"
#include "utils.h"
#include "worker.h"
#include "zerocopy.h"
#include <arpa/inet.h>
#include <errno.h>
#include <netdb.h>
#include <netinet/in.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/epoll.h>
#include <sys/socket.h>
#include <unistd.h>

/*
 * HTTP Proxy Client Implementation
 *
 * This module implements an HTTP reverse proxy that forwards requests
 * to upstream HTTP servers and streams the response back to clients.
 */

#define HTTP_PROXY_USER_AGENT "rtp2httpd/" VERSION

/* Helper function prototypes */
static int http_proxy_build_request(http_proxy_session_t *session);
static int http_proxy_try_send_pending(http_proxy_session_t *session);
static int http_proxy_try_receive_response(http_proxy_session_t *session);
static int http_proxy_parse_response_headers(http_proxy_session_t *session);

void http_proxy_session_init(http_proxy_session_t *session) {
  memset(session, 0, sizeof(http_proxy_session_t));
  session->initialized = 1;
  session->state = HTTP_PROXY_STATE_INIT;
  session->socket = -1;
  session->epoll_fd = -1;
  session->status_index = -1;
  session->target_port = 80; /* Default HTTP port */
  session->content_length = -1;
  session->bytes_received = 0;
  session->headers_received = 0;
  session->headers_forwarded = 0;
  session->cleanup_done = 0;
}

int http_proxy_parse_url(http_proxy_session_t *session, const char *url) {
  const char *p;
  char *colon;
  char *slash;
  size_t host_len;

  if (!session || !url) {
    logger(LOG_ERROR, "HTTP Proxy: Invalid parameters to parse_url");
    return -1;
  }

  /* Skip /http/ prefix if present */
  if (strncmp(url, "/http/", 6) == 0) {
    p = url + 6;
  } else if (strncmp(url, "http://", 7) == 0) {
    p = url + 7;
  } else {
    /* Assume it's already host:port/path format */
    p = url;
  }

  /* Find the first slash after host:port */
  slash = strchr(p, '/');

  /* Extract host and port */
  if (slash) {
    host_len = slash - p;
  } else {
    host_len = strlen(p);
  }

  /* Check for port in host:port format */
  /* Need to handle IPv6 addresses like [::1]:8080 */
  if (p[0] == '[') {
    /* IPv6 address */
    char *bracket = strchr(p, ']');
    if (bracket && bracket < p + host_len) {
      colon = strchr(bracket, ':');
      if (colon && colon < p + host_len) {
        /* Has port after IPv6 address */
        size_t addr_len = bracket - p + 1;
        if (addr_len >= HTTP_PROXY_HOST_SIZE) {
          logger(LOG_ERROR, "HTTP Proxy: Host too long");
          return -1;
        }
        memcpy(session->target_host, p, addr_len);
        session->target_host[addr_len] = '\0';
        session->target_port = atoi(colon + 1);
      } else {
        /* No port, just IPv6 address */
        if (host_len >= HTTP_PROXY_HOST_SIZE) {
          logger(LOG_ERROR, "HTTP Proxy: Host too long");
          return -1;
        }
        memcpy(session->target_host, p, host_len);
        session->target_host[host_len] = '\0';
      }
    } else {
      logger(LOG_ERROR, "HTTP Proxy: Invalid IPv6 address format");
      return -1;
    }
  } else {
    /* IPv4 or hostname */
    colon = memchr(p, ':', host_len);
    if (colon) {
      /* Has port */
      size_t hostname_len = colon - p;
      if (hostname_len >= HTTP_PROXY_HOST_SIZE) {
        logger(LOG_ERROR, "HTTP Proxy: Host too long");
        return -1;
      }
      memcpy(session->target_host, p, hostname_len);
      session->target_host[hostname_len] = '\0';
      session->target_port = atoi(colon + 1);
    } else {
      /* No port */
      if (host_len >= HTTP_PROXY_HOST_SIZE) {
        logger(LOG_ERROR, "HTTP Proxy: Host too long");
        return -1;
      }
      memcpy(session->target_host, p, host_len);
      session->target_host[host_len] = '\0';
    }
  }

  /* Validate port */
  if (session->target_port <= 0 || session->target_port > 65535) {
    session->target_port = 80;
  }

  /* Extract path (including query string), but strip r2h-token to avoid
   * leaking credentials to upstream server */
  if (slash) {
    if (strlen(slash) >= HTTP_PROXY_PATH_SIZE) {
      logger(LOG_ERROR, "HTTP Proxy: Path too long");
      return -1;
    }

    /* Check if URL has query string with potential r2h-token */
    const char *query_start = strchr(slash, '?');
    if (query_start && config.r2h_token && config.r2h_token[0] != '\0') {
      /* Copy path portion up to query string */
      size_t path_len = (size_t)(query_start - slash);
      memcpy(session->target_path, slash, path_len);

      /* Filter out r2h-token from query string */
      char filtered_query[HTTP_PROXY_PATH_SIZE];
      int filtered_len = http_filter_query_param(query_start + 1, "r2h-token",
                                                  filtered_query,
                                                  sizeof(filtered_query));
      if (filtered_len > 0) {
        /* Append filtered query string */
        int result = snprintf(session->target_path + path_len,
                              HTTP_PROXY_PATH_SIZE - path_len, "?%s",
                              filtered_query);
        if (result < 0 || (size_t)result >= HTTP_PROXY_PATH_SIZE - path_len) {
          logger(LOG_ERROR, "HTTP Proxy: Path with query too long");
          return -1;
        }
      } else {
        /* No remaining query params, just terminate at path */
        session->target_path[path_len] = '\0';
      }
    } else {
      /* No query string or no r2h-token configured, copy as-is */
      strncpy(session->target_path, slash, HTTP_PROXY_PATH_SIZE - 1);
      session->target_path[HTTP_PROXY_PATH_SIZE - 1] = '\0';
    }
  } else {
    /* No path, default to / */
    strcpy(session->target_path, "/");
  }

  logger(LOG_DEBUG, "HTTP Proxy: Parsed URL - host=%s, port=%d, path=%s",
         session->target_host, session->target_port, session->target_path);

  return 0;
}

void http_proxy_set_method(http_proxy_session_t *session, const char *method) {
  if (!session || !method)
    return;

  strncpy(session->method, method, sizeof(session->method) - 1);
  session->method[sizeof(session->method) - 1] = '\0';
}

void http_proxy_set_raw_headers(http_proxy_session_t *session,
                                const char *raw_headers,
                                size_t raw_headers_len) {
  if (!session)
    return;

  /* Store pointer reference instead of copying - raw_headers points to
   * http_request_t.raw_headers which remains valid during the proxy session */
  session->raw_headers = raw_headers;
  session->raw_headers_len = raw_headers_len;
}

void http_proxy_set_request_body(http_proxy_session_t *session,
                                 const char *body, size_t body_len) {
  if (!session)
    return;

  session->request_body = body;
  session->request_body_len = body_len;
}

void http_proxy_set_request_headers(http_proxy_session_t *session,
                                    const char *host_header,
                                    const char *x_forwarded_host,
                                    const char *x_forwarded_proto) {
  if (!session)
    return;

  if (host_header) {
    strncpy(session->host_header, host_header, sizeof(session->host_header) - 1);
    session->host_header[sizeof(session->host_header) - 1] = '\0';
  } else {
    session->host_header[0] = '\0';
  }

  if (x_forwarded_host) {
    strncpy(session->x_forwarded_host, x_forwarded_host,
            sizeof(session->x_forwarded_host) - 1);
    session->x_forwarded_host[sizeof(session->x_forwarded_host) - 1] = '\0';
  } else {
    session->x_forwarded_host[0] = '\0';
  }

  if (x_forwarded_proto) {
    strncpy(session->x_forwarded_proto, x_forwarded_proto,
            sizeof(session->x_forwarded_proto) - 1);
    session->x_forwarded_proto[sizeof(session->x_forwarded_proto) - 1] = '\0';
  } else {
    session->x_forwarded_proto[0] = '\0';
  }
}

int http_proxy_connect(http_proxy_session_t *session) {
  struct sockaddr_in server_addr;
  struct hostent *he;
  int connect_result;
  const char *upstream_if;

  if (!session || session->socket >= 0) {
    logger(LOG_ERROR, "HTTP Proxy: Invalid session or already connected");
    return -1;
  }

  /* Resolve hostname */
  he = gethostbyname(session->target_host);
  if (!he) {
    logger(LOG_ERROR, "HTTP Proxy: Cannot resolve hostname %s: %s",
           session->target_host, hstrerror(h_errno));
    return -1;
  }

  /* Validate address list */
  if (!he->h_addr_list[0]) {
    logger(LOG_ERROR, "HTTP Proxy: No addresses for hostname %s",
           session->target_host);
    return -1;
  }

  /* Create TCP socket */
  session->socket = socket(AF_INET, SOCK_STREAM, 0);
  if (session->socket < 0) {
    logger(LOG_ERROR, "HTTP Proxy: Failed to create socket: %s",
           strerror(errno));
    return -1;
  }

  /* Set socket to non-blocking mode */
  if (connection_set_nonblocking(session->socket) < 0) {
    logger(LOG_ERROR, "HTTP Proxy: Failed to set socket non-blocking: %s",
           strerror(errno));
    close(session->socket);
    session->socket = -1;
    return -1;
  }

  /* Bind to upstream interface if configured */
  upstream_if = get_upstream_interface_for_http();
  bind_to_upstream_interface(session->socket, upstream_if);

  /* Connect to server (non-blocking) */
  memset(&server_addr, 0, sizeof(server_addr));
  server_addr.sin_family = AF_INET;
  server_addr.sin_port = htons(session->target_port);
  memcpy(&server_addr.sin_addr.s_addr, he->h_addr_list[0], he->h_length);

  connect_result = connect(session->socket, (struct sockaddr *)&server_addr,
                           sizeof(server_addr));

  /* Handle non-blocking connect result */
  if (connect_result < 0) {
    if (errno == EINPROGRESS || errno == EWOULDBLOCK) {
      /* Connection in progress - normal for non-blocking sockets */
      logger(LOG_DEBUG, "HTTP Proxy: Connection to %s:%d in progress (async)",
             session->target_host, session->target_port);

      /* Register socket with epoll for EPOLLOUT to detect connection
       * completion */
      if (session->epoll_fd >= 0) {
        struct epoll_event ev;
        ev.events = EPOLLOUT | EPOLLIN | EPOLLERR | EPOLLHUP | EPOLLRDHUP;
        ev.data.fd = session->socket;
        if (epoll_ctl(session->epoll_fd, EPOLL_CTL_ADD, session->socket, &ev) <
            0) {
          logger(LOG_ERROR, "HTTP Proxy: Failed to add socket to epoll: %s",
                 strerror(errno));
          close(session->socket);
          session->socket = -1;
          return -1;
        }
        fdmap_set(session->socket, session->conn);
        logger(LOG_DEBUG,
               "HTTP Proxy: Socket registered with epoll for connection");
      }

      session->state = HTTP_PROXY_STATE_CONNECTING;
      status_update_client_state(session->status_index, CLIENT_STATE_HTTP_CONNECTING);
      return 0; /* Success - connection in progress */
    } else {
      /* Real connection error */
      logger(LOG_ERROR, "HTTP Proxy: Failed to connect to %s:%d: %s",
             session->target_host, session->target_port, strerror(errno));
      close(session->socket);
      session->socket = -1;
      return -1;
    }
  }

  /* Immediate connection success (rare, but possible for localhost) */
  logger(LOG_DEBUG, "HTTP Proxy: Connected immediately to %s:%d",
         session->target_host, session->target_port);

  /* Register socket with epoll */
  if (session->epoll_fd >= 0) {
    struct epoll_event ev;
    ev.events = EPOLLIN | EPOLLOUT | EPOLLHUP | EPOLLERR | EPOLLRDHUP;
    ev.data.fd = session->socket;
    if (epoll_ctl(session->epoll_fd, EPOLL_CTL_ADD, session->socket, &ev) < 0) {
      logger(LOG_ERROR, "HTTP Proxy: Failed to add socket to epoll: %s",
             strerror(errno));
      close(session->socket);
      session->socket = -1;
      return -1;
    }
    fdmap_set(session->socket, session->conn);
  }

  session->state = HTTP_PROXY_STATE_CONNECTED;

  /* Build and queue HTTP request */
  if (http_proxy_build_request(session) < 0) {
    logger(LOG_ERROR, "HTTP Proxy: Failed to build request");
    session->state = HTTP_PROXY_STATE_ERROR;
    return -1;
  }

  session->state = HTTP_PROXY_STATE_SENDING_REQUEST;
  status_update_client_state(session->status_index, CLIENT_STATE_HTTP_SENDING_REQUEST);
  return 0;
}

static int http_proxy_build_request(http_proxy_session_t *session) {
  int len;
  char host_header[HTTP_PROXY_HOST_SIZE + 16];
  char *p;
  size_t remaining;

  /* Build Host header with port if non-standard */
  if (session->target_port == 80) {
    snprintf(host_header, sizeof(host_header), "%s", session->target_host);
  } else {
    snprintf(host_header, sizeof(host_header), "%s:%d", session->target_host,
             session->target_port);
  }

  /* Use stored method or default to GET */
  const char *method = session->method[0] ? session->method : "GET";

  /* Build HTTP request - request line and mandatory headers */
  len = snprintf(session->pending_request, sizeof(session->pending_request),
                 "%s %s HTTP/1.1\r\n"
                 "Host: %s\r\n"
                 "Connection: close\r\n",
                 method, session->target_path, host_header);

  if (len < 0 || len >= (int)sizeof(session->pending_request)) {
    logger(LOG_ERROR, "HTTP Proxy: Request too large");
    return -1;
  }

  p = session->pending_request + len;
  remaining = sizeof(session->pending_request) - len;

  /* Add Content-Length header if there's a request body */
  if (session->request_body_len > 0) {
    int cl_len = snprintf(p, remaining, "Content-Length: %zu\r\n",
                          session->request_body_len);
    if (cl_len < 0 || (size_t)cl_len >= remaining) {
      logger(LOG_ERROR, "HTTP Proxy: Request too large (Content-Length)");
      return -1;
    }
    len += cl_len;
    p += cl_len;
    remaining -= cl_len;
  }

  /* Add raw headers from client for full passthrough */
  if (session->raw_headers_len > 0) {
    if (session->raw_headers_len >= remaining) {
      logger(LOG_ERROR, "HTTP Proxy: Request too large (raw headers)");
      return -1;
    }
    memcpy(p, session->raw_headers, session->raw_headers_len);
    len += (int)session->raw_headers_len;
    p += session->raw_headers_len;
    remaining -= session->raw_headers_len;
  }

  /* Add final CRLF to end headers */
  if (remaining < 3) {
    logger(LOG_ERROR, "HTTP Proxy: Request too large (final CRLF)");
    return -1;
  }
  strcpy(p, "\r\n");
  len += 2;

  /* Headers only in pending_request - body will be sent separately */
  session->pending_request_len = len;
  session->pending_request_sent = 0;
  session->request_body_sent = 0;

  logger(LOG_DEBUG,
         "HTTP Proxy: Built request headers (%d bytes, body %zu bytes) for %s%s",
         len, session->request_body_len, host_header, session->target_path);

  return 0;
}

static int http_proxy_try_send_pending(http_proxy_session_t *session) {
  ssize_t sent;
  size_t remaining;
  int total_sent = 0;

  /* Phase 1: Send request headers from pending_request buffer */
  if (session->pending_request_sent < session->pending_request_len) {
    remaining = session->pending_request_len - session->pending_request_sent;
    sent = send(session->socket,
                session->pending_request + session->pending_request_sent,
                remaining, MSG_NOSIGNAL);

    if (sent < 0) {
      if (errno == EAGAIN) {
        return 0; /* Would block, try again later */
      }
      logger(LOG_ERROR, "HTTP Proxy: Send headers failed: %s", strerror(errno));
      return -1;
    }

    session->pending_request_sent += sent;
    total_sent += (int)sent;
    logger(LOG_DEBUG, "HTTP Proxy: Sent headers %zd bytes (%zu/%zu)", sent,
           session->pending_request_sent, session->pending_request_len);

    /* If headers not fully sent, return and wait for next EPOLLOUT */
    if (session->pending_request_sent < session->pending_request_len) {
      return total_sent;
    }
  }

  /* Phase 2: Send request body directly from request_body pointer */
  if (session->request_body_len > 0 &&
      session->request_body_sent < session->request_body_len) {
    remaining = session->request_body_len - session->request_body_sent;
    sent = send(session->socket,
                session->request_body + session->request_body_sent, remaining,
                MSG_NOSIGNAL);

    if (sent < 0) {
      if (errno == EAGAIN) {
        return total_sent > 0 ? total_sent : 0; /* Headers sent, body blocked */
      }
      logger(LOG_ERROR, "HTTP Proxy: Send body failed: %s", strerror(errno));
      return -1;
    }

    session->request_body_sent += sent;
    total_sent += (int)sent;
    logger(LOG_DEBUG, "HTTP Proxy: Sent body %zd bytes (%zu/%zu)", sent,
           session->request_body_sent, session->request_body_len);
  }

  return total_sent;
}

static int http_proxy_try_receive_response(http_proxy_session_t *session) {
  ssize_t received;
  int bytes_forwarded = 0;

  /*
   * Two-phase receive strategy for zero-copy optimization:
   * Phase 1 (AWAITING_HEADERS): Use fixed buffer for header parsing
   * Phase 2 (STREAMING): Recv directly to buffer pool for zero-copy send
   *                      OR buffer for rewriting if needs_body_rewrite
   */

  if (session->state == HTTP_PROXY_STATE_STREAMING) {
    /* Check if we need to buffer for rewriting */
    if (session->needs_body_rewrite) {
      /* Buffer mode: collect body for rewriting */
      uint8_t temp_buf[8192];
      received = recv(session->socket, temp_buf, sizeof(temp_buf), 0);

      if (received < 0) {
        if (errno == EAGAIN) {
          return 0;
        }
        logger(LOG_ERROR, "HTTP Proxy: Recv failed: %s", strerror(errno));
        return -1;
      }

      if (received == 0) {
        /* Connection closed - process buffered body */
        logger(LOG_DEBUG, "HTTP Proxy: Upstream closed, processing rewrite buffer");
        goto process_rewrite_body;
      }

      /* Append to rewrite buffer */
      {
      size_t new_size = session->rewrite_body_buffer_used + (size_t)received;
      if (new_size > REWRITE_MAX_BODY_SIZE) {
        logger(LOG_ERROR, "HTTP Proxy: Rewrite body exceeds max size");
        return -1;
      }

      /* Grow buffer if needed */
      if (new_size > session->rewrite_body_buffer_size) {
        size_t new_alloc = session->rewrite_body_buffer_size == 0
                               ? 16384
                               : session->rewrite_body_buffer_size * 2;
        while (new_alloc < new_size)
          new_alloc *= 2;
        if (new_alloc > REWRITE_MAX_BODY_SIZE)
          new_alloc = REWRITE_MAX_BODY_SIZE;

        char *new_buf = realloc(session->rewrite_body_buffer, new_alloc);
        if (!new_buf) {
          logger(LOG_ERROR, "HTTP Proxy: Failed to grow rewrite buffer");
          return -1;
        }
        session->rewrite_body_buffer = new_buf;
        session->rewrite_body_buffer_size = new_alloc;
      }

      memcpy(session->rewrite_body_buffer + session->rewrite_body_buffer_used,
             temp_buf, (size_t)received);
      session->rewrite_body_buffer_used = new_size;
      session->bytes_received += received;

      /* Check if we've received all content */
      if (session->content_length >= 0 &&
          session->bytes_received >= session->content_length) {
        goto process_rewrite_body;
      }
      }

      return 0; /* Keep buffering */

    process_rewrite_body:
      /* Process the buffered body */
      if (session->rewrite_body_buffer_used > 0) {
        /* Null-terminate for rewriting */
        if (session->rewrite_body_buffer_used >= session->rewrite_body_buffer_size) {
          char *new_buf = realloc(session->rewrite_body_buffer,
                                  session->rewrite_body_buffer_used + 1);
          if (!new_buf) {
            logger(LOG_ERROR, "HTTP Proxy: Failed to grow rewrite buffer for null");
            return -1;
          }
          session->rewrite_body_buffer = new_buf;
          session->rewrite_body_buffer_size = session->rewrite_body_buffer_used + 1;
        }
        session->rewrite_body_buffer[session->rewrite_body_buffer_used] = '\0';

        /* Build base URL and rewrite context */
        char *base_url = build_proxy_base_url(
            session->host_header, session->x_forwarded_host, session->x_forwarded_proto);
        if (!base_url) {
          logger(LOG_ERROR, "HTTP Proxy: Failed to build base URL for rewriting");
          return -1;
        }

        rewrite_context_t ctx = {.upstream_host = session->target_host,
                                 .upstream_port = session->target_port,
                                 .upstream_path = session->target_path,
                                 .base_url = base_url};

        char *rewritten = NULL;
        size_t rewritten_size = 0;

        int rewrite_result = rewrite_m3u_content(&ctx, session->rewrite_body_buffer,
                                                 &rewritten, &rewritten_size);
        free(base_url);

        if (rewrite_result < 0) {
          logger(LOG_ERROR, "HTTP Proxy: M3U rewrite failed");
          return -1;
        }

        /* Build and send response headers with new Content-Length
         * Passthrough original headers except Content-Length and Transfer-Encoding */
        char headers[HTTP_PROXY_RESPONSE_BUFFER_SIZE];
        char *hdr_ptr = headers;
        size_t hdr_remaining = sizeof(headers);
        int headers_len = 0;

        if (session->saved_response_headers && session->saved_response_headers_len > 0) {
          /* Parse and rebuild headers from saved original headers */
          char *saved_copy = strdup(session->saved_response_headers);
          if (saved_copy) {
            char *line = strtok(saved_copy, "\r\n");
            while (line != NULL) {
              /* Skip headers that need to be modified */
              if (strncasecmp(line, "Content-Length:", 15) == 0 ||
                  strncasecmp(line, "Transfer-Encoding:", 18) == 0) {
                /* Skip - will add correct Content-Length later */
              } else {
                /* Pass through this header */
                int written = snprintf(hdr_ptr, hdr_remaining, "%s\r\n", line);
                if (written > 0 && (size_t)written < hdr_remaining) {
                  hdr_ptr += written;
                  hdr_remaining -= written;
                  headers_len += written;
                }
              }
              line = strtok(NULL, "\r\n");
            }
            free(saved_copy);
          }

          /* Add correct Content-Length */
          int cl_written = snprintf(hdr_ptr, hdr_remaining, "Content-Length: %zu\r\n",
                                    rewritten_size);
          if (cl_written > 0 && (size_t)cl_written < hdr_remaining) {
            hdr_ptr += cl_written;
            hdr_remaining -= cl_written;
            headers_len += cl_written;
          }
        } else {
          /* Fallback: build minimal headers */
          headers_len = snprintf(
              headers, sizeof(headers),
              "HTTP/1.1 %d OK\r\n"
              "Content-Type: %s\r\n"
              "Content-Length: %zu\r\n"
              "Connection: close\r\n",
              session->response_status_code, session->response_content_type,
              rewritten_size);
          hdr_ptr = headers + headers_len;
          hdr_remaining = sizeof(headers) - headers_len;
        }

        /* Inject Set-Cookie header if needed */
        if (session->conn && session->conn->should_set_r2h_cookie &&
            config.r2h_token && config.r2h_token[0] != '\0') {
          int cookie_written = snprintf(
              hdr_ptr, hdr_remaining,
              "Set-Cookie: r2h-token=%s; Path=/; HttpOnly; SameSite=Strict\r\n",
              config.r2h_token);
          if (cookie_written > 0 && (size_t)cookie_written < hdr_remaining) {
            hdr_ptr += cookie_written;
            hdr_remaining -= cookie_written;
            headers_len += cookie_written;
          }
          session->conn->should_set_r2h_cookie = 0;
        }

        /* Add final CRLF to end headers */
        int final_written = snprintf(hdr_ptr, hdr_remaining, "\r\n");
        if (final_written > 0) {
          headers_len += final_written;
        }

        if (connection_queue_output(session->conn, (const uint8_t *)headers,
                                    headers_len) < 0) {
          free(rewritten);
          logger(LOG_ERROR, "HTTP Proxy: Failed to send rewritten headers");
          return -1;
        }

        /* Send rewritten body */
        if (connection_queue_output(session->conn, (const uint8_t *)rewritten,
                                    rewritten_size) < 0) {
          free(rewritten);
          logger(LOG_ERROR, "HTTP Proxy: Failed to send rewritten body");
          return -1;
        }

        session->headers_forwarded = 1;
        if (session->conn) {
          session->conn->headers_sent = 1;
        }

        bytes_forwarded = (int)(headers_len + rewritten_size);
        free(rewritten);

        logger(LOG_DEBUG, "HTTP Proxy: Sent rewritten M3U (%zu bytes body)",
               rewritten_size);
      }

      session->state = HTTP_PROXY_STATE_COMPLETE;
      return bytes_forwarded;
    }

    /* Phase 2: Zero-copy streaming - recv directly to buffer pool */
    buffer_ref_t *buf = buffer_pool_alloc();
    if (!buf) {
      logger(LOG_ERROR, "HTTP Proxy: Buffer pool exhausted");
      return -1;
    }

    received = recv(session->socket, buf->data, BUFFER_POOL_BUFFER_SIZE, 0);

    if (received < 0) {
      buffer_ref_put(buf);
      if (errno == EAGAIN) {
        return 0;
      }
      logger(LOG_ERROR, "HTTP Proxy: Recv failed: %s", strerror(errno));
      return -1;
    }

    if (received == 0) {
      buffer_ref_put(buf);
      logger(LOG_DEBUG, "HTTP Proxy: Upstream closed connection");
      session->state = HTTP_PROXY_STATE_COMPLETE;
      return 0;
    }

    /* Queue for zero-copy send */
    buf->data_size = received;
    if (connection_queue_zerocopy(session->conn, buf) < 0) {
      buffer_ref_put(buf);
      logger(LOG_ERROR, "HTTP Proxy: Failed to queue body data");
      return -1;
    }
    buffer_ref_put(buf);
    bytes_forwarded = (int)received;

    /* Let connection_queue_zerocopy's internal batching mechanism handle
     * EPOLLOUT - it uses zerocopy_should_flush() for optimal batching */
    session->bytes_received += bytes_forwarded;

    /* Check if we've received all content */
    if (session->content_length >= 0 &&
        session->bytes_received >= session->content_length) {
      logger(LOG_DEBUG, "HTTP Proxy: Received all content (%zd bytes)",
             session->bytes_received);
      session->state = HTTP_PROXY_STATE_COMPLETE;
    }

    return bytes_forwarded;
  }

  /* Phase 1: Header parsing - use fixed buffer */
  size_t available =
      HTTP_PROXY_RESPONSE_BUFFER_SIZE - session->response_buffer_pos;
  if (available == 0) {
    logger(LOG_ERROR, "HTTP Proxy: Response buffer full");
    return -1;
  }

  received = recv(session->socket,
                  session->response_buffer + session->response_buffer_pos,
                  available, 0);

  if (received < 0) {
    if (errno == EAGAIN) {
      return 0;
    }
    logger(LOG_ERROR, "HTTP Proxy: Recv failed: %s", strerror(errno));
    return -1;
  }

  if (received == 0) {
    logger(LOG_DEBUG, "HTTP Proxy: Upstream closed connection");
    session->state = HTTP_PROXY_STATE_COMPLETE;
    return 0;
  }

  session->response_buffer_pos += received;

  /* Try to parse headers */
  if (!session->headers_received) {
    int result = http_proxy_parse_response_headers(session);
    if (result < 0) {
      return -1;
    }
    if (result == 0) {
      return 0; /* Need more data for headers */
    }
    /* result > 0 means headers complete, state is now STREAMING */
  }

  /* Forward any body data that came with headers (in response_buffer) */
  if (session->headers_received && session->response_buffer_pos > 0) {
    if (session->needs_body_rewrite) {
      /* Buffer mode: save initial body data for rewriting */
      size_t initial_size = session->response_buffer_pos;
      if (initial_size > REWRITE_MAX_BODY_SIZE) {
        logger(LOG_ERROR, "HTTP Proxy: Initial body exceeds max rewrite size");
        return -1;
      }

      session->rewrite_body_buffer = malloc(initial_size + 1);
      if (!session->rewrite_body_buffer) {
        logger(LOG_ERROR, "HTTP Proxy: Failed to allocate rewrite buffer");
        return -1;
      }
      memcpy(session->rewrite_body_buffer, session->response_buffer, initial_size);
      session->rewrite_body_buffer_size = initial_size + 1;
      session->rewrite_body_buffer_used = initial_size;
      session->bytes_received += initial_size;
      session->response_buffer_pos = 0;

      /* Check if we've received all content */
      if (session->content_length >= 0 &&
          session->bytes_received >= session->content_length) {
        /* All body received - trigger rewrite processing on next iteration */
        logger(LOG_DEBUG,
               "HTTP Proxy: All M3U content received with headers (%zd bytes)",
               session->bytes_received);
      }
    } else {
      /* Normal mode: forward immediately */
      if (connection_queue_output(session->conn, session->response_buffer,
                                  session->response_buffer_pos) < 0) {
        logger(LOG_ERROR, "HTTP Proxy: Failed to queue initial body data");
        return -1;
      }

      bytes_forwarded = (int)session->response_buffer_pos;
      session->response_buffer_pos = 0;
      session->bytes_received += bytes_forwarded;

      /* Check if we've received all content */
      if (session->content_length >= 0 &&
          session->bytes_received >= session->content_length) {
        logger(LOG_DEBUG, "HTTP Proxy: Received all content (%zd bytes)",
               session->bytes_received);
        session->state = HTTP_PROXY_STATE_COMPLETE;
      }
    }
  }

  return bytes_forwarded;
}

/* Check if status code is a redirect that may have Location header */
static int http_proxy_is_redirect_status(int status_code) {
  return (status_code == 301 || status_code == 302 || status_code == 303 ||
          status_code == 307 || status_code == 308);
}

static int http_proxy_parse_response_headers(http_proxy_session_t *session) {
  char *header_end;
  char *line;
  char *body_start;
  size_t header_len;
  char headers_copy[HTTP_PROXY_RESPONSE_BUFFER_SIZE];
  char location_header[HTTP_PROXY_PATH_SIZE];
  int has_location = 0;

  location_header[0] = '\0';

  /* Look for end of headers (double CRLF) */
  session->response_buffer[session->response_buffer_pos] = '\0';
  header_end = strstr((char *)session->response_buffer, "\r\n\r\n");
  if (!header_end) {
    return 0; /* Need more data */
  }

  header_len = header_end - (char *)session->response_buffer + 4;
  body_start = header_end + 4;

  /* Copy headers for parsing (strtok modifies the string) */
  memcpy(headers_copy, session->response_buffer, header_len);
  headers_copy[header_len] = '\0';

  /* Parse status line */
  line = strtok(headers_copy, "\r\n");
  if (!line) {
    logger(LOG_ERROR, "HTTP Proxy: Empty response");
    return -1;
  }

  /* Parse "HTTP/1.x STATUS MESSAGE" */
  if (strncmp(line, "HTTP/", 5) != 0) {
    logger(LOG_ERROR, "HTTP Proxy: Invalid HTTP response: %s", line);
    return -1;
  }

  char *status_str = strchr(line, ' ');
  if (!status_str) {
    logger(LOG_ERROR, "HTTP Proxy: Cannot find status code");
    return -1;
  }
  session->response_status_code = atoi(status_str + 1);

  logger(LOG_DEBUG, "HTTP Proxy: Response status: %d",
         session->response_status_code);

  /* Parse headers */
  while ((line = strtok(NULL, "\r\n")) != NULL) {
    if (strncasecmp(line, "Content-Length:", 15) == 0) {
      session->content_length = atoll(line + 15);
      logger(LOG_DEBUG, "HTTP Proxy: Content-Length: %zd",
             session->content_length);
    } else if (strncasecmp(line, "Content-Type:", 13) == 0) {
      char *value = line + 13;
      while (*value == ' ')
        value++;
      strncpy(session->response_content_type, value,
              sizeof(session->response_content_type) - 1);
      session->response_content_type[sizeof(session->response_content_type) -
                                     1] = '\0';
      logger(LOG_DEBUG, "HTTP Proxy: Content-Type: %s",
             session->response_content_type);
    } else if (strncasecmp(line, "Location:", 9) == 0) {
      /* Extract Location header value for potential rewriting */
      char *value = line + 9;
      while (*value == ' ')
        value++;
      strncpy(location_header, value, sizeof(location_header) - 1);
      location_header[sizeof(location_header) - 1] = '\0';
      has_location = 1;
      logger(LOG_DEBUG, "HTTP Proxy: Location: %s", location_header);
    }
    /* Note: Transfer-Encoding is passed through, not parsed */
  }

  session->headers_received = 1;

  /* Check if response body needs rewriting (M3U content).
   * Skip for HEAD requests — there is no body to rewrite. */
  if (rewrite_is_m3u_content_type(session->response_content_type) &&
      strcasecmp(session->method, "HEAD") != 0) {
    /* Only rewrite if Content-Length is known and within limits */
    if (session->content_length > 0 &&
        (size_t)session->content_length <= REWRITE_MAX_BODY_SIZE) {
      session->needs_body_rewrite = 1;
      logger(LOG_DEBUG, "HTTP Proxy: M3U content detected, will rewrite body");
    } else if (session->content_length == -1) {
      /* Chunked or unknown length - try to buffer if reasonable */
      session->needs_body_rewrite = 1;
      logger(LOG_DEBUG,
             "HTTP Proxy: M3U content with unknown length, will buffer");
    } else {
      logger(LOG_WARN,
             "HTTP Proxy: M3U content too large for rewriting (%zd bytes)",
             session->content_length);
    }

    /* Save original response headers for passthrough during rewrite */
    if (session->needs_body_rewrite) {
      session->saved_response_headers = malloc(header_len + 1);
      if (session->saved_response_headers) {
        memcpy(session->saved_response_headers, session->response_buffer, header_len);
        session->saved_response_headers[header_len] = '\0';
        session->saved_response_headers_len = header_len;
        logger(LOG_DEBUG, "HTTP Proxy: Saved %zu bytes of response headers for rewrite",
               header_len);
      }
    }
  }

  /* Forward response headers to client - flush immediately */
  /* Skip header forwarding if body needs rewriting (Content-Length may change) */
  if (!session->headers_forwarded && session->conn && !session->needs_body_rewrite) {
    /*
     * For redirect responses (30x), we need to rewrite the Location header
     * to point back through the proxy. We rebuild headers line by line.
     *
     * For non-redirect responses, we need to inject Set-Cookie header if
     * should_set_r2h_cookie is set.
     */
    int is_redirect = http_proxy_is_redirect_status(session->response_status_code);
    char rewritten_location[HTTP_PROXY_PATH_SIZE];
    int location_rewritten = 0;

    /* Rewrite Location header for redirects */
    if (is_redirect && has_location) {
      if (http_proxy_build_url(location_header, "/", rewritten_location,
                               sizeof(rewritten_location)) == 0) {
        location_rewritten = 1;
        logger(LOG_DEBUG, "HTTP Proxy: Rewritten Location: %s -> %s",
               location_header, rewritten_location);
      }
    }

    if (location_rewritten) {
      /*
       * Need to rebuild headers with modified Location.
       * Parse original headers again and rebuild with new Location value.
       */
      char rebuilt_headers[HTTP_PROXY_RESPONSE_BUFFER_SIZE];
      char *rebuild_ptr = rebuilt_headers;
      size_t rebuild_remaining = sizeof(rebuilt_headers);
      char *orig_line;
      char orig_headers[HTTP_PROXY_RESPONSE_BUFFER_SIZE];
      int first_line = 1;

      /* Copy headers again for parsing */
      memcpy(orig_headers, session->response_buffer, header_len - 2);
      orig_headers[header_len - 2] = '\0';

      /* Rebuild headers line by line */
      orig_line = strtok(orig_headers, "\r\n");
      while (orig_line != NULL) {
        int written;

        if (strncasecmp(orig_line, "Location:", 9) == 0) {
          /* Replace Location header with rewritten value */
          written = snprintf(rebuild_ptr, rebuild_remaining, "Location: %s\r\n",
                             rewritten_location);
        } else {
          /* Copy other headers as-is */
          written = snprintf(rebuild_ptr, rebuild_remaining, "%s\r\n", orig_line);
        }

        if (written < 0 || (size_t)written >= rebuild_remaining) {
          logger(LOG_ERROR, "HTTP Proxy: Rebuilt headers too large");
          return -1;
        }

        rebuild_ptr += written;
        rebuild_remaining -= written;
        first_line = 0;
        orig_line = strtok(NULL, "\r\n");
      }

      (void)first_line; /* Suppress unused warning */

      /* Send rebuilt headers */
      size_t rebuilt_len = rebuild_ptr - rebuilt_headers;
      if (connection_queue_output(session->conn, (const uint8_t *)rebuilt_headers,
                                  rebuilt_len) < 0) {
        logger(LOG_ERROR, "HTTP Proxy: Failed to forward rebuilt headers");
        return -1;
      }

      /* Inject Set-Cookie header if needed */
      if (session->conn->should_set_r2h_cookie && config.r2h_token &&
          config.r2h_token[0] != '\0') {
        char set_cookie_header[512];
        int cookie_len =
            snprintf(set_cookie_header, sizeof(set_cookie_header),
                     "Set-Cookie: r2h-token=%s; Path=/; HttpOnly; "
                     "SameSite=Strict\r\n",
                     config.r2h_token);
        if (cookie_len > 0 && cookie_len < (int)sizeof(set_cookie_header)) {
          if (connection_queue_output(session->conn,
                                      (const uint8_t *)set_cookie_header,
                                      cookie_len) < 0) {
            logger(LOG_ERROR, "HTTP Proxy: Failed to send Set-Cookie header");
            return -1;
          }
          logger(LOG_DEBUG,
                 "HTTP Proxy: Injected Set-Cookie header for r2h-token");
        }
        session->conn->should_set_r2h_cookie = 0;
      }

      /* Send final CRLF to end headers */
      if (connection_queue_output(session->conn, (const uint8_t *)"\r\n", 2) < 0) {
        logger(LOG_ERROR, "HTTP Proxy: Failed to send header terminator");
        return -1;
      }
    } else {
      /* No Location rewriting needed - use original logic */
      size_t headers_without_crlf = header_len - 2; /* Exclude final \r\n */

      /* Send headers up to (but not including) final \r\n\r\n */
      if (connection_queue_output(session->conn, session->response_buffer,
                                  headers_without_crlf) < 0) {
        logger(LOG_ERROR, "HTTP Proxy: Failed to forward headers to client");
        return -1;
      }

      /* Inject Set-Cookie header if needed */
      if (session->conn->should_set_r2h_cookie && config.r2h_token &&
          config.r2h_token[0] != '\0') {
        char set_cookie_header[512];
        int cookie_len =
            snprintf(set_cookie_header, sizeof(set_cookie_header),
                     "Set-Cookie: r2h-token=%s; Path=/; HttpOnly; "
                     "SameSite=Strict\r\n",
                     config.r2h_token);
        if (cookie_len > 0 && cookie_len < (int)sizeof(set_cookie_header)) {
          if (connection_queue_output(session->conn,
                                      (const uint8_t *)set_cookie_header,
                                      cookie_len) < 0) {
            logger(LOG_ERROR, "HTTP Proxy: Failed to send Set-Cookie header");
            return -1;
          }
          logger(LOG_DEBUG,
                 "HTTP Proxy: Injected Set-Cookie header for r2h-token");
        }
        session->conn->should_set_r2h_cookie = 0; /* Only set once */
      }

      /* Send final \r\n to end headers */
      if (connection_queue_output(session->conn, (const uint8_t *)"\r\n", 2) < 0) {
        logger(LOG_ERROR, "HTTP Proxy: Failed to send header terminator");
        return -1;
      }
    }

    session->headers_forwarded = 1;
    session->conn->headers_sent = 1; /* Mark headers as sent */
    logger(LOG_DEBUG, "HTTP Proxy: Forwarded %zu bytes of headers to client",
           header_len);

    /* Flush headers immediately - don't use queue_output_and_flush which sets
     * CONN_CLOSING */
    connection_epoll_update_events(
        session->conn->epfd, session->conn->fd,
        EPOLLIN | EPOLLOUT | EPOLLRDHUP | EPOLLHUP | EPOLLERR);
  }

  /* HEAD responses have no body — go straight to COMPLETE */
  if (strcasecmp(session->method, "HEAD") == 0) {
    session->response_buffer_pos = 0;
    session->state = HTTP_PROXY_STATE_COMPLETE;
  } else {
    /* Move body data to beginning of buffer */
    size_t body_len = session->response_buffer_pos - header_len;
    if (body_len > 0) {
      memmove(session->response_buffer, body_start, body_len);
    }
    session->response_buffer_pos = body_len;

    session->state = HTTP_PROXY_STATE_STREAMING;
  }
  status_update_client_state(session->status_index,
                               CLIENT_STATE_HTTP_STREAMING);

  return 1; /* Headers complete */
}


int http_proxy_handle_socket_event(http_proxy_session_t *session,
                                   uint32_t events) {
  int result;

  if (!session || session->socket < 0) {
    return -1;
  }

  /* Check for hard socket errors first */
  if (events & EPOLLERR) {
    int sock_error = 0;
    socklen_t error_len = sizeof(sock_error);
    if (getsockopt(session->socket, SOL_SOCKET, SO_ERROR, &sock_error,
                   &error_len) == 0 &&
        sock_error != 0) {
      logger(LOG_ERROR, "HTTP Proxy: Socket error: %s", strerror(sock_error));
    } else {
      logger(LOG_ERROR, "HTTP Proxy: Socket error event received");
    }
    session->state = HTTP_PROXY_STATE_ERROR;
    return -1;
  }

  /* Handle connection completion FIRST - before checking HUP events
   * When TCP connect completes, we may get EPOLLOUT | EPOLLHUP together
   * in some edge cases, so we must check connection state first */
  if (session->state == HTTP_PROXY_STATE_CONNECTING) {
    int sock_error = 0;
    socklen_t error_len = sizeof(sock_error);

    if (getsockopt(session->socket, SOL_SOCKET, SO_ERROR, &sock_error,
                   &error_len) < 0) {
      logger(LOG_ERROR, "HTTP Proxy: getsockopt(SO_ERROR) failed: %s",
             strerror(errno));
      session->state = HTTP_PROXY_STATE_ERROR;
      return -1;
    }

    if (sock_error != 0) {
      logger(LOG_ERROR, "HTTP Proxy: Connection to %s:%d failed: %s",
             session->target_host, session->target_port, strerror(sock_error));
      session->state = HTTP_PROXY_STATE_ERROR;
      return -1;
    }

    /* Connection succeeded */
    logger(LOG_INFO, "HTTP Proxy: Connected to %s:%d", session->target_host,
           session->target_port);

    session->state = HTTP_PROXY_STATE_CONNECTED;

    /* Build and queue HTTP request */
    if (http_proxy_build_request(session) < 0) {
      logger(LOG_ERROR, "HTTP Proxy: Failed to build request");
      session->state = HTTP_PROXY_STATE_ERROR;
      return -1;
    }

    session->state = HTTP_PROXY_STATE_SENDING_REQUEST;
    status_update_client_state(session->status_index, CLIENT_STATE_HTTP_SENDING_REQUEST);
  }

  /* Handle writable socket - send pending request */
  if ((events & EPOLLOUT) &&
      session->state == HTTP_PROXY_STATE_SENDING_REQUEST) {
    result = http_proxy_try_send_pending(session);
    if (result < 0) {
      logger(LOG_ERROR, "HTTP Proxy: Failed to send request");
      session->state = HTTP_PROXY_STATE_ERROR;
      return -1;
    }

    /* Check if send completed (headers + body) */
    if (session->pending_request_sent >= session->pending_request_len &&
        session->request_body_sent >= session->request_body_len) {
      logger(LOG_DEBUG, "HTTP Proxy: Request sent (%zu headers + %zu body bytes)",
             session->pending_request_len, session->request_body_len);
      session->state = HTTP_PROXY_STATE_AWAITING_HEADERS;
      status_update_client_state(session->status_index, CLIENT_STATE_HTTP_AWAITING_HEADERS);

      /* Update epoll to only monitor EPOLLIN */
      if (session->epoll_fd >= 0) {
        struct epoll_event ev;
        ev.events = EPOLLIN | EPOLLHUP | EPOLLERR | EPOLLRDHUP;
        ev.data.fd = session->socket;
        if (epoll_ctl(session->epoll_fd, EPOLL_CTL_MOD, session->socket, &ev) <
            0) {
          logger(LOG_ERROR, "HTTP Proxy: Failed to modify epoll events: %s",
                 strerror(errno));
          session->state = HTTP_PROXY_STATE_ERROR;
          return -1;
        }
      }
    }
  }

  /* Handle readable socket - receive response */
  if (events & EPOLLIN) {
    if (session->state == HTTP_PROXY_STATE_AWAITING_HEADERS ||
        session->state == HTTP_PROXY_STATE_STREAMING) {
      result = http_proxy_try_receive_response(session);
      if (result < 0) {
        logger(LOG_ERROR, "HTTP Proxy: Failed to receive response");
        session->state = HTTP_PROXY_STATE_ERROR;
        return -1;
      }
      return result; /* Return bytes forwarded */
    }
  }

  /* Check for connection hangup AFTER processing data
   * This ensures we drain any remaining data before closing */
  if (events & (EPOLLHUP | EPOLLRDHUP)) {
    /* Upstream closed connection */
    if (session->state == HTTP_PROXY_STATE_STREAMING ||
        session->state == HTTP_PROXY_STATE_AWAITING_HEADERS) {
      logger(LOG_DEBUG, "HTTP Proxy: Upstream closed connection (normal)");
      session->state = HTTP_PROXY_STATE_COMPLETE;
      return 0;
    }
    /* If already complete, this is expected - just return success */
    if (session->state == HTTP_PROXY_STATE_COMPLETE) {
      return 0;
    }
    /* For other states (like SENDING_REQUEST), this is unexpected */
    logger(LOG_INFO, "HTTP Proxy: Upstream closed connection unexpectedly in "
                     "state %d",
           session->state);
    session->state = HTTP_PROXY_STATE_ERROR;
    return -1;
  }

  return 0;
}

int http_proxy_session_cleanup(http_proxy_session_t *session) {
  if (!session || !session->initialized) {
    return 0;
  }

  if (session->cleanup_done) {
    return 0;
  }

  logger(LOG_DEBUG, "HTTP Proxy: Cleaning up session (socket=%d)",
         session->socket);

  /* Close socket */
  if (session->socket >= 0) {
    worker_cleanup_socket_from_epoll(session->epoll_fd, session->socket);
    session->socket = -1;
  }

  /* Free rewrite body buffer if allocated */
  if (session->rewrite_body_buffer) {
    free(session->rewrite_body_buffer);
    session->rewrite_body_buffer = NULL;
    session->rewrite_body_buffer_size = 0;
    session->rewrite_body_buffer_used = 0;
  }

  /* Free saved response headers if allocated */
  if (session->saved_response_headers) {
    free(session->saved_response_headers);
    session->saved_response_headers = NULL;
    session->saved_response_headers_len = 0;
  }

  session->cleanup_done = 1;
  session->initialized = 0;
  session->state = HTTP_PROXY_STATE_CLOSING;

  return 0;
}

int http_proxy_build_url(const char *http_url, const char *base_url_placeholder,
                         char *output, size_t output_size) {
  const char *host_start;
  char *encoded_token = NULL;
  int result;
  int has_r2h_token = (config.r2h_token && config.r2h_token[0] != '\0');

  /* Skip http:// prefix */
  if (strncasecmp(http_url, "http://", 7) != 0) {
    logger(LOG_ERROR, "http_proxy_build_url: URL must start with http://");
    return -1;
  }
  host_start = http_url + 7; /* Points to host:port/path */

  /* URL encode r2h-token if configured */
  if (has_r2h_token) {
    encoded_token = http_url_encode(config.r2h_token);
    if (!encoded_token) {
      logger(LOG_ERROR, "Failed to URL encode r2h-token");
      return -1;
    }
  }

  /* Build proxy URL: {BASE_URL}http/host:port/path[?r2h-token=xxx] */
  /* Check if original URL has query parameters */
  const char *query_start = strchr(host_start, '?');

  if (has_r2h_token && encoded_token) {
    if (query_start) {
      /* Original URL has query params, append r2h-token with & */
      result = snprintf(output, output_size, "%shttp/%s&r2h-token=%s",
                        base_url_placeholder, host_start, encoded_token);
    } else {
      /* No query params, add r2h-token with ? */
      result = snprintf(output, output_size, "%shttp/%s?r2h-token=%s",
                        base_url_placeholder, host_start, encoded_token);
    }
  } else {
    /* No r2h-token, just transform the URL */
    result =
        snprintf(output, output_size, "%shttp/%s", base_url_placeholder, host_start);
  }

  if (encoded_token)
    free(encoded_token);

  if (result >= (int)output_size) {
    logger(LOG_ERROR, "HTTP proxy URL too long");
    return -1;
  }

  return 0;
}

