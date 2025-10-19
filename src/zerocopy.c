#ifdef HAVE_CONFIG_H
#include "config.h"
#endif

#include "zerocopy.h"
#include "rtp2httpd.h"
#include "status.h"
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <unistd.h>
#include <sys/socket.h>
#include <sys/sendfile.h>
#include <linux/errqueue.h>
#include <netinet/in.h>
#include <sys/time.h>

/* Global zero-copy state */
zerocopy_state_t zerocopy_state = {0};

/**
 * Helper macro to access this worker's statistics in shared memory
 * Falls back to no-op if shared memory not available
 */
#define WORKER_STATS_INC(field)                             \
    do                                                      \
    {                                                       \
        if (status_shared && worker_id >= 0 &&              \
            worker_id < STATUS_MAX_WORKERS)                 \
        {                                                   \
            status_shared->worker_stats[worker_id].field++; \
        }                                                   \
    } while (0)

static uint64_t get_time_us(void)
{
    struct timeval tv;
    gettimeofday(&tv, NULL);
    return (uint64_t)tv.tv_sec * 1000000ULL + (uint64_t)tv.tv_usec;
}

/**
 * Detect MSG_ZEROCOPY support by attempting to enable it on a test socket
 */
static int detect_msg_zerocopy_support(void)
{
    int sock = socket(AF_INET, SOCK_STREAM, 0);
    if (sock < 0)
        return 0;

    int one = 1;
    int ret = setsockopt(sock, SOL_SOCKET, SO_ZEROCOPY, &one, sizeof(one));
    close(sock);

    return (ret == 0) ? 1 : 0;
}

void zerocopy_register_stream_client(void)
{
    zerocopy_state.active_streams++;
}

void zerocopy_unregister_stream_client(void)
{
    if (zerocopy_state.active_streams > 0)
        zerocopy_state.active_streams--;
}

size_t zerocopy_active_streams(void)
{
    return zerocopy_state.active_streams;
}

int zerocopy_init(void)
{
    if (zerocopy_state.initialized)
        return 0;

    zerocopy_state.features = ZEROCOPY_DISABLED;

    /* Initialize per-worker statistics in shared memory */
    if (status_shared && worker_id >= 0 && worker_id < STATUS_MAX_WORKERS)
    {
        memset(&status_shared->worker_stats[worker_id], 0, sizeof(worker_stats_t));
    }
    if (status_shared && worker_id >= 0 && worker_id < STATUS_MAX_WORKERS)
    {
        status_shared->worker_stats[worker_id].worker_pid = getpid();
    }

    /* MSG_ZEROCOPY is mandatory - detect support */
    if (!detect_msg_zerocopy_support())
    {
        logger(LOG_FATAL, "Zero-copy: MSG_ZEROCOPY not available (kernel 4.14+ required)");
        logger(LOG_FATAL, "Zero-copy: This feature is mandatory for rtp2httpd operation");
        return -1;
    }

    /* Enable both sendmsg() scatter-gather and MSG_ZEROCOPY */
    zerocopy_state.features = ZEROCOPY_SENDMSG | ZEROCOPY_MSG_ZEROCOPY;

    /* Initialize buffer pool with dynamic expansion support */
    if (buffer_pool_init(&zerocopy_state.pool,
                         BUFFER_POOL_BUFFER_SIZE,
                         BUFFER_POOL_INITIAL_SIZE,
                         config.buffer_pool_max_size,
                         BUFFER_POOL_EXPAND_SIZE,
                         BUFFER_POOL_LOW_WATERMARK,
                         BUFFER_POOL_HIGH_WATERMARK) < 0)
    {
        logger(LOG_FATAL, "Zero-copy: Failed to initialize buffer pool");
        return -1;
    }

    /* Initialize control plane pool */
    if (buffer_pool_init(&zerocopy_state.control_pool,
                         BUFFER_POOL_BUFFER_SIZE,
                         CONTROL_POOL_INITIAL_SIZE,
                         CONTROL_POOL_MAX_BUFFERS,
                         CONTROL_POOL_EXPAND_SIZE,
                         CONTROL_POOL_LOW_WATERMARK,
                         CONTROL_POOL_HIGH_WATERMARK) < 0)
    {
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

void zerocopy_cleanup(void)
{
    if (!zerocopy_state.initialized)
        return;

    buffer_pool_cleanup(&zerocopy_state.pool);
    buffer_pool_cleanup(&zerocopy_state.control_pool);
    buffer_pool_update_stats(&zerocopy_state.pool);
    buffer_pool_update_stats(&zerocopy_state.control_pool);
    zerocopy_state.initialized = 0;
    zerocopy_state.features = ZEROCOPY_DISABLED;
    zerocopy_state.active_streams = 0;
}

void zerocopy_queue_init(zerocopy_queue_t *queue)
{
    memset(queue, 0, sizeof(*queue));
}

void zerocopy_queue_cleanup(zerocopy_queue_t *queue)
{
    /* Clean up send queue - buffers are now directly in the queue */
    buffer_ref_t *buf = queue->head;
    while (buf)
    {
        buffer_ref_t *next = buf->send_next;
        buffer_ref_put(buf);
        buf = next;
    }

    /* Clean up pending completion queue */
    buf = queue->pending_head;
    while (buf)
    {
        buffer_ref_t *next = buf->send_next;
        buffer_ref_put(buf);
        buf = next;
    }

    zerocopy_queue_init(queue);
}

int zerocopy_queue_add(zerocopy_queue_t *queue, buffer_ref_t *buf_ref_list)
{
    if (!queue || !buf_ref_list)
        return 0;

    buffer_ref_t *current = buf_ref_list;
    buffer_ref_t *list_tail = NULL;
    size_t total_bytes_added = 0;
    size_t num_buffers_added = 0;

    /* Process each buffer in the linked list */
    while (current)
    {
        uint8_t *base = (uint8_t *)current->data;
        size_t offset = (size_t)current->data_offset;
        size_t len = current->data_len;
        size_t buffer_size = current->segment->parent->buffer_size;

        if (!base || offset > buffer_size || len > buffer_size - offset)
        {
            logger(LOG_ERROR, "zerocopy_queue_add: Invalid buffer parameters (offset=%zu len=%zu size=%zu)",
                   offset, len, buffer_size);
            return -1;
        }

        uint8_t *data_ptr = base + offset;

        /* Setup send queue fields in the buffer */
        current->sendmsg_info.iov.iov_base = data_ptr;
        current->sendmsg_info.iov.iov_len = len;
        current->zerocopy_id = 0;

        /* Increment reference count - queue now holds a reference */
        buffer_ref_get(current);

        total_bytes_added += len;
        num_buffers_added++;
        list_tail = current;

        /* Note: send_next and process_next are union, so we don't need to modify the linkage */
        current = current->send_next;
    }

    /* Add the entire list to queue */
    if (queue->tail)
    {
        /* Connect existing queue tail to new list head */
        queue->tail->send_next = buf_ref_list;
        queue->tail = list_tail;
    }
    else
    {
        /* First entry - record timestamp for batching timeout */
        queue->head = buf_ref_list;
        queue->tail = list_tail;
        queue->first_queued_time_us = get_time_us();
    }

    queue->total_bytes += total_bytes_added;
    queue->num_queued += num_buffers_added;

    return 0;
}

int zerocopy_queue_add_file(zerocopy_queue_t *queue, int file_fd, off_t file_offset, size_t file_size)
{
    if (file_fd < 0 || file_size == 0)
        return -1;

    /* Allocate a buffer_ref_t to represent the file (not from pool) */
    buffer_ref_t *buf_ref = calloc(1, sizeof(buffer_ref_t));
    if (!buf_ref)
    {
        logger(LOG_ERROR, "zerocopy_queue_add_file: Failed to allocate buffer_ref");
        return -1;
    }

    /* Setup file send fields */
    buf_ref->type = BUFFER_TYPE_FILE;
    buf_ref->fd = file_fd;
    buf_ref->data_offset = file_offset;
    buf_ref->data_len = file_size;
    buf_ref->sendfile_info.sent = 0;
    buf_ref->refcount = 1;   /* Initial reference */
    buf_ref->segment = NULL; /* Not from pool */
    buf_ref->zerocopy_id = 0;
    buf_ref->send_next = NULL;

    /* Add to queue */
    if (queue->tail)
    {
        queue->tail->send_next = buf_ref;
        queue->tail = buf_ref;
    }
    else
    {
        /* First entry - record timestamp for batching timeout */
        queue->head = queue->tail = buf_ref;
        queue->first_queued_time_us = get_time_us();
    }

    /* Note: File buffers do NOT count towards total_bytes for batching logic
     * because they are always flushed immediately and don't participate in
     * the batching optimization designed for small RTP packets.
     */
    queue->num_queued++;

    logger(LOG_DEBUG, "zerocopy_queue_add_file: Queued file fd=%d offset=%ld size=%zu",
           file_fd, (long)file_offset, file_size);

    return 0;
}

int zerocopy_should_flush(zerocopy_queue_t *queue)
{
    if (!queue || !queue->head)
        return 0; /* Nothing to flush */

    /* Flush if accumulated bytes >= threshold */
    if (queue->total_bytes >= ZEROCOPY_BATCH_BYTES)
    {
        WORKER_STATS_INC(batch_sends);
        return 1;
    }

    /* Flush if timeout expired since first queued entry */
    uint64_t now_us = get_time_us();
    uint64_t elapsed_us = now_us - queue->first_queued_time_us;
    if (elapsed_us >= ZEROCOPY_BATCH_TIMEOUT_US)
    {
        WORKER_STATS_INC(timeout_flushes);
        return 1;
    }

    return 0; /* Not ready to flush yet */
}

int zerocopy_send(int fd, zerocopy_queue_t *queue, size_t *bytes_sent)
{
    if (!queue->head)
    {
        *bytes_sent = 0;
        return 0;
    }

    /* Check if head is a file - sendfile() must be done separately */
    if (queue->head->type == BUFFER_TYPE_FILE)
    {
        buffer_ref_t *file_buf = queue->head;
        size_t remaining = file_buf->data_len - file_buf->sendfile_info.sent;
        off_t offset = file_buf->data_offset + file_buf->sendfile_info.sent;

        /* Use sendfile() for non-blocking file send */
        ssize_t sent = sendfile(fd, file_buf->fd, &offset, remaining);

        if (sent < 0)
        {
            if (errno == EAGAIN)
            {
                WORKER_STATS_INC(eagain_count);
                *bytes_sent = 0;
                return -2; /* Would block */
            }

            logger(LOG_ERROR, "Zero-copy: sendfile failed: %s", strerror(errno));
            *bytes_sent = 0;
            return -1;
        }

        *bytes_sent = (size_t)sent;
        file_buf->sendfile_info.sent += sent;

        /* Check if file send is complete */
        if (file_buf->sendfile_info.sent >= file_buf->data_len)
        {
            /* File completely sent - remove from queue and cleanup */
            size_t total_file_size = file_buf->data_len; /* Save before put */

            queue->head = file_buf->send_next;
            if (!queue->head)
                queue->tail = NULL;

            /* Note: File buffers don't count towards total_bytes, so no need to update it */
            queue->num_queued--;

            /* Release reference - this will close fd and free buffer_ref */
            buffer_ref_put(file_buf);

            logger(LOG_DEBUG, "Zero-copy: sendfile complete (%zu bytes)", total_file_size);
        }
        /* Note: Partial sends for files don't update total_bytes (files don't count) */

        /* Update statistics */
        WORKER_STATS_INC(total_sends);

        return 0;
    }

    /* Build iovec array from queue buffers (memory buffers only) */
    struct iovec iovecs[ZEROCOPY_MAX_IOVECS];
    buffer_ref_t *buffers[ZEROCOPY_MAX_IOVECS];
    int iov_count = 0;
    size_t total_len = 0;

    buffer_ref_t *buf = queue->head;
    while (buf && iov_count < ZEROCOPY_MAX_IOVECS && buf->type == BUFFER_TYPE_MEMORY)
    {
        iovecs[iov_count] = buf->sendmsg_info.iov;
        buffers[iov_count] = buf;
        total_len += buf->sendmsg_info.iov.iov_len;
        iov_count++;
        buf = buf->send_next;
    }

    if (iov_count == 0)
    {
        *bytes_sent = 0;
        return 0;
    }

    /* Prepare message header */
    struct msghdr msg;
    memset(&msg, 0, sizeof(msg));
    msg.msg_iov = iovecs;
    msg.msg_iovlen = iov_count;

    /* Determine flags - MSG_ZEROCOPY is always used (mandatory) */
    int flags = MSG_DONTWAIT | MSG_NOSIGNAL | MSG_ZEROCOPY;

    /* Send data */
    ssize_t sent = sendmsg(fd, &msg, flags);

    if (sent < 0)
    {
        if (errno == EAGAIN)
        {
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
        if (errno == ENOBUFS)
        {
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

    /* Assign zerocopy ID for this sendmsg call AFTER successful send
     * All iovecs in this call share the same ID for completion tracking
     * IMPORTANT: Only increment the ID counter after sendmsg() succeeds,
     * because the kernel only assigns an ID to successful sends.
     */
    uint32_t zerocopy_id = queue->next_zerocopy_id++;
    for (int i = 0; i < iov_count; i++)
    {
        buffers[i]->zerocopy_id = zerocopy_id;
    }

    /* Move sent buffers from send queue to pending completion queue
     * Note: With MSG_ZEROCOPY, the kernel tracks what was actually sent,
     * and the completion notification will arrive for the sent data only.
     * IMPORTANT: Only process BUFFER_TYPE_MEMORY buffers here, stop at file buffers.
     */
    size_t remaining = (size_t)sent;
    while (remaining > 0 && queue->head)
    {
        buffer_ref_t *current = queue->head;

        /* Stop if we hit a file buffer - we only sent memory buffers */
        if (current->type != BUFFER_TYPE_MEMORY)
            break;

        if (current->sendmsg_info.iov.iov_len <= remaining)
        {
            /* Entire buffer sent - move to pending queue */
            remaining -= current->sendmsg_info.iov.iov_len;
            queue->total_bytes -= current->sendmsg_info.iov.iov_len;
            queue->num_queued--;
            queue->head = current->send_next;

            if (!queue->head)
                queue->tail = NULL;

            /* Add to pending completion queue */
            current->send_next = NULL;
            if (queue->pending_tail)
            {
                queue->pending_tail->send_next = current;
                queue->pending_tail = current;
            }
            else
            {
                queue->pending_head = queue->pending_tail = current;
            }
            queue->num_pending++;

            /* Note: Buffer will be freed when MSG_ZEROCOPY completion arrives */
        }
        else
        {
            /* Partial send within a buffer - this is tricky with MSG_ZEROCOPY
             * The kernel will send a completion for what was sent, but we need to
             * track the unsent portion separately. We'll reset the zerocopy_id to 0
             * so it gets a new ID on the next send attempt.
             */
            current->sendmsg_info.iov.iov_base = (uint8_t *)current->sendmsg_info.iov.iov_base + remaining;
            current->sendmsg_info.iov.iov_len -= remaining;
            current->zerocopy_id = 0; /* Reset ID for next send */
            queue->total_bytes -= remaining;
            remaining = 0;
        }
    }

    /* If queue still has data, update timestamp for next batch */
    if (queue->head)
    {
        queue->first_queued_time_us = get_time_us();
    }

    return 0;
}

int zerocopy_handle_completions(int fd, zerocopy_queue_t *queue)
{
    if (!(zerocopy_state.features & ZEROCOPY_MSG_ZEROCOPY))
        return 0;

    int completions = 0;

    /* Read completion notifications from error queue */
    while (1)
    {
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
        if (ret < 0)
        {
            if (errno == EAGAIN)
                break; /* No more completions */
            if (errno == EINTR)
                continue;
            return -1;
        }

        /* Parse control messages */
        struct cmsghdr *cmsg;
        for (cmsg = CMSG_FIRSTHDR(&msg); cmsg; cmsg = CMSG_NXTHDR(&msg, cmsg))
        {
            /* Check for both IPv4 and IPv6 error messages */
            if ((cmsg->cmsg_level == SOL_IP && cmsg->cmsg_type == IP_RECVERR) ||
                (cmsg->cmsg_level == SOL_IPV6 && cmsg->cmsg_type == IPV6_RECVERR))
            {
                struct sock_extended_err *serr = (struct sock_extended_err *)CMSG_DATA(cmsg);

                if (serr->ee_origin == SO_EE_ORIGIN_ZEROCOPY)
                {
                    uint32_t lo = serr->ee_info;
                    uint32_t hi = serr->ee_data;

                    /* Update statistics */
                    WORKER_STATS_INC(total_completions);

                    /* Check if data was copied (fallback) instead of zero-copy */
                    if (serr->ee_code & SO_EE_CODE_ZEROCOPY_COPIED)
                    {
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

                    while (buf)
                    {
                        buffer_ref_t *next = buf->send_next;

                        /* Check if this buffer's zerocopy_id is in the completed range */
                        /* Handle wraparound: if lo <= hi, check [lo, hi]; otherwise check [lo, MAX] or [0, hi] */
                        int completed = 0;
                        if (lo <= hi)
                        {
                            completed = (buf->zerocopy_id >= lo && buf->zerocopy_id <= hi);
                        }
                        else
                        {
                            /* Wraparound case */
                            completed = (buf->zerocopy_id >= lo || buf->zerocopy_id <= hi);
                        }

                        if (completed)
                        {
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
                        }
                        else
                        {
                            unmatched++;
                            prev = buf;
                            buf = next;
                        }
                    }

                    /* Log if we didn't find any matching buffers - this indicates a bug */
                    if (matched == 0)
                    {
                        logger(LOG_ERROR, "Zero-copy: Completion for IDs %u-%u but no matching buffers in pending queue (unmatched: %d, pending: %zu)",
                               lo, hi, unmatched, queue->num_pending);
                    }
                }
            }
        }
    }

    return completions;
}
