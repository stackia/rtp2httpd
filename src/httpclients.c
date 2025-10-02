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
#include "status.h"

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
  int service_owned; /* 1 if service was dynamically allocated for this request */
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
  ctx->service_owned = 0;
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

  if (ctx->service && ctx->service_owned)
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
 * Parse HTTP request line (METHOD URL [HTTP/VERSION])
 * Returns 0 on success, -1 on failure
 */
static int parse_http_request_line(FILE *client_stream, http_request_context_t *ctx)
{
  char request_line[HTTP_CLIENT_BUFFER_SIZE];
  char http_version_char;
  int num_fields;

  /* Read HTTP request line */
  if (fgets(request_line, sizeof(request_line), client_stream) == NULL)
  {
    logger(LOG_DEBUG, "HTTP: Failed to read request line from client");
    return -1;
  }

  /* Parse request line: METHOD URL [HTTP/VERSION] */
  num_fields = sscanf(request_line, "%ms %ms %c", &ctx->method, &ctx->url, &http_version_char);
  if (num_fields < 2)
  {
    logger(LOG_DEBUG, "HTTP: Received non-HTTP request");
    return -1;
  }

  logger(LOG_INFO, "HTTP: %s %s", ctx->method, ctx->url);
  ctx->is_http_1_1 = (num_fields == 3);

  return 0;
}

/**
 * Parse HTTP headers (Host, User-Agent, etc.)
 * Only processes headers for HTTP/1.1 requests
 */
static void parse_http_headers(FILE *client_stream, http_request_context_t *ctx)
{
  char header_line[HTTP_CLIENT_BUFFER_SIZE];

  if (!ctx->is_http_1_1)
    return;

  while (fgets(header_line, sizeof(header_line), client_stream) != NULL &&
         strcmp("\r\n", header_line) != 0)
  {
    /* Extract Host header */
    if (strncasecmp("Host: ", header_line, 6) == 0)
    {
      char *host_end = strpbrk(header_line + 6, ":\r\n");
      if (host_end)
      {
        ctx->hostname = strndup(header_line + 6, host_end - header_line - 6);
        logger(LOG_DEBUG, "HTTP: Host header: %s", ctx->hostname);
      }
    }
    /* Extract User-Agent header for timezone detection */
    else if (strncasecmp("User-Agent: ", header_line, 12) == 0)
    {
      char *ua_end = strpbrk(header_line + 12, "\r\n");
      if (ua_end)
      {
        ctx->user_agent = strndup(header_line + 12, ua_end - header_line - 12);
        logger(LOG_DEBUG, "HTTP: User-Agent: %s", ctx->user_agent);
      }
    }
  }
}

/**
 * Extract query parameter value from query string
 * Returns allocated string that must be freed by caller, or NULL if not found
 */
static char *extract_query_param(const char *query_string, const char *param_name)
{
  char *param_start, *param_end;
  char *search_pattern;
  char *result = NULL;

  if (!query_string || !param_name)
    return NULL;

  /* Build search pattern "param_name=" */
  search_pattern = malloc(strlen(param_name) + 2);
  if (!search_pattern)
    return NULL;
  sprintf(search_pattern, "%s=", param_name);

  param_start = strstr(query_string, search_pattern);
  free(search_pattern);

  if (param_start)
  {
    param_start += strlen(param_name) + 1; /* Skip "param_name=" */
    param_end = strchr(param_start, '&');
    if (param_end)
    {
      result = strndup(param_start, param_end - param_start);
    }
    else
    {
      result = strdup(param_start);
    }
  }

  return result;
}

/**
 * Route status page and API endpoints
 * Returns 1 if request was handled, 0 if not a status/API endpoint
 */
static int route_status_endpoints(int client_socket, http_request_context_t *ctx,
                                  const char *service_path, size_t path_len,
                                  const char *query_start)
{
  /* Root path or /status - serve status page */
  if (path_len == 0 || (strncmp(service_path, "status", 6) == 0 && path_len == 6))
  {
    logger(LOG_DEBUG, "HTTP: Serving status page");
    handle_status_page(client_socket, ctx->is_http_1_1);
    return 1;
  }

  /* SSE endpoint for real-time updates */
  if (strncmp(service_path, "status/sse", 10) == 0 && path_len == 10)
  {
    logger(LOG_DEBUG, "HTTP: Starting SSE stream");
    handle_status_sse(client_socket, ctx->is_http_1_1);
    return 1;
  }

  /* API endpoint to disconnect a client */
  if (strncmp(service_path, "api/disconnect", 14) == 0 && path_len == 14)
  {
    char *pid_param = extract_query_param(query_start ? query_start + 1 : NULL, "pid");
    logger(LOG_DEBUG, "HTTP: Disconnect client API called");
    handle_disconnect_client(client_socket, ctx->is_http_1_1, pid_param);
    if (pid_param)
      free(pid_param);
    return 1;
  }

  /* API endpoint to change log level */
  if (strncmp(service_path, "api/loglevel", 12) == 0 && path_len == 12)
  {
    char *level_param = extract_query_param(query_start ? query_start + 1 : NULL, "level");
    logger(LOG_DEBUG, "HTTP: Set log level API called");
    handle_set_log_level(client_socket, ctx->is_http_1_1, level_param);
    if (level_param)
      free(level_param);
    return 1;
  }

  return 0; /* Not a status/API endpoint */
}

/**
 * Find matching service from configured services list or parse dynamically
 * Returns service pointer (may be dynamically allocated) or NULL if not found
 */
static struct services_s *find_matching_service(http_request_context_t *ctx,
                                                const char *service_path, size_t path_len,
                                                const char *query_start)
{
  struct services_s *service = NULL;

  /* Find matching service in configured services list */
  for (service = services; service; service = service->next)
  {
    if (strncmp(service_path, service->url, path_len) == 0 &&
        strlen(service->url) == path_len)
    {
      logger(LOG_DEBUG, "HTTP: Matched configured service: %s", service->url);
      break;
    }
  }

  /* Handle RTSP service with query parameters (e.g., playseek) */
  if (service && service->service_type == SERVICE_RTSP && query_start)
  {
    char *rtsp_url_with_params;
    int rtsp_url_len = strlen(service->rtsp_url);
    const char *query_params = query_start + 1; /* Skip '?' */
    int query_len = strlen(query_params);
    char connector = '?';

    /* Check if RTSP URL already has query parameters */
    if (strchr(service->rtsp_url, '?') != NULL)
    {
      connector = '&';
    }

    /* Build combined RTSP URL with query parameters */
    rtsp_url_with_params = malloc(rtsp_url_len + 1 + query_len + 1);
    if (!rtsp_url_with_params)
    {
      logger(LOG_ERROR, "HTTP: Failed to allocate memory for RTSP URL with parameters");
      return NULL;
    }
    strcpy(rtsp_url_with_params, service->rtsp_url);
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
        return NULL;
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
      service = new_service;
      ctx->service_owned = 1; /* newly allocated service owned by this request */
    }

    free(rtsp_url_with_params);
    free(http_format_url);
  }
  /* Try UDPxy-style URL parsing if no service found and UDPxy mode enabled */
  else if (service == NULL && conf_udpxy)
  {
    logger(LOG_DEBUG, "HTTP: Attempting UDPxy URL parsing");
    service = parse_udpxy_url(ctx->url);
    if (service)
      ctx->service_owned = 1; /* dynamically parsed service owned by this request */
  }

  /* Set user_agent for dynamically parsed services */
  if (service && ctx->user_agent)
  {
    service->user_agent = strdup(ctx->user_agent);
    if (service->user_agent)
    {
      logger(LOG_DEBUG, "HTTP: Set User-Agent: %s", service->user_agent);
    }
  }

  return service;
}

/**
 * Handle HTTP client connection in forked process.
 * Parses HTTP request, validates it, finds matching service, and starts streaming.
 *
 * @param client_socket Connected client socket descriptor
 */
void handle_http_client(int client_socket)
{
  FILE *client_stream = NULL;
  http_request_context_t ctx;
  char *url_path, *service_path, *query_start;
  size_t path_len;

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

  /* Parse HTTP request line */
  if (parse_http_request_line(client_stream, &ctx) < 0)
  {
    exit(RETVAL_BAD_REQUEST);
  }

  /* Parse HTTP headers */
  parse_http_headers(client_stream, &ctx);

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
  url_path = index(ctx.url, '/');
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
  service_path = url_path + 1; /* Skip leading '/' */
  query_start = strchr(service_path, '?');

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

  /* Route status page and API endpoints */
  if (route_status_endpoints(client_socket, &ctx, service_path, path_len, query_start))
  {
    cleanup_request_context(&ctx);
    exit(RETVAL_CLEAN);
  }

  /* Find matching service (configured or dynamically parsed) */
  ctx.service = find_matching_service(&ctx, service_path, path_len, query_start);

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

  /* Record original HTTP URL for status before starting stream */
  status_update_service(ctx.url);

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
