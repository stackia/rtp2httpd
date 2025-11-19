#ifndef __UTILS_H__
#define __UTILS_H__

#include "configuration.h"
#include <stdint.h>

/* Return values used across multiple modules */
typedef enum {
  RETVAL_CLEAN = 0,
  RETVAL_WRITE_FAILED = 1,
  RETVAL_READ_FAILED = 2,
  RETVAL_UNKNOWN_METHOD = 3,
  RETVAL_BAD_REQUEST = 4,
  RETVAL_RTP_FAILED = 5,
  RETVAL_SOCK_READ_FAILED = 6
} retval_t;

/**
 * Logger function. Show the message if current verbosity is above
 * logged level.
 *
 * @param levem Message log level
 * @param format printf style format string
 * @returns Whatever printf returns
 */
int logger(loglevel_t level, const char *format, ...)
    __attribute__((format(printf, 2, 3)));

/**
 * Get current monotonic time in milliseconds.
 * Uses CLOCK_MONOTONIC for high precision and immunity to system clock changes.
 * Thread-safe.
 *
 * @return Current time in milliseconds since an unspecified starting point
 */
int64_t get_time_ms(void);

/**
 * Get current real time in milliseconds since Unix epoch.
 * Uses CLOCK_REALTIME for wall clock time.
 * Thread-safe.
 *
 * @return Current time in milliseconds since Unix epoch (1970-01-01 00:00:00
 * UTC)
 */
int64_t get_realtime_ms(void);

#ifndef strndupa
#define strndupa(s, n)                                                         \
  (__extension__({                                                             \
    const char *__in = (s);                                                    \
    size_t __len = strnlen(__in, (n)) + 1;                                     \
    char *__out = (char *)alloca(__len);                                       \
    __out[__len - 1] = '\0';                                                   \
    (char *)memcpy(__out, __in, __len - 1);                                    \
  }))
#endif

#define max(a, b) ((a) > (b) ? (a) : (b))
#define min(a, b) ((a) < (b) ? (a) : (b))

/* Array size calculation macro */
#define ARRAY_SIZE(arr) (sizeof(arr) / sizeof((arr)[0]))

/* Branch prediction hints for compiler optimization */
#ifdef __GNUC__
#define likely(x) __builtin_expect(!!(x), 1)
#define unlikely(x) __builtin_expect(!!(x), 0)
#else
#define likely(x) (x)
#define unlikely(x) (x)
#endif

#endif /* __UTILS_H__ */
