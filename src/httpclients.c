#ifdef HAVE_CONFIG_H
#include "config.h"
#endif /* HAVE_CONFIG_H */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <signal.h>
#include <netinet/tcp.h>

#include "rtp2httpd.h"
#include "httpclients.h"
#include "http.h"
#include "stream.h"

/* HTTP error response templates */
static const char http_error_501[] =
    "<!DOCTYPE HTML PUBLIC \"-//IETF//DTD HTML 2.0//EN\">\r\n"
    "<html><head>\r\n"
    "<title>501 Method Not Implemented</title>\r\n"
    "</head><body>\r\n"
    "<h1>501 Method Not Implemented</h1>\r\n"
    "<p>Sorry, only GET and HEAD methods are supported.</p>\r\n"
    "<hr>\r\n"
    "<address>Server " PACKAGE " version " VERSION "</address>\r\n"
    "</body></html>\r\n";

static const char http_error_400[] =
    "<!DOCTYPE HTML PUBLIC \"-//IETF//DTD HTML 2.0//EN\">\r\n"
    "<html><head>\r\n"
    "<title>400 Bad Request</title>\r\n"
    "</head><body>\r\n"
    "<h1>400 Bad Request</h1>\r\n"
    "<p>Your browser sent a request that this server could not understand.</p>\r\n"
    "<hr>\r\n"
    "<address>Server " PACKAGE " version " VERSION "</address>\r\n"
    "</body></html>\r\n";

static const char http_error_404[] =
    "<!DOCTYPE HTML PUBLIC \"-//IETF//DTD HTML 2.0//EN\">\r\n"
    "<html><head>\r\n"
    "<title>404 Service Not Found</title>\r\n"
    "</head><body>\r\n"
    "<h1>404 Service Not Found</h1>\r\n"
    "<p>Sorry, the requested service is not configured.</p>\r\n"
    "<hr>\r\n"
    "<address>Server " PACKAGE " version " VERSION "</address>\r\n"
    "</body></html>\r\n";

static const char http_error_503[] =
    "<!DOCTYPE HTML PUBLIC \"-//IETF//DTD HTML 2.0//EN\">\r\n"
    "<html><head>\r\n"
    "<title>503 Service Unavailable</title>\r\n"
    "</head><body>\r\n"
    "<h1>503 Service Unavailable</h1>\r\n"
    "<p>Sorry, there are too many connections at this time. Please try again later.</p>\r\n"
    "<hr>\r\n"
    "<address>Server " PACKAGE " version " VERSION "</address>\r\n"
    "</body></html>\r\n";

/* Global list of configured services */
struct services_s *services = NULL;

/**
 * HTTP request context structure
 * Encapsulates all request-related state for cleaner memory management
 */
typedef struct http_request_context
{
  char *method;
  char *url;
  char *hostname;
  char *user_agent;
  struct services_s *service;
  int is_http_1_1;
} http_request_context_t;

/**
 * Initialize request context with all fields set to NULL/0
 */
static void init_request_context(http_request_context_t *ctx)
{
  ctx->method = NULL;
  ctx->url = NULL;
  ctx->hostname = NULL;
  ctx->user_agent = NULL;
  ctx->service = NULL;
  ctx->is_http_1_1 = 0;
}

/**
 * Clean up all allocated resources in request context
 * Follows DRY principle to avoid code duplication
 */
static void cleanup_request_context(http_request_context_t *ctx)
{
  if (!ctx)
    return;

  if (ctx->service)
    free_service(ctx->service);
  if (ctx->method)
    free(ctx->method);
  if (ctx->url)
    free(ctx->url);
  if (ctx->hostname)
    free(ctx->hostname);
  if (ctx->user_agent)
    free(ctx->user_agent);

  /* Reset all pointers to NULL after freeing */
  init_request_context(ctx);
}

/**
 * Handle HTTP client connection in forked process.
 * Parses HTTP request, validates it, finds matching service, and starts streaming.
 *
 * @param client_socket Connected client socket descriptor
 */
void handle_http_client(int client_socket)
{
  char request_line[HTTP_CLIENT_BUFFER_SIZE];
  FILE *client_stream = NULL;
  int num_fields;
  char http_version_char;
  http_request_context_t ctx;

  /* Initialize request context */
  init_request_context(&ctx);

  /* Setup signal handler for broken pipe */
  signal(SIGPIPE, &sigpipe_handler);

  /* Enable TCP_NODELAY to reduce latency for streaming */
  int tcp_nodelay = 1;
  if (setsockopt(client_socket, IPPROTO_TCP, TCP_NODELAY, &tcp_nodelay, sizeof(tcp_nodelay)) < 0)
  {
    logger(LOG_ERROR, "HTTP: Failed to set TCP_NODELAY on client socket");
  }

  /* Open socket as FILE stream for easier line reading */
  client_stream = fdopen(client_socket, "r");
  if (!client_stream)
  {
    logger(LOG_ERROR, "HTTP: Failed to open client socket as stream");
    exit(RETVAL_READ_FAILED);
  }

  /* Read HTTP request line */
  if (fgets(request_line, sizeof(request_line), client_stream) == NULL)
  {
    logger(LOG_DEBUG, "HTTP: Failed to read request line from client");
    exit(RETVAL_READ_FAILED);
  }

  /* Parse request line: METHOD URL [HTTP/VERSION] */
  num_fields = sscanf(request_line, "%ms %ms %c", &ctx.method, &ctx.url, &http_version_char);
  if (num_fields < 2)
  {
    logger(LOG_DEBUG, "HTTP: Received non-HTTP request");
    exit(RETVAL_BAD_REQUEST);
  }

  logger(LOG_INFO, "HTTP: %s %s", ctx.method, ctx.url);
  ctx.is_http_1_1 = (num_fields == 3);

  /* Parse HTTP headers if HTTP/1.1 request */
  if (ctx.is_http_1_1)
  {
    char header_line[HTTP_CLIENT_BUFFER_SIZE];
    while (fgets(header_line, sizeof(header_line), client_stream) != NULL &&
           strcmp("\r\n", header_line) != 0)
    {
      /* Extract Host header */
      if (strncasecmp("Host: ", header_line, 6) == 0)
      {
        char *host_end = strpbrk(header_line + 6, ":\r\n");
        if (host_end)
        {
          ctx.hostname = strndup(header_line + 6, host_end - header_line - 6);
          logger(LOG_DEBUG, "HTTP: Host header: %s", ctx.hostname);
        }
      }
      /* Extract User-Agent header for timezone detection */
      else if (strncasecmp("User-Agent: ", header_line, 12) == 0)
      {
        char *ua_end = strpbrk(header_line + 12, "\r\n");
        if (ua_end)
        {
          ctx.user_agent = strndup(header_line + 12, ua_end - header_line - 12);
          logger(LOG_DEBUG, "HTTP: User-Agent: %s", ctx.user_agent);
        }
      }
    }
  }

  /* Validate HTTP method */
  if (strcmp(ctx.method, "GET") != 0 && strcmp(ctx.method, "HEAD") != 0)
  {
    logger(LOG_INFO, "HTTP: Unsupported method: %s", ctx.method);
    if (ctx.is_http_1_1)
      send_http_headers(client_socket, STATUS_501, CONTENT_HTML);
    write_to_client(client_socket, (const uint8_t *)http_error_501, sizeof(http_error_501) - 1);
    cleanup_request_context(&ctx);
    exit(RETVAL_UNKNOWN_METHOD);
  }

  /* Validate URL format and hostname */
  char *url_path = index(ctx.url, '/');
  if (url_path == NULL || (conf_hostname && ctx.hostname && strcasecmp(conf_hostname, ctx.hostname) != 0))
  {
    logger(LOG_INFO, "HTTP: Bad request - invalid URL or hostname mismatch");
    if (ctx.is_http_1_1)
      send_http_headers(client_socket, STATUS_400, CONTENT_HTML);
    write_to_client(client_socket, (const uint8_t *)http_error_400, sizeof(http_error_400) - 1);
    cleanup_request_context(&ctx);
    exit(RETVAL_BAD_REQUEST);
  }

  /* Parse service path from URL */
  char *service_path = url_path + 1; /* Skip leading '/' */
  char *query_start = strchr(service_path, '?');
  size_t path_len;

  if (query_start)
  {
    path_len = query_start - service_path;
  }
  else
  {
    path_len = strlen(service_path);
  }

  /* Remove trailing slash if present */
  if (path_len > 0 && service_path[path_len - 1] == '/')
  {
    path_len--;
  }

  /* Find matching service in configured services list */
  for (ctx.service = services; ctx.service; ctx.service = ctx.service->next)
  {
    if (strncmp(service_path, ctx.service->url, path_len) == 0 &&
        strlen(ctx.service->url) == path_len)
    {
      logger(LOG_DEBUG, "HTTP: Matched configured service: %s", ctx.service->url);
      break;
    }
  }

  /* Handle RTSP service with query parameters (e.g., playseek) */
  if (ctx.service && ctx.service->service_type == SERVICE_RTSP && query_start)
  {
    char *rtsp_url_with_params;
    int rtsp_url_len = strlen(ctx.service->rtsp_url);
    char *query_params = query_start + 1; /* Skip '?' */
    int query_len = strlen(query_params);
    char connector = '?';

    /* Check if RTSP URL already has query parameters */
    if (strchr(ctx.service->rtsp_url, '?') != NULL)
    {
      connector = '&';
    }

    /* Build combined RTSP URL with query parameters */
    rtsp_url_with_params = malloc(rtsp_url_len + 1 + query_len + 1);
    if (!rtsp_url_with_params)
    {
      logger(LOG_ERROR, "HTTP: Failed to allocate memory for RTSP URL with parameters");
      exit(RETVAL_CLEAN);
    }
    strcpy(rtsp_url_with_params, ctx.service->rtsp_url);
    rtsp_url_with_params[rtsp_url_len] = connector;
    strcpy(rtsp_url_with_params + rtsp_url_len + 1, query_params);

    /* Convert rtsp://server:port/path?query to /rtsp/server:port/path?query format */
    char *http_format_url = NULL;
    if (strncmp(rtsp_url_with_params, "rtsp://", 7) == 0)
    {
      int new_url_len = strlen(rtsp_url_with_params) - 7 + 6 + 1;
      http_format_url = malloc(new_url_len);
      if (!http_format_url)
      {
        logger(LOG_ERROR, "HTTP: Failed to allocate memory for HTTP format URL");
        free(rtsp_url_with_params);
        exit(RETVAL_CLEAN);
      }
      strcpy(http_format_url, "/rtsp/");
      strcat(http_format_url, rtsp_url_with_params + 7);
    }
    else
    {
      http_format_url = strdup(rtsp_url_with_params);
    }

    /* Reparse URL to extract playseek parameters */
    struct services_s *new_service = http_parse_rtsp_request_url(http_format_url);
    if (new_service)
    {
      logger(LOG_DEBUG, "HTTP: RTSP service reparsed with query parameters");
      ctx.service = new_service;
    }

    free(rtsp_url_with_params);
    free(http_format_url);
  }
  /* Try UDPxy-style URL parsing if no service found and UDPxy mode enabled */
  else if (ctx.service == NULL && conf_udpxy)
  {
    logger(LOG_DEBUG, "HTTP: Attempting UDPxy URL parsing");
    ctx.service = parse_udpxy_url(ctx.url);
  }

  /* Set user_agent for dynamically parsed services */
  if (ctx.service && ctx.user_agent)
  {
    ctx.service->user_agent = strdup(ctx.user_agent);
    if (ctx.service->user_agent)
    {
      logger(LOG_DEBUG, "HTTP: Set User-Agent: %s", ctx.service->user_agent);
    }
  }

  /* Service not found */
  if (ctx.service == NULL)
  {
    logger(LOG_INFO, "HTTP: Service not found for URL: %s", ctx.url);
    if (ctx.is_http_1_1)
      send_http_headers(client_socket, STATUS_404, CONTENT_HTML);
    write_to_client(client_socket, (const uint8_t *)http_error_404, sizeof(http_error_404) - 1);
    cleanup_request_context(&ctx);
    exit(RETVAL_CLEAN);
  }

  /* Check if server is at capacity */
  if (client_count > conf_maxclients)
  {
    logger(LOG_INFO, "HTTP: Service unavailable - too many clients (%d/%d)", client_count, conf_maxclients);
    if (ctx.is_http_1_1)
      send_http_headers(client_socket, STATUS_503, CONTENT_HTML);
    write_to_client(client_socket, (const uint8_t *)http_error_503, sizeof(http_error_503) - 1);
    cleanup_request_context(&ctx);
    exit(RETVAL_CLEAN);
  }

  /* Handle HEAD request - send headers only */
  if (strcmp(ctx.method, "HEAD") == 0)
  {
    logger(LOG_DEBUG, "HTTP: HEAD request - sending headers only");
    if (ctx.is_http_1_1)
      send_http_headers(client_socket, STATUS_200, CONTENT_MP2T);
    cleanup_request_context(&ctx);
    exit(RETVAL_CLEAN);
  }

  /* Send success headers and start streaming */
  logger(LOG_DEBUG, "HTTP: Starting media stream for service: %s", ctx.service->url ? ctx.service->url : "(dynamic)");
  if (ctx.is_http_1_1)
    send_http_headers(client_socket, STATUS_200, CONTENT_MP2T);

  /* Transfer ownership of service to streaming function, clean up other resources */
  struct services_s *service = ctx.service;
  ctx.service = NULL; /* Prevent cleanup_request_context from freeing service */
  cleanup_request_context(&ctx);

  start_media_stream(client_socket, service);

  exit(RETVAL_CLEAN);
}
