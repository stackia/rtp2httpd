#ifndef EMBEDDED_WEB_H
#define EMBEDDED_WEB_H

#include "connection.h"
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* Embedded file structure */
typedef struct {
  const char *path;
  const char *mime_type;
  const char *etag;
  const uint8_t *data;
  size_t size;
  bool has_hash;
} embedded_file_t;

/**
 * Handle embedded static file request
 * @param c The connection
 * @param path The requested path
 */
void handle_embedded_file(connection_t *c, const char *path);

#endif /* EMBEDDED_WEB_H */
