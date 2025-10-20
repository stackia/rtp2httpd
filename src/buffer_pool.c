#ifdef HAVE_CONFIG_H
#include "config.h"
#endif

#include "buffer_pool.h"
#include "zerocopy.h"
#include "rtp2httpd.h"
#include "status.h"
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <unistd.h>
#include <sys/time.h>
#include <sys/socket.h>
#include <netinet/in.h>

#define WORKER_STATS_INC(field)                             \
    do                                                      \
    {                                                       \
        if (status_shared && worker_id >= 0 &&              \
            worker_id < STATUS_MAX_WORKERS)                 \
        {                                                   \
            status_shared->worker_stats[worker_id].field++; \
        }                                                   \
    } while (0)

static uint64_t buffer_pool_time_us(void)
{
    struct timeval tv;
    gettimeofday(&tv, NULL);
    return (uint64_t)tv.tv_sec * 1000000ULL + (uint64_t)tv.tv_usec;
}

void buffer_pool_update_stats(buffer_pool_t *pool)
{
    if (!status_shared || worker_id < 0 || worker_id >= STATUS_MAX_WORKERS)
        return;

    worker_stats_t *stats = &status_shared->worker_stats[worker_id];

    if (pool == &zerocopy_state.pool)
    {
        stats->pool_total_buffers = pool->num_buffers;
        stats->pool_free_buffers = pool->num_free;
        stats->pool_max_buffers = pool->max_buffers;
    }
    else if (pool == &zerocopy_state.control_pool)
    {
        stats->control_pool_total_buffers = pool->num_buffers;
        stats->control_pool_free_buffers = pool->num_free;
        stats->control_pool_max_buffers = pool->max_buffers;
    }
}

static buffer_pool_segment_t *buffer_pool_segment_create(size_t buffer_size, size_t num_buffers, buffer_pool_t *pool)
{
    buffer_pool_segment_t *segment = malloc(sizeof(buffer_pool_segment_t));
    if (!segment)
        return NULL;

    segment->num_buffers = num_buffers;
    segment->num_free = num_buffers;
    segment->create_time_us = buffer_pool_time_us();
    segment->parent = pool;
    segment->next = NULL;

    if (posix_memalign((void **)&segment->buffers, BUFFER_POOL_ALIGNMENT, buffer_size * num_buffers) != 0)
    {
        logger(LOG_ERROR, "Buffer pool: Failed to allocate aligned memory for %zu buffers", num_buffers);
        free(segment);
        return NULL;
    }

    segment->refs = calloc(num_buffers, sizeof(buffer_ref_t));
    if (!segment->refs)
    {
        free(segment->buffers);
        free(segment);
        return NULL;
    }

    for (size_t i = 0; i < num_buffers; i++)
    {
        buffer_ref_t *ref = &segment->refs[i];
        ref->data = segment->buffers + (i * buffer_size);
        ref->segment = segment;
        ref->type = BUFFER_TYPE_MEMORY;
        ref->free_next = pool->free_list;
        pool->free_list = ref;
    }

    return segment;
}

int buffer_pool_init(buffer_pool_t *pool, size_t buffer_size, size_t initial_buffers,
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

    buffer_pool_segment_t *initial_segment = buffer_pool_segment_create(buffer_size, initial_buffers, pool);
    if (!initial_segment)
        return -1;

    pool->segments = initial_segment;
    pool->num_buffers = initial_buffers;
    pool->num_free = initial_buffers;

    buffer_pool_update_stats(pool);
    return 0;
}

static inline const char *buffer_pool_name(buffer_pool_t *pool)
{
    return (pool == &zerocopy_state.pool) ? "Buffer pool" : "Control pool";
}

static int buffer_pool_expand(buffer_pool_t *pool)
{
    if (pool->num_buffers >= pool->max_buffers)
    {
        logger(LOG_DEBUG, "%s: Cannot expand beyond maximum size (%zu buffers)",
               buffer_pool_name(pool), pool->max_buffers);
        return -1;
    }

    size_t buffers_to_add = pool->expand_size;
    if (pool->num_buffers + buffers_to_add > pool->max_buffers)
    {
        buffers_to_add = pool->max_buffers - pool->num_buffers;
    }

    logger(LOG_DEBUG, "%s: Expanding by %zu buffers (current: %zu, free: %zu, max: %zu)",
           buffer_pool_name(pool), buffers_to_add, pool->num_buffers, pool->num_free, pool->max_buffers);

    buffer_pool_segment_t *new_segment = buffer_pool_segment_create(pool->buffer_size, buffers_to_add, pool);
    if (!new_segment)
    {
        logger(LOG_ERROR, "%s: Failed to allocate new segment", buffer_pool_name(pool));
        return -1;
    }

    new_segment->next = pool->segments;
    pool->segments = new_segment;
    pool->num_buffers += buffers_to_add;
    pool->num_free += buffers_to_add;

    if (pool == &zerocopy_state.pool)
    {
        WORKER_STATS_INC(pool_expansions);
    }
    else if (pool == &zerocopy_state.control_pool)
    {
        WORKER_STATS_INC(control_pool_expansions);
    }

    buffer_pool_update_stats(pool);

    logger(LOG_DEBUG, "%s: Expansion successful (total: %zu buffers, free: %zu)",
           buffer_pool_name(pool), pool->num_buffers, pool->num_free);

    return 0;
}

void buffer_pool_cleanup(buffer_pool_t *pool)
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

    buffer_pool_update_stats(pool);
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
        if (ref->type == BUFFER_TYPE_FILE)
        {
            if (ref->fd >= 0)
            {
                close(ref->fd);
            }
            free(ref);
            return;
        }

        buffer_pool_t *pool = ref->segment ? ref->segment->parent : &zerocopy_state.pool;

        if (ref->segment)
        {
            ref->segment->num_free++;
        }

        ref->free_next = pool->free_list;
        pool->free_list = ref;
        pool->num_free++;

        buffer_pool_update_stats(pool);
    }
}

/**
 * Allocate one or more buffers from the pool (with partial allocation support)
 *
 * @param pool The buffer pool to allocate from
 * @param num_buffers Desired number of buffers to allocate
 * @param allocated [out] Optional pointer to receive actual number of buffers allocated
 * @return Head of linked list of allocated buffers (linked via process_next/send_next/free_next union)
 *         Returns NULL if no buffers available at all
 *
 * Note: This function supports partial allocation. If fewer than num_buffers are available,
 *       it will allocate as many as possible (minimum 1). Check *allocated for actual count.
 *       Buffers are pre-linked together using the union field.
 */
buffer_ref_t *buffer_pool_alloc_from(buffer_pool_t *pool, size_t num_buffers, size_t *allocated)
{
    if (!pool || num_buffers == 0)
    {
        if (allocated)
            *allocated = 0;
        return NULL;
    }

    /* Try to expand if we don't have enough buffers */
    if (pool->num_free < num_buffers)
    {
        if (pool->num_free == 0)
        {
            /* No buffers at all - must expand */
            if (pool == &zerocopy_state.pool)
            {
                WORKER_STATS_INC(pool_exhaustions);
            }
            else if (pool == &zerocopy_state.control_pool)
            {
                WORKER_STATS_INC(control_pool_exhaustions);
            }

            if (buffer_pool_expand(pool) < 0)
            {
                logger(LOG_DEBUG, "%s: Cannot allocate any buffers (pool exhausted, max: %zu)",
                       buffer_pool_name(pool), pool->max_buffers);
                if (allocated)
                    *allocated = 0;
                return NULL;
            }

            /* After expansion, we should have at least some buffers */
            if (pool->num_free == 0)
            {
                logger(LOG_ERROR, "%s: Expansion succeeded but still no free buffers",
                       buffer_pool_name(pool));
                if (allocated)
                    *allocated = 0;
                return NULL;
            }
        }

        /* We have some buffers but not enough - try to expand to meet demand */
        size_t needed = num_buffers - pool->num_free;
        size_t expansions_needed = (needed + pool->expand_size - 1) / pool->expand_size;

        for (size_t i = 0; i < expansions_needed && pool->num_free < num_buffers; i++)
        {
            if (buffer_pool_expand(pool) < 0)
            {
                /* Expansion failed, but we can still use what we have */
                logger(LOG_DEBUG, "%s: Partial allocation - requested %zu, have %zu",
                       buffer_pool_name(pool), num_buffers, pool->num_free);
                break;
            }
        }
    }
    else if (pool->num_free <= pool->low_watermark && pool->num_buffers < pool->max_buffers)
    {
        logger(LOG_DEBUG, "%s: Low watermark reached (free: %zu, watermark: %zu), expanding proactively",
               buffer_pool_name(pool), pool->num_free, pool->low_watermark);

        if (buffer_pool_expand(pool) < 0)
        {
            logger(LOG_DEBUG, "%s: Proactive expansion failed, continuing with current buffers",
                   buffer_pool_name(pool));
        }
    }

    /* Allocate as many buffers as available (up to num_buffers) */
    size_t to_allocate = (pool->num_free < num_buffers) ? pool->num_free : num_buffers;

    if (to_allocate == 0)
    {
        if (allocated)
            *allocated = 0;
        return NULL;
    }

    /* Allocate buffers by taking the first to_allocate from free_list
     * Since free_next and process_next are union, the list is already linked! */
    buffer_ref_t *head = pool->free_list;
    buffer_ref_t *tail = head;

    /* Traverse to find the tail and initialize each buffer */
    for (size_t i = 0; i < to_allocate; i++)
    {
        /* Initialize buffer */
        tail->data_offset = 0;
        tail->data_len = 0;
        tail->refcount = 1;

        if (tail->segment)
        {
            tail->segment->num_free--;
        }

        /* Move to next, but remember current tail for cutting */
        if (i < to_allocate - 1)
        {
            tail = tail->process_next; /* Using union: free_next == process_next */
        }
    }

    /* Cut the list: update pool's free_list to point after our allocated chunk */
    pool->free_list = tail->process_next; /* The rest of free list */
    tail->process_next = NULL;            /* Terminate our allocated list */

    pool->num_free -= to_allocate;

    buffer_pool_update_stats(pool);

    if (allocated)
        *allocated = to_allocate;

    return head;
}

buffer_ref_t *buffer_pool_alloc(void)
{
    return buffer_pool_alloc_from(&zerocopy_state.pool, 1, NULL);
}

static void buffer_pool_try_shrink_pool(buffer_pool_t *pool, size_t min_buffers)
{
    if (pool->num_free <= pool->high_watermark || pool->num_buffers <= min_buffers)
    {
        return;
    }

    logger(LOG_DEBUG, "%s: Checking for shrink opportunity (free: %zu, high_watermark: %zu, total: %zu)",
           buffer_pool_name(pool), pool->num_free, pool->high_watermark, pool->num_buffers);

    buffer_pool_segment_t *prev = NULL;
    buffer_pool_segment_t *seg = pool->segments;
    size_t segments_freed = 0;

    while (seg != NULL)
    {
        buffer_pool_segment_t *next = seg->next;

        if (seg->num_free == seg->num_buffers &&
            pool->num_buffers - seg->num_buffers >= min_buffers)
        {
            buffer_ref_t **free_ptr = &pool->free_list;
            size_t removed_count = 0;

            while (*free_ptr != NULL)
            {
                buffer_ref_t *ref = *free_ptr;
                uint8_t *buf_addr = (uint8_t *)ref->data;
                uint8_t *seg_start = seg->buffers;
                uint8_t *seg_end = seg->buffers + (seg->num_buffers * pool->buffer_size);

                if (buf_addr >= seg_start && buf_addr < seg_end)
                {
                    *free_ptr = ref->free_next;
                    removed_count++;
                }
                else
                {
                    free_ptr = &(ref->free_next);
                }
            }

            if (removed_count != seg->num_buffers)
            {
                logger(LOG_ERROR, "%s: Shrink inconsistency - expected %zu free buffers, found %zu",
                       buffer_pool_name(pool), seg->num_buffers, removed_count);
            }

            pool->num_buffers -= seg->num_buffers;
            pool->num_free -= removed_count;

            if (prev)
            {
                prev->next = next;
            }
            else
            {
                pool->segments = next;
            }

            logger(LOG_DEBUG, "%s: Freeing idle segment with %zu buffers (age: %.1fs, total: %zu -> %zu)",
                   buffer_pool_name(pool),
                   seg->num_buffers,
                   (buffer_pool_time_us() - seg->create_time_us) / 1000000.0,
                   pool->num_buffers + seg->num_buffers,
                   pool->num_buffers);

            free(seg->refs);
            free(seg->buffers);
            free(seg);

            segments_freed++;

            if (pool == &zerocopy_state.pool)
            {
                WORKER_STATS_INC(pool_shrinks);
            }
            else if (pool == &zerocopy_state.control_pool)
            {
                WORKER_STATS_INC(control_pool_shrinks);
            }

            seg = next;

            if (pool->num_free <= pool->high_watermark)
            {
                break;
            }
        }
        else
        {
            prev = seg;
            seg = next;
        }
    }

    if (segments_freed > 0)
    {
        logger(LOG_DEBUG, "%s: Shrink completed - freed %zu segments (total: %zu buffers, free: %zu)",
               buffer_pool_name(pool), segments_freed, pool->num_buffers, pool->num_free);

        buffer_pool_update_stats(pool);
    }
}

void buffer_pool_try_shrink(void)
{
    buffer_pool_try_shrink_pool(&zerocopy_state.pool, BUFFER_POOL_INITIAL_SIZE);
    buffer_pool_try_shrink_pool(&zerocopy_state.control_pool, CONTROL_POOL_INITIAL_SIZE);
}

/*
 * Batch receive packets from a socket into a linked list
 * Uses recvmmsg() to receive multiple packets in a single system call
 */
buffer_ref_t *buffer_pool_batch_recv(int sock, int save_peer_info, const char *drain_label,
                                     int *packets_received, int *packets_dropped)
{
    int dropped = 0;

    /* Pre-allocate buffers - supports partial allocation if pool is low */
    size_t buf_count = 0;
    buffer_ref_t *bufs_head = buffer_pool_alloc_from(&zerocopy_state.pool,
                                                     MAX_RECV_PACKETS_PER_BATCH,
                                                     &buf_count);

    if (!bufs_head || buf_count == 0)
    {
        /* No buffers available - drain socket to avoid blocking sender */
        logger(LOG_DEBUG, "%s: No buffers available, draining socket", drain_label);
        uint8_t dummy[BUFFER_POOL_BUFFER_SIZE];
        while (1)
        {
            ssize_t drained = recv(sock, dummy, sizeof(dummy), MSG_DONTWAIT);
            if (drained < 0)
                break;
            dropped++;
        }

        if (packets_received)
            *packets_received = 0;
        if (packets_dropped)
            *packets_dropped = dropped;
        return NULL;
    }

    /* Build array of buffer pointers from linked list for recvmmsg */
    buffer_ref_t *bufs[MAX_RECV_PACKETS_PER_BATCH];
    struct mmsghdr msgs[MAX_RECV_PACKETS_PER_BATCH];
    struct iovec iovecs[MAX_RECV_PACKETS_PER_BATCH];

    memset(msgs, 0, sizeof(msgs));

    /* Convert linked list to array and setup mmsghdr structures */
    buffer_ref_t *cur = bufs_head;

    for (size_t i = 0; i < buf_count && cur; i++)
    {
        bufs[i] = cur;

        /* Setup iovec */
        iovecs[i].iov_base = cur->data;
        iovecs[i].iov_len = cur->segment->parent->buffer_size;

        /* Setup mmsghdr */
        msgs[i].msg_hdr.msg_iov = &iovecs[i];
        msgs[i].msg_hdr.msg_iovlen = 1;

        if (save_peer_info)
        {
            /* Direct write to buffer's recv_info - no memcpy needed later */
            msgs[i].msg_hdr.msg_name = &cur->recv_info.peer_addr;
            msgs[i].msg_hdr.msg_namelen = sizeof(struct sockaddr_in);
        }

        cur = cur->process_next;
    }

    /* Receive multiple messages in ONE system call */
    struct timespec timeout = {0, 0}; /* Non-blocking */
    int received = recvmmsg(sock, msgs, buf_count, MSG_DONTWAIT, &timeout);
    buffer_ref_t *result = NULL;

    if (received < 0)
    {
        if (errno != EAGAIN)
        {
            logger(LOG_DEBUG, "%s: recvmmsg failed: %s", drain_label, strerror(errno));
        }
        received = 0; /* Treat error as 0 packets received */
    }
    else if (received > 0)
    {
        /* Update data length for received packets */
        for (int i = 0; i < received; i++)
        {
            bufs[i]->data_len = msgs[i].msg_len;
        }
        result = bufs_head;
    }

    /* Free unused buffers (allocated but not received) */
    if ((size_t)received < buf_count)
    {
        if (received > 0)
        {
            bufs[received - 1]->process_next = NULL; /* Terminate received list */
        }

        buffer_ref_t *unused = (received > 0) ? bufs[received] : bufs_head;
        while (unused)
        {
            buffer_ref_t *next = unused->process_next;
            buffer_ref_put(unused);
            unused = next;
        }
    }

    /* Write output parameters once at the end */
    if (packets_received)
        *packets_received = received;
    if (packets_dropped)
        *packets_dropped = dropped;

    return result;
}
