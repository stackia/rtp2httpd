#ifndef ZEROCOPY_H
#define ZEROCOPY_H

#include <stdint.h>
#include <sys/types.h>
#include <sys/uio.h>

/**
 * Zero-Copy Send Infrastructure for rtp2httpd
 *
 * This module implements zero-copy send optimization using:
 * - Scatter-gather I/O with sendmsg()
 * - MSG_ZEROCOPY flag for kernel-level zero-copy
 * - Buffer pooling and lifecycle management
 * - Automatic fallback for compatibility
 */

/* Forward declarations */
struct connection_s;

/* Zero-copy feature flags */
#define ZEROCOPY_DISABLED 0
#define ZEROCOPY_SENDMSG (1 << 0)      /* Use sendmsg() with scatter-gather */
#define ZEROCOPY_MSG_ZEROCOPY (1 << 1) /* Use MSG_ZEROCOPY flag (mandatory) */

/* Zero-copy configuration */
#define ZEROCOPY_MAX_IOVECS 64 /* Maximum iovec entries per sendmsg() */

/* Batching configuration - accumulate small packets before sending */
#define ZEROCOPY_BATCH_BYTES 10240      /* Send when accumulated >= 15KB */
#define ZEROCOPY_BATCH_TIMEOUT_US 15000 /* Send after 15ms timeout */

/* Buffer pool configuration - optimized for RTP packets (< 1500 bytes) */
#define BUFFER_POOL_INITIAL_SIZE 1024 /* Initial number of buffers in pool */
#define BUFFER_POOL_EXPAND_SIZE 512   /* Number of buffers to add when expanding */
#define BUFFER_POOL_BUFFER_SIZE 1500  /* Size of each pooled buffer */
#define BUFFER_POOL_LOW_WATERMARK 256 /* Trigger expansion when free buffers < this */

/**
 * Buffer reference counting for zero-copy lifecycle management
 */
typedef struct buffer_ref_s
{
    void *data;                    /* Pointer to buffer data */
    size_t size;                   /* Size of buffer */
    int refcount;                  /* Reference count */
    void (*free_callback)(void *); /* Callback to free buffer */
    void *owner;                   /* Owner context (for callback) */
    struct buffer_ref_s *next;     /* For free list */
} buffer_ref_t;

/**
 * Send queue entry for zero-copy transmission
 * Each entry represents a buffer to be sent without copying
 */
typedef struct send_queue_entry_s
{
    struct iovec iov;      /* Data pointer and length */
    buffer_ref_t *buf_ref; /* Reference to buffer (NULL for inline data) */
    size_t buf_offset;     /* Offset in buffer where data starts (for partial sends) */
    uint32_t zerocopy_id;  /* ID for tracking MSG_ZEROCOPY completions */
    struct send_queue_entry_s *next;
} send_queue_entry_t;

/**
 * Zero-copy send queue for a connection
 */
typedef struct zerocopy_queue_s
{
    send_queue_entry_t *head;         /* First entry to send */
    send_queue_entry_t *tail;         /* Last entry in queue */
    send_queue_entry_t *pending_head; /* First entry pending completion */
    send_queue_entry_t *pending_tail; /* Last entry pending completion */
    size_t total_bytes;               /* Total bytes queued */
    size_t num_entries;               /* Number of entries in send queue */
    size_t num_pending;               /* Number of entries pending completion */
    uint32_t next_zerocopy_id;        /* Next ID for MSG_ZEROCOPY tracking */
    uint32_t last_completed_id;       /* Last completed MSG_ZEROCOPY ID */
    uint64_t first_queued_time_us;    /* Timestamp of first queued entry (microseconds) */
} zerocopy_queue_t;

/**
 * Buffer pool segment for dynamic expansion
 */
typedef struct buffer_pool_segment_s
{
    uint8_t *buffers;                   /* Pre-allocated buffer array for this segment */
    buffer_ref_t *refs;                 /* Buffer reference structures for this segment */
    size_t num_buffers;                 /* Number of buffers in this segment */
    struct buffer_pool_segment_s *next; /* Next segment in chain */
} buffer_pool_segment_t;

/**
 * Buffer pool for efficient buffer allocation with dynamic expansion
 */
typedef struct buffer_pool_s
{
    buffer_pool_segment_t *segments; /* Linked list of buffer segments */
    buffer_ref_t *free_list;         /* Free list head */
    size_t buffer_size;              /* Size of each buffer */
    size_t num_buffers;              /* Total number of buffers across all segments */
    size_t num_free;                 /* Number of free buffers */
    size_t max_buffers;              /* Maximum allowed buffers (expansion limit) */
    size_t expand_size;              /* Number of buffers to add per expansion */
    size_t low_watermark;            /* Trigger expansion when free < this */
    size_t total_expansions;         /* Statistics: number of times pool expanded */
    size_t total_exhaustions;        /* Statistics: number of times pool was exhausted */
} buffer_pool_t;

/**
 * Zero-copy statistics
 */
typedef struct zerocopy_stats_s
{
    uint64_t total_sends;       /* Total number of sendmsg() calls */
    uint64_t total_completions; /* Total MSG_ZEROCOPY completions */
    uint64_t total_copied;      /* Times kernel copied instead of zero-copy */
    uint64_t eagain_count;      /* Number of EAGAIN/EWOULDBLOCK errors */
    uint64_t enobufs_count;     /* Number of ENOBUFS errors */
    uint64_t batch_sends;       /* Number of batched sends (size threshold) */
    uint64_t timeout_flushes;   /* Number of timeout-triggered flushes */
} zerocopy_stats_t;

/**
 * Global zero-copy state
 */
typedef struct zerocopy_state_s
{
    int features;           /* Enabled features (ZEROCOPY_* flags) */
    buffer_pool_t pool;     /* Global buffer pool */
    zerocopy_stats_t stats; /* Zero-copy statistics */
    int initialized;        /* Whether initialized */
} zerocopy_state_t;

/* Global zero-copy state */
extern zerocopy_state_t zerocopy_state;

/**
 * Initialize zero-copy infrastructure
 * Detects kernel support and initializes buffer pool
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
 * @param queue Send queue
 * @param data Data pointer (can be in middle of buffer)
 * @param len Data length
 * @param buf_ref Buffer reference (NULL for static data)
 * @param offset Offset in buffer where data starts (for partial buffer sends)
 * @return 0 on success, -1 if queue full
 */
int zerocopy_queue_add(zerocopy_queue_t *queue, void *data, size_t len, buffer_ref_t *buf_ref, size_t offset);

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

/**
 * Create a buffer reference for zero-copy
 * @param data Data pointer
 * @param size Data size
 * @param owner Owner context
 * @param free_callback Callback to free buffer
 * @return Buffer reference, or NULL on error
 */
buffer_ref_t *buffer_ref_create(void *data, size_t size, void *owner, void (*free_callback)(void *));

/**
 * Increment buffer reference count
 * @param ref Buffer reference
 */
void buffer_ref_get(buffer_ref_t *ref);

/**
 * Decrement buffer reference count and free if zero
 * @param ref Buffer reference
 */
void buffer_ref_put(buffer_ref_t *ref);

/**
 * Allocate a buffer from the pool
 * @param size Requested size (must be <= BUFFER_POOL_BUFFER_SIZE)
 * @return Buffer reference, or NULL if pool exhausted
 */
buffer_ref_t *buffer_pool_alloc(size_t size);

/**
 * Get statistics about zero-copy usage
 * @param queue_bytes Output: bytes currently queued
 * @param pool_free Output: free buffers in pool
 */
void zerocopy_get_stats(size_t *queue_bytes, size_t *pool_free);

/**
 * Get detailed buffer pool statistics
 * @param total_buffers Output: total number of buffers in pool
 * @param free_buffers Output: number of free buffers
 * @param max_buffers Output: maximum allowed buffers
 * @param expansions Output: number of times pool expanded
 * @param exhaustions Output: number of times pool was exhausted
 */
void buffer_pool_get_stats(size_t *total_buffers, size_t *free_buffers, size_t *max_buffers,
                           size_t *expansions, size_t *exhaustions);

/**
 * Get detailed zero-copy statistics
 * @param stats Output: pointer to zerocopy_stats_t structure to fill
 */
void zerocopy_get_detailed_stats(zerocopy_stats_t *stats);

#endif /* ZEROCOPY_H */
