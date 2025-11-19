#ifndef BUFFER_POOL_H
#define BUFFER_POOL_H

#include <netinet/in.h>
#include <stdint.h>
#include <sys/types.h>

/* Buffer pool configuration - optimized for RTP packets with cache alignment */
#define BUFFER_POOL_ALIGNMENT 64
#define BUFFER_POOL_INITIAL_SIZE 1024
#define BUFFER_POOL_EXPAND_SIZE 512
#define BUFFER_POOL_BUFFER_SIZE 1536
#define BUFFER_POOL_LOW_WATERMARK 256
#define BUFFER_POOL_HIGH_WATERMARK (BUFFER_POOL_INITIAL_SIZE * 3)

/* Control/API buffer pool configuration */
#define CONTROL_POOL_INITIAL_SIZE 256
#define CONTROL_POOL_EXPAND_SIZE 128
#define CONTROL_POOL_MAX_BUFFERS 4096
#define CONTROL_POOL_LOW_WATERMARK 64
#define CONTROL_POOL_HIGH_WATERMARK (CONTROL_POOL_INITIAL_SIZE * 2)

typedef enum {
  BUFFER_TYPE_MEMORY = 0, /* Normal memory buffer from pool */
  BUFFER_TYPE_FILE = 1    /* File descriptor for sendfile() */
} buffer_type_t;

/**
 * Buffer reference counting for zero-copy lifecycle management
 * Supports both memory buffers (pool-managed) and file descriptors (for
 * sendfile)
 *
 * This structure serves dual purpose:
 * 1. When buffer is free: linked via free_next in pool's free list
 * 2. When buffer is in use: can be queued for sending via send_next
 *
 * The send queue fields (iov, zerocopy_id) are only valid
 * when the buffer is in a send queue or pending completion queue.
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
  int refcount; /* Reference count */
  struct buffer_pool_segment_s
      *segment; /* Segment this buffer belongs to (BUFFER_TYPE_MEMORY) */

  /* Union: buffer is either in free list OR in send queue, never both */
  union {
    struct buffer_ref_s *free_next; /* For free list linkage */
    struct buffer_ref_s *send_next; /* For send/pending queue linkage */
  };

  union {
    struct iovec
        iov; /* Data pointer and length for sendmsg() (BUFFER_TYPE_MEMORY) */
    size_t file_sent; /* Bytes already sent from this file (BUFFER_TYPE_FILE) */
  };
  union {
    size_t data_offset; /* Offset in buffer where data starts (for partial
                           sends, BUFFER_TYPE_MEMORY only) */
    off_t file_offset;  /* Current offset in file */
  };
  uint32_t zerocopy_id; /* ID for tracking MSG_ZEROCOPY completions */
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

int buffer_pool_init(buffer_pool_t *pool, size_t buffer_size,
                     size_t initial_buffers, size_t max_buffers,
                     size_t expand_size, size_t low_watermark,
                     size_t high_watermark);
void buffer_pool_cleanup(buffer_pool_t *pool);
void buffer_pool_update_stats(buffer_pool_t *pool);
void buffer_ref_get(buffer_ref_t *ref);
void buffer_ref_put(buffer_ref_t *ref);
buffer_ref_t *buffer_pool_alloc_from(buffer_pool_t *pool);
buffer_ref_t *buffer_pool_alloc(void);
buffer_ref_t *buffer_pool_alloc_control(void);
void buffer_pool_try_shrink(void);

#endif /* BUFFER_POOL_H */
