#ifndef __HTTP_PROXY_REWRITE_H__
#define __HTTP_PROXY_REWRITE_H__

#include <stddef.h>

/**
 * HTTP Proxy Content Rewriting Module
 *
 * This module provides URL rewriting capabilities for proxied content.
 * Currently supports M3U/HLS playlists, designed to be extensible for
 * future content types (HTML, CSS, etc.)
 */

/* Maximum body size for rewriting (prevent memory exhaustion) */
#define REWRITE_MAX_BODY_SIZE (2 * 1024 * 1024) /* 2MB */

/* Rewrite context - contains all information needed for URL rewriting */
typedef struct {
  /* Upstream server info (for resolving relative URLs) */
  const char *upstream_host;
  int upstream_port;
  const char *upstream_path; /* Current request path, for relative URL resolution
                              */

  /* Proxy base URL (for generating absolute proxy URLs) */
  const char *base_url; /* e.g., "http://router:5140/" */
} rewrite_context_t;

/* ========== M3U/HLS Rewriting ========== */

/**
 * Check if Content-Type indicates M3U/M3U8 playlist
 * @param content_type Content-Type header value
 * @return 1 if M3U type, 0 otherwise
 */
int rewrite_is_m3u_content_type(const char *content_type);

/**
 * Rewrite all URLs in M3U content
 * Handles:
 * - http:// URLs -> proxy format
 * - Relative URLs -> absolute proxy format
 * - URI attributes in HLS tags (#EXT-X-KEY, #EXT-X-MAP, etc.)
 *
 * @param ctx Rewrite context
 * @param input Original M3U content (null-terminated)
 * @param output Pointer to receive rewritten content (malloc, caller must free)
 * @param output_size Pointer to receive output size
 * @return 0 on success, -1 on error
 */
int rewrite_m3u_content(const rewrite_context_t *ctx, const char *input,
                        char **output, size_t *output_size);

/* ========== Generic URL Rewriting Helpers ========== */

/**
 * Resolve a relative URL to absolute http:// URL
 * @param relative_url Relative URL (e.g., "segment.ts" or "/path/file.ts")
 * @param base_host Upstream hostname
 * @param base_port Upstream port
 * @param base_path Upstream path (for extracting directory)
 * @param output Output buffer
 * @param output_size Output buffer size
 * @return 0 on success, -1 on error
 */
int rewrite_resolve_relative_url(const char *relative_url, const char *base_host,
                                 int base_port, const char *base_path,
                                 char *output, size_t output_size);

/**
 * Rewrite a single URL to proxy format
 * Supports http://, relative paths, and absolute paths
 *
 * @param ctx Rewrite context
 * @param url Original URL
 * @param output Output buffer
 * @param output_size Output buffer size
 * @return 0 on success, -1 on error (e.g., https:// URLs return -1)
 */
int rewrite_url_to_proxy_format(const rewrite_context_t *ctx, const char *url,
                                char *output, size_t output_size);

/* ========== Future Extensions ========== */
/* int rewrite_is_html_content_type(const char *content_type); */
/* int rewrite_html_content(const rewrite_context_t *ctx, ...); */
/* int rewrite_css_content(const rewrite_context_t *ctx, ...); */

#endif /* __HTTP_PROXY_REWRITE_H__ */
