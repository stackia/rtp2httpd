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
#define ZEROCOPY_BATCH_BYTES 65536       /* Send when accumulated >= 64KB */
#define ZEROCOPY_BATCH_TIMEOUT_US 100000 /* Send after 100ms timeout */

/* Buffer pool configuration - optimized for RTP packets with cache alignment */
#define BUFFER_POOL_ALIGNMENT 64                                  /* Cache line alignment for DMA efficiency */
#define BUFFER_POOL_INITIAL_SIZE 1024                             /* Initial number of buffers in pool */
#define BUFFER_POOL_EXPAND_SIZE 512                               /* Number of buffers to add when expanding */
#define BUFFER_POOL_BUFFER_SIZE 1536                              /* Size of each pooled buffer (1536 = 24*64, cache-aligned, fits max RTP packet) */
#define BUFFER_POOL_LOW_WATERMARK 256                             /* Trigger expansion when free buffers < this */
#define BUFFER_POOL_HIGH_WATERMARK (BUFFER_POOL_INITIAL_SIZE * 3) /* Trigger shrink when free > this (3072) */

/**
 * Buffer reference counting for zero-copy lifecycle management
 * All buffers are pool-managed, no external buffers supported
 *
 * This structure serves dual purpose:
 * 1. When buffer is free: linked via free_next in pool's free list
 * 2. When buffer is in use: can be queued for sending via send_next
 *
 * The send queue fields (iov, buf_offset, zerocopy_id) are only valid
 * when the buffer is in a send queue or pending completion queue.
 */
typedef struct buffer_ref_s
{
    void *data;                            /* Pointer to buffer data */
    size_t size;                           /* Size of buffer */
    int refcount;                          /* Reference count */
    struct buffer_pool_segment_s *segment; /* Segment this buffer belongs to */

    /* Union: buffer is either in free list OR in send queue, never both */
    union
    {
        struct buffer_ref_s *free_next; /* For free list linkage */
        struct buffer_ref_s *send_next; /* For send/pending queue linkage */
    };

    /* Send queue fields - only valid when buffer is queued for sending */
    struct iovec iov;     /* Data pointer and length for sendmsg() */
    size_t buf_offset;    /* Offset in buffer where data starts (for partial sends) */
    uint32_t zerocopy_id; /* ID for tracking MSG_ZEROCOPY completions */
} buffer_ref_t;

/* send_queue_entry_t has been removed - functionality merged into buffer_ref_t */

/**
 * Zero-copy send queue for a connection
 * Now uses buffer_ref_t directly instead of separate send_queue_entry_t
 */
typedef struct zerocopy_queue_s
{
    buffer_ref_t *head;            /* First buffer to send */
    buffer_ref_t *tail;            /* Last buffer in queue */
    buffer_ref_t *pending_head;    /* First buffer pending completion */
    buffer_ref_t *pending_tail;    /* Last buffer pending completion */
    size_t total_bytes;            /* Total bytes queued */
    size_t num_entries;            /* Number of buffers in send queue */
    size_t num_pending;            /* Number of buffers pending completion */
    uint32_t next_zerocopy_id;     /* Next ID for MSG_ZEROCOPY tracking */
    uint32_t last_completed_id;    /* Last completed MSG_ZEROCOPY ID */
    uint64_t first_queued_time_us; /* Timestamp of first queued entry (microseconds) */
} zerocopy_queue_t;

/**
 * Buffer pool segment for dynamic expansion
 */
typedef struct buffer_pool_segment_s
{
    uint8_t *buffers;                   /* Pre-allocated buffer array for this segment */
    buffer_ref_t *refs;                 /* Buffer reference structures for this segment */
    size_t num_buffers;                 /* Number of buffers in this segment */
    size_t num_free;                    /* Number of free buffers in this segment */
    uint64_t create_time_us;            /* Creation timestamp (for age-based reclaim) */
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
    size_t high_watermark;           /* Trigger shrink when free > this */
    size_t total_expansions;         /* Statistics: number of times pool expanded */
    size_t total_exhaustions;        /* Statistics: number of times pool was exhausted */
    size_t total_shrinks;            /* Statistics: number of times pool shrank */
} buffer_pool_t;

/**
 * Global zero-copy state
 */
typedef struct zerocopy_state_s
{
    int features;       /* Enabled features (ZEROCOPY_* flags) */
    buffer_pool_t pool; /* Global buffer pool */
    int worker_id;      /* This worker's ID for accessing shared stats */
    int initialized;    /* Whether initialized */
} zerocopy_state_t;

/* Global zero-copy state */
extern zerocopy_state_t zerocopy_state;

/**
 * Initialize zero-copy infrastructure
 * Detects kernel support and initializes buffer pool
 * @param worker_id Worker ID for per-worker statistics (0-based)
 * @return 0 on success, -1 on error
 */
int zerocopy_init(int worker_id);

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
 * Try to shrink buffer pool by freeing completely idle segments
 * Called when connections are freed to reclaim memory
 * This is a lightweight operation that only frees segments where all buffers are free
 */
void buffer_pool_try_shrink(void);

#endif /* ZEROCOPY_H */
