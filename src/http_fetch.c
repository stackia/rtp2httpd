#ifdef HAVE_CONFIG_H
#include "config.h"
#endif

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>
#include <fcntl.h>
#include <sys/epoll.h>

#include "http_fetch.h"
#include "rtp2httpd.h"

#define HTTP_FETCH_BUFFER_SIZE 8192         /* Read buffer size for async fetch */
#define MAX_HTTP_CONTENT (20 * 1024 * 1024) /* 10MB max */
#define MAX_URL_LENGTH 2048

/* Async HTTP fetch context */
struct http_fetch_ctx_s
{
    FILE *pipe_fp;                        /* popen file pointer */
    int pipe_fd;                          /* pipe file descriptor for epoll */
    int epfd;                             /* epoll fd */
    char *url;                            /* URL being fetched */
    char *temp_file;                      /* temporary file path */
    char *buffer;                         /* accumulated data buffer */
    size_t buffer_size;                   /* allocated buffer size */
    size_t buffer_used;                   /* bytes written to buffer */
    http_fetch_callback_t callback;       /* completion callback */
    http_fetch_fd_callback_t fd_callback; /* fd-based completion callback */
    void *user_data;                      /* user-provided data */
    int use_fd;                           /* 1 to use fd callback (zero-copy), 0 to use memory callback */
    struct http_fetch_ctx_s *next;        /* linked list pointer */
};

/* Global list of active HTTP fetch contexts */
static http_fetch_ctx_t *active_fetches = NULL;

/* Synchronously fetch content from HTTP(S) URL using curl (blocking, returns fd) */
int http_fetch_fd_sync(const char *url, size_t *out_size)
{
    char curl_cmd[MAX_URL_LENGTH + 256];
    char temp_file[] = "/tmp/rtp2httpd_fetch_sync_XXXXXX";
    int temp_fd;
    long file_size;
    int ret;

    if (!url || !out_size)
    {
        logger(LOG_ERROR, "Invalid parameters for sync HTTP fetch");
        return -1;
    }

    *out_size = 0;

    /* Create temporary file */
    temp_fd = mkstemp(temp_file);
    if (temp_fd == -1)
    {
        logger(LOG_ERROR, "Failed to create temporary file for sync HTTP fetch");
        return -1;
    }
    close(temp_fd);

    /* Build curl command with timeout and follow redirects */
    ret = snprintf(curl_cmd, sizeof(curl_cmd),
                   "curl -L -f -s -S --compressed --max-time 30 --connect-timeout 30 -o '%s' '%s' 2>&1",
                   temp_file, url);

    if (ret >= (int)sizeof(curl_cmd))
    {
        logger(LOG_ERROR, "Curl command too long for URL: %s", url);
        unlink(temp_file);
        return -1;
    }

    logger(LOG_DEBUG, "Fetching URL (sync): %s", url);

    /* Execute curl command */
    ret = system(curl_cmd);
    if (ret != 0)
    {
        logger(LOG_ERROR, "Failed to fetch URL (curl exit code %d): %s", ret, url);
        unlink(temp_file);
        return -1;
    }

    /* Open downloaded file */
    temp_fd = open(temp_file, O_RDONLY);
    if (temp_fd < 0)
    {
        logger(LOG_ERROR, "Failed to open downloaded file");
        unlink(temp_file);
        return -1;
    }

    /* Get file size */
    file_size = lseek(temp_fd, 0, SEEK_END);
    lseek(temp_fd, 0, SEEK_SET);

    if (file_size < 0 || file_size > MAX_HTTP_CONTENT)
    {
        logger(LOG_ERROR, "Invalid or too large downloaded file (size: %ld)", file_size);
        close(temp_fd);
        unlink(temp_file);
        return -1;
    }

    /* Unlink the file (but keep fd open) - file will be deleted when fd is closed */
    unlink(temp_file);

    *out_size = (size_t)file_size;
    logger(LOG_DEBUG, "Successfully fetched URL (sync, fd=%d): %zu bytes", temp_fd, *out_size);
    return temp_fd;
}

/* Synchronously fetch content from HTTP(S) URL using curl (blocking, returns memory buffer) */
char *http_fetch_sync(const char *url, size_t *out_size)
{
    int fd;
    char *content = NULL;
    size_t content_size;
    ssize_t read_size;

    if (!url || !out_size)
    {
        logger(LOG_ERROR, "Invalid parameters for sync HTTP fetch");
        return NULL;
    }

    *out_size = 0;

    /* Fetch using fd-based method */
    fd = http_fetch_fd_sync(url, &content_size);
    if (fd < 0)
    {
        return NULL;
    }

    /* Allocate memory for content */
    content = malloc(content_size + 1);
    if (!content)
    {
        logger(LOG_ERROR, "Failed to allocate memory for downloaded content (%zu bytes)", content_size);
        close(fd);
        return NULL;
    }

    /* Read file content into memory */
    read_size = read(fd, content, content_size);
    if (read_size != (ssize_t)content_size)
    {
        logger(LOG_ERROR, "Failed to read downloaded file completely (read %zd of %zu bytes)",
               read_size, content_size);
        free(content);
        close(fd);
        return NULL;
    }

    content[content_size] = '\0';
    close(fd);

    *out_size = content_size;
    logger(LOG_DEBUG, "Successfully fetched URL (sync, memory): %zu bytes", content_size);
    return content;
}

/* Find HTTP fetch context by file descriptor */
http_fetch_ctx_t *http_fetch_find_by_fd(int fd)
{
    for (http_fetch_ctx_t *ctx = active_fetches; ctx != NULL; ctx = ctx->next)
    {
        if (ctx->pipe_fd == fd)
        {
            return ctx;
        }
    }
    return NULL;
}

/* Remove context from active list */
static void http_fetch_remove_from_list(http_fetch_ctx_t *ctx)
{
    if (!ctx)
        return;

    if (active_fetches == ctx)
    {
        active_fetches = ctx->next;
        return;
    }

    for (http_fetch_ctx_t *c = active_fetches; c != NULL; c = c->next)
    {
        if (c->next == ctx)
        {
            c->next = ctx->next;
            return;
        }
    }
}

/* Cleanup and free fetch context */
static void http_fetch_free(http_fetch_ctx_t *ctx)
{
    if (!ctx)
        return;

    /* Remove from epoll if registered */
    if (ctx->epfd >= 0 && ctx->pipe_fd >= 0)
    {
        epoll_ctl(ctx->epfd, EPOLL_CTL_DEL, ctx->pipe_fd, NULL);
    }

    /* Close pipe */
    if (ctx->pipe_fp)
    {
        pclose(ctx->pipe_fp);
        ctx->pipe_fp = NULL;
        ctx->pipe_fd = -1;
    }

    /* Remove temporary file if exists */
    if (ctx->temp_file)
    {
        unlink(ctx->temp_file);
        free(ctx->temp_file);
    }

    /* Free buffers */
    if (ctx->url)
        free(ctx->url);
    if (ctx->buffer)
        free(ctx->buffer);

    /* Remove from active list */
    http_fetch_remove_from_list(ctx);

    free(ctx);
}

/* Internal helper to start async HTTP fetch */
static http_fetch_ctx_t *http_fetch_start_async_internal(const char *url,
                                                         http_fetch_callback_t callback,
                                                         http_fetch_fd_callback_t fd_callback,
                                                         void *user_data, int epfd)
{
    char curl_cmd[MAX_URL_LENGTH + 256];
    char temp_file_template[] = "/tmp/rtp2httpd_http_fetch_XXXXXX";
    int temp_fd;
    int ret;
    struct epoll_event ev;

    if (!url || (!callback && !fd_callback) || epfd < 0)
    {
        logger(LOG_ERROR, "Invalid parameters for async HTTP fetch");
        return NULL;
    }

    /* Create context */
    http_fetch_ctx_t *ctx = calloc(1, sizeof(*ctx));
    if (!ctx)
    {
        logger(LOG_ERROR, "Failed to allocate HTTP fetch context");
        return NULL;
    }

    ctx->url = strdup(url);
    ctx->callback = callback;
    ctx->fd_callback = fd_callback;
    ctx->user_data = user_data;
    ctx->epfd = epfd;
    ctx->pipe_fd = -1;
    ctx->use_fd = (fd_callback != NULL);

    /* Create temporary file */
    temp_fd = mkstemp(temp_file_template);
    if (temp_fd == -1)
    {
        logger(LOG_ERROR, "Failed to create temporary file for async HTTP fetch");
        http_fetch_free(ctx);
        return NULL;
    }
    close(temp_fd);
    ctx->temp_file = strdup(temp_file_template);

    /* Build curl command - output to temp file, errors to stdout for monitoring */
    ret = snprintf(curl_cmd, sizeof(curl_cmd),
                   "curl -L -f -s -S --max-time 30 --connect-timeout 10 -o '%s' '%s' 2>&1; echo \"EXIT_CODE:$?\"",
                   ctx->temp_file, url);

    if (ret >= (int)sizeof(curl_cmd))
    {
        logger(LOG_ERROR, "Curl command too long for URL: %s", url);
        http_fetch_free(ctx);
        return NULL;
    }

    logger(LOG_DEBUG, "Starting async HTTP fetch: %s", url);

    /* Start curl process with popen */
    ctx->pipe_fp = popen(curl_cmd, "r");
    if (!ctx->pipe_fp)
    {
        logger(LOG_ERROR, "Failed to start curl process: %s", strerror(errno));
        http_fetch_free(ctx);
        return NULL;
    }

    /* Get file descriptor from FILE* */
    ctx->pipe_fd = fileno(ctx->pipe_fp);
    if (ctx->pipe_fd < 0)
    {
        logger(LOG_ERROR, "Failed to get file descriptor from popen");
        http_fetch_free(ctx);
        return NULL;
    }

    /* Set non-blocking mode */
    int flags = fcntl(ctx->pipe_fd, F_GETFL, 0);
    if (flags < 0 || fcntl(ctx->pipe_fd, F_SETFL, flags | O_NONBLOCK) < 0)
    {
        logger(LOG_ERROR, "Failed to set non-blocking mode on pipe: %s", strerror(errno));
        http_fetch_free(ctx);
        return NULL;
    }

    /* Allocate initial buffer for curl output (errors/progress) */
    ctx->buffer_size = HTTP_FETCH_BUFFER_SIZE;
    ctx->buffer = malloc(ctx->buffer_size);
    if (!ctx->buffer)
    {
        logger(LOG_ERROR, "Failed to allocate buffer for async HTTP fetch");
        http_fetch_free(ctx);
        return NULL;
    }
    ctx->buffer_used = 0;

    /* Register pipe fd with epoll */
    memset(&ev, 0, sizeof(ev));
    ev.events = EPOLLIN | EPOLLHUP | EPOLLERR;
    ev.data.fd = ctx->pipe_fd;

    if (epoll_ctl(epfd, EPOLL_CTL_ADD, ctx->pipe_fd, &ev) < 0)
    {
        logger(LOG_ERROR, "Failed to add async HTTP fetch to epoll: %s", strerror(errno));
        http_fetch_free(ctx);
        return NULL;
    }

    /* Add to active list */
    ctx->next = active_fetches;
    active_fetches = ctx;

    logger(LOG_DEBUG, "Async HTTP fetch started, pipe_fd=%d", ctx->pipe_fd);
    return ctx;
}

/* Handle epoll event for async HTTP fetch */
int http_fetch_handle_event(http_fetch_ctx_t *ctx)
{
    char read_buf[HTTP_FETCH_BUFFER_SIZE];
    ssize_t nread;

    if (!ctx)
        return -1;

    /* Read available data from pipe (curl stderr output) */
    while ((nread = read(ctx->pipe_fd, read_buf, sizeof(read_buf))) > 0)
    {
        /* Grow buffer if needed */
        while (ctx->buffer_used + nread + 1 > ctx->buffer_size)
        {
            size_t new_size = ctx->buffer_size * 2;
            if (new_size > MAX_HTTP_CONTENT)
            {
                logger(LOG_ERROR, "Async HTTP fetch output too large");
                http_fetch_cancel(ctx);
                return -1;
            }
            char *new_buf = realloc(ctx->buffer, new_size);
            if (!new_buf)
            {
                logger(LOG_ERROR, "Failed to grow buffer for async HTTP fetch");
                http_fetch_cancel(ctx);
                return -1;
            }
            ctx->buffer = new_buf;
            ctx->buffer_size = new_size;
        }

        /* Append to buffer */
        memcpy(ctx->buffer + ctx->buffer_used, read_buf, nread);
        ctx->buffer_used += nread;
    }

    if (nread < 0 && errno != EAGAIN && errno != EWOULDBLOCK)
    {
        logger(LOG_ERROR, "Error reading from async HTTP fetch pipe: %s", strerror(errno));
        http_fetch_cancel(ctx);
        return -1;
    }

    /* Check if pipe has closed (curl process finished) */
    if (nread == 0)
    {
        FILE *fp;
        char *content = NULL;
        long file_size;
        size_t read_size;
        int exit_code = -1;

        logger(LOG_DEBUG, "Async HTTP fetch pipe closed, checking results");

        /* Null-terminate buffer */
        if (ctx->buffer_used < ctx->buffer_size)
        {
            ctx->buffer[ctx->buffer_used] = '\0';
        }

        /* Parse exit code from output */
        char *exit_marker = strstr(ctx->buffer, "EXIT_CODE:");
        if (exit_marker)
        {
            exit_code = atoi(exit_marker + 10);
        }

        /* Close the pipe */
        (void)pclose(ctx->pipe_fp);
        ctx->pipe_fp = NULL;
        ctx->pipe_fd = -1;

        /* Check curl exit code */
        if (exit_code != 0)
        {
            logger(LOG_ERROR, "Async HTTP fetch failed (curl exit code %d): %s", exit_code, ctx->url);
            logger(LOG_DEBUG, "Curl output: %.*s", (int)ctx->buffer_used, ctx->buffer);

            if (ctx->use_fd)
            {
                ctx->fd_callback(ctx, -1, 0, ctx->user_data);
            }
            else
            {
                ctx->callback(ctx, NULL, 0, ctx->user_data);
            }
            http_fetch_free(ctx);
            return -1;
        }

        /* Handle fd-based callback (zero-copy) */
        if (ctx->use_fd)
        {
            int content_fd;

            /* Open downloaded file */
            content_fd = open(ctx->temp_file, O_RDONLY);
            if (content_fd < 0)
            {
                logger(LOG_ERROR, "Failed to open downloaded file: %s", ctx->temp_file);
                ctx->fd_callback(ctx, -1, 0, ctx->user_data);
                http_fetch_free(ctx);
                return -1;
            }

            /* Get file size */
            file_size = lseek(content_fd, 0, SEEK_END);
            lseek(content_fd, 0, SEEK_SET);

            if (file_size < 0 || file_size > MAX_HTTP_CONTENT)
            {
                logger(LOG_ERROR, "Invalid or too large downloaded file (size: %ld)", file_size);
                close(content_fd);
                ctx->fd_callback(ctx, -1, 0, ctx->user_data);
                http_fetch_free(ctx);
                return -1;
            }

            logger(LOG_DEBUG, "Async HTTP fetch completed successfully (%ld bytes, fd=%d): %s",
                   file_size, content_fd, ctx->url);

            /* Call fd-based callback with file descriptor
             * Note: temp_file will be unlinked by http_fetch_free,
             * but the fd remains valid until the caller closes it */
            ctx->fd_callback(ctx, content_fd, (size_t)file_size, ctx->user_data);

            /* Cleanup context */
            http_fetch_free(ctx);
            return 1;
        }

        /* Handle memory-based callback (traditional) */
        /* Read downloaded file */
        fp = fopen(ctx->temp_file, "r");
        if (!fp)
        {
            logger(LOG_ERROR, "Failed to open downloaded file: %s", ctx->temp_file);
            ctx->callback(ctx, NULL, 0, ctx->user_data);
            http_fetch_free(ctx);
            return -1;
        }

        /* Get file size */
        fseek(fp, 0, SEEK_END);
        file_size = ftell(fp);
        fseek(fp, 0, SEEK_SET);

        if (file_size < 0 || file_size > MAX_HTTP_CONTENT)
        {
            logger(LOG_ERROR, "Invalid or too large downloaded file (size: %ld)", file_size);
            fclose(fp);
            ctx->callback(ctx, NULL, 0, ctx->user_data);
            http_fetch_free(ctx);
            return -1;
        }

        /* Allocate memory for content */
        content = malloc(file_size + 1);
        if (!content)
        {
            logger(LOG_ERROR, "Failed to allocate memory for HTTP content");
            fclose(fp);
            ctx->callback(ctx, NULL, 0, ctx->user_data);
            http_fetch_free(ctx);
            return -1;
        }

        /* Read file content */
        read_size = fread(content, 1, file_size, fp);
        content[read_size] = '\0';
        fclose(fp);

        logger(LOG_DEBUG, "Async HTTP fetch completed successfully (%zu bytes): %s", read_size, ctx->url);

        /* Call completion callback with actual content size */
        ctx->callback(ctx, content, read_size, ctx->user_data);

        /* Cleanup context */
        http_fetch_free(ctx);
        return 1;
    }

    /* More data expected */
    return 0;
}

/* Cancel and cleanup async HTTP fetch */
void http_fetch_cancel(http_fetch_ctx_t *ctx)
{
    if (!ctx)
        return;

    logger(LOG_DEBUG, "Cancelling async HTTP fetch: %s", ctx->url);

    /* Invoke callback with NULL/error to signal cancellation */
    if (ctx->use_fd && ctx->fd_callback)
    {
        ctx->fd_callback(ctx, -1, 0, ctx->user_data);
    }
    else if (ctx->callback)
    {
        ctx->callback(ctx, NULL, 0, ctx->user_data);
    }

    /* Cleanup */
    http_fetch_free(ctx);
}

/* Start async HTTP fetch using popen (memory-based) */
http_fetch_ctx_t *http_fetch_start_async(const char *url, http_fetch_callback_t callback,
                                         void *user_data, int epfd)
{
    return http_fetch_start_async_internal(url, callback, NULL, user_data, epfd);
}

/* Start async HTTP fetch using popen (fd-based, zero-copy) */
http_fetch_ctx_t *http_fetch_start_async_fd(const char *url, http_fetch_fd_callback_t callback,
                                            void *user_data, int epfd)
{
    return http_fetch_start_async_internal(url, NULL, callback, user_data, epfd);
}
