#ifndef BUFFER_POOL_H
#define BUFFER_POOL_H

#include <netinet/in.h>
#include <stdint.h>
#include <sys/types.h>
#include <sys/uio.h>

/* Buffer pool configuration - optimized for RTP packets with cache alignment */
#define BUFFER_POOL_ALIGNMENT 64
#define BUFFER_POOL_INITIAL_SIZE 128
#define BUFFER_POOL_EXPAND_SIZE 128
#define BUFFER_POOL_BUFFER_SIZE 1536
#define BUFFER_POOL_LOW_WATERMARK 32
#define BUFFER_POOL_HIGH_WATERMARK (BUFFER_POOL_INITIAL_SIZE * 3)
/* Keep shared output below 64 KiB, including the last complete RTP payload. */
#define BUFFER_POOL_BATCH_SIZE 65536

/* Control/API buffer pool configuration */
#define CONTROL_POOL_INITIAL_SIZE 16
#define CONTROL_POOL_EXPAND_SIZE 16
#define CONTROL_POOL_MAX_BUFFERS 4096
#define CONTROL_POOL_LOW_WATERMARK 4
#define CONTROL_POOL_HIGH_WATERMARK (CONTROL_POOL_INITIAL_SIZE * 2)

typedef enum {
  BUFFER_TYPE_MEMORY = 0, /* Normal memory buffer from pool */
  BUFFER_TYPE_FILE = 1    /* File descriptor for sendfile() */
} buffer_type_t;

/**
 * Reference-counted storage for queued output
 * Supports both memory buffers (pool-managed) and file descriptors (for
 * sendfile)
 *
 * This structure serves dual purpose:
 * 1. When buffer is free: linked via free_next in pool's free list
 * 2. When buffer is in use: can be queued for sending via send_next
 *
 * The send queue field (iov) is only valid
 * when the buffer is in a send queue.
 */
typedef struct buffer_ref_s {
  buffer_type_t type; /* Buffer type: memory or file */
  union {
    void *data;  /* Pointer to buffer data (BUFFER_TYPE_MEMORY) */
    int file_fd; /* File descriptor for sendfile() (BUFFER_TYPE_FILE) */
  };
  union {
    size_t data_size; /* Size of buffer data (BUFFER_TYPE_MEMORY) */
    size_t file_size; /* Total size to send from file (BUFFER_TYPE_FILE) */
  };
  int refcount;                          /* Reference count */
  struct buffer_pool_segment_s *segment; /* Segment this buffer belongs to (BUFFER_TYPE_MEMORY) */
  struct buffer_ref_s *owner;            /* Non-NULL for a view sharing another buffer's immutable data */
  int shared_fd;                         /* Immutable batch snapshot, -1 if absent; views use their owner */

  /* Union: buffer is either in free list OR in send queue, never both */
  union {
    struct buffer_ref_s *free_next; /* For free list linkage */
    struct buffer_ref_s *send_next; /* For send queue linkage */
  };

  union {
    struct iovec iov; /* Data pointer and length for sendmsg() (BUFFER_TYPE_MEMORY) */
    size_t file_sent; /* Bytes already sent from this file (BUFFER_TYPE_FILE) */
  };
  union {
    size_t data_offset; /* Offset in buffer where data starts (for partial
                           sends, BUFFER_TYPE_MEMORY only) */
    off_t file_offset;  /* Current offset in file */
  };
} buffer_ref_t;

/**
 * Buffer pool segment for dynamic expansion
 */
typedef struct buffer_pool_segment_s {
  uint8_t *buffers;
  buffer_ref_t *refs;
  size_t num_buffers;
  size_t num_free;
  uint64_t create_time_us;
  struct buffer_pool_s *parent;
  struct buffer_pool_segment_s *next;
} buffer_pool_segment_t;

/**
 * Buffer pool for efficient buffer allocation with dynamic expansion
 */
typedef struct buffer_pool_s {
  buffer_pool_segment_t *segments;
  buffer_ref_t *free_list;
  size_t buffer_size;
  size_t num_buffers;
  size_t num_free;
  size_t max_buffers;
  size_t expand_size;
  size_t low_watermark;
  size_t high_watermark;
} buffer_pool_t;

int buffer_pool_init(buffer_pool_t *pool, size_t buffer_size, size_t initial_buffers, size_t max_buffers,
                     size_t expand_size, size_t low_watermark, size_t high_watermark);
void buffer_pool_cleanup(buffer_pool_t *pool);
void buffer_pool_update_stats(buffer_pool_t *pool);
void buffer_ref_get(buffer_ref_t *ref);
void buffer_ref_put(buffer_ref_t *ref);
/* Share data while keeping offsets and send links independent.
 * The returned view owns a reference to the backing buffer; release with put. */
buffer_ref_t *buffer_ref_view(buffer_ref_t *ref);
size_t buffer_ref_capacity(const buffer_ref_t *ref);
void buffer_ref_snapshot(buffer_ref_t *ref);
int buffer_ref_sendfile_fd(const buffer_ref_t *ref);
/* Worker-owned pool: queued batches can outlive their multicast source. */
buffer_ref_t *buffer_pool_alloc_batch(void);
buffer_ref_t *buffer_pool_alloc_from(buffer_pool_t *pool);
buffer_ref_t *buffer_pool_alloc(void);
buffer_ref_t *buffer_pool_alloc_control(void);
void buffer_pool_try_shrink(void);

#endif /* BUFFER_POOL_H */
