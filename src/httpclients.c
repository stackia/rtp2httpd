#ifdef HAVE_CONFIG_H
#include "config.h"
#endif /* HAVE_CONFIG_H */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <signal.h>

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

  urlfrom = rindex(url, '/');
  if (urlfrom == NULL || (conf_hostname && strcasecmp(conf_hostname, hostname) != 0))
  {
    if (numfields == 3)
      send_http_headers(s, STATUS_400, CONTENT_HTML);
    write_to_client(s, (const uint8_t *)badrequest, sizeof(badrequest) - 1);
    exit(RETVAL_BAD_REQUEST);
  }

  for (service = services; service; service = service->next)
  {
    if (strcmp(urlfrom + 1, service->url) == 0)
      break;
  }

  if (service == NULL && conf_udpxy)
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
      send_http_headers(s, STATUS_200, CONTENT_OSTREAM);
    free_service(service);
    exit(RETVAL_CLEAN);
  }
  free(method);
  method = NULL;

  if (numfields == 3)
    send_http_headers(s, STATUS_200, CONTENT_OSTREAM);
  start_media_stream(s, service);
  /* SHOULD NEVER REACH HERE */
  exit(RETVAL_CLEAN);
}
