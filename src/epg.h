#ifndef __EPG_H__
#define __EPG_H__

#include <stddef.h>
#include <stdint.h>

/* EPG cache structure */
typedef struct {
  char *url;   /* EPG source URL */
  int data_fd; /* tmpfs file descriptor for EPG data (zero-copy), or -1 if not
                  available */
  size_t data_size; /* Size of EPG data */
  int is_gzipped; /* 1 if data is gzip compressed (based on URL), 0 otherwise */
  int fetch_error_count; /* Number of consecutive fetch errors */
  char
      etag[33]; /* MD5 hash of EPG data as hex string (for HTTP ETag caching) */
  int etag_valid;  /* 1 if etag is valid, 0 otherwise */
  int retry_count; /* Current retry count (0-8) */
  int64_t
      next_retry_time; /* Next retry time in milliseconds (0 if not retrying) */
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

/* Start async EPG fetch
 * epfd: epoll file descriptor for async I/O
 * Returns: 0 on success, -1 on error
 */
int epg_fetch_async(int epfd);

/* Check if URL ends with .gz (case insensitive)
 * Returns: 1 if URL ends with .gz, 0 otherwise
 */
int epg_url_is_gzipped(const char *url);

/* Get EPG cache for direct access
 * Returns: pointer to epg_cache_t structure
 */
epg_cache_t *epg_get_cache(void);

#endif /* __EPG_H__ */
