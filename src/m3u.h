#ifndef __M3U_H__
#define __M3U_H__

#include <stdint.h>
#include <stdio.h>

/* M3U cache structure for external M3U state tracking */
typedef struct {
  int retry_count; /* Current retry count (0-8) */
  int64_t
      next_retry_time; /* Next retry time in milliseconds (0 if not retrying) */

  /* Transformed M3U playlist buffer */
  char *transformed_m3u;       /* Dynamic buffer for transformed playlist */
  size_t transformed_m3u_size; /* Total allocated size */
  size_t transformed_m3u_used; /* Used size (content length) */
  size_t transformed_m3u_inline_end; /* Marks end of inline content */
  int transformed_m3u_has_header; /* 1 if #EXTM3U header was added, 0 otherwise
                                   */

  /* ETag for transformed M3U playlist */
  char transformed_m3u_etag[33];  /* MD5 hash as hex string */
  int transformed_m3u_etag_valid; /* 1 if etag is valid, 0 otherwise */
} m3u_cache_t;

/* Parse M3U content and create services
 * content: M3U content as string
 * source_url: source URL of the M3U (for identification, can be NULL for
 * inline) Returns: 0 on success, -1 on error
 */
int m3u_parse_and_create_services(const char *content, const char *source_url);

/* Check if a line is an M3U header
 * line: line to check
 * Returns: 1 if line is #EXTM3U, 0 otherwise
 */
int m3u_is_header(const char *line);

/* Get the transformed M3U playlist
 * Returns: transformed M3U content (static buffer, valid until next parse)
 */
const char *m3u_get_transformed_playlist(void);

/* Get the ETag for the current transformed M3U playlist
 * Returns: ETag string (static buffer), or NULL if no playlist
 */
const char *m3u_get_etag(void);

/* Reset the transformed M3U playlist buffer
 * Called when configuration is reloaded
 */
void m3u_reset_transformed_playlist(void);

/* Reset only the external M3U playlist buffer
 * Called when external M3U is reloaded (keeps inline content)
 */
void m3u_reset_external_playlist(void);

/* Get server address as complete URL
 * Priority: hostname config > non-upstream interface private IP > non-upstream
 * interface public IP > upstream interface IP > localhost Returns: malloc'd
 * string containing complete URL (protocol://host:port/ or
 * protocol://host:port/path/) Always ends with trailing slash '/' Port is
 * omitted if it's 80 for http or 443 for https Caller must free the returned
 * string
 */
char *get_server_address(void);

/* Async external M3U reloading (non-blocking, for worker processes)
 * epfd: epoll file descriptor for async I/O
 * Returns: 0 if async fetch started, -1 on error or if not configured
 */
int m3u_reload_external_async(int epfd);

/* Get M3U cache for retry state tracking
 * Returns: pointer to m3u_cache_t structure
 */
m3u_cache_t *m3u_get_cache(void);

#endif /* __M3U_H__ */
