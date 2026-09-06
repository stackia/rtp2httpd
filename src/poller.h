#ifndef POLLER_H
#define POLLER_H

/**
 * Platform-agnostic event polling abstraction (edge-triggered by default).
 *
 * Provides a unified API over platform-specific event notification mechanisms:
 *   - Linux:   epoll with EPOLLET (edge-triggered)
 *   - macOS:   kqueue with EV_CLEAR (edge-triggered)
 *   - Windows: (future) IOCP
 *
 * Edge-triggered handlers must drain socket data (read/write until EAGAIN) because
 * edge-triggered pollers only notify on state transitions, not while
 * data remains available.
 */

#include <stdint.h>

/* Event flags (platform-independent) */
#define POLLER_IN 0x001    /* Ready to read */
#define POLLER_OUT 0x002   /* Ready to write */
#define POLLER_ERR 0x004   /* Error condition */
#define POLLER_HUP 0x008   /* Hangup (peer closed) */
#define POLLER_RDHUP 0x010 /* Read half of connection closed */
/* Registration option: keep reporting readiness while data remains. */
#define POLLER_LEVEL 0x020
/* Disable notifications after delivery; poller_mod() rearms the filter. */
#define POLLER_ONESHOT 0x040

/* Event structure returned by poller_wait() */
typedef struct {
  int fd;
  uint32_t events;
} poller_event_t;

/**
 * Create a new poller instance.
 * @return Poller file descriptor (>= 0) on success, -1 on error
 */
int poller_create(void);

/**
 * Close a poller instance.
 * @param pfd Poller file descriptor
 */
void poller_close(int pfd);

/**
 * Add a file descriptor to the poller.
 * @param pfd Poller file descriptor
 * @param fd File descriptor to monitor
 * @param events Bitmask of POLLER_* events to monitor
 * @return 0 on success, -1 on error
 */
int poller_add(int pfd, int fd, uint32_t events);

/**
 * Modify interest or rearm a file descriptor without changing its trigger mode.
 * Use poller_reset() when changing POLLER_LEVEL or POLLER_ONESHOT.
 * @param pfd Poller file descriptor
 * @param fd File descriptor to modify
 * @param events New bitmask of POLLER_* events to monitor
 * @return 0 on success, -1 on error
 */
int poller_mod(int pfd, int fd, uint32_t events);

/**
 * Replace interest and trigger mode, including for an already-ready descriptor.
 * kqueue requires fresh filters to replace EV_CLEAR/EV_DISPATCH behavior.
 * @return 0 on success, -1 on error; monitoring may be removed on failure
 */
int poller_reset(int pfd, int fd, uint32_t events);

/**
 * Remove a file descriptor from the poller.
 * @param pfd Poller file descriptor
 * @param fd File descriptor to remove
 * @return 0 on success, -1 on error
 */
int poller_del(int pfd, int fd);

/**
 * Wait for events on monitored file descriptors.
 * @param pfd Poller file descriptor
 * @param events Output array of events
 * @param max_events Maximum number of events to return
 * @param timeout_ms Timeout in milliseconds (-1 for infinite, 0 for non-blocking)
 * @return Number of events (>= 0), or -1 on error (errno set)
 */
int poller_wait(int pfd, poller_event_t *events, int max_events, int timeout_ms);

#endif /* POLLER_H */
