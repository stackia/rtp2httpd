#ifndef __HTTP_FETCH_H__
#define __HTTP_FETCH_H__

#include <stddef.h>

/* Async HTTP fetch context (opaque) */
typedef struct http_fetch_ctx_s http_fetch_ctx_t;

/* Callback type for async HTTP fetch completion
 * ctx: fetch context
 * content: fetched content (caller must free), or NULL on error
 * user_data: user-provided data passed to http_fetch_start_async
 */
typedef void (*http_fetch_callback_t)(http_fetch_ctx_t *ctx, char *content, void *user_data);

/**
 * Start async HTTP fetch using popen and curl
 * This function starts a non-blocking HTTP(S) fetch using curl via popen.
 * The pipe is added to the provided epoll instance for async I/O.
 *
 * @param url HTTP(S) URL to fetch
 * @param callback Function to call when fetch completes (required)
 * @param user_data User-provided data passed to callback (can be NULL)
 * @param epfd epoll file descriptor for async I/O (required)
 * @return Fetch context on success, NULL on error
 */
http_fetch_ctx_t *http_fetch_start_async(const char *url, http_fetch_callback_t callback,
                                          void *user_data, int epfd);

/**
 * Find HTTP fetch context by file descriptor
 * This is used by the epoll event loop to identify HTTP fetch events.
 *
 * @param fd File descriptor from epoll event
 * @return Fetch context if fd belongs to an HTTP fetch, NULL otherwise
 */
http_fetch_ctx_t *http_fetch_find_by_fd(int fd);

/**
 * Handle epoll event for async HTTP fetch
 * This should be called when epoll reports an event on an HTTP fetch fd.
 * The function handles reading data, detecting completion, and invoking callbacks.
 *
 * @param ctx Fetch context
 * @return 0 if more data expected, 1 if fetch completed, -1 on error
 *         Note: On completion or error, the context is automatically cleaned up
 */
int http_fetch_handle_event(http_fetch_ctx_t *ctx);

/**
 * Cancel and cleanup async HTTP fetch
 * This terminates the curl process, removes it from epoll, and frees resources.
 * The completion callback is invoked with NULL content to signal cancellation.
 *
 * @param ctx Fetch context to cancel
 */
void http_fetch_cancel(http_fetch_ctx_t *ctx);

#endif /* __HTTP_FETCH_H__ */
