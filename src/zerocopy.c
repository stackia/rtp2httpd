#include "zerocopy.h"
#include "rtp2httpd.h"
#include "status.h"
#include "utils.h"
#include <errno.h>
#include <linux/errqueue.h>
#include <netinet/in.h>
#include <stdlib.h>
#include <string.h>
#include <sys/sendfile.h>
#include <sys/socket.h>
#include <unistd.h>

/* Global zero-copy state */
zerocopy_state_t zerocopy_state = {0};

/**
 * Helper macro to access this worker's statistics in shared memory
 * Falls back to no-op if shared memory not available
 */
#define WORKER_STATS_INC(field)                                                \
  do {                                                                         \
    if (status_shared && worker_id >= 0 && worker_id < STATUS_MAX_WORKERS) {   \
      status_shared->worker_stats[worker_id].field++;                          \
    }                                                                          \
  } while (0)

/**
 * Detect MSG_ZEROCOPY support by attempting to enable it on a test socket
 */
static int detect_msg_zerocopy_support(void) {
  int sock = socket(AF_INET, SOCK_STREAM, 0);
  if (sock < 0)
    return 0;

  int one = 1;
  int ret = setsockopt(sock, SOL_SOCKET, SO_ZEROCOPY, &one, sizeof(one));
  close(sock);

  return (ret == 0) ? 1 : 0;
}

void zerocopy_register_stream_client(void) { zerocopy_state.active_streams++; }

void zerocopy_unregister_stream_client(void) {
  if (zerocopy_state.active_streams > 0)
    zerocopy_state.active_streams--;
}

size_t zerocopy_active_streams(void) { return zerocopy_state.active_streams; }

int zerocopy_init(void) {
  if (zerocopy_state.initialized)
    return 0;

  /* Initialize per-worker statistics in shared memory */
  if (status_shared && worker_id >= 0 && worker_id < STATUS_MAX_WORKERS) {
    memset(&status_shared->worker_stats[worker_id], 0, sizeof(worker_stats_t));
  }
  if (status_shared && worker_id >= 0 && worker_id < STATUS_MAX_WORKERS) {
    status_shared->worker_stats[worker_id].worker_pid = getpid();
  }

  /* Check if zerocopy is explicitly enabled by configuration */
  if (config.zerocopy_on_send) {
    /* Try to detect MSG_ZEROCOPY support */
    if (!detect_msg_zerocopy_support()) {
      logger(LOG_WARN,
             "Zero-copy: MSG_ZEROCOPY not available (kernel 4.14+ required)");
      logger(LOG_WARN, "Zero-copy: Falling back to regular send");
      /* Disable zerocopy in config since it's not supported */
      config.zerocopy_on_send = 0;
    } else {
      logger(LOG_INFO,
             "Zero-copy: MSG_ZEROCOPY enabled for better performance");
    }
  } else {
    /* Default: Use regular send for maximum compatibility */
    logger(LOG_INFO,
           "Zero-copy: Using regular send (default). Enable zerocopy-on-send "
           "for better performance on supported devices.");
  }

  /* Initialize buffer pool with dynamic expansion support */
  if (buffer_pool_init(&zerocopy_state.pool, BUFFER_POOL_BUFFER_SIZE,
                       BUFFER_POOL_INITIAL_SIZE, config.buffer_pool_max_size,
                       BUFFER_POOL_EXPAND_SIZE, BUFFER_POOL_LOW_WATERMARK,
                       BUFFER_POOL_HIGH_WATERMARK) < 0) {
    logger(LOG_FATAL, "Zero-copy: Failed to initialize buffer pool");
    return -1;
  }

  /* Initialize control plane pool */
  if (buffer_pool_init(&zerocopy_state.control_pool, BUFFER_POOL_BUFFER_SIZE,
                       CONTROL_POOL_INITIAL_SIZE, CONTROL_POOL_MAX_BUFFERS,
                       CONTROL_POOL_EXPAND_SIZE, CONTROL_POOL_LOW_WATERMARK,
                       CONTROL_POOL_HIGH_WATERMARK) < 0) {
    logger(LOG_FATAL, "Zero-copy: Failed to initialize control buffer pool");
    buffer_pool_cleanup(&zerocopy_state.pool);
    return -1;
  }

  zerocopy_state.active_streams = 0;

  /* Sync initial buffer pool state to shared memory */
  buffer_pool_update_stats(&zerocopy_state.pool);
  buffer_pool_update_stats(&zerocopy_state.control_pool);

  zerocopy_state.initialized = 1;

  return 0;
}

void zerocopy_cleanup(void) {
  if (!zerocopy_state.initialized)
    return;

  buffer_pool_cleanup(&zerocopy_state.pool);
  buffer_pool_cleanup(&zerocopy_state.control_pool);
  buffer_pool_update_stats(&zerocopy_state.pool);
  buffer_pool_update_stats(&zerocopy_state.control_pool);
  zerocopy_state.initialized = 0;
  zerocopy_state.active_streams = 0;
}

void zerocopy_queue_init(zerocopy_queue_t *queue) {
  memset(queue, 0, sizeof(*queue));
}

void zerocopy_queue_cleanup(zerocopy_queue_t *queue) {
  /* Clean up send queue - buffers are now directly in the queue */
  buffer_ref_t *buf = queue->head;
  while (buf) {
    buffer_ref_t *next = buf->send_next;
    buffer_ref_put(buf);
    buf = next;
  }

  /* Clean up pending completion queue */
  buf = queue->pending_head;
  while (buf) {
    buffer_ref_t *next = buf->send_next;
    buffer_ref_put(buf);
    buf = next;
  }

  zerocopy_queue_init(queue);
}

int zerocopy_queue_add(zerocopy_queue_t *queue, buffer_ref_t *buf_ref) {
  if (!queue || !buf_ref || buf_ref->data_size == 0)
    return 0;

  uint8_t *base = (uint8_t *)buf_ref->data;

  if (!base || buf_ref->data_offset > BUFFER_POOL_BUFFER_SIZE ||
      buf_ref->data_size > BUFFER_POOL_BUFFER_SIZE - buf_ref->data_offset) {
    logger(LOG_ERROR,
           "zerocopy_queue_add: Invalid buffer parameters (offset=%zu len=%zu "
           "size=%d)",
           buf_ref->data_offset, buf_ref->data_size, BUFFER_POOL_BUFFER_SIZE);
    return -1;
  }

  uint8_t *data_ptr = base + buf_ref->data_offset;

  /* Setup send queue fields in the buffer */
  buf_ref->type = BUFFER_TYPE_MEMORY;
  buf_ref->iov.iov_base = data_ptr;
  buf_ref->iov.iov_len = buf_ref->data_size;
  buf_ref->zerocopy_id = 0;
  buf_ref->send_next = NULL;

  /* Increment reference count - queue now holds a reference */
  buffer_ref_get(buf_ref);

  /* Add to queue */
  if (queue->tail) {
    queue->tail->send_next = buf_ref;
    queue->tail = buf_ref;
  } else {
    /* First entry - record timestamp for batching timeout */
    queue->head = queue->tail = buf_ref;
  }

  queue->total_bytes += buf_ref->data_size;
  queue->num_queued++;

  return 0;
}

int zerocopy_queue_add_file(zerocopy_queue_t *queue, int file_fd,
                            off_t file_offset, size_t file_size) {
  if (file_fd < 0 || file_size == 0)
    return -1;

  /* Allocate a buffer_ref_t to represent the file (not from pool) */
  buffer_ref_t *buf_ref = calloc(1, sizeof(buffer_ref_t));
  if (!buf_ref) {
    logger(LOG_ERROR, "zerocopy_queue_add_file: Failed to allocate buffer_ref");
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
  buf_ref->zerocopy_id = 0;
  buf_ref->send_next = NULL;

  /* Add to queue */
  if (queue->tail) {
    queue->tail->send_next = buf_ref;
    queue->tail = buf_ref;
  } else {
    /* First entry - record timestamp for batching timeout */
    queue->head = queue->tail = buf_ref;
  }

  /* Note: File buffers do NOT count towards total_bytes for batching logic
   * because they are always flushed immediately and don't participate in
   * the batching optimization designed for small RTP packets.
   */
  queue->num_queued++;

  logger(LOG_DEBUG,
         "zerocopy_queue_add_file: Queued file fd=%d offset=%ld size=%zu",
         file_fd, (long)file_offset, file_size);

  return 0;
}

int zerocopy_should_flush(zerocopy_queue_t *queue) {
  if (!queue || !queue->head)
    return 0; /* Nothing to flush */

  /* Flush if accumulated bytes >= threshold */
  if (queue->total_bytes >= ZEROCOPY_BATCH_BYTES) {
    WORKER_STATS_INC(batch_sends);
    return 1;
  }

  return 0; /* Not ready to flush yet */
}

int zerocopy_send(int fd, zerocopy_queue_t *queue, size_t *bytes_sent) {
  if (!queue->head) {
    *bytes_sent = 0;
    return 0;
  }

  /* Check if head is a file - sendfile() must be done separately */
  if (queue->head->type == BUFFER_TYPE_FILE) {
    buffer_ref_t *file_buf = queue->head;
    size_t remaining = file_buf->file_size - file_buf->file_sent;
    off_t offset = file_buf->file_offset + file_buf->file_sent;

    /* Use sendfile() for non-blocking file send */
    ssize_t sent = sendfile(fd, file_buf->file_fd, &offset, remaining);

    if (sent < 0) {
      if (errno == EAGAIN) {
        WORKER_STATS_INC(eagain_count);
        *bytes_sent = 0;
        return -2; /* Would block */
      }

      logger(LOG_ERROR, "Zero-copy: sendfile failed: %s", strerror(errno));
      *bytes_sent = 0;
      return -1;
    }

    *bytes_sent = (size_t)sent;
    file_buf->file_sent += sent;

    /* Check if file send is complete */
    if (file_buf->file_sent >= file_buf->file_size) {
      /* File completely sent - remove from queue and cleanup */
      size_t total_file_size = file_buf->file_size; /* Save before put */

      queue->head = file_buf->send_next;
      if (!queue->head)
        queue->tail = NULL;

      /* Note: File buffers don't count towards total_bytes, so no need to
       * update it */
      queue->num_queued--;

      /* Release reference - this will close fd and free buffer_ref */
      buffer_ref_put(file_buf);

      logger(LOG_DEBUG, "Zero-copy: sendfile complete (%zu bytes)",
             total_file_size);
    }
    /* Note: Partial sends for files don't update total_bytes (files don't
     * count) */

    /* Update statistics */
    WORKER_STATS_INC(total_sends);

    return 0;
  }

  /* Build iovec array from queue buffers (memory buffers only) */
  struct iovec iovecs[ZEROCOPY_MAX_IOVECS];
  buffer_ref_t *buffers[ZEROCOPY_MAX_IOVECS];
  int iov_count = 0;

  buffer_ref_t *buf = queue->head;
  while (buf && iov_count < ZEROCOPY_MAX_IOVECS &&
         buf->type == BUFFER_TYPE_MEMORY) {
    iovecs[iov_count] = buf->iov;
    buffers[iov_count] = buf;
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

  /* Determine flags based on zerocopy configuration */
  int flags = MSG_DONTWAIT | MSG_NOSIGNAL;
  if (config.zerocopy_on_send) {
    flags |= MSG_ZEROCOPY;
  }

  /* Send data */
  ssize_t sent = sendmsg(fd, &msg, flags);

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
     * - Too many pending MSG_ZEROCOPY operations
     *
     * This is NOT a fatal error - we should back off and retry later
     */
    if (errno == ENOBUFS) {
      WORKER_STATS_INC(enobufs_count);
      *bytes_sent = 0;
      return -2; /* Treat as would-block - caller should retry later */
    }

    logger(LOG_DEBUG, "Zero-copy: sendmsg failed: %s", strerror(errno));
    *bytes_sent = 0;
    return -1;
  }

  /* Update statistics */
  WORKER_STATS_INC(total_sends);

  *bytes_sent = (size_t)sent;

  /* Handle buffer management based on whether MSG_ZEROCOPY is used */
  if (config.zerocopy_on_send) {
    /* Assign zerocopy ID for this sendmsg call AFTER successful send
     * All iovecs in this call share the same ID for completion tracking
     * IMPORTANT: Only increment the ID counter after sendmsg() succeeds,
     * because the kernel only assigns an ID to successful sends.
     */
    uint32_t zerocopy_id = queue->next_zerocopy_id++;
    for (int i = 0; i < iov_count; i++) {
      buffers[i]->zerocopy_id = zerocopy_id;
    }

    /* Move sent buffers from send queue to pending completion queue
     * Note: With MSG_ZEROCOPY, the kernel tracks what was actually sent,
     * and the completion notification will arrive for the sent data only.
     * IMPORTANT: Only process BUFFER_TYPE_MEMORY buffers here, stop at file
     * buffers.
     */
    size_t remaining = (size_t)sent;
    while (remaining > 0 && queue->head) {
      buffer_ref_t *current = queue->head;

      /* Stop if we hit a file buffer - we only sent memory buffers */
      if (current->type != BUFFER_TYPE_MEMORY)
        break;

      if (current->iov.iov_len <= remaining) {
        /* Entire buffer sent - move to pending queue */
        remaining -= current->iov.iov_len;
        queue->total_bytes -= current->iov.iov_len;
        queue->num_queued--;
        queue->head = current->send_next;

        if (!queue->head)
          queue->tail = NULL;

        /* Add to pending completion queue */
        current->send_next = NULL;
        if (queue->pending_tail) {
          queue->pending_tail->send_next = current;
          queue->pending_tail = current;
        } else {
          queue->pending_head = queue->pending_tail = current;
        }
        queue->num_pending++;

        /* Note: Buffer will be freed when MSG_ZEROCOPY completion arrives */
      } else {
        /* Partial send within a buffer - this is tricky with MSG_ZEROCOPY
         * The kernel will send a completion for what was sent, but we need to
         * track the unsent portion separately. We'll reset the zerocopy_id to 0
         * so it gets a new ID on the next send attempt.
         */
        current->iov.iov_base = (uint8_t *)current->iov.iov_base + remaining;
        current->iov.iov_len -= remaining;
        current->zerocopy_id = 0; /* Reset ID for next send */
        queue->total_bytes -= remaining;
        remaining = 0;
      }
    }
  } else {
    /* Regular send without MSG_ZEROCOPY - free buffers immediately */
    size_t remaining = (size_t)sent;
    while (remaining > 0 && queue->head) {
      buffer_ref_t *current = queue->head;

      /* Stop if we hit a file buffer - we only sent memory buffers */
      if (current->type != BUFFER_TYPE_MEMORY)
        break;

      if (current->iov.iov_len <= remaining) {
        /* Entire buffer sent - remove from queue and free immediately */
        remaining -= current->iov.iov_len;
        queue->total_bytes -= current->iov.iov_len;
        queue->num_queued--;
        queue->head = current->send_next;

        if (!queue->head)
          queue->tail = NULL;

        /* Free buffer immediately since kernel has copied the data */
        buffer_ref_put(current);
      } else {
        /* Partial send within a buffer - update the iovec to point to remaining
         * data */
        current->iov.iov_base = (uint8_t *)current->iov.iov_base + remaining;
        current->iov.iov_len -= remaining;
        queue->total_bytes -= remaining;
        remaining = 0;
      }
    }
  }

  return 0;
}

int zerocopy_handle_completions(int fd, zerocopy_queue_t *queue) {
  if (!config.zerocopy_on_send)
    return 0;

  int completions = 0;

  /* Read completion notifications from error queue */
  while (1) {
    uint8_t control_buf[128];
    struct msghdr msg;
    struct iovec iov;
    uint8_t dummy;

    memset(&msg, 0, sizeof(msg));
    iov.iov_base = &dummy;
    iov.iov_len = 1;
    msg.msg_iov = &iov;
    msg.msg_iovlen = 1;
    msg.msg_control = control_buf;
    msg.msg_controllen = sizeof(control_buf);

    ssize_t ret = recvmsg(fd, &msg, MSG_ERRQUEUE | MSG_DONTWAIT);
    if (ret < 0) {
      if (errno == EAGAIN)
        break; /* No more completions */
      if (errno == EINTR)
        continue;
      return -1;
    }

    /* Parse control messages */
    struct cmsghdr *cmsg;
    for (cmsg = CMSG_FIRSTHDR(&msg); cmsg; cmsg = CMSG_NXTHDR(&msg, cmsg)) {
      /* Check for both IPv4 and IPv6 error messages */
      if ((cmsg->cmsg_level == SOL_IP && cmsg->cmsg_type == IP_RECVERR) ||
          (cmsg->cmsg_level == SOL_IPV6 && cmsg->cmsg_type == IPV6_RECVERR)) {
        struct sock_extended_err *serr =
            (struct sock_extended_err *)CMSG_DATA(cmsg);

        if (serr->ee_origin == SO_EE_ORIGIN_ZEROCOPY) {
          uint32_t lo = serr->ee_info;
          uint32_t hi = serr->ee_data;

          /* Update statistics */
          WORKER_STATS_INC(total_completions);

          /* Check if data was copied (fallback) instead of zero-copy */
          if (serr->ee_code & SO_EE_CODE_ZEROCOPY_COPIED) {
            WORKER_STATS_INC(total_copied);
          }

          /* Update last completed ID */
          queue->last_completed_id = hi;

          /* Free buffers for completed entries */
          /* Note: lo and hi are the range of zerocopy_id that completed */
          buffer_ref_t *buf = queue->pending_head;
          buffer_ref_t *prev = NULL;
          int matched = 0;
          int unmatched = 0;

          while (buf) {
            buffer_ref_t *next = buf->send_next;

            /* Check if this buffer's zerocopy_id is in the completed range */
            /* Handle wraparound: if lo <= hi, check [lo, hi]; otherwise check
             * [lo, MAX] or [0, hi] */
            int completed = 0;
            if (lo <= hi) {
              completed = (buf->zerocopy_id >= lo && buf->zerocopy_id <= hi);
            } else {
              /* Wraparound case */
              completed = (buf->zerocopy_id >= lo || buf->zerocopy_id <= hi);
            }

            if (completed) {
              /* Remove from pending queue */
              if (prev)
                prev->send_next = next;
              else
                queue->pending_head = next;

              if (buf == queue->pending_tail)
                queue->pending_tail = prev;

              queue->num_pending--;
              completions++;
              matched++;

              /* Release buffer reference - kernel is done with the data */
              buffer_ref_put(buf);

              buf = next;
            } else {
              unmatched++;
              prev = buf;
              buf = next;
            }
          }

          /* Log if we didn't find any matching buffers - this indicates a bug
           */
          if (matched == 0) {
            logger(LOG_ERROR,
                   "Zero-copy: Completion for IDs %u-%u but no matching "
                   "buffers in pending queue (unmatched: %d, pending: %zu)",
                   lo, hi, unmatched, queue->num_pending);
          }
        }
      }
    }
  }

  return completions;
}
