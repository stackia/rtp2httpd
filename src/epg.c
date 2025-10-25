#ifdef HAVE_CONFIG_H
#include "config.h"
#endif

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <unistd.h>
#include <time.h>

#include "epg.h"
#include "rtp2httpd.h"
#include "http_fetch.h"

/* Global EPG cache */
static epg_cache_t epg_cache = {0};

/* Check if URL ends with .gz (case insensitive)
 * Handles URLs with query strings (e.g., http://example.com/epg.xml.gz?query=123)
 * Returns: 1 if URL ends with .gz (before query string), 0 otherwise
 */
int epg_url_is_gzipped(const char *url)
{
    const char *path_end;
    const char *gz_pos;
    size_t path_len;

    if (!url)
    {
        return 0;
    }

    /* Find the end of the path (before query string or fragment) */
    path_end = strchr(url, '?');
    if (!path_end)
    {
        path_end = strchr(url, '#');
    }

    /* Calculate path length */
    if (path_end)
    {
        path_len = path_end - url;
    }
    else
    {
        path_len = strlen(url);
    }

    /* Need at least 3 characters for .gz */
    if (path_len < 3)
    {
        return 0;
    }

    /* Check if path ends with .gz (case insensitive) */
    gz_pos = url + path_len - 3;
    return (strcasecmp(gz_pos, ".gz") == 0);
}

/* Async fetch completion callback (fd-based, zero-copy) */
static void epg_fetch_fd_callback(http_fetch_ctx_t *ctx, int fd, size_t content_size, void *user_data)
{
    (void)ctx;       /* Unused */
    (void)user_data; /* Unused */

    if (fd < 0)
    {
        epg_cache.fetch_error_count++;
        logger(LOG_ERROR, "EPG fetch failed (error count: %d)", epg_cache.fetch_error_count);
        return;
    }

    /* Close old fd if present */
    if (epg_cache.data_fd >= 0)
    {
        close(epg_cache.data_fd);
    }

    /* Store new fd */
    epg_cache.data_fd = fd;
    epg_cache.data_size = content_size;
    epg_cache.is_gzipped = epg_url_is_gzipped(epg_cache.url);
    epg_cache.last_fetch = time(NULL);
    epg_cache.fetch_error_count = 0;

    logger(LOG_INFO, "EPG data cached: %zu bytes, fd=%d (%s)",
           content_size, fd, epg_cache.is_gzipped ? "gzipped" : "uncompressed");
}

int epg_init(void)
{
    memset(&epg_cache, 0, sizeof(epg_cache));
    epg_cache.data_fd = -1;
    logger(LOG_DEBUG, "EPG cache initialized");
    return 0;
}

void epg_cleanup(void)
{
    if (epg_cache.url)
    {
        free(epg_cache.url);
        epg_cache.url = NULL;
    }
    if (epg_cache.data_fd >= 0)
    {
        close(epg_cache.data_fd);
        epg_cache.data_fd = -1;
    }
    epg_cache.data_size = 0;
    epg_cache.is_gzipped = 0;
    epg_cache.last_fetch = 0;
    epg_cache.fetch_error_count = 0;
    logger(LOG_DEBUG, "EPG cache cleaned up");
}

int epg_set_url(const char *url)
{
    char *new_url = NULL;

    /* Handle NULL or empty URL - clear the URL */
    if (!url || strlen(url) == 0)
    {
        logger(LOG_INFO, "EPG URL cleared");
        if (epg_cache.url)
        {
            free(epg_cache.url);
            epg_cache.url = NULL;
        }
        return 0;
    }

    /* Check if URL actually changed */
    if (epg_cache.url && strcmp(epg_cache.url, url) == 0)
    {
        logger(LOG_DEBUG, "EPG URL unchanged: %s", url);
        return 0;
    }

    /* Allocate new URL */
    new_url = strdup(url);
    if (!new_url)
    {
        logger(LOG_ERROR, "Failed to allocate memory for EPG URL");
        return -1;
    }

    /* Free old URL and set new one */
    if (epg_cache.url)
    {
        free(epg_cache.url);
    }
    epg_cache.url = new_url;

    logger(LOG_INFO, "EPG URL set to: %s", url);
    return 0;
}

int epg_fetch_sync(void)
{
    int new_fd;
    size_t new_size;

    /* Check if URL is set */
    if (!epg_cache.url)
    {
        logger(LOG_ERROR, "Cannot fetch EPG: URL not set");
        return -1;
    }

    logger(LOG_INFO, "Fetching EPG from: %s", epg_cache.url);

    /* Fetch data synchronously using http_fetch_fd_sync (zero-copy) */
    new_fd = http_fetch_fd_sync(epg_cache.url, &new_size);
    epg_fetch_fd_callback(NULL, new_fd, new_size, NULL);
    return 0;
}

int epg_fetch_async(int epfd)
{
    http_fetch_ctx_t *fetch_ctx;

    /* Check if URL is set */
    if (!epg_cache.url)
    {
        logger(LOG_DEBUG, "No EPG URL configured, skipping async fetch");
        return -1;
    }

    if (epfd < 0)
    {
        logger(LOG_ERROR, "Invalid epoll fd for async EPG fetch");
        return -1;
    }

    logger(LOG_INFO, "Starting async EPG fetch from: %s", epg_cache.url);

    /* Start async fetch with fd-based callback (zero-copy) */
    fetch_ctx = http_fetch_start_async_fd(epg_cache.url, epg_fetch_fd_callback, NULL, epfd);
    if (!fetch_ctx)
    {
        logger(LOG_ERROR, "Failed to start async fetch for EPG");
        epg_cache.fetch_error_count++;
        return -1;
    }

    return 0;
}

const char *epg_get_url(void)
{
    return epg_cache.url;
}

int epg_get_data_fd(int *fd, size_t *size, int *is_gzipped)
{
    if (epg_cache.data_fd < 0 || epg_cache.data_size == 0)
    {
        return -1;
    }

    if (fd)
    {
        *fd = epg_cache.data_fd;
    }
    if (size)
    {
        *size = epg_cache.data_size;
    }
    if (is_gzipped)
    {
        *is_gzipped = epg_cache.is_gzipped;
    }

    return 0;
}

int epg_get_fd(void)
{
    return epg_cache.data_fd;
}

int epg_has_data(void)
{
    return (epg_cache.data_fd >= 0 && epg_cache.data_size > 0);
}

time_t epg_get_age(void)
{
    if (epg_cache.last_fetch == 0)
    {
        return -1;
    }
    return time(NULL) - epg_cache.last_fetch;
}

void epg_reset(void)
{
    epg_cleanup();
    logger(LOG_INFO, "EPG cache reset");
}
