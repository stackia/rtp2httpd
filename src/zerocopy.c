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
#include <linux/errqueue.h>
#include <netinet/in.h>
#include <sys/time.h>

/* MSG_ZEROCOPY support detection */
#ifndef MSG_ZEROCOPY
#define MSG_ZEROCOPY 0x4000000
#endif

#ifndef SO_ZEROCOPY
#define SO_ZEROCOPY 60
#endif

#ifndef SOL_IPV6
#define SOL_IPV6 41
#endif

/* Global zero-copy state */
zerocopy_state_t zerocopy_state = {0};

/**
 * Helper macro to access this worker's statistics in shared memory
 * Falls back to no-op if shared memory not available
 */
#define WORKER_STATS_INC(field)                                            \
    do                                                                     \
    {                                                                      \
        if (status_shared && zerocopy_state.worker_id >= 0 &&              \
            zerocopy_state.worker_id < STATUS_MAX_WORKERS)                 \
        {                                                                  \
            status_shared->worker_stats[zerocopy_state.worker_id].field++; \
        }                                                                  \
    } while (0)

/**
 * Get current time in microseconds
 */
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

/**
 * Create a new buffer pool segment with cache-aligned buffers
 */
static buffer_pool_segment_t *buffer_pool_segment_create(size_t buffer_size, size_t num_buffers, buffer_pool_t *pool)
{
    buffer_pool_segment_t *segment = malloc(sizeof(buffer_pool_segment_t));
    if (!segment)
        return NULL;

    segment->num_buffers = num_buffers;
    segment->num_free = num_buffers;
    segment->create_time_us = get_time_us();
    segment->next = NULL;

    /* Allocate buffer array with cache line alignment for optimal DMA performance
     * posix_memalign ensures each buffer starts at a cache-aligned address,
     * improving both receive (recvfrom) and send (MSG_ZEROCOPY) performance */
    if (posix_memalign((void **)&segment->buffers, BUFFER_POOL_ALIGNMENT, buffer_size * num_buffers) != 0)
    {
        logger(LOG_ERROR, "Buffer pool: Failed to allocate aligned memory for %zu buffers", num_buffers);
        free(segment);
        return NULL;
    }

    /* Allocate reference structures */
    segment->refs = calloc(num_buffers, sizeof(buffer_ref_t));
    if (!segment->refs)
    {
        free(segment->buffers);
        free(segment);
        return NULL;
    }

    /* Initialize buffer references and add to pool's free list */
    for (size_t i = 0; i < num_buffers; i++)
    {
        buffer_ref_t *ref = &segment->refs[i];
        ref->data = segment->buffers + (i * buffer_size);
        ref->size = buffer_size;
        ref->refcount = 0;
        ref->segment = segment; /* Direct reference to owning segment */
        ref->free_next = pool->free_list;
        pool->free_list = ref;
    }

    return segment;
}

/**
 * Initialize buffer pool with dynamic expansion support
 */
static int buffer_pool_init(buffer_pool_t *pool, size_t buffer_size, size_t initial_buffers,
                            size_t max_buffers, size_t expand_size, size_t low_watermark,
                            size_t high_watermark)
{
    memset(pool, 0, sizeof(*pool));

    pool->buffer_size = buffer_size;
    pool->max_buffers = max_buffers;
    pool->expand_size = expand_size;
    pool->low_watermark = low_watermark;
    pool->high_watermark = high_watermark;
    pool->free_list = NULL;
    pool->segments = NULL;
    pool->num_buffers = 0;
    pool->num_free = 0;
    pool->total_expansions = 0;
    pool->total_exhaustions = 0;
    pool->total_shrinks = 0;

    /* Create initial segment */
    buffer_pool_segment_t *initial_segment = buffer_pool_segment_create(buffer_size, initial_buffers, pool);
    if (!initial_segment)
        return -1;

    pool->segments = initial_segment;
    pool->num_buffers = initial_buffers;
    pool->num_free = initial_buffers;

    return 0;
}

/**
 * Expand buffer pool by adding a new segment
 * Returns 0 on success, -1 on failure
 */
static int buffer_pool_expand(buffer_pool_t *pool)
{
    /* Check if we've reached the maximum size */
    if (pool->num_buffers >= pool->max_buffers)
    {
        logger(LOG_WARN, "Buffer pool: Cannot expand beyond maximum size (%zu buffers)", pool->max_buffers);
        return -1;
    }

    /* Calculate how many buffers to add (don't exceed max) */
    size_t buffers_to_add = pool->expand_size;
    if (pool->num_buffers + buffers_to_add > pool->max_buffers)
    {
        buffers_to_add = pool->max_buffers - pool->num_buffers;
    }

    logger(LOG_INFO, "Buffer pool: Expanding by %zu buffers (current: %zu, free: %zu, max: %zu)",
           buffers_to_add, pool->num_buffers, pool->num_free, pool->max_buffers);

    /* Create new segment */
    buffer_pool_segment_t *new_segment = buffer_pool_segment_create(pool->buffer_size, buffers_to_add, pool);
    if (!new_segment)
    {
        logger(LOG_ERROR, "Buffer pool: Failed to allocate new segment");
        return -1;
    }

    /* Add segment to the front of the list */
    new_segment->next = pool->segments;
    pool->segments = new_segment;

    /* Update pool statistics */
    pool->num_buffers += buffers_to_add;
    pool->num_free += buffers_to_add;
    pool->total_expansions++;

    logger(LOG_INFO, "Buffer pool: Expansion successful (total: %zu buffers, free: %zu, expansions: %zu)",
           pool->num_buffers, pool->num_free, pool->total_expansions);

    return 0;
}

/**
 * Cleanup buffer pool and all segments
 */
static void buffer_pool_cleanup(buffer_pool_t *pool)
{
    buffer_pool_segment_t *segment = pool->segments;
    while (segment)
    {
        buffer_pool_segment_t *next = segment->next;
        if (segment->buffers)
            free(segment->buffers);
        if (segment->refs)
            free(segment->refs);
        free(segment);
        segment = next;
    }

    pool->segments = NULL;
    pool->free_list = NULL;
    pool->num_free = 0;
    pool->num_buffers = 0;
}

int zerocopy_init(int worker_id)
{
    if (zerocopy_state.initialized)
        return 0;

    zerocopy_state.features = ZEROCOPY_DISABLED;
    zerocopy_state.worker_id = worker_id;

    /* Initialize per-worker statistics in shared memory */
    if (status_shared && worker_id >= 0 && worker_id < STATUS_MAX_WORKERS)
    {
        memset(&status_shared->worker_stats[worker_id], 0, sizeof(worker_zerocopy_stats_t));
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

    zerocopy_state.initialized = 1;

    return 0;
}

void zerocopy_cleanup(void)
{
    if (!zerocopy_state.initialized)
        return;

    buffer_pool_cleanup(&zerocopy_state.pool);
    zerocopy_state.initialized = 0;
    zerocopy_state.features = ZEROCOPY_DISABLED;
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

int zerocopy_queue_add(zerocopy_queue_t *queue, void *data, size_t len, buffer_ref_t *buf_ref, size_t offset)
{
    if (!data || len == 0 || !buf_ref)
        return 0;

    /* No malloc needed! Use the buffer_ref directly as queue entry */
    /* Setup send queue fields in the buffer */
    buf_ref->iov.iov_base = data;
    buf_ref->iov.iov_len = len;
    buf_ref->buf_offset = offset; /* Store offset for partial buffer sends */
    buf_ref->zerocopy_id = 0;
    buf_ref->send_next = NULL;

    /* Increment reference count - queue now holds a reference */
    buffer_ref_get(buf_ref);

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

    queue->total_bytes += len;
    queue->num_entries++;

    return 0;
}

void buffer_ref_get(buffer_ref_t *ref)
{
    if (ref)
        ref->refcount++;
}

void buffer_ref_put(buffer_ref_t *ref)
{
    if (!ref)
        return;

    ref->refcount--;
    if (ref->refcount <= 0)
    {
        /* All buffers are pool-managed, return to pool */
        buffer_pool_t *pool = &zerocopy_state.pool;

        /* Update segment free count using direct reference */
        if (ref->segment)
        {
            ref->segment->num_free++;
        }

        ref->free_next = pool->free_list;
        pool->free_list = ref;
        pool->num_free++;
    }
}

buffer_ref_t *buffer_pool_alloc(size_t size)
{
    buffer_pool_t *pool = &zerocopy_state.pool;

    if (size > pool->buffer_size)
        return NULL;

    /* Check if pool is exhausted */
    if (!pool->free_list)
    {
        pool->total_exhaustions++;

        /* Try to expand the pool */
        if (buffer_pool_expand(pool) < 0)
        {
            /* Expansion failed - pool is at maximum or allocation failed */
            logger(LOG_WARN, "Buffer pool: Exhausted and cannot expand (total: %zu, max: %zu, exhaustions: %zu)",
                   pool->num_buffers, pool->max_buffers, pool->total_exhaustions);
            return NULL;
        }

        /* After expansion, free_list should have buffers */
        if (!pool->free_list)
        {
            logger(LOG_ERROR, "Buffer pool: Expansion succeeded but free_list is still empty");
            return NULL;
        }
    }
    /* Check if we're running low and should proactively expand */
    else if (pool->num_free <= pool->low_watermark && pool->num_buffers < pool->max_buffers)
    {
        logger(LOG_INFO, "Buffer pool: Low watermark reached (free: %zu, watermark: %zu), expanding proactively",
               pool->num_free, pool->low_watermark);

        /* Try to expand proactively (non-critical if it fails) */
        if (buffer_pool_expand(pool) < 0)
        {
            logger(LOG_WARN, "Buffer pool: Proactive expansion failed, continuing with current buffers");
        }
    }

    /* Pop from free list */
    buffer_ref_t *ref = pool->free_list;
    pool->free_list = ref->free_next;
    pool->num_free--;

    /* Update segment free count using direct reference */
    if (ref->segment)
    {
        ref->segment->num_free--;
    }

    ref->refcount = 1;
    ref->size = size;
    ref->send_next = NULL; /* Clear send_next when allocating */

    return ref;
}

/**
 * Get detailed buffer pool statistics
 * @param total_buffers Output: total number of buffers in pool
 * @param free_buffers Output: number of free buffers
 * @param max_buffers Output: maximum allowed buffers
 * @param expansions Output: number of times pool expanded
 * @param exhaustions Output: number of times pool was exhausted
 */
void buffer_pool_get_stats(size_t *total_buffers, size_t *free_buffers, size_t *max_buffers,
                           size_t *expansions, size_t *exhaustions)
{
    buffer_pool_t *pool = &zerocopy_state.pool;

    if (total_buffers)
        *total_buffers = pool->num_buffers;
    if (free_buffers)
        *free_buffers = pool->num_free;
    if (max_buffers)
        *max_buffers = pool->max_buffers;
    if (expansions)
        *expansions = pool->total_expansions;
    if (exhaustions)
        *exhaustions = pool->total_exhaustions;
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

    /* Build iovec array from queue buffers */
    struct iovec iovecs[ZEROCOPY_MAX_IOVECS];
    buffer_ref_t *buffers[ZEROCOPY_MAX_IOVECS];
    int iov_count = 0;
    size_t total_len = 0;

    buffer_ref_t *buf = queue->head;
    while (buf && iov_count < ZEROCOPY_MAX_IOVECS)
    {
        iovecs[iov_count] = buf->iov;
        buffers[iov_count] = buf;
        total_len += buf->iov.iov_len;
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
        if (errno == EAGAIN || errno == EWOULDBLOCK)
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
     */
    size_t remaining = (size_t)sent;
    while (remaining > 0 && queue->head)
    {
        buffer_ref_t *current = queue->head;

        if (current->iov.iov_len <= remaining)
        {
            /* Entire buffer sent - move to pending queue */
            remaining -= current->iov.iov_len;
            queue->total_bytes -= current->iov.iov_len;
            queue->num_entries--;
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
            current->iov.iov_base = (uint8_t *)current->iov.iov_base + remaining;
            current->iov.iov_len -= remaining;
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

/**
 * Try to shrink buffer pool by freeing completely idle segments
 * This function is called when connections are freed to reclaim memory
 * Strategy: Free oldest segments that are completely idle (all buffers free)
 * Keep at least BUFFER_POOL_INITIAL_SIZE buffers to avoid thrashing
 */
void buffer_pool_try_shrink(void)
{
    buffer_pool_t *pool = &zerocopy_state.pool;

    /* Fast path: Don't shrink if we're not above high watermark or at minimum size */
    if (pool->num_free <= pool->high_watermark || pool->num_buffers <= BUFFER_POOL_INITIAL_SIZE)
    {
        return;
    }

    logger(LOG_DEBUG, "Buffer pool: Checking for shrink opportunity (free: %zu, high_watermark: %zu, total: %zu)",
           pool->num_free, pool->high_watermark, pool->num_buffers);

    /* Find and free completely idle segments (oldest first) */
    buffer_pool_segment_t *prev = NULL;
    buffer_pool_segment_t *seg = pool->segments;
    size_t segments_freed = 0;

    while (seg != NULL)
    {
        buffer_pool_segment_t *next = seg->next;

        /* Check if this segment is completely idle and we can afford to free it */
        if (seg->num_free == seg->num_buffers &&
            pool->num_buffers - seg->num_buffers >= BUFFER_POOL_INITIAL_SIZE)
        {
            /* Remove all buffers from this segment from the free list */
            buffer_ref_t **free_ptr = &pool->free_list;
            size_t removed_count = 0;

            while (*free_ptr != NULL)
            {
                buffer_ref_t *ref = *free_ptr;

                /* Check if this buffer belongs to the segment we're freeing */
                uint8_t *buf_addr = (uint8_t *)ref->data;
                uint8_t *seg_start = seg->buffers;
                uint8_t *seg_end = seg->buffers + (seg->num_buffers * pool->buffer_size);

                if (buf_addr >= seg_start && buf_addr < seg_end)
                {
                    /* Remove from free list */
                    *free_ptr = ref->free_next;
                    removed_count++;
                }
                else
                {
                    /* Move to next entry */
                    free_ptr = &(ref->free_next);
                }
            }

            /* Verify we removed all buffers from this segment */
            if (removed_count != seg->num_buffers)
            {
                logger(LOG_ERROR, "Buffer pool: Shrink inconsistency - expected %zu free buffers, found %zu",
                       seg->num_buffers, removed_count);
            }

            /* Update pool statistics */
            pool->num_buffers -= seg->num_buffers;
            pool->num_free -= removed_count;

            /* Remove segment from list */
            if (prev)
            {
                prev->next = next;
            }
            else
            {
                pool->segments = next;
            }

            /* Free segment memory */
            logger(LOG_DEBUG, "Buffer pool: Freeing idle segment with %zu buffers (age: %.1fs, total: %zu -> %zu)",
                   seg->num_buffers,
                   (get_time_us() - seg->create_time_us) / 1000000.0,
                   pool->num_buffers + seg->num_buffers,
                   pool->num_buffers);

            free(seg->refs);
            free(seg->buffers);
            free(seg);

            segments_freed++;
            pool->total_shrinks++;

            /* Don't update prev since we removed current segment */
            seg = next;

            /* Stop if we've shrunk enough */
            if (pool->num_free <= pool->high_watermark)
            {
                break;
            }
        }
        else
        {
            /* Keep this segment, move to next */
            prev = seg;
            seg = next;
        }
    }

    if (segments_freed > 0)
    {
        logger(LOG_DEBUG, "Buffer pool: Shrink completed - freed %zu segments (total: %zu buffers, free: %zu, shrinks: %zu)",
               segments_freed, pool->num_buffers, pool->num_free, pool->total_shrinks);
    }
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
            if (errno == EAGAIN || errno == EWOULDBLOCK)
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
            if ((cmsg->cmsg_level == SOL_IP || cmsg->cmsg_level == SOL_IPV6) &&
                cmsg->cmsg_type == IP_RECVERR)
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
                        logger(LOG_DEBUG, "Zero-copy: Kernel copied data (fallback) for IDs %u-%u", lo, hi);
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
