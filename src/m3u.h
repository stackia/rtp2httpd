#ifndef __M3U_H__
#define __M3U_H__

#include <stdio.h>

/* Parse M3U content and create services
 * content: M3U content as string
 * source_url: source URL of the M3U (for identification, can be NULL for inline)
 * Returns: 0 on success, -1 on error
 */
int m3u_parse_and_create_services(const char *content, const char *source_url);

/* Fetch M3U content from URL
 * url: URL to fetch from
 * Returns: malloc'd string containing content (caller must free), or NULL on error
 */
char *m3u_fetch_url(const char *url);

/* Check if a line is an M3U header
 * line: line to check
 * Returns: 1 if line is #EXTM3U, 0 otherwise
 */
int m3u_is_header(const char *line);

/* Get the transformed M3U playlist
 * Returns: transformed M3U content (static buffer, valid until next parse)
 */
const char *m3u_get_transformed_playlist(void);

/* Reset the transformed M3U playlist buffer
 * Called when configuration is reloaded
 */
void m3u_reset_transformed_playlist(void);

/* Reset only the external M3U playlist buffer
 * Called when external M3U is reloaded (keeps inline content)
 */
void m3u_reset_external_playlist(void);

#endif /* __M3U_H__ */
