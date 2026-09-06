#ifndef __SEND_QUEUE_H__
#define __SEND_QUEUE_H__

#include "buffer_pool.h"
#include <sys/types.h>

#define SEND_QUEUE_MAX_IOVECS 64
#define SEND_QUEUE_BATCH_BYTES 65536

/* Each connection owns its queue links and partial-send offsets. Buffer data
 * can be shared through reference-counted views. */
typedef struct send_queue_s {
  buffer_ref_t *head;
  buffer_ref_t *tail;
  size_t total_bytes;  /* Unsent payload bytes; file entries are excluded */
  size_t memory_bytes; /* Full backing capacity retained by queued entries */
  size_t num_queued;
} send_queue_t;

/* Buffer pools belong to the worker, so queued batches can outlive a source. */
typedef struct send_buffer_state_s {
  buffer_pool_t pool;
  buffer_pool_t control_pool;
  buffer_pool_t batch_pool;
  size_t active_streams;
  int initialized;
} send_buffer_state_t;

extern send_buffer_state_t send_buffer_state;

int send_buffer_init(void);
void send_buffer_cleanup(void);
void send_buffer_register_stream_client(void);
void send_buffer_unregister_stream_client(void);
size_t send_buffer_active_streams(void);

void send_queue_init(send_queue_t *queue);
void send_queue_cleanup(send_queue_t *queue);
/* The queue acquires a reference; the caller retains its own reference. */
int send_queue_add(send_queue_t *queue, buffer_ref_t *buf_ref);
/* Transfers ownership of file_fd only on success. */
int send_queue_add_file(send_queue_t *queue, int file_fd, off_t file_offset, size_t file_size);
/* Send at most max_bytes. Return 0 on success, -1 on fatal error, or -2 when blocked. */
int send_queue_send(int fd, send_queue_t *queue, size_t max_bytes, size_t *bytes_sent);
int send_queue_should_flush(send_queue_t *queue);

#endif /* __SEND_QUEUE_H__ */
