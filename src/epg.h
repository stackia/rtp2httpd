#ifndef __EPG_H__
#define __EPG_H__

#include <stddef.h>
#include <time.h>

/* EPG cache structure */
typedef struct
{
    char *url;              /* EPG source URL */
    int data_fd;            /* tmpfs file descriptor for EPG data (zero-copy), or -1 if not available */
    size_t data_size;       /* Size of EPG data */
    int is_gzipped;         /* 1 if data is gzip compressed (based on URL), 0 otherwise */
    time_t last_fetch;      /* Timestamp of last successful fetch */
    int fetch_error_count;  /* Number of consecutive fetch errors */
} epg_cache_t;

/* Initialize EPG cache
 * Returns: 0 on success, -1 on error
 */
int epg_init(void);

/* Cleanup EPG cache
 */
void epg_cleanup(void);

/* Set EPG source URL (without fetching)
 * url: EPG source URL (will be copied), or NULL to clear
 * Returns: 0 on success, -1 on error
 */
int epg_set_url(const char *url);

/* Fetch EPG data synchronously (blocking)
 * Uses the URL previously set by epg_set_url()
 * Returns: 0 on success, -1 on error
 */
int epg_fetch_sync(void);

/* Start async EPG fetch
 * epfd: epoll file descriptor for async I/O
 * Returns: 0 on success, -1 on error
 */
int epg_fetch_async(int epfd);

/* Get EPG source URL
 * Returns: EPG source URL or NULL if not set
 */
const char *epg_get_url(void);

/* Get cached EPG data file descriptor (zero-copy)
 * fd: pointer to receive file descriptor (read-only, do not close)
 * size: pointer to receive data size
 * is_gzipped: pointer to receive compression status (can be NULL)
 * Returns: 0 on success, -1 if no data available
 *
 * Note: The returned fd is owned by the EPG cache and should NOT be closed by the caller.
 * The fd remains valid until the next EPG fetch or epg_cleanup() is called.
 */
int epg_get_data_fd(int *fd, size_t *size, int *is_gzipped);

/* Check if EPG data is available
 * Returns: 1 if data is available, 0 otherwise
 */
int epg_has_data(void);

/* Get EPG data file descriptor (zero-copy)
 * Returns: file descriptor on success, -1 if no data available
 *
 * Note: The returned fd is owned by the EPG cache and should NOT be closed by the caller.
 */
int epg_get_fd(void);

/* Get time since last successful fetch
 * Returns: seconds since last fetch, or -1 if never fetched
 */
time_t epg_get_age(void);

/* Reset EPG cache (clears data and URL)
 */
void epg_reset(void);

/* Check if URL ends with .gz (case insensitive)
 * Returns: 1 if URL ends with .gz, 0 otherwise
 */
int epg_url_is_gzipped(const char *url);

#endif /* __EPG_H__ */
