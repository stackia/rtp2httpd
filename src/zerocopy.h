#ifndef ZEROCOPY_H
#define ZEROCOPY_H

#include "buffer_pool.h"
#include <stdint.h>
#include <sys/types.h>

/**
 * Zero-Copy Send Infrastructure for rtp2httpd
 *
 * This module implements zero-copy send optimization using:
 * - Scatter-gather I/O with sendmsg()
 * - MSG_ZEROCOPY flag for kernel-level zero-copy
 * - Buffer pooling and lifecycle management
 * - Automatic fallback for compatibility
 */

/* Zero-copy configuration */
#define ZEROCOPY_MAX_IOVECS 64 /* Maximum iovec entries per sendmsg() */

/* Batching configuration - accumulate small packets before sending */
#define ZEROCOPY_BATCH_BYTES 65536 /* Send when accumulated >= 64KB */

/**
 * Zero-copy send queue for a connection
 */
typedef struct zerocopy_queue_s {
  buffer_ref_t *head;         /* First buffer to send */
  buffer_ref_t *tail;         /* Last buffer in queue */
  buffer_ref_t *pending_head; /* First buffer pending completion */
  buffer_ref_t *pending_tail; /* Last buffer pending completion */
  size_t total_bytes;         /* Total bytes queued */
  size_t num_queued;          /* Number of buffers in send queue */
  size_t num_pending;         /* Number of buffers pending completion */
  uint32_t next_zerocopy_id;  /* Next ID for MSG_ZEROCOPY tracking */
  uint32_t last_completed_id; /* Last completed MSG_ZEROCOPY ID */
} zerocopy_queue_t;

/**
 * Global zero-copy state
 */
typedef struct zerocopy_state_s {
  buffer_pool_t pool;         /* Global buffer pool */
  buffer_pool_t control_pool; /* Dedicated pool for status/API control plane */
  size_t active_streams;      /* Number of active media streaming clients */
  int initialized;            /* Whether initialized */
} zerocopy_state_t;

/* Global zero-copy state */
extern zerocopy_state_t zerocopy_state;

/**
 * Initialize zero-copy infrastructure
 * Detects kernel support and initializes buffer pool
 * Uses global worker_id for per-worker statistics
 * @return 0 on success, -1 on error
 */
int zerocopy_init(void);

/**
 * Cleanup zero-copy infrastructure
 */
void zerocopy_cleanup(void);

/**
 * Initialize zero-copy queue for a connection
 * @param queue Queue to initialize
 */
void zerocopy_queue_init(zerocopy_queue_t *queue);

/**
 * Cleanup zero-copy queue and free all entries
 * @param queue Queue to cleanup
 */
void zerocopy_queue_cleanup(zerocopy_queue_t *queue);

/**
 * Queue data for zero-copy send (no memcpy)
 * Takes ownership of the buffer via reference counting
 * Data pointer is derived from buffer_ref and offset
 * @param queue Send queue
 * @param buf_ref Buffer reference (must not be NULL)
 * @return 0 on success, -1 if queue full or invalid parameters
 */
int zerocopy_queue_add(zerocopy_queue_t *queue, buffer_ref_t *buf_ref);

/**
 * Queue a file descriptor for zero-copy send using sendfile()
 * Creates a special buffer_ref_t to represent the file
 * Takes ownership of the file descriptor (will close it when done)
 * @param queue Send queue
 * @param file_fd File descriptor to send (must be seekable)
 * @param file_offset Starting offset in file
 * @param file_size Number of bytes to send from file
 * @return 0 on success, -1 on error
 */
int zerocopy_queue_add_file(zerocopy_queue_t *queue, int file_fd,
                            off_t file_offset, size_t file_size);

/**
 * Send queued data using zero-copy techniques
 * @param fd Socket file descriptor
 * @param queue Send queue
 * @param bytes_sent Output: number of bytes sent
 * @return 0 on success, -1 on error, -2 on EAGAIN
 */
int zerocopy_send(int fd, zerocopy_queue_t *queue, size_t *bytes_sent);

/**
 * Check if queue should be flushed based on batching thresholds
 * Returns true if accumulated bytes >= ZEROCOPY_BATCH_BYTES or timeout expired
 * @param queue Send queue
 * @return 1 if should flush, 0 otherwise
 */
int zerocopy_should_flush(zerocopy_queue_t *queue);

/**
 * Handle MSG_ZEROCOPY completion notifications
 * @param fd Socket file descriptor
 * @param queue Send queue
 * @return Number of completions processed, -1 on error
 */
int zerocopy_handle_completions(int fd, zerocopy_queue_t *queue);

void zerocopy_register_stream_client(void);
void zerocopy_unregister_stream_client(void);
size_t zerocopy_active_streams(void);

#endif /* ZEROCOPY_H */
