#include "configuration.h"
#include "connection.h"
#include "embedded_web_data.h"
#include "hashmap.h"
#include "http.h"
#include "utils.h"
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>

/* Static hashmap for O(1) embedded file lookup */
static struct hashmap *embedded_files_map = NULL;

/**
 * Hash function for embedded file paths
 */
static uint64_t hash_path(const void *item, uint64_t seed0, uint64_t seed1) {
  const embedded_file_t *file = item;
  return hashmap_xxhash3(file->path, strlen(file->path), seed0, seed1);
}

/**
 * Compare function for embedded file paths
 */
static int compare_paths(const void *a, const void *b, void *udata) {
  const embedded_file_t *fa = a;
  const embedded_file_t *fb = b;
  (void)udata; /* unused */
  return strcmp(fa->path, fb->path);
}

/**
 * Initialize the embedded files hashmap (lazy initialization)
 */
static void init_embedded_files_map(void) {
  if (embedded_files_map)
    return;

  /* Create hashmap with initial capacity set to number of embedded files */
  embedded_files_map = hashmap_new(sizeof(embedded_file_t), /* element size */
                                   EMBEDDED_FILES_COUNT,    /* initial capacity */
                                   0, 0,                    /* seeds (use default) */
                                   hash_path,               /* hash function */
                                   compare_paths,           /* compare function */
                                   NULL,                    /* no element free function (static data) */
                                   NULL                     /* no udata */
  );

  if (!embedded_files_map) {
    logger(LOG_ERROR, "Failed to create embedded files hashmap");
    return;
  }

  /* Insert all embedded files into hashmap */
  for (size_t i = 0; i < EMBEDDED_FILES_COUNT; i++) {
    hashmap_set(embedded_files_map, &embedded_files[i]);
  }

  logger(LOG_DEBUG, "Initialized embedded files hashmap with %d files", EMBEDDED_FILES_COUNT);
}

/**
 * Find an embedded file by path (O(1) lookup using hashmap)
 * Internal function - not exposed in header
 * @param path The requested path (e.g., "/status.html")
 * @return Pointer to embedded_file_t or NULL if not found
 */
static const embedded_file_t *find_embedded_file(const char *path) {
  if (!path)
    return NULL;

  /* Lazy initialization of hashmap */
  if (!embedded_files_map) {
    init_embedded_files_map();
    if (!embedded_files_map)
      return NULL; /* Initialization failed */
  }

  /* Create temporary key for lookup */
  embedded_file_t key = {.path = path};

  /* O(1) hashmap lookup */
  return hashmap_get(embedded_files_map, &key);
}

static size_t html_attr_escaped_len(const char *value) {
  size_t len = 0;

  if (!value)
    return 0;

  for (const char *p = value; *p; p++) {
    switch (*p) {
    case '"':
      len += 6;
      break;
    case '&':
    case '\'':
      len += 5;
      break;
    case '<':
    case '>':
      len += 4;
      break;
    default:
      len++;
      break;
    }
  }

  return len;
}

static char *html_attr_escape_string(const char *value) {
  size_t len = html_attr_escaped_len(value);
  char *result = malloc(len + 1);
  char *out = result;

  if (!result)
    return NULL;

  for (const char *p = value; value && *p; p++) {
    switch (*p) {
    case '"':
      memcpy(out, "&quot;", 6);
      out += 6;
      break;
    case '&':
      memcpy(out, "&amp;", 5);
      out += 5;
      break;
    case '\'':
      memcpy(out, "&#39;", 5);
      out += 5;
      break;
    case '<':
      memcpy(out, "&lt;", 4);
      out += 4;
      break;
    case '>':
      memcpy(out, "&gt;", 4);
      out += 4;
      break;
    default:
      *out++ = *p;
      break;
    }
  }
  *out = '\0';

  return result;
}

static int handle_embedded_html(connection_t *c, const embedded_file_t *file) {
  const char *prefix = (config.app_path_prefix && config.app_path_prefix[0] != '\0') ? config.app_path_prefix : "";
  char *base_href = NULL;
  char *escaped_prefix = json_escape_string(prefix);
  char *escaped_base_href = NULL;
  char *html = NULL;
  char *output = NULL;
  char *head = NULL;
  char *injection = NULL;
  char extra_headers[256];
  size_t injection_size;
  int injection_len;

  if (!escaped_prefix) {
    http_send_500(c);
    return -1;
  }

  base_href = malloc(strlen(prefix) + 2);
  if (!base_href) {
    free(escaped_prefix);
    http_send_500(c);
    return -1;
  }
  snprintf(base_href, strlen(prefix) + 2, "%s%s", prefix[0] ? prefix : "/", prefix[0] ? "/" : "");
  escaped_base_href = html_attr_escape_string(base_href);
  free(base_href);
  if (!escaped_base_href) {
    free(escaped_prefix);
    http_send_500(c);
    return -1;
  }

  injection_size = strlen(escaped_base_href) + strlen(escaped_prefix) + 160;
  injection = malloc(injection_size);
  if (!injection) {
    free(escaped_base_href);
    free(escaped_prefix);
    http_send_500(c);
    return -1;
  }

  injection_len = snprintf(injection, injection_size,
                           "<base href=\"%s\">\n"
                           "<script>window.__RTP2HTTPD_CONFIG__={\"appPathPrefix\":\"%s\",\"logLevel\":%d};</script>\n",
                           escaped_base_href, escaped_prefix, config.verbosity);
  free(escaped_base_href);
  free(escaped_prefix);

  if (injection_len < 0 || (size_t)injection_len >= injection_size) {
    free(injection);
    http_send_500(c);
    return -1;
  }

  html = malloc(file->size + 1);
  if (!html) {
    free(injection);
    http_send_500(c);
    return -1;
  }
  memcpy(html, file->data, file->size);
  html[file->size] = '\0';

  head = strstr(html, "<head>");
  size_t prefix_len = head ? (size_t)(head + strlen("<head>") - html) : 0;
  size_t output_size = file->size + (size_t)injection_len;

  output = malloc(output_size);
  if (!output) {
    free(injection);
    free(html);
    http_send_500(c);
    return -1;
  }

  memcpy(output, html, prefix_len);
  memcpy(output + prefix_len, injection, (size_t)injection_len);
  memcpy(output + prefix_len + (size_t)injection_len, html + prefix_len, file->size - prefix_len);

  snprintf(extra_headers, sizeof(extra_headers),
           "Content-Length: %zu\r\n"
           "Cache-Control: no-cache\r\n",
           output_size);
  send_http_headers(c, STATUS_200, file->mime_type, extra_headers);
  connection_queue_output_and_flush(c, (const uint8_t *)output, output_size);

  free(output);
  free(injection);
  free(html);
  return 0;
}

/**
 * Handle embedded static file request
 * @param c The connection
 * @param path The requested path
 */
void handle_embedded_file(connection_t *c, const char *path) {
  if (!c || !path)
    return;

  const embedded_file_t *file = find_embedded_file(path);
  if (!file) {
    http_send_404(c);
    return;
  }

  char extra_headers[512];

  if (!file->gzip_encoded && strncasecmp(file->mime_type, "text/html", 9) == 0) {
    handle_embedded_html(c, file);
    return;
  }

  /* Apply different caching strategies based on whether filename has hash */
  if (file->has_hash) {
    /* Hashed files: use immutable long-term caching */
    snprintf(extra_headers, sizeof(extra_headers),
             "%sContent-Length: %zu\r\n"
             "Cache-Control: public, max-age=31536000, immutable\r\n",
             file->gzip_encoded ? "Content-Encoding: gzip\r\n" : "", file->size);

    send_http_headers(c, STATUS_200, file->mime_type, extra_headers);
    connection_queue_output_and_flush(c, file->data, file->size);
  } else {
    /* Non-hashed files (e.g., HTML): use ETag-based negotiation caching */

    /* Check ETag and send 304 if it matches */
    if (http_check_etag_and_send_304(c, file->etag, file->mime_type)) {
      return;
    }

    /* Send file with ETag for future cache validation */
    http_build_etag_headers(extra_headers, sizeof(extra_headers), file->size, file->etag,
                            file->gzip_encoded ? "Content-Encoding: gzip" : NULL);

    send_http_headers(c, STATUS_200, file->mime_type, extra_headers);
    connection_queue_output_and_flush(c, file->data, file->size);
  }
}
