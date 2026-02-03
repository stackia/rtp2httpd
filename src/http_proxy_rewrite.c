/**
 * HTTP Proxy Content Rewriting Module
 *
 * Provides URL rewriting capabilities for proxied content.
 * Currently supports M3U/HLS playlists with extensible architecture
 * for future content types (HTML, CSS, etc.)
 */

#include "http_proxy_rewrite.h"
#include "configuration.h"
#include "http.h" /* For http_url_encode */
#include "http_proxy.h"
#include "utils.h"
#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>

/* ========== M3U Content-Type Detection ========== */

int rewrite_is_m3u_content_type(const char *content_type) {
  if (!content_type)
    return 0;

  /* Skip leading whitespace */
  while (*content_type && isspace((unsigned char)*content_type))
    content_type++;

  /* Check for known M3U MIME types */
  if (strncasecmp(content_type, "application/vnd.apple.mpegurl", 29) == 0)
    return 1;
  if (strncasecmp(content_type, "application/x-mpegurl", 21) == 0)
    return 1;
  if (strncasecmp(content_type, "audio/x-mpegurl", 15) == 0)
    return 1;
  if (strncasecmp(content_type, "audio/mpegurl", 13) == 0)
    return 1;

  return 0;
}

/* ========== URL Resolution Helpers ========== */

int rewrite_resolve_relative_url(const char *relative_url, const char *base_host,
                                 int base_port, const char *base_path,
                                 char *output, size_t output_size) {
  if (!relative_url || !base_host || !output || output_size == 0)
    return -1;

  int result;

  if (relative_url[0] == '/') {
    /* Absolute path - use host:port directly */
    if (base_port == 80) {
      result =
          snprintf(output, output_size, "http://%s%s", base_host, relative_url);
    } else {
      result = snprintf(output, output_size, "http://%s:%d%s", base_host,
                        base_port, relative_url);
    }
  } else {
    /* Relative path - need to extract directory from base_path */
    char dir_path[HTTP_PROXY_PATH_SIZE];
    dir_path[0] = '\0';

    if (base_path && base_path[0]) {
      /* Find last slash to get directory */
      const char *last_slash = strrchr(base_path, '/');
      if (last_slash) {
        size_t dir_len = (size_t)(last_slash - base_path + 1);
        if (dir_len >= sizeof(dir_path))
          dir_len = sizeof(dir_path) - 1;
        memcpy(dir_path, base_path, dir_len);
        dir_path[dir_len] = '\0';
      } else {
        /* No slash in path, use root */
        strcpy(dir_path, "/");
      }
    } else {
      strcpy(dir_path, "/");
    }

    if (base_port == 80) {
      result = snprintf(output, output_size, "http://%s%s%s", base_host,
                        dir_path, relative_url);
    } else {
      result = snprintf(output, output_size, "http://%s:%d%s%s", base_host,
                        base_port, dir_path, relative_url);
    }
  }

  if (result < 0 || (size_t)result >= output_size) {
    logger(LOG_ERROR, "rewrite_resolve_relative_url: buffer too small");
    return -1;
  }

  return 0;
}

int rewrite_url_to_proxy_format(const rewrite_context_t *ctx, const char *url,
                                char *output, size_t output_size) {
  if (!ctx || !url || !output || output_size == 0)
    return -1;

  /* Skip empty URLs */
  if (url[0] == '\0') {
    output[0] = '\0';
    return 0;
  }

  /* Skip https:// URLs - proxy doesn't support them */
  if (strncasecmp(url, "https://", 8) == 0) {
    return -1;
  }

  char absolute_url[HTTP_PROXY_PATH_SIZE * 2];

  if (strncasecmp(url, "http://", 7) == 0) {
    /* Already absolute http:// URL */
    if (strlen(url) >= sizeof(absolute_url))
      return -1;
    strcpy(absolute_url, url);
  } else {
    /* Relative URL - resolve to absolute */
    if (rewrite_resolve_relative_url(url, ctx->upstream_host, ctx->upstream_port,
                                     ctx->upstream_path, absolute_url,
                                     sizeof(absolute_url)) < 0) {
      return -1;
    }
  }

  /* Use existing http_proxy_build_url to convert to proxy format */
  return http_proxy_build_url(absolute_url, ctx->base_url, output, output_size);
}

/* ========== M3U Line Rewriting (Internal) ========== */

/**
 * Check if a line is a comment line (starts with #)
 */
static int is_comment_line(const char *line) {
  while (*line && isspace((unsigned char)*line))
    line++;
  return *line == '#';
}

/**
 * Check if URL should be rewritten
 * Returns 1 for http:// URLs and relative URLs, 0 for https:// or empty
 */
static int should_rewrite_url(const char *url) {
  if (!url || url[0] == '\0')
    return 0;

  /* Skip https:// - not supported */
  if (strncasecmp(url, "https://", 8) == 0)
    return 0;

  /* Rewrite http:// and relative URLs */
  return 1;
}

/**
 * Find and extract URI attribute value from a comment line
 * Returns pointer to start of URI value and sets end pointer
 * Handles both URI="value" and URI=value formats
 * Only matches URI= that appears to be an HLS attribute (preceded by comma, colon, or start)
 */
static const char *find_uri_attribute(const char *line, const char **value_end,
                                      int *has_quotes, const char **attr_start) {
  const char *uri_pos = line;

  while ((uri_pos = strcasestr(uri_pos, "URI=")) != NULL) {
    /* Check that this is an attribute, not part of a URL */
    /* URI= should be preceded by comma, colon, space, or be at start */
    if (uri_pos > line) {
      char prev = *(uri_pos - 1);
      if (prev != ',' && prev != ':' && prev != ' ' && prev != '\t') {
        uri_pos++;
        continue;
      }
    }

    const char *value_start = uri_pos + 4; /* Skip "URI=" */
    *attr_start = uri_pos;

    if (*value_start == '"') {
      /* Quoted value */
      *has_quotes = 1;
      value_start++;
      const char *end = strchr(value_start, '"');
      if (end) {
        *value_end = end;
        return value_start;
      }
    } else {
      /* Unquoted value - ends at comma, space, or end of line */
      *has_quotes = 0;
      const char *end = value_start;
      while (*end && *end != ',' && *end != ' ' && *end != '\t' &&
             *end != '\r' && *end != '\n') {
        end++;
      }
      if (end > value_start) {
        *value_end = end;
        return value_start;
      }
    }
    uri_pos++;
  }

  return NULL;
}

/**
 * Rewrite all URI attributes in a comment line (non-recursive)
 * @return New malloc'd string with rewritten URIs, or NULL if no rewrite needed
 */
static char *rewrite_uri_attributes(const rewrite_context_t *ctx,
                                    const char *line) {
  char *result = NULL;
  char *current = strdup(line);
  if (!current)
    return NULL;

  int modified = 0;
  size_t search_offset = 0;

  while (1) {
    const char *value_end;
    const char *attr_start;
    int has_quotes;
    const char *uri_value =
        find_uri_attribute(current + search_offset, &value_end, &has_quotes, &attr_start);

    if (!uri_value)
      break;

    /* Adjust pointers to be relative to current (not current + search_offset) */
    size_t value_offset = (size_t)(uri_value - current);
    (void)attr_start; /* Used only for validation in find_uri_attribute */
    size_t value_end_offset = (size_t)(value_end - current);

    /* Extract URI value */
    size_t uri_len = value_end_offset - value_offset;
    char *original_uri = malloc(uri_len + 1);
    if (!original_uri) {
      free(current);
      return result; /* Return what we have so far */
    }
    memcpy(original_uri, current + value_offset, uri_len);
    original_uri[uri_len] = '\0';

    /* Check if this URI should be rewritten */
    if (!should_rewrite_url(original_uri)) {
      free(original_uri);
      /* Move search past this URI to avoid infinite loop */
      search_offset = value_end_offset + (has_quotes ? 1 : 0);
      continue;
    }

    /* Rewrite the URI */
    char rewritten_uri[HTTP_PROXY_PATH_SIZE * 2];
    if (rewrite_url_to_proxy_format(ctx, original_uri, rewritten_uri,
                                    sizeof(rewritten_uri)) < 0) {
      free(original_uri);
      search_offset = value_end_offset + (has_quotes ? 1 : 0);
      continue;
    }

    free(original_uri);

    /* Build new line with rewritten URI */
    size_t prefix_len = value_offset;
    if (has_quotes)
      prefix_len--; /* Include opening quote position */
    size_t suffix_start = value_end_offset;
    if (has_quotes)
      suffix_start++; /* Skip closing quote */
    size_t suffix_len = strlen(current + suffix_start);
    size_t rewritten_len = strlen(rewritten_uri);

    size_t new_line_len =
        prefix_len + (has_quotes ? 1 : 0) + rewritten_len + (has_quotes ? 1 : 0) + suffix_len + 1;
    char *new_line = malloc(new_line_len);
    if (!new_line) {
      free(current);
      return result;
    }

    char *ptr = new_line;
    memcpy(ptr, current, prefix_len);
    ptr += prefix_len;
    if (has_quotes)
      *ptr++ = '"';
    memcpy(ptr, rewritten_uri, rewritten_len);
    ptr += rewritten_len;
    if (has_quotes)
      *ptr++ = '"';
    strcpy(ptr, current + suffix_start);

    /* Update search offset to point past the rewritten URI */
    search_offset = prefix_len + (has_quotes ? 1 : 0) + rewritten_len + (has_quotes ? 1 : 0);

    free(current);
    current = new_line;
    modified = 1;
  }

  if (modified) {
    return current;
  } else {
    free(current);
    return NULL;
  }
}

/**
 * Rewrite a single M3U line
 * @return New malloc'd string with rewritten content, or NULL if no changes
 */
static char *rewrite_m3u_line(const rewrite_context_t *ctx, const char *line,
                              size_t line_len) {
  /* Skip empty lines */
  if (line_len == 0)
    return NULL;

  /* Make null-terminated copy for processing */
  char *line_copy = malloc(line_len + 1);
  if (!line_copy)
    return NULL;
  memcpy(line_copy, line, line_len);
  line_copy[line_len] = '\0';

  /* Remove trailing \r\n for processing */
  size_t process_len = line_len;
  while (process_len > 0 &&
         (line_copy[process_len - 1] == '\r' || line_copy[process_len - 1] == '\n')) {
    line_copy[--process_len] = '\0';
  }

  char *result = NULL;

  if (is_comment_line(line_copy)) {
    /* Comment line - check for URI attributes */
    result = rewrite_uri_attributes(ctx, line_copy);
  } else if (process_len > 0) {
    /* Regular URL line */
    const char *url = line_copy;
    /* Skip leading whitespace */
    while (*url && isspace((unsigned char)*url))
      url++;

    if (should_rewrite_url(url)) {
      char rewritten[HTTP_PROXY_PATH_SIZE * 2];
      if (rewrite_url_to_proxy_format(ctx, url, rewritten, sizeof(rewritten)) == 0) {
        result = strdup(rewritten);
      }
    }
  }

  free(line_copy);
  return result;
}

/* ========== Main M3U Rewriting Function ========== */

int rewrite_m3u_content(const rewrite_context_t *ctx, const char *input,
                        char **output, size_t *output_size) {
  if (!ctx || !input || !output || !output_size)
    return -1;

  size_t input_len = strlen(input);

  /* Limit body size to prevent memory exhaustion */
  if (input_len > REWRITE_MAX_BODY_SIZE) {
    logger(LOG_ERROR, "M3U content too large for rewriting: %zu bytes", input_len);
    return -1;
  }

  /* Estimate output size - rewritten URLs are typically longer */
  /* Assume worst case: every line is a URL that doubles in length */
  size_t estimated_size = input_len * 3;
  char *result = malloc(estimated_size);
  if (!result) {
    logger(LOG_ERROR, "Failed to allocate M3U rewrite buffer");
    return -1;
  }

  char *out_ptr = result;
  size_t remaining = estimated_size;
  const char *line_start = input;
  const char *input_end = input + input_len;

  while (line_start < input_end) {
    /* Find end of line */
    const char *line_end = line_start;
    while (line_end < input_end && *line_end != '\n')
      line_end++;

    /* Include the newline if present */
    if (line_end < input_end)
      line_end++;

    size_t line_len = (size_t)(line_end - line_start);

    /* Try to rewrite this line */
    char *rewritten = rewrite_m3u_line(ctx, line_start, line_len);

    if (rewritten) {
      /* Use rewritten line */
      size_t rewritten_len = strlen(rewritten);

      /* Check if we need to grow the buffer */
      while (rewritten_len + 2 > remaining) {
        size_t used = (size_t)(out_ptr - result);
        size_t new_size = estimated_size * 2;
        char *new_result = realloc(result, new_size);
        if (!new_result) {
          free(rewritten);
          free(result);
          logger(LOG_ERROR, "Failed to grow M3U rewrite buffer");
          return -1;
        }
        result = new_result;
        out_ptr = result + used;
        remaining = new_size - used;
        estimated_size = new_size;
      }

      memcpy(out_ptr, rewritten, rewritten_len);
      out_ptr += rewritten_len;
      remaining -= rewritten_len;

      /* Add line ending if original had one but rewritten doesn't */
      if (line_len > 0 && line_start[line_len - 1] == '\n' &&
          (rewritten_len == 0 || rewritten[rewritten_len - 1] != '\n')) {
        *out_ptr++ = '\n';
        remaining--;
      }

      free(rewritten);
    } else {
      /* Keep original line */
      if (line_len + 1 > remaining) {
        size_t used = (size_t)(out_ptr - result);
        size_t new_size = estimated_size * 2;
        char *new_result = realloc(result, new_size);
        if (!new_result) {
          free(result);
          logger(LOG_ERROR, "Failed to grow M3U rewrite buffer");
          return -1;
        }
        result = new_result;
        out_ptr = result + used;
        remaining = new_size - used;
        estimated_size = new_size;
      }

      memcpy(out_ptr, line_start, line_len);
      out_ptr += line_len;
      remaining -= line_len;
    }

    line_start = line_end;
  }

  *out_ptr = '\0';
  *output = result;
  *output_size = (size_t)(out_ptr - result);

  logger(LOG_DEBUG, "M3U rewrite: %zu bytes -> %zu bytes", input_len, *output_size);
  return 0;
}
