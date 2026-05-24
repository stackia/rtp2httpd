#ifndef __EPG_H__
#define __EPG_H__

#include <stddef.h>
#include <stdint.h>

/* Maximum number of EPG sources accepted from one M3U header */
#define EPG_MAX_SOURCES 32

/* Per-source EPG cache entry */
typedef struct {
  char *url;               /* EPG source URL */
  int data_fd;             /* tmpfs file descriptor for EPG data (zero-copy), or -1 if not
                              available */
  size_t data_size;        /* Size of EPG data */
  int is_gzipped;          /* 1 if data is gzip compressed (based on URL), 0 otherwise */
  int fetch_error_count;   /* Number of consecutive fetch errors */
  char etag[33];           /* MD5 hash of EPG data as hex string (for HTTP ETag caching) */
  int etag_valid;          /* 1 if etag is valid, 0 otherwise */
  int retry_count;         /* Current retry count (0-8) */
  int64_t next_retry_time; /* Next retry time in milliseconds (0 if not retrying) */
} epg_source_t;

/* EPG cache structure */
typedef struct {
  epg_source_t *sources; /* Ordered EPG sources */
  size_t source_count;   /* Number of configured EPG sources */
} epg_cache_t;

/* Cleanup EPG cache
 */
void epg_cleanup(void);

/* Set EPG source URL (without fetching)
 * url: EPG source URL (will be copied), or NULL to clear
 * Returns: 0 on success, -1 on error
 */
int epg_set_url(const char *url);

/* Set ordered EPG source URLs (without fetching)
 * urls: array of EPG source URLs
 * url_count: number of URLs in array
 * Returns: 0 on success, -1 on error
 */
int epg_set_urls(const char **urls, size_t url_count);

/* Start async EPG fetch
 * epfd: epoll file descriptor for async I/O
 * Returns: 0 on success, -1 on error
 */
int epg_fetch_async(int epfd);

/* Start async EPG fetch for one source by zero-based index
 * epfd: epoll file descriptor for async I/O
 * index: zero-based EPG source index
 * Returns: 0 on success, -1 on error
 */
int epg_fetch_source_async(int epfd, size_t index);

/* Reset retry state for all EPG sources */
void epg_reset_retry_state_all(void);

/* Find the first EPG source whose retry time is due
 * now: current monotonic time in milliseconds
 * Returns: zero-based source index, or -1 if no retry is due
 */
int epg_get_retry_source_index(int64_t now);

/* Clear retry time for one source by zero-based index */
void epg_clear_retry_time(size_t index);

/* Get EPG cache for direct access
 * Returns: pointer to epg_cache_t structure
 */
epg_cache_t *epg_get_cache(void);

/* Get one EPG source by zero-based index
 * Returns: pointer to source, or NULL if index is invalid
 */
epg_source_t *epg_get_source(size_t index);

#endif /* __EPG_H__ */
