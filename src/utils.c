#include "utils.h"
#include "configuration.h"
#include "rtp2httpd.h"
#include "status.h"
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <time.h>

/**
 * Get current monotonic time in milliseconds.
 * Uses CLOCK_MONOTONIC for high precision and immunity to system clock changes.
 * Thread-safe.
 *
 * @return Current time in milliseconds since an unspecified starting point
 */
int64_t get_time_ms(void) {
  struct timespec ts;
  if (clock_gettime(CLOCK_MONOTONIC, &ts) != 0) {
    /* Fallback to CLOCK_REALTIME if MONOTONIC is not available */
    if (clock_gettime(CLOCK_REALTIME, &ts) != 0) {
      return 0;
    }
  }
  return (int64_t)ts.tv_sec * 1000LL + ts.tv_nsec / 1000000LL;
}

/**
 * Get current real time in milliseconds since Unix epoch.
 * Uses CLOCK_REALTIME for wall clock time.
 * Thread-safe.
 *
 * @return Current time in milliseconds since Unix epoch (1970-01-01 00:00:00
 * UTC)
 */
int64_t get_realtime_ms(void) {
  struct timespec ts;
  if (clock_gettime(CLOCK_REALTIME, &ts) != 0) {
    return 0;
  }
  return (int64_t)ts.tv_sec * 1000LL + ts.tv_nsec / 1000000LL;
}

/**
 * Logger function. Show the message if current verbosity is above
 * logged level.
 *
 * @param level Message log level
 * @param format printf style format string
 * @returns Whatever printf returns
 */
int logger(loglevel_t level, const char *format, ...) {
  va_list ap;
  int r = 0;
  char message[1024];
  int prefix_len = 0;

  /* Check log level from shared memory if available, otherwise use config */
  loglevel_t current_level = config.verbosity;
  if (status_shared) {
    current_level = status_shared->current_log_level;
  }

  if (current_level >= level) {
    /* Add worker_id prefix only if multiple workers */
    if (config.workers > 1) {
      prefix_len =
          snprintf(message, sizeof(message), "[Worker %d] ", worker_id);
    }

    /* Format the actual message after the prefix (if any) */
    va_start(ap, format);
    vsnprintf(message + prefix_len, sizeof(message) - prefix_len, format, ap);
    va_end(ap);

    /* Output to stderr */
    r = fputs(message, stderr);

    /* Store in status log buffer */
    status_add_log_entry(level, message);

    // Automatically add newline if format doesn't end with one
    if (format && strlen(format) > 0 && format[strlen(format) - 1] != '\n') {
      fputc('\n', stderr);
    }
  }
  return r;
}
