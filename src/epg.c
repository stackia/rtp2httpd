#include "epg.h"
#include "http_fetch.h"
#include "md5.h"
#include "utils.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <unistd.h>

/* Global EPG cache */
static epg_cache_t epg_cache = {0};
static uint64_t epg_generation = 1;

typedef struct {
  size_t index;
  uint64_t generation;
} epg_fetch_request_t;

/* Retry delays in seconds: 2, 4, 8, 16, 32, 64, 128, 256 */
static const int retry_delays[] = {2, 4, 8, 16, 32, 64, 128, 256};
#define EPG_MAX_RETRY_COUNT 8

static void epg_source_init(epg_source_t *source) {
  if (!source)
    return;

  memset(source, 0, sizeof(*source));
  source->data_fd = -1;
}

static void epg_source_cleanup(epg_source_t *source) {
  if (!source)
    return;

  if (source->url) {
    free(source->url);
    source->url = NULL;
  }
  if (source->data_fd >= 0) {
    close(source->data_fd);
    source->data_fd = -1;
  }
  source->data_size = 0;
  source->is_gzipped = 0;
  source->fetch_error_count = 0;
  source->etag_valid = 0;
  source->etag[0] = '\0';
  source->retry_count = 0;
  source->next_retry_time = 0;
}

static int epg_url_has_supported_scheme(const char *url) {
  return strncasecmp(url, "http://", 7) == 0 || strncasecmp(url, "https://", 8) == 0 ||
         strncasecmp(url, "file://", 7) == 0;
}

/* Detect gzip-compressed data via gzip magic number (0x1f 0x8b) */
static int epg_fd_is_gzipped(int fd) {
  unsigned char magic[2];

  if (pread(fd, magic, sizeof(magic), 0) != sizeof(magic)) {
    return 0;
  }

  return (magic[0] == 0x1f && magic[1] == 0x8b);
}

/* Calculate MD5 hash of EPG data from file descriptor */
static void calculate_epg_etag(epg_source_t *source, int fd, size_t size) {
  MD5Context ctx;
  uint8_t digest[16];
  uint8_t buffer[8192];
  ssize_t bytes_read;
  size_t total_read = 0;
  off_t original_offset;

  if (!source)
    return;

  /* Save original file offset */
  original_offset = lseek(fd, 0, SEEK_CUR);
  if (original_offset < 0) {
    logger(LOG_WARN, "Failed to get current file offset for ETag calculation");
    source->etag_valid = 0;
    return;
  }

  /* Seek to beginning of file */
  if (lseek(fd, 0, SEEK_SET) < 0) {
    logger(LOG_WARN, "Failed to seek to beginning for ETag calculation");
    source->etag_valid = 0;
    return;
  }

  /* Calculate MD5 hash */
  md5Init(&ctx);

  while (total_read < size) {
    size_t to_read = (size - total_read < sizeof(buffer)) ? (size - total_read) : sizeof(buffer);
    bytes_read = read(fd, buffer, to_read);

    if (bytes_read <= 0) {
      logger(LOG_WARN, "Failed to read EPG data for ETag calculation");
      source->etag_valid = 0;
      lseek(fd, original_offset, SEEK_SET);
      return;
    }

    md5Update(&ctx, buffer, bytes_read);
    total_read += bytes_read;
  }

  md5Finalize(&ctx);

  /* Convert digest to hex string */
  memcpy(digest, ctx.digest, 16);
  md5_to_hex(digest, source->etag);
  source->etag_valid = 1;

  /* Restore original file offset */
  lseek(fd, original_offset, SEEK_SET);

  logger(LOG_DEBUG, "EPG ETag calculated: %s", source->etag);
}

/* Async fetch completion callback (fd-based, zero-copy) */
static void epg_fetch_fd_callback(http_fetch_ctx_t *ctx, int fd, size_t content_size, void *user_data) {
  (void)ctx; /* Unused */

  epg_fetch_request_t *request = (epg_fetch_request_t *)user_data;
  epg_source_t *source = NULL;
  size_t source_number = 0;

  if (request && request->generation == epg_generation && request->index < epg_cache.source_count) {
    source = &epg_cache.sources[request->index];
    source_number = request->index + 1;
  }

  if (!source) {
    if (fd >= 0)
      close(fd);
    if (request)
      free(request);
    logger(LOG_DEBUG, "Ignoring stale EPG fetch result");
    return;
  }

  if (fd < 0) {
    source->fetch_error_count++;

    /* Schedule retry if we haven't exceeded max retries */
    if (source->retry_count < EPG_MAX_RETRY_COUNT) {
      int64_t delay_ms = (int64_t)retry_delays[source->retry_count] * 1000;
      source->next_retry_time = get_time_ms() + delay_ms;
      logger(LOG_ERROR,
             "EPG source %zu fetch failed (error count: %d), will retry in %d seconds "
             "(retry %d/%d)",
             source_number, source->fetch_error_count, retry_delays[source->retry_count], source->retry_count + 1,
             EPG_MAX_RETRY_COUNT);
      source->retry_count++;
    } else {
      logger(LOG_ERROR,
             "EPG source %zu fetch failed (error count: %d), max retries (%d) exceeded, "
             "will wait for next update interval",
             source_number, source->fetch_error_count, EPG_MAX_RETRY_COUNT);
      source->retry_count = 0;
      source->next_retry_time = 0;
    }
    free(request);
    return;
  }

  /* Close old fd if present */
  if (source->data_fd >= 0) {
    close(source->data_fd);
  }

  /* Store new fd */
  source->data_fd = fd;
  source->data_size = content_size;
  source->is_gzipped = epg_fd_is_gzipped(fd);
  source->fetch_error_count = 0;

  /* Reset retry state on success */
  source->retry_count = 0;
  source->next_retry_time = 0;

  /* Calculate ETag for the fetched data */
  calculate_epg_etag(source, fd, content_size);

  logger(LOG_INFO, "EPG source %zu data cached: %zu bytes, fd=%d (%s), ETag=%s", source_number, content_size, fd,
         source->is_gzipped ? "gzipped" : "uncompressed", source->etag_valid ? source->etag : "none");

  free(request);
}

void epg_cleanup(void) {
  for (size_t i = 0; i < epg_cache.source_count; i++) {
    epg_source_cleanup(&epg_cache.sources[i]);
  }
  if (epg_cache.sources) {
    free(epg_cache.sources);
    epg_cache.sources = NULL;
  }
  epg_cache.source_count = 0;
  epg_generation++;
  logger(LOG_DEBUG, "EPG cache cleaned up");
}

int epg_set_urls(const char **urls, size_t url_count) {
  epg_source_t *new_sources = NULL;
  size_t effective_count = url_count;

  if (!urls || url_count == 0) {
    logger(LOG_INFO, "EPG URLs cleared");
    epg_cleanup();
    return 0;
  }

  if (effective_count > EPG_MAX_SOURCES) {
    logger(LOG_WARN, "Too many EPG URLs (%zu), keeping first %d", effective_count, EPG_MAX_SOURCES);
    effective_count = EPG_MAX_SOURCES;
  }

  new_sources = calloc(effective_count, sizeof(*new_sources));
  if (!new_sources) {
    logger(LOG_ERROR, "Failed to allocate memory for EPG sources");
    return -1;
  }

  for (size_t i = 0; i < effective_count; i++) {
    epg_source_init(&new_sources[i]);

    if (!urls[i] || urls[i][0] == '\0') {
      logger(LOG_ERROR, "Invalid empty EPG URL at position %zu", i + 1);
      for (size_t j = 0; j <= i; j++) {
        epg_source_cleanup(&new_sources[j]);
      }
      free(new_sources);
      return -1;
    }

    if (!epg_url_has_supported_scheme(urls[i])) {
      logger(LOG_ERROR, "Unsupported EPG URL scheme at position %zu: %s", i + 1, urls[i]);
      for (size_t j = 0; j <= i; j++) {
        epg_source_cleanup(&new_sources[j]);
      }
      free(new_sources);
      return -1;
    }

    new_sources[i].url = strdup(urls[i]);
    if (!new_sources[i].url) {
      logger(LOG_ERROR, "Failed to allocate memory for EPG URL");
      for (size_t j = 0; j <= i; j++) {
        epg_source_cleanup(&new_sources[j]);
      }
      free(new_sources);
      return -1;
    }
  }

  for (size_t i = 0; i < effective_count && i < epg_cache.source_count; i++) {
    epg_source_t *old_source = &epg_cache.sources[i];
    epg_source_t *new_source = &new_sources[i];

    if (!old_source->url || strcmp(old_source->url, new_source->url) != 0)
      continue;

    new_source->data_fd = old_source->data_fd;
    new_source->data_size = old_source->data_size;
    new_source->is_gzipped = old_source->is_gzipped;
    new_source->fetch_error_count = old_source->fetch_error_count;
    memcpy(new_source->etag, old_source->etag, sizeof(new_source->etag));
    new_source->etag_valid = old_source->etag_valid;
    new_source->retry_count = old_source->retry_count;
    new_source->next_retry_time = old_source->next_retry_time;

    old_source->data_fd = -1;
    old_source->data_size = 0;
    old_source->etag_valid = 0;
    old_source->etag[0] = '\0';
  }

  for (size_t i = 0; i < epg_cache.source_count; i++) {
    epg_source_cleanup(&epg_cache.sources[i]);
  }
  if (epg_cache.sources) {
    free(epg_cache.sources);
  }

  epg_cache.sources = new_sources;
  epg_cache.source_count = effective_count;
  epg_generation++;

  logger(LOG_INFO, "EPG URL list set: %zu source%s", effective_count, effective_count == 1 ? "" : "s");
  for (size_t i = 0; i < effective_count; i++) {
    logger(LOG_DEBUG, "EPG source %zu URL: %s", i + 1, epg_cache.sources[i].url);
  }

  return 0;
}

int epg_set_url(const char *url) {
  const char *urls[1];

  /* Handle NULL or empty URL - clear the URL */
  if (!url || strlen(url) == 0) {
    return epg_set_urls(NULL, 0);
  }

  urls[0] = url;
  return epg_set_urls(urls, 1);
}

int epg_fetch_source_async(int epfd, size_t index) {
  http_fetch_ctx_t *fetch_ctx;
  epg_fetch_request_t *request;
  epg_source_t *source;

  if (index >= epg_cache.source_count) {
    logger(LOG_DEBUG, "Invalid EPG source index: %zu", index);
    return -1;
  }

  source = &epg_cache.sources[index];
  if (!source->url) {
    logger(LOG_DEBUG, "No EPG URL configured for source %zu, skipping async fetch", index + 1);
    return -1;
  }

  if (epfd < 0) {
    logger(LOG_ERROR, "Invalid epoll fd for async EPG fetch");
    return -1;
  }

  request = malloc(sizeof(*request));
  if (!request) {
    logger(LOG_ERROR, "Failed to allocate EPG fetch request");
    return -1;
  }
  request->index = index;
  request->generation = epg_generation;

  logger(LOG_INFO, "Starting async EPG source %zu/%zu fetch from: %s", index + 1, epg_cache.source_count, source->url);

  /* Start async fetch with fd-based callback (zero-copy)
   * Note: file:// URLs complete synchronously and return NULL (callback already
   * invoked) */
  fetch_ctx = http_fetch_start_async_fd(source->url, epg_fetch_fd_callback, request, epfd);

  if (fetch_ctx) {
    logger(LOG_DEBUG, "Async HTTP(S) EPG source %zu fetch started, waiting for completion", index + 1);
    return 0;
  }

  if (strncmp(source->url, "file://", 7) == 0) {
    logger(LOG_DEBUG, "EPG source %zu fetch completed immediately (file:// URL)", index + 1);
    return 0;
  }

  logger(LOG_ERROR, "Failed to start async EPG source %zu fetch from: %s", index + 1, source->url);
  epg_fetch_fd_callback(NULL, -1, 0, request);

  return -1;
}

int epg_fetch_async(int epfd) {
  int result = -1;

  if (epg_cache.source_count == 0) {
    logger(LOG_DEBUG, "No EPG URL configured, skipping async fetch");
    return -1;
  }

  for (size_t i = 0; i < epg_cache.source_count; i++) {
    if (epg_fetch_source_async(epfd, i) == 0) {
      result = 0;
    }
  }

  return result;
}

void epg_reset_retry_state_all(void) {
  for (size_t i = 0; i < epg_cache.source_count; i++) {
    epg_cache.sources[i].retry_count = 0;
    epg_cache.sources[i].next_retry_time = 0;
  }
}

int epg_get_retry_source_index(int64_t now) {
  for (size_t i = 0; i < epg_cache.source_count; i++) {
    if (epg_cache.sources[i].next_retry_time > 0 && now >= epg_cache.sources[i].next_retry_time) {
      return (int)i;
    }
  }

  return -1;
}

void epg_clear_retry_time(size_t index) {
  if (index >= epg_cache.source_count)
    return;

  epg_cache.sources[index].next_retry_time = 0;
}

epg_cache_t *epg_get_cache(void) { return &epg_cache; }

epg_source_t *epg_get_source(size_t index) {
  if (index >= epg_cache.source_count)
    return NULL;

  return &epg_cache.sources[index];
}
