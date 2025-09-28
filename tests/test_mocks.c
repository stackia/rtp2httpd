/*
 * Mock functions and variables for testing
 */

#include <stdio.h>
#include <stdarg.h>
#include <stdlib.h>
#include <string.h>
#include "rtp2httpd.h"

#ifdef MOCK_NETWORK_FUNCTIONS
#include <arpa/inet.h>
#include <netinet/in.h>
#include <netdb.h>
#include <errno.h>
#endif

/* Mock global variables */
struct bindaddr_s *bind_addresses = NULL;
struct services_s *services = NULL;
int client_count = 0;
enum loglevel conf_verbosity = LOG_DEBUG;

/* Mock logger function */
int logger(enum loglevel level, const char *format, ...)
{
    va_list ap;
    int r = 0;

    /* For testing, we can either silence the logger or print to stdout */
    if (conf_verbosity >= level)
    {
        va_start(ap, format);
        r = vprintf(format, ap);
        va_end(ap);
    }

    return r;
}

/* Mock function to create a simple bindaddr for testing */
struct bindaddr_s *new_empty_bindaddr(void)
{
    struct bindaddr_s *ba = malloc(sizeof(struct bindaddr_s));
    if (ba)
    {
        ba->node = NULL;
        ba->service = strdup("8080"); /* Default test port */
        ba->next = NULL;
    }
    return ba;
}

/* Mock function to free bindaddr */
void free_bindaddr(struct bindaddr_s *ba)
{
    struct bindaddr_s *current = ba;
    struct bindaddr_s *next;

    while (current != NULL)
    {
        next = current->next;
        if (current->node)
        {
            free(current->node);
        }
        if (current->service)
        {
            free(current->service);
        }
        free(current);
        current = next;
    }
}

#ifdef MOCK_NETWORK_FUNCTIONS

/* Simplified getaddrinfo mock - only handles basic cases needed for testing */
int getaddrinfo(const char *node, const char *service, const struct addrinfo *hints, struct addrinfo **res)
{
    if (!res)
        return EAI_FAIL;

    /* Simulate failure for .invalid domains */
    if (node && strstr(node, ".invalid"))
    {
        return EAI_NONAME;
    }

    /* Create minimal IPv4 response */
    struct addrinfo *result = calloc(1, sizeof(struct addrinfo));
    struct sockaddr_in *addr = calloc(1, sizeof(struct sockaddr_in));

    if (!result || !addr)
    {
        free(result);
        free(addr);
        return EAI_MEMORY;
    }

    addr->sin_family = AF_INET;
    addr->sin_addr.s_addr = htonl(INADDR_LOOPBACK); /* Default to localhost */
    if (service)
    {
        int port = atoi(service);
        if (port > 0 && port <= 65535)
        {
            addr->sin_port = htons(port);
        }
    }

    result->ai_family = AF_INET;
    result->ai_socktype = hints ? hints->ai_socktype : SOCK_STREAM;
    result->ai_addrlen = sizeof(struct sockaddr_in);
    result->ai_addr = (struct sockaddr *)addr;

    *res = result;
    return 0;
}

void freeaddrinfo(struct addrinfo *res)
{
    while (res)
    {
        struct addrinfo *next = res->ai_next;
        free(res->ai_addr);
        free(res);
        res = next;
    }
}

#endif /* MOCK_NETWORK_FUNCTIONS */
