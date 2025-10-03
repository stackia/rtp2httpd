#ifdef HAVE_CONFIG_H
#include "config.h"
#endif

#include "connection.h"
#include "worker.h"
#include "rtp2httpd.h"
#include "http.h"
#include "service.h"
#include "status.h"
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/tcp.h>
#include <sys/epoll.h>

int connection_set_nonblocking(int fd)
{
  int flags = fcntl(fd, F_GETFL, 0);
  if (flags < 0)
    return -1;
  return fcntl(fd, F_SETFL, flags | O_NONBLOCK);
}

int connection_set_tcp_nodelay(int fd)
{
  int on = 1;
  return setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &on, sizeof(on));
}

void connection_epoll_update_events(int epfd, int fd, uint32_t events)
{
  struct epoll_event ev;
  memset(&ev, 0, sizeof(ev));
  ev.events = events;
  ev.data.fd = fd;
  epoll_ctl(epfd, EPOLL_CTL_MOD, fd, &ev);
}

connection_t *connection_create(int fd, int epfd, pid_t status_id)
{
  connection_t *c = calloc(1, sizeof(*c));
  if (!c)
    return NULL;
  c->fd = fd;
  c->epfd = epfd;
  c->state = CONN_READ_REQ_LINE;
  c->service = NULL;
  c->service_owned = 0;
  c->streaming = 0;
  c->sse_active = 0;
  c->status_id = status_id;
  c->next = NULL;
  /* Initialize HTTP request parser */
  http_request_init(&c->http_req);
  return c;
}

void connection_free(connection_t *c)
{
  if (!c)
    return;

  /* Clean up stream context if still marked as streaming
   * Note: worker_close_and_free_connection should have already called stream_context_cleanup
   * for streaming connections, so this is a safety fallback */
  if (c->streaming)
  {
    logger(LOG_ERROR, "connection_free: streaming flag still set, cleaning up stream");
    stream_context_cleanup(&c->stream);
  }

  /* Free service if owned */
  if (c->service_owned && c->service)
  {
    service_free(c->service);
    c->service = NULL;
  }

  /* Unregister from status */
  status_unregister_client(c->status_id);

  /* Close socket */
  if (c->fd >= 0)
  {
    close(c->fd);
    c->fd = -1;
  }

  free(c);
}

/**
 * Queue data to connection output buffer for reliable delivery
 */
int connection_queue_output(connection_t *c, const uint8_t *data, size_t len)
{
  if (!c || !data || len == 0)
    return 0;

  /* Check if buffer has space */
  if (c->out_len + len > OUTBUF_SIZE)
    return -1; /* Buffer full */

  /* Append to output buffer */
  memcpy(c->outbuf + c->out_len, data, len);
  c->out_len += len;

  /* Enable EPOLLOUT to trigger write */
  connection_epoll_update_events(c->epfd, c->fd, EPOLLIN | EPOLLOUT | EPOLLRDHUP | EPOLLHUP | EPOLLERR);

  return 0;
}

void connection_handle_write(connection_t *c)
{
  if (!c)
    return;
  if (c->out_off < c->out_len)
  {
    /* Non-blocking write logic */
    size_t remaining = c->out_len - c->out_off;
#ifdef MSG_NOSIGNAL
    int flags = MSG_DONTWAIT | MSG_NOSIGNAL;
#else
    int flags = MSG_DONTWAIT;
#endif
    ssize_t w = send(c->fd, c->outbuf + c->out_off, remaining, flags);

    if (w > 0)
    {
      c->out_off += (size_t)w;
      if (c->out_off >= c->out_len)
      {
        c->out_off = c->out_len = 0;
        /* stop EPOLLOUT until more data */
        connection_epoll_update_events(c->epfd, c->fd, EPOLLIN | EPOLLRDHUP | EPOLLHUP | EPOLLERR);
      }
    }
    else if (w < 0)
    {
      if (errno != EAGAIN && errno != EINTR)
      {
        c->state = CONN_CLOSING;
        return;
      }
    }
  }
  /* For SSE: if active and no pending outbuf, just wait for event notifications */
  if (c->sse_active && c->out_len == c->out_off)
  {
    /* nothing to do */
  }
  if (c->state == CONN_CLOSING && c->out_len == c->out_off && !c->streaming && !c->sse_active)
  {
    /* Ready to close */
  }
}

void connection_handle_read(connection_t *c)
{
  if (!c)
    return;

  /* Read into input buffer */
  if (c->in_len < INBUF_SIZE)
  {
    int r = read(c->fd, c->inbuf + c->in_len, INBUF_SIZE - c->in_len);
    if (r > 0)
    {
      c->in_len += r;
    }
    else if (r == 0)
    {
      c->state = CONN_CLOSING;
      return;
    }
    else if (errno == EAGAIN)
    {
      return;
    }
    else
    {
      c->state = CONN_CLOSING;
      return;
    }
  }

  /* Parse HTTP request using http.c parser */
  if (c->state == CONN_READ_REQ_LINE || c->state == CONN_READ_HEADERS)
  {
    int parse_result = http_parse_request(c->inbuf, &c->in_len, &c->http_req);
    if (parse_result == 1)
    {
      /* Request complete, route it */
      c->state = CONN_ROUTE;
      connection_route_and_start(c);
      return;
    }
    else if (parse_result < 0)
    {
      /* Parse error */
      c->state = CONN_CLOSING;
      return;
    }
    /* else parse_result == 0: need more data, continue reading */
  }
}

int connection_route_and_start(connection_t *c)
{
  /* Ensure URL begins with '/' */
  const char *url = c->http_req.url;
  if (url[0] != '/')
  {
    static const char resp[] = "HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n";
    connection_queue_output(c, (const uint8_t *)resp, sizeof(resp) - 1);
    c->state = CONN_CLOSING;
    return 0;
  }

  /* Extract service_path and query */
  const char *service_path = url + 1; /* skip leading '/' */
  const char *query_start = strchr(service_path, '?');
  size_t path_len = query_start ? (size_t)(query_start - service_path) : strlen(service_path);
  if (path_len > 0 && service_path[path_len - 1] == '/')
    path_len--;

  /* Route status endpoints */
  if (path_len == 0 || (strncmp(service_path, "status", 6) == 0 && path_len == 6))
  {
    handle_status_page(c);
    c->state = CONN_CLOSING;
    return 0;
  }
  if (strncmp(service_path, "status/sse", 10) == 0 && path_len == 10)
  {
    /* Delegate SSE initialization to status module */
    return status_handle_sse_init(c);
  }
  if (strncmp(service_path, "api/disconnect", 14) == 0 && path_len == 14)
  {
    handle_disconnect_client(c);
    c->state = CONN_CLOSING;
    return 0;
  }
  if (strncmp(service_path, "api/loglevel", 12) == 0 && path_len == 12)
  {
    handle_set_log_level(c);
    c->state = CONN_CLOSING;
    return 0;
  }

  /* Find configured service */
  service_t *service = NULL;
  for (service = services; service; service = service->next)
  {
    if (strncmp(service_path, service->url, path_len) == 0 && strlen(service->url) == path_len)
      break;
  }

  /* Dynamic parsing for RTSP and UDPxy if needed */
  int owned = 0;
  if (service == NULL)
  {
    if (config.udpxy)
    {
      service = service_create_from_udpxy_url(c->http_req.url);
      if (service)
        owned = 1;
    }
  }
  else if (service->service_type == SERVICE_RTSP)
  {
    /* Found configured RTSP service - try to merge query params if present */
    service_t *merged_service = service_create_from_rtsp_with_query_merge(service, c->http_req.url);
    if (merged_service)
    {
      service = merged_service;
      owned = 1;
    }
    /* If merge returns NULL (no query params), use configured service as-is (owned = 0) */
  }

  if (!service)
  {
    /* Queue 404 response to output buffer for reliable delivery */
    if (c->http_req.is_http_1_1)
    {
      static const char headers[] = "HTTP/1.1 404 Not Found\r\n"
                                    "Content-Type: text/html\r\n"
                                    "Server: rtp2httpd\r\n"
                                    "\r\n";
      connection_queue_output(c, (const uint8_t *)headers, sizeof(headers) - 1);
    }
    static const char body[] = "<!doctype html><title>404</title>Service Not Found";
    connection_queue_output(c, (const uint8_t *)body, sizeof(body) - 1);
    c->state = CONN_CLOSING;
    return 0;
  }

  if (owned && c->http_req.user_agent[0])
  {
    service->user_agent = strdup(c->http_req.user_agent);
  }

  /* Capacity check */
  if (status_shared && status_shared->total_clients >= config.maxclients)
  {
    /* Queue 503 response to output buffer for reliable delivery */
    if (c->http_req.is_http_1_1)
    {
      static const char headers[] = "HTTP/1.1 503 Service Unavailable\r\n"
                                    "Content-Type: text/html\r\n"
                                    "Server: rtp2httpd\r\n"
                                    "\r\n";
      connection_queue_output(c, (const uint8_t *)headers, sizeof(headers) - 1);
    }
    static const char body503[] = "<!doctype html><title>503</title>Service Unavailable";
    connection_queue_output(c, (const uint8_t *)body503, sizeof(body503) - 1);
    if (owned)
      service_free(service);
    c->state = CONN_CLOSING;
    return 0;
  }

  /* Update service URL in status */
  status_update_service_by_pid(c->status_id, c->http_req.url);

  /* Send success headers */
  if (c->http_req.is_http_1_1)
    send_http_headers(c, STATUS_200, CONTENT_MP2T);

  /* Initialize stream in unified epoll */
  if (stream_context_init_for_worker(&c->stream, c, service, c->epfd, c->status_id) == 0)
  {
    c->streaming = 1;
    c->service = service;
    c->service_owned = owned;
    c->state = CONN_STREAMING;
    return 0;
  }
  else
  {
    if (owned)
      service_free(service);
    c->state = CONN_CLOSING;
    return -1;
  }
}
