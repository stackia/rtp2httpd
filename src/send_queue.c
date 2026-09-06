#include "send_queue.h"
#include "platform_compat.h"
#include "rtp2httpd.h"
#include "status.h"
#include "utils.h"
#include <errno.h>
#include <netinet/in.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

/* Global buffered output state */
send_buffer_state_t send_buffer_state = {0};

/**
 * Helper macro to access this worker's statistics in shared memory
 * Falls back to no-op if shared memory not available
 */
#define WORKER_STATS_INC(field)                                                                                        \
  do {                                                                                                                 \
    if (status_shared && worker_id >= 0 && worker_id < STATUS_MAX_WORKERS) {                                           \
      status_shared->worker_stats[worker_id].field++;                                                                  \
    }                                                                                                                  \
  } while (0)

void send_buffer_register_stream_client(void) { send_buffer_state.active_streams++; }

void send_buffer_unregister_stream_client(void) {
  if (send_buffer_state.active_streams > 0)
    send_buffer_state.active_streams--;
}

size_t send_buffer_active_streams(void) { return send_buffer_state.active_streams; }

int send_buffer_init(void) {
  if (send_buffer_state.initialized)
    return 0;

  /* Initialize per-worker statistics in shared memory */
  if (status_shared && worker_id >= 0 && worker_id < STATUS_MAX_WORKERS) {
    memset(&status_shared->worker_stats[worker_id], 0, sizeof(worker_stats_t));
  }
  if (status_shared && worker_id >= 0 && worker_id < STATUS_MAX_WORKERS) {
    status_shared->worker_stats[worker_id].worker_pid = getpid();
  }

  /* Initialize buffer pool with dynamic expansion support */
  if (buffer_pool_init(&send_buffer_state.pool, BUFFER_POOL_BUFFER_SIZE, BUFFER_POOL_INITIAL_SIZE,
                       config.buffer_pool_max_size, BUFFER_POOL_EXPAND_SIZE, BUFFER_POOL_LOW_WATERMARK,
                       BUFFER_POOL_HIGH_WATERMARK) < 0) {
    logger(LOG_FATAL, "Send queue: Failed to initialize buffer pool");
    return -1;
  }

  /* Initialize control plane pool */
  if (buffer_pool_init(&send_buffer_state.control_pool, BUFFER_POOL_BUFFER_SIZE, CONTROL_POOL_INITIAL_SIZE,
                       CONTROL_POOL_MAX_BUFFERS, CONTROL_POOL_EXPAND_SIZE, CONTROL_POOL_LOW_WATERMARK,
                       CONTROL_POOL_HIGH_WATERMARK) < 0) {
    logger(LOG_FATAL, "Send queue: Failed to initialize control buffer pool");
    buffer_pool_cleanup(&send_buffer_state.pool);
    return -1;
  }

  send_buffer_state.active_streams = 0;

  /* Sync initial buffer pool state to shared memory */
  buffer_pool_update_stats(&send_buffer_state.pool);
  buffer_pool_update_stats(&send_buffer_state.control_pool);

  send_buffer_state.initialized = 1;

  return 0;
}

void send_buffer_cleanup(void) {
  if (!send_buffer_state.initialized)
    return;

  buffer_pool_cleanup(&send_buffer_state.pool);
  buffer_pool_cleanup(&send_buffer_state.control_pool);
  buffer_pool_cleanup(&send_buffer_state.batch_pool);
  buffer_pool_update_stats(&send_buffer_state.pool);
  buffer_pool_update_stats(&send_buffer_state.control_pool);
  send_buffer_state.initialized = 0;
  send_buffer_state.active_streams = 0;
}

void send_queue_init(send_queue_t *queue) { memset(queue, 0, sizeof(*queue)); }

void send_queue_cleanup(send_queue_t *queue) {
  /* Clean up send queue - buffers are now directly in the queue */
  buffer_ref_t *buf = queue->head;
  while (buf) {
    buffer_ref_t *next = buf->send_next;
    buffer_ref_put(buf);
    buf = next;
  }

  send_queue_init(queue);
}

int send_queue_add(send_queue_t *queue, buffer_ref_t *buf_ref) {
  if (!queue || !buf_ref || buf_ref->data_size == 0)
    return 0;

  uint8_t *base = (uint8_t *)buf_ref->data;

  size_t capacity = buffer_ref_capacity(buf_ref);
  if (!base || buf_ref->data_offset > capacity || buf_ref->data_size > capacity - buf_ref->data_offset) {
    logger(LOG_ERROR,
           "send_queue_add: Invalid buffer parameters (offset=%zu len=%zu "
           "size=%zu)",
           buf_ref->data_offset, buf_ref->data_size, capacity);
    return -1;
  }

  uint8_t *data_ptr = base + buf_ref->data_offset;

  /* Setup send queue fields in the buffer */
  buf_ref->type = BUFFER_TYPE_MEMORY;
  buf_ref->iov.iov_base = data_ptr;
  buf_ref->iov.iov_len = buf_ref->data_size;
  buf_ref->send_next = NULL;

  /* Increment reference count - queue now holds a reference */
  buffer_ref_get(buf_ref);

  /* Add to queue */
  if (queue->tail) {
    queue->tail->send_next = buf_ref;
    queue->tail = buf_ref;
  } else {
    /* First queued entry. */
    queue->head = queue->tail = buf_ref;
  }

  queue->total_bytes += buf_ref->data_size;
  queue->memory_bytes += capacity;
  queue->num_queued++;

  return 0;
}

int send_queue_add_file(send_queue_t *queue, int file_fd, off_t file_offset, size_t file_size) {
  if (file_fd < 0 || file_size == 0)
    return -1;

  /* Allocate a buffer_ref_t to represent the file (not from pool) */
  buffer_ref_t *buf_ref = calloc(1, sizeof(buffer_ref_t));
  if (!buf_ref) {
    logger(LOG_ERROR, "send_queue_add_file: Failed to allocate buffer_ref");
    return -1;
  }

  /* Setup file send fields */
  buf_ref->type = BUFFER_TYPE_FILE;
  buf_ref->file_fd = file_fd;
  buf_ref->file_offset = file_offset;
  buf_ref->file_size = file_size;
  buf_ref->file_sent = 0;
  buf_ref->refcount = 1;   /* Initial reference */
  buf_ref->segment = NULL; /* Not from pool */
  buf_ref->send_next = NULL;

  /* Add to queue */
  if (queue->tail) {
    queue->tail->send_next = buf_ref;
    queue->tail = buf_ref;
  } else {
    /* First queued entry. */
    queue->head = queue->tail = buf_ref;
  }

  /* Note: File buffers do NOT count towards total_bytes for batching logic
   * because they are always flushed immediately and don't participate in
   * the batching optimization designed for small RTP packets.
   */
  queue->num_queued++;
  queue->memory_bytes += BUFFER_POOL_BUFFER_SIZE;

  logger(LOG_DEBUG, "send_queue_add_file: Queued file fd=%d offset=%ld size=%zu", file_fd, (long)file_offset,
         file_size);

  return 0;
}

int send_queue_should_flush(send_queue_t *queue) {
  if (!queue || !queue->head)
    return 0; /* Nothing to flush */

  /* Flush if accumulated bytes >= threshold */
  if (queue->total_bytes >= SEND_QUEUE_BATCH_BYTES) {
    WORKER_STATS_INC(batch_sends);
    return 1;
  }

  return 0; /* Not ready to flush yet */
}

/* Payload progress and retained capacity have different lifetimes: a partial
 * send reduces total_bytes, but capacity is released only with the last byte. */
static void send_queue_pop_head(send_queue_t *queue) {
  buffer_ref_t *head = queue->head;
  queue->head = head->send_next;
  if (!queue->head)
    queue->tail = NULL;
  queue->num_queued--;
  queue->memory_bytes -= head->type == BUFFER_TYPE_FILE ? BUFFER_POOL_BUFFER_SIZE : buffer_ref_capacity(head);
  buffer_ref_put(head);
}

static void send_queue_consume_memory(send_queue_t *queue, size_t sent) {
  queue->total_bytes -= sent;
  while (sent) {
    buffer_ref_t *head = queue->head;
    if (sent < head->iov.iov_len) {
      head->iov.iov_base = (uint8_t *)head->iov.iov_base + sent;
      head->iov.iov_len -= sent;
      return;
    }
    sent -= head->iov.iov_len;
    send_queue_pop_head(queue);
  }
}

int send_queue_send(int fd, send_queue_t *queue, size_t max_bytes, size_t *bytes_sent) {
  if (!queue->head || !max_bytes) {
    *bytes_sent = 0;
    return 0;
  }

  buffer_ref_t *shared = queue->head;
  int shared_fd = buffer_ref_sendfile_fd(shared);
  if (shared_fd >= 0) {
    off_t offset = (uint8_t *)shared->iov.iov_base - ((uint8_t *)shared->data + shared->data_offset);
    size_t count = shared->iov.iov_len < max_bytes ? shared->iov.iov_len : max_bytes;
    ssize_t sent = platform_sendfile(fd, shared_fd, &offset, count);
    if (sent < 0 && (errno == EINVAL || errno == ENOSYS || errno == EOPNOTSUPP)) {
      /* Keep this subscriber's fallback private; others can still sendfile. */
      shared->shared_fd = -2;
    } else {
      *bytes_sent = sent > 0 ? (size_t)sent : 0;
      if (sent < 0) {
        if (errno == EAGAIN || errno == EINTR || errno == ENOBUFS) {
          WORKER_STATS_INC(eagain_count);
          return -2;
        }
        return -1;
      }
      if (sent == 0)
        return -1; /* The immutable snapshot must contain the complete batch. */
      WORKER_STATS_INC(total_sends);
      send_queue_consume_memory(queue, (size_t)sent);
      return 0;
    }
  }

  /* Check if head is a file - sendfile() must be done separately */
  if (queue->head->type == BUFFER_TYPE_FILE) {
    buffer_ref_t *file_buf = queue->head;
    size_t remaining = file_buf->file_size - file_buf->file_sent;
    if (remaining > max_bytes)
      remaining = max_bytes;
    off_t offset = file_buf->file_offset + file_buf->file_sent;

    /* Use platform_sendfile() for non-blocking file send */
    ssize_t sent = platform_sendfile(fd, file_buf->file_fd, &offset, remaining);

    if (sent < 0) {
      if (errno == EAGAIN) {
        WORKER_STATS_INC(eagain_count);
        *bytes_sent = 0;
        return -2; /* Would block */
      }

      logger(LOG_ERROR, "Send queue: sendfile failed: %s", strerror(errno));
      *bytes_sent = 0;
      return -1;
    }

    *bytes_sent = (size_t)sent;
    file_buf->file_sent += sent;

    /* Check if file send is complete */
    if (file_buf->file_sent >= file_buf->file_size) {
      /* File completely sent - remove from queue and cleanup */
      size_t total_file_size = file_buf->file_size; /* Save before put */

      /* File buffers don't count towards total_bytes. */
      send_queue_pop_head(queue);

      logger(LOG_DEBUG, "Send queue: sendfile complete (%zu bytes)", total_file_size);
    }
    /* Note: Partial sends for files don't update total_bytes (files don't
     * count) */

    /* Update statistics */
    WORKER_STATS_INC(total_sends);

    return 0;
  }

  /* Build iovec array from queue buffers (memory buffers only) */
  struct iovec iovecs[SEND_QUEUE_MAX_IOVECS];
  int iov_count = 0;
  size_t remaining_budget = max_bytes;

  buffer_ref_t *buf = queue->head;
  while (buf && remaining_budget && iov_count < SEND_QUEUE_MAX_IOVECS && buf->type == BUFFER_TYPE_MEMORY &&
         buffer_ref_sendfile_fd(buf) < 0) {
    iovecs[iov_count] = buf->iov;
    if (iovecs[iov_count].iov_len > remaining_budget)
      iovecs[iov_count].iov_len = remaining_budget;
    remaining_budget -= iovecs[iov_count].iov_len;
    iov_count++;
    buf = buf->send_next;
  }

  if (iov_count == 0) {
    *bytes_sent = 0;
    return 0;
  }

  /* Prepare message header */
  struct msghdr msg;
  memset(&msg, 0, sizeof(msg));
  msg.msg_iov = iovecs;
  msg.msg_iovlen = iov_count;

  /* Send data */
  ssize_t sent = sendmsg(fd, &msg, MSG_DONTWAIT | MSG_NOSIGNAL);

  if (sent < 0) {
    if (errno == EAGAIN) {
      WORKER_STATS_INC(eagain_count);
      *bytes_sent = 0;
      return -2; /* Would block */
    }

    /* ENOBUFS: Socket send buffer is full - treat as temporary condition
     * This happens when:
     * - SO_SNDBUF limit reached
     * - Network is congested or receiver is slow
     *
     * This is NOT a fatal error - we should back off and retry later
     */
    if (errno == ENOBUFS) {
      WORKER_STATS_INC(enobufs_count);
      *bytes_sent = 0;
      return -2; /* Treat as would-block - caller should retry later */
    }

    logger(LOG_DEBUG, "Send queue: sendmsg failed: %s", strerror(errno));
    *bytes_sent = 0;
    return -1;
  }

  /* Update statistics */
  WORKER_STATS_INC(total_sends);

  *bytes_sent = (size_t)sent;

  send_queue_consume_memory(queue, (size_t)sent);

  return 0;
}
