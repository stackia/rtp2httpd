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

static const char unimplemented[] =
    "<!DOCTYPE HTML PUBLIC \"-//IETF//DTD HTML 2.0//EN\">\r\n"
    "<html><head>\r\n"
    "<title>501 Method Not Implemented</title>\r\n"
    "</head><body>\r\n"
    "<h1>501 Method Not Implemented</h1>\r\n"
    "<p>Sorry, only GET is supported.</p>\r\n"
    "<hr>\r\n"
    "<address>Server " PACKAGE " version " VERSION "</address>\r\n"
    "</body></html>\r\n";

static const char badrequest[] =
    "<!DOCTYPE HTML PUBLIC \"-//IETF//DTD HTML 2.0//EN\">\r\n"
    "<html><head>\r\n"
    "<title>400 Bad Request</title>\r\n"
    "</head><body>\r\n"
    "<h1>400 Bad Request</h1>\r\n"
    "<p>Your browser sent a request that this server could not understand.<br />\r\n"
    "</p>\r\n"
    "<hr>\r\n"
    "<address>Server " PACKAGE " version " VERSION "</address>\r\n"
    "</body></html>\r\n";

static const char service_not_found[] =
    "<!DOCTYPE HTML PUBLIC \"-//IETF//DTD HTML 2.0//EN\">\r\n"
    "<html><head>\r\n"
    "<title>404 Service not found!</title>\r\n"
    "</head><body>\r\n"
    "<h1>404 Service not found!</h1>\r\n"
    "<p>Sorry, this service was not configured.</p>\r\n"
    "<hr>\r\n"
    "<address>Server " PACKAGE " version " VERSION "</address>\r\n"
    "</body></html>\r\n";

static const char service_unavailable[] =
    "<!DOCTYPE HTML PUBLIC \"-//IETF//DTD HTML 2.0//EN\">\r\n"
    "<html><head>\r\n"
    "<title>503 Service Unavaliable</title>\r\n"
    "</head><body>\r\n"
    "<h1>503 Service Unavaliable</h1>\r\n"
    "<p>Sorry, there are too many connections at this time.\r\n"
    "Try again later.</p>\r\n"
    "<hr>\r\n"
    "<address>Server " PACKAGE " version " VERSION "</address>\r\n"
    "</body></html>\r\n";

/*
 * Linked list of allowed services
 */
struct services_s *services = NULL;

/*
 * Service for connected client.
 * Run in forked thread.
 */
void client_service(int s)
{
  char buf[HTTP_CLIENT_BUFFER_SIZE];
  FILE *client;
  int numfields;
  char *method, *url, httpver;
  char *hostname = NULL;
  char *urlfrom;
  struct services_s *service;

  signal(SIGPIPE, &sigpipe_handler);

  /* Enable TCP_NODELAY to reduce send latency */
  int tcp_nodelay_flag = 1;
  if (setsockopt(s, IPPROTO_TCP, TCP_NODELAY, &tcp_nodelay_flag, sizeof(tcp_nodelay_flag)) < 0)
  {
    logger(LOG_ERROR, "Failed to set TCP_NODELAY");
  }

  client = fdopen(s, "r");
  /*read only one line*/
  if (fgets(buf, sizeof(buf), client) == NULL)
  {
    exit(RETVAL_READ_FAILED);
  }
  numfields = sscanf(buf, "%ms %ms %c", &method, &url, &httpver);
  if (numfields < 2)
  {
    logger(LOG_DEBUG, "Non-HTTP input.");
  }
  logger(LOG_INFO, "request: %s %s", method, url);

  if (numfields == 3)
  { /* Read and discard all headers before replying */
    while (fgets(buf, sizeof(buf), client) != NULL &&
           strcmp("\r\n", buf) != 0)
    {
      if (strncasecmp("Host: ", buf, 6) == 0)
      {
        hostname = strpbrk(buf + 6, ":\r\n");
        if (hostname)
          hostname = strndup(buf + 6, hostname - buf - 6);
        logger(LOG_DEBUG, "Host header: %s", hostname);
      }
    }
  }

  if (strcmp(method, "GET") != 0 && strcmp(method, "HEAD") != 0)
  {
    if (numfields == 3)
      send_http_headers(s, STATUS_501, CONTENT_HTML);
    write_to_client(s, (const uint8_t *)unimplemented, sizeof(unimplemented) - 1);
    exit(RETVAL_UNKNOWN_METHOD);
  }

  urlfrom = index(url, '/');

  if (urlfrom == NULL || (conf_hostname && strcasecmp(conf_hostname, hostname) != 0))
  {
    if (numfields == 3)
      send_http_headers(s, STATUS_400, CONTENT_HTML);
    write_to_client(s, (const uint8_t *)badrequest, sizeof(badrequest) - 1);
    exit(RETVAL_BAD_REQUEST);
  }

  char *service_path = urlfrom + 1; // Skip the leading '/'
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

  // Remove trailing slash if present
  if (path_len > 0 && service_path[path_len - 1] == '/')
  {
    path_len--;
  }

  for (service = services; service; service = service->next)
  {
    if (strncmp(service_path, service->url, path_len) == 0 &&
        strlen(service->url) == path_len)
      break;
  }

  if (service && service->service_type == SERVICE_RTSP)
  {
    // For RTSP services, append query parameters to rtsp_url and reparse
    if (query_start)
    {
      char *rtsp_url_with_params;
      int rtsp_url_len = strlen(service->rtsp_url);
      char *query_params = query_start + 1; // Skip the '?' character
      int query_len = strlen(query_params);
      char connector = '?';

      // Check if rtsp_url already contains query parameters
      if (strchr(service->rtsp_url, '?') != NULL)
      {
        connector = '&';
      }

      // Allocate memory for the combined URL (rtsp_url + connector + query_params)
      rtsp_url_with_params = malloc(rtsp_url_len + 1 + query_len + 1);
      strcpy(rtsp_url_with_params, service->rtsp_url);
      rtsp_url_with_params[rtsp_url_len] = connector;
      strcpy(rtsp_url_with_params + rtsp_url_len + 1, query_params);

      // Convert rtsp://server:port/path?query format to /rtsp/server:port/path?query format
      char *http_format_url = NULL;
      if (strncmp(rtsp_url_with_params, "rtsp://", 7) == 0)
      {
        int new_url_len = strlen(rtsp_url_with_params) - 7 + 6 + 1; // -7 for "rtsp://", +6 for "/rtsp/", +1 for null terminator
        http_format_url = malloc(new_url_len);
        strcpy(http_format_url, "/rtsp/");
        strcat(http_format_url, rtsp_url_with_params + 7);
      }
      else
      {
        // If it doesn't start with rtsp://, assume it's already in the right format
        http_format_url = strdup(rtsp_url_with_params);
      }

      // Parse the new URL to get updated service with playseek params
      struct services_s *new_service = parse_rtsp_url(http_format_url);
      if (new_service)
      {
        service = new_service;
      }

      free(rtsp_url_with_params);
      free(http_format_url);
    }
  }
  else if (service == NULL && conf_udpxy)
  {
    service = parse_udpxy_url(url);
  }

  free(url);
  url = NULL;

  if (service == NULL)
  {
    if (numfields == 3)
      send_http_headers(s, STATUS_404, CONTENT_HTML);
    write_to_client(s, (const uint8_t *)service_not_found, sizeof(service_not_found) - 1);
    exit(RETVAL_CLEAN);
  }

  if (client_count > conf_maxclients)
  { /*Too much clients*/
    if (numfields == 3)
      send_http_headers(s, STATUS_503, CONTENT_HTML);
    write_to_client(s, (const uint8_t *)service_unavailable, sizeof(service_unavailable) - 1);
    free_service(service);
    exit(RETVAL_CLEAN);
  }

  if (strcmp(method, "HEAD") == 0)
  {
    if (numfields == 3)
      send_http_headers(s, STATUS_200, CONTENT_MP2T);
    free_service(service);
    exit(RETVAL_CLEAN);
  }
  free(method);
  method = NULL;

  if (numfields == 3)
    send_http_headers(s, STATUS_200, CONTENT_MP2T);
  start_media_stream(s, service);
  /* SHOULD NEVER REACH HERE */
  exit(RETVAL_CLEAN);
}
