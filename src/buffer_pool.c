#include "buffer_pool.h"
#include "rtp2httpd.h"
#include "status.h"
#include "utils.h"
#include "zerocopy.h"
#include <stdlib.h>
#include <string.h>
#include <sys/time.h>
#include <unistd.h>

#define WORKER_STATS_INC(field)                                                \
  do {                                                                         \
    if (status_shared && worker_id >= 0 && worker_id < STATUS_MAX_WORKERS) {   \
      status_shared->worker_stats[worker_id].field++;                          \
    }                                                                          \
  } while (0)

static uint64_t buffer_pool_time_us(void) {
  struct timeval tv;
  gettimeofday(&tv, NULL);
  return (uint64_t)tv.tv_sec * 1000000ULL + (uint64_t)tv.tv_usec;
}

void buffer_pool_update_stats(buffer_pool_t *pool) {
  if (!status_shared || worker_id < 0 || worker_id >= STATUS_MAX_WORKERS)
    return;

  worker_stats_t *stats = &status_shared->worker_stats[worker_id];

  if (pool == &zerocopy_state.pool) {
    stats->pool_total_buffers = pool->num_buffers;
    stats->pool_free_buffers = pool->num_free;
    stats->pool_max_buffers = pool->max_buffers;
  } else if (pool == &zerocopy_state.control_pool) {
    stats->control_pool_total_buffers = pool->num_buffers;
    stats->control_pool_free_buffers = pool->num_free;
    stats->control_pool_max_buffers = pool->max_buffers;
  }
}

static buffer_pool_segment_t *buffer_pool_segment_create(size_t buffer_size,
                                                         size_t num_buffers,
                                                         buffer_pool_t *pool) {
  buffer_pool_segment_t *segment = malloc(sizeof(buffer_pool_segment_t));
  if (!segment)
    return NULL;

  segment->num_buffers = num_buffers;
  segment->num_free = num_buffers;
  segment->create_time_us = buffer_pool_time_us();
  segment->parent = pool;
  segment->next = NULL;

  if (posix_memalign((void **)&segment->buffers, BUFFER_POOL_ALIGNMENT,
                     buffer_size * num_buffers) != 0) {
    logger(LOG_ERROR,
           "Buffer pool: Failed to allocate aligned memory for %zu buffers",
           num_buffers);
    free(segment);
    return NULL;
  }

  segment->refs = calloc(num_buffers, sizeof(buffer_ref_t));
  if (!segment->refs) {
    free(segment->buffers);
    free(segment);
    return NULL;
  }

  for (size_t i = 0; i < num_buffers; i++) {
    buffer_ref_t *ref = &segment->refs[i];
    ref->data = segment->buffers + (i * buffer_size);
    ref->refcount = 0;
    ref->segment = segment;
    ref->free_next = pool->free_list;
    pool->free_list = ref;
  }

  return segment;
}

int buffer_pool_init(buffer_pool_t *pool, size_t buffer_size,
                     size_t initial_buffers, size_t max_buffers,
                     size_t expand_size, size_t low_watermark,
                     size_t high_watermark) {
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

  buffer_pool_segment_t *initial_segment =
      buffer_pool_segment_create(buffer_size, initial_buffers, pool);
  if (!initial_segment)
    return -1;

  pool->segments = initial_segment;
  pool->num_buffers = initial_buffers;
  pool->num_free = initial_buffers;

  buffer_pool_update_stats(pool);
  return 0;
}

static inline const char *buffer_pool_name(buffer_pool_t *pool) {
  return (pool == &zerocopy_state.pool) ? "Buffer pool" : "Control pool";
}

static int buffer_pool_expand(buffer_pool_t *pool) {
  if (pool->num_buffers >= pool->max_buffers) {
    logger(LOG_DEBUG, "%s: Cannot expand beyond maximum size (%zu buffers)",
           buffer_pool_name(pool), pool->max_buffers);
    return -1;
  }

  size_t buffers_to_add = pool->expand_size;
  if (pool->num_buffers + buffers_to_add > pool->max_buffers) {
    buffers_to_add = pool->max_buffers - pool->num_buffers;
  }

  logger(LOG_DEBUG,
         "%s: Expanding by %zu buffers (current: %zu, free: %zu, max: %zu)",
         buffer_pool_name(pool), buffers_to_add, pool->num_buffers,
         pool->num_free, pool->max_buffers);

  buffer_pool_segment_t *new_segment =
      buffer_pool_segment_create(pool->buffer_size, buffers_to_add, pool);
  if (!new_segment) {
    logger(LOG_ERROR, "%s: Failed to allocate new segment",
           buffer_pool_name(pool));
    return -1;
  }

  new_segment->next = pool->segments;
  pool->segments = new_segment;
  pool->num_buffers += buffers_to_add;
  pool->num_free += buffers_to_add;

  if (pool == &zerocopy_state.pool) {
    WORKER_STATS_INC(pool_expansions);
  } else if (pool == &zerocopy_state.control_pool) {
    WORKER_STATS_INC(control_pool_expansions);
  }

  buffer_pool_update_stats(pool);

  logger(LOG_DEBUG, "%s: Expansion successful (total: %zu buffers, free: %zu)",
         buffer_pool_name(pool), pool->num_buffers, pool->num_free);

  return 0;
}

void buffer_pool_cleanup(buffer_pool_t *pool) {
  buffer_pool_segment_t *segment = pool->segments;
  while (segment) {
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

void buffer_ref_get(buffer_ref_t *ref) {
  if (ref)
    ref->refcount++;
}

void buffer_ref_put(buffer_ref_t *ref) {
  if (!ref)
    return;

  ref->refcount--;
  if (ref->refcount <= 0) {
    if (ref->type == BUFFER_TYPE_FILE) {
      if (ref->file_fd >= 0) {
        close(ref->file_fd);
      }
      free(ref);
      return;
    }

    buffer_pool_t *pool =
        ref->segment ? ref->segment->parent : &zerocopy_state.pool;

    if (ref->segment) {
      ref->segment->num_free++;
    }

    ref->free_next = pool->free_list;
    pool->free_list = ref;
    pool->num_free++;

    buffer_pool_update_stats(pool);
  }
}

buffer_ref_t *buffer_pool_alloc_from(buffer_pool_t *pool) {
  if (!pool)
    return NULL;

  if (!pool->free_list) {
    if (pool == &zerocopy_state.pool) {
      WORKER_STATS_INC(pool_exhaustions);
    } else if (pool == &zerocopy_state.control_pool) {
      WORKER_STATS_INC(control_pool_exhaustions);
    }

    if (buffer_pool_expand(pool) < 0) {
      logger(LOG_DEBUG,
             "%s: Exhausted and cannot expand (total: %zu, max: %zu)",
             buffer_pool_name(pool), pool->num_buffers, pool->max_buffers);
      return NULL;
    }

    if (!pool->free_list) {
      logger(LOG_ERROR, "%s: Expansion succeeded but free_list is still empty",
             buffer_pool_name(pool));
      return NULL;
    }
  } else if (pool->num_free <= pool->low_watermark &&
             pool->num_buffers < pool->max_buffers) {
    logger(LOG_DEBUG,
           "%s: Low watermark reached (free: %zu, watermark: %zu), expanding "
           "proactively",
           buffer_pool_name(pool), pool->num_free, pool->low_watermark);

    if (buffer_pool_expand(pool) < 0) {
      logger(LOG_DEBUG,
             "%s: Proactive expansion failed, continuing with current buffers",
             buffer_pool_name(pool));
    }
  }

  buffer_ref_t *ref = pool->free_list;
  pool->free_list = ref->free_next;
  pool->num_free--;

  if (ref->segment) {
    ref->segment->num_free--;
  }

  ref->refcount = 1;
  ref->data_offset = 0;
  ref->data_size = 0;
  ref->send_next = NULL;

  buffer_pool_update_stats(pool);

  return ref;
}

buffer_ref_t *buffer_pool_alloc(void) {
  return buffer_pool_alloc_from(&zerocopy_state.pool);
}

buffer_ref_t *buffer_pool_alloc_control(void) {
  return buffer_pool_alloc_from(&zerocopy_state.control_pool);
}

static void buffer_pool_try_shrink_pool(buffer_pool_t *pool,
                                        size_t min_buffers) {
  if (pool->num_free <= pool->high_watermark ||
      pool->num_buffers <= min_buffers) {
    return;
  }

  logger(LOG_DEBUG,
         "%s: Checking for shrink opportunity (free: %zu, high_watermark: %zu, "
         "total: %zu)",
         buffer_pool_name(pool), pool->num_free, pool->high_watermark,
         pool->num_buffers);

  buffer_pool_segment_t *prev = NULL;
  buffer_pool_segment_t *seg = pool->segments;
  size_t segments_freed = 0;

  while (seg != NULL) {
    buffer_pool_segment_t *next = seg->next;

    if (seg->num_free == seg->num_buffers &&
        pool->num_buffers - seg->num_buffers >= min_buffers) {
      buffer_ref_t **free_ptr = &pool->free_list;
      size_t removed_count = 0;

      while (*free_ptr != NULL) {
        buffer_ref_t *ref = *free_ptr;
        uint8_t *buf_addr = (uint8_t *)ref->data;
        uint8_t *seg_start = seg->buffers;
        uint8_t *seg_end =
            seg->buffers + (seg->num_buffers * pool->buffer_size);

        if (buf_addr >= seg_start && buf_addr < seg_end) {
          *free_ptr = ref->free_next;
          removed_count++;
        } else {
          free_ptr = &(ref->free_next);
        }
      }

      if (removed_count != seg->num_buffers) {
        logger(
            LOG_ERROR,
            "%s: Shrink inconsistency - expected %zu free buffers, found %zu",
            buffer_pool_name(pool), seg->num_buffers, removed_count);
      }

      pool->num_buffers -= seg->num_buffers;
      pool->num_free -= removed_count;

      if (prev) {
        prev->next = next;
      } else {
        pool->segments = next;
      }

      logger(LOG_DEBUG,
             "%s: Freeing idle segment with %zu buffers (age: %.1fs, total: "
             "%zu -> %zu)",
             buffer_pool_name(pool), seg->num_buffers,
             (buffer_pool_time_us() - seg->create_time_us) / 1000000.0,
             pool->num_buffers + seg->num_buffers, pool->num_buffers);

      free(seg->refs);
      free(seg->buffers);
      free(seg);

      segments_freed++;

      if (pool == &zerocopy_state.pool) {
        WORKER_STATS_INC(pool_shrinks);
      } else if (pool == &zerocopy_state.control_pool) {
        WORKER_STATS_INC(control_pool_shrinks);
      }

      seg = next;

      if (pool->num_free <= pool->high_watermark) {
        break;
      }
    } else {
      prev = seg;
      seg = next;
    }
  }

  if (segments_freed > 0) {
    logger(LOG_DEBUG,
           "%s: Shrink completed - freed %zu segments (total: %zu buffers, "
           "free: %zu)",
           buffer_pool_name(pool), segments_freed, pool->num_buffers,
           pool->num_free);

    buffer_pool_update_stats(pool);
  }
}

void buffer_pool_try_shrink(void) {
  buffer_pool_try_shrink_pool(&zerocopy_state.pool, BUFFER_POOL_INITIAL_SIZE);
  buffer_pool_try_shrink_pool(&zerocopy_state.control_pool,
                              CONTROL_POOL_INITIAL_SIZE);
}
