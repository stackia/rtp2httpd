/*
 * Mock functions and variables for testing
 */

#include <stdio.h>
#include <stdarg.h>
#include <stdlib.h>
#include <string.h>
#include "rtp2httpd.h"

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
    if (conf_verbosity >= level) {
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
    if (ba) {
        ba->node = NULL;
        ba->service = strdup("8080");  /* Default test port */
        ba->next = NULL;
    }
    return ba;
}

/* Mock function to free bindaddr */
void free_bindaddr(struct bindaddr_s *ba)
{
    struct bindaddr_s *current = ba;
    struct bindaddr_s *next;

    while (current != NULL) {
        next = current->next;
        if (current->node) {
            free(current->node);
        }
        if (current->service) {
            free(current->service);
        }
        free(current);
        current = next;
    }
}
