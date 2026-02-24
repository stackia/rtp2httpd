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

/* Retry delays in seconds: 2, 4, 8, 16, 32, 64, 128, 256 */
static const int retry_delays[] = {2, 4, 8, 16, 32, 64, 128, 256};
#define EPG_MAX_RETRY_COUNT 8

/* Detect gzip-compressed data via gzip magic number (0x1f 0x8b) */
static int epg_fd_is_gzipped(int fd) {
  unsigned char magic[2];

  if (pread(fd, magic, sizeof(magic), 0) != sizeof(magic)) {
    return 0;
  }

  return (magic[0] == 0x1f && magic[1] == 0x8b);
}

/* Calculate MD5 hash of EPG data from file descriptor */
static void calculate_epg_etag(int fd, size_t size) {
  MD5Context ctx;
  uint8_t digest[16];
  uint8_t buffer[8192];
  ssize_t bytes_read;
  size_t total_read = 0;
  off_t original_offset;

  /* Save original file offset */
  original_offset = lseek(fd, 0, SEEK_CUR);
  if (original_offset < 0) {
    logger(LOG_WARN, "Failed to get current file offset for ETag calculation");
    epg_cache.etag_valid = 0;
    return;
  }

  /* Seek to beginning of file */
  if (lseek(fd, 0, SEEK_SET) < 0) {
    logger(LOG_WARN, "Failed to seek to beginning for ETag calculation");
    epg_cache.etag_valid = 0;
    return;
  }

  /* Calculate MD5 hash */
  md5Init(&ctx);

  while (total_read < size) {
    size_t to_read = (size - total_read < sizeof(buffer)) ? (size - total_read)
                                                          : sizeof(buffer);
    bytes_read = read(fd, buffer, to_read);

    if (bytes_read <= 0) {
      logger(LOG_WARN, "Failed to read EPG data for ETag calculation");
      epg_cache.etag_valid = 0;
      lseek(fd, original_offset, SEEK_SET);
      return;
    }

    md5Update(&ctx, buffer, bytes_read);
    total_read += bytes_read;
  }

  md5Finalize(&ctx);

  /* Convert digest to hex string */
  memcpy(digest, ctx.digest, 16);
  md5_to_hex(digest, epg_cache.etag);
  epg_cache.etag_valid = 1;

  /* Restore original file offset */
  lseek(fd, original_offset, SEEK_SET);

  logger(LOG_DEBUG, "EPG ETag calculated: %s", epg_cache.etag);
}

/* Async fetch completion callback (fd-based, zero-copy) */
static void epg_fetch_fd_callback(http_fetch_ctx_t *ctx, int fd,
                                  size_t content_size, void *user_data) {
  (void)ctx;       /* Unused */
  (void)user_data; /* Unused */

  if (fd < 0) {
    epg_cache.fetch_error_count++;

    /* Schedule retry if we haven't exceeded max retries */
    if (epg_cache.retry_count < EPG_MAX_RETRY_COUNT) {
      int64_t delay_ms = (int64_t)retry_delays[epg_cache.retry_count] * 1000;
      epg_cache.next_retry_time = get_time_ms() + delay_ms;
      logger(LOG_ERROR,
             "EPG fetch failed (error count: %d), will retry in %d seconds "
             "(retry %d/%d)",
             epg_cache.fetch_error_count, retry_delays[epg_cache.retry_count],
             epg_cache.retry_count + 1, EPG_MAX_RETRY_COUNT);
      epg_cache.retry_count++;
    } else {
      logger(LOG_ERROR,
             "EPG fetch failed (error count: %d), max retries (%d) exceeded, "
             "will wait for next update interval",
             epg_cache.fetch_error_count, EPG_MAX_RETRY_COUNT);
      epg_cache.retry_count = 0;
      epg_cache.next_retry_time = 0;
    }
    return;
  }

  /* Close old fd if present */
  if (epg_cache.data_fd >= 0) {
    close(epg_cache.data_fd);
  }

  /* Store new fd */
  epg_cache.data_fd = fd;
  epg_cache.data_size = content_size;
  epg_cache.is_gzipped = epg_fd_is_gzipped(fd);
  epg_cache.fetch_error_count = 0;

  /* Reset retry state on success */
  epg_cache.retry_count = 0;
  epg_cache.next_retry_time = 0;

  /* Calculate ETag for the fetched data */
  calculate_epg_etag(fd, content_size);

  logger(LOG_INFO, "EPG data cached: %zu bytes, fd=%d (%s), ETag=%s",
         content_size, fd, epg_cache.is_gzipped ? "gzipped" : "uncompressed",
         epg_cache.etag_valid ? epg_cache.etag : "none");
}

int epg_init(void) {
  memset(&epg_cache, 0, sizeof(epg_cache));
  epg_cache.data_fd = -1;
  logger(LOG_DEBUG, "EPG cache initialized");
  return 0;
}

void epg_cleanup(void) {
  if (epg_cache.url) {
    free(epg_cache.url);
    epg_cache.url = NULL;
  }
  if (epg_cache.data_fd >= 0) {
    close(epg_cache.data_fd);
    epg_cache.data_fd = -1;
  }
  epg_cache.data_size = 0;
  epg_cache.is_gzipped = 0;
  epg_cache.fetch_error_count = 0;
  epg_cache.etag_valid = 0;
  epg_cache.etag[0] = '\0';
  logger(LOG_DEBUG, "EPG cache cleaned up");
}

int epg_set_url(const char *url) {
  char *new_url = NULL;

  /* Handle NULL or empty URL - clear the URL */
  if (!url || strlen(url) == 0) {
    logger(LOG_INFO, "EPG URL cleared");
    if (epg_cache.url) {
      free(epg_cache.url);
      epg_cache.url = NULL;
    }
    return 0;
  }

  /* Check if URL actually changed */
  if (epg_cache.url && strcmp(epg_cache.url, url) == 0) {
    logger(LOG_DEBUG, "EPG URL unchanged: %s", url);
    return 0;
  }

  /* Allocate new URL */
  new_url = strdup(url);
  if (!new_url) {
    logger(LOG_ERROR, "Failed to allocate memory for EPG URL");
    return -1;
  }

  /* Free old URL and set new one */
  if (epg_cache.url) {
    free(epg_cache.url);
  }
  epg_cache.url = new_url;

  logger(LOG_INFO, "EPG URL set to: %s", url);
  return 0;
}

int epg_fetch_async(int epfd) {
  http_fetch_ctx_t *fetch_ctx;

  /* Check if URL is set */
  if (!epg_cache.url) {
    logger(LOG_DEBUG, "No EPG URL configured, skipping async fetch");
    return -1;
  }

  if (epfd < 0) {
    logger(LOG_ERROR, "Invalid epoll fd for async EPG fetch");
    return -1;
  }

  logger(LOG_INFO, "Starting async EPG fetch from: %s", epg_cache.url);

  /* Start async fetch with fd-based callback (zero-copy)
   * Note: file:// URLs complete synchronously and return NULL (callback already
   * invoked) */
  fetch_ctx = http_fetch_start_async_fd(epg_cache.url, epg_fetch_fd_callback,
                                        NULL, epfd);

  /* NULL return value can mean:
   * 1. file:// URL completed synchronously (callback already called) - SUCCESS
   * 2. Error occurred (callback called with error) - also handled
   * Non-NULL means HTTP(S) fetch started successfully and is in progress */
  if (fetch_ctx) {
    logger(LOG_DEBUG, "Async HTTP(S) fetch started, waiting for completion");
  } else {
    logger(LOG_DEBUG, "Fetch completed immediately (likely file:// URL)");
  }

  return 0;
}

epg_cache_t *epg_get_cache(void) { return &epg_cache; }
