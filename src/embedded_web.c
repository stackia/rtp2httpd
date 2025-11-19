#include "connection.h"
#include "embedded_web_data.h"
#include "hashmap.h"
#include "http.h"
#include "utils.h"
#include <stdint.h>
#include <stdio.h>
#include <string.h>

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
  embedded_files_map =
      hashmap_new(sizeof(embedded_file_t), /* element size */
                  EMBEDDED_FILES_COUNT,    /* initial capacity */
                  0, 0,                    /* seeds (use default) */
                  hash_path,               /* hash function */
                  compare_paths,           /* compare function */
                  NULL, /* no element free function (static data) */
                  NULL  /* no udata */
      );

  if (!embedded_files_map) {
    logger(LOG_ERROR, "Failed to create embedded files hashmap");
    return;
  }

  /* Insert all embedded files into hashmap */
  for (size_t i = 0; i < EMBEDDED_FILES_COUNT; i++) {
    hashmap_set(embedded_files_map, &embedded_files[i]);
  }

  logger(LOG_DEBUG, "Initialized embedded files hashmap with %d files",
         EMBEDDED_FILES_COUNT);
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

  /* Apply different caching strategies based on whether filename has hash */
  if (file->has_hash) {
    /* Hashed files: use immutable long-term caching */
    snprintf(extra_headers, sizeof(extra_headers),
             "Content-Encoding: gzip\r\n"
             "Content-Length: %zu\r\n"
             "Cache-Control: public, max-age=31536000, immutable\r\n",
             file->size);

    send_http_headers(c, STATUS_200, file->mime_type, extra_headers);
    connection_queue_output_and_flush(c, file->data, file->size);
  } else {
    /* Non-hashed files (e.g., HTML): use ETag-based negotiation caching */

    /* Check ETag and send 304 if it matches */
    if (http_check_etag_and_send_304(c, file->etag, file->mime_type)) {
      return;
    }

    /* Send file with ETag for future cache validation */
    http_build_etag_headers(extra_headers, sizeof(extra_headers), file->size,
                            file->etag, "Content-Encoding: gzip");

    send_http_headers(c, STATUS_200, file->mime_type, extra_headers);
    connection_queue_output_and_flush(c, file->data, file->size);
  }
}
