#include "status.h"
#include "connection.h"
#include "http.h"
#include "rtp2httpd.h"
#include "utils.h"
#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>

/* Helper: escape JSON string into out buffer */
static void json_escape_string(const char *in, char *out, size_t out_sz) {
  const unsigned char *src = (const unsigned char *)in;
  char *dst = out;
  if (out_sz == 0)
    return;
  while (*src && (size_t)(dst - out) < out_sz - 1) {
    unsigned char c = *src++;
    if (c == '"' || c == '\\') {
      if ((size_t)(dst - out) + 2 >= out_sz)
        break;
      *dst++ = '\\';
      *dst++ = (char)c;
    } else if (c == '\n' || c == '\r' || c == '\t' || c == '\b' || c == '\f') {
      if ((size_t)(dst - out) + 2 >= out_sz)
        break;
      *dst++ = '\\';
      *dst++ = (c == '\n')   ? 'n'
               : (c == '\r') ? 'r'
               : (c == '\t') ? 't'
               : (c == '\b') ? 'b'
                             : 'f';
    } else if (c < 0x20) {
      /* Control chars as \u00XX */
      size_t rem = out_sz - (size_t)(dst - out);
      if (rem < 7)
        break;
      int n = snprintf(dst, rem, "\\u%04X", c);
      if (n <= 0 || (size_t)n >= rem)
        break;
      dst += n;
    } else {
      *dst++ = (char)c;
    }
  }
  *dst = '\0';
}

/* Global pointer to shared memory */
status_shared_t *status_shared = NULL;

/* Path for shared memory file in /tmp */
static char shm_path[256] = {0};

/**
 * Initialize status tracking system
 * Creates and maps shared memory file in /tmp, then immediately closes the file
 * descriptor. The mmap() mapping remains valid after close() per POSIX
 * specification.
 */
int status_init(void) {
  int fd;

  /* Create shared memory file in /tmp */
  snprintf(shm_path, sizeof(shm_path), "/tmp/rtp2httpd_status_%d", getpid());
  fd = open(shm_path, O_CREAT | O_RDWR | O_EXCL, 0600);
  if (fd == -1) {
    logger(LOG_ERROR, "Failed to create shared memory file: %s",
           strerror(errno));
    return -1;
  }

  /* Set size of shared memory */
  if (ftruncate(fd, sizeof(status_shared_t)) == -1) {
    logger(LOG_ERROR, "Failed to set shared memory size: %s", strerror(errno));
    close(fd);
    unlink(shm_path);
    return -1;
  }

  /* Map shared memory */
  status_shared = mmap(NULL, sizeof(status_shared_t), PROT_READ | PROT_WRITE,
                       MAP_SHARED, fd, 0);
  if (status_shared == MAP_FAILED) {
    logger(LOG_ERROR, "Failed to map shared memory: %s", strerror(errno));
    close(fd);
    unlink(shm_path);
    return -1;
  }

  /* Close file descriptor immediately after mmap()
   * Per POSIX: "closing the file descriptor does not unmap the region"
   * This is best practice and avoids fd management issues after fork() */
  close(fd);

  /* Initialize shared memory structure */
  memset(status_shared, 0, sizeof(status_shared_t));
  status_shared->server_start_time = get_realtime_ms();
  status_shared->current_log_level = config.verbosity;
  status_shared->event_counter = 0;

  /* Initialize pipe fds to -1 (invalid) */
  for (int i = 0; i < STATUS_MAX_WORKERS; i++) {
    status_shared->worker_notification_pipe_read_fds[i] = -1;
    status_shared->worker_notification_pipes[i] = -1;
  }

  /* Create notification pipes for all workers BEFORE fork
   * This ensures all workers can access all pipe write ends for cross-worker
   * notification */
  if (config.workers > 0) {
    int num_workers = config.workers;
    if (num_workers > STATUS_MAX_WORKERS) {
      logger(LOG_WARN,
             "Requested %d workers exceeds maximum %d, limiting to %d",
             num_workers, STATUS_MAX_WORKERS, STATUS_MAX_WORKERS);
      num_workers = STATUS_MAX_WORKERS;
    }

    for (int i = 0; i < num_workers; i++) {
      int pipe_fds[2];
      if (pipe(pipe_fds) == -1) {
        logger(LOG_ERROR,
               "Failed to create notification pipe for worker %d: %s", i,
               strerror(errno));
        /* Clean up already created pipes */
        for (int j = 0; j < i; j++) {
          if (status_shared->worker_notification_pipe_read_fds[j] != -1)
            close(status_shared->worker_notification_pipe_read_fds[j]);
          if (status_shared->worker_notification_pipes[j] != -1)
            close(status_shared->worker_notification_pipes[j]);
        }
        munmap(status_shared, sizeof(status_shared_t));
        unlink(shm_path);
        return -1;
      }

      /* Set read end to non-blocking mode */
      int flags = fcntl(pipe_fds[0], F_GETFL, 0);
      fcntl(pipe_fds[0], F_SETFL, flags | O_NONBLOCK);

      /* Store both ends in shared memory
       * Read ends will be used by each worker after fork
       * Write ends are accessible by all workers for cross-worker notification
       */
      status_shared->worker_notification_pipe_read_fds[i] = pipe_fds[0];
      status_shared->worker_notification_pipes[i] = pipe_fds[1];
    }
  }

  /* Initialize mutexes for multi-process safety */
  pthread_mutexattr_t mutex_attr;
  pthread_mutexattr_init(&mutex_attr);
  pthread_mutexattr_setpshared(&mutex_attr, PTHREAD_PROCESS_SHARED);
  pthread_mutex_init(&status_shared->log_mutex, &mutex_attr);
  pthread_mutex_init(&status_shared->clients_mutex, &mutex_attr);
  pthread_mutexattr_destroy(&mutex_attr);

  logger(LOG_INFO, "Status tracking initialized");
  return 0;
}

/**
 * Cleanup status tracking system
 * IMPORTANT: This function is called by each worker process on exit.
 * Some cleanup operations must only be performed by worker 0 to avoid
 * race conditions and undefined behavior in multi-worker environments.
 */
void status_cleanup(void) {
  if (status_shared != NULL && status_shared != MAP_FAILED) {
    /* Close all pipe write ends (shared across all workers)
     * Only worker 0 should do this to avoid closing pipes other workers might
     * still use */
    if (worker_id == 0) {
      for (int i = 0; i < STATUS_MAX_WORKERS; i++) {
        if (status_shared->worker_notification_pipes[i] != -1) {
          close(status_shared->worker_notification_pipes[i]);
          status_shared->worker_notification_pipes[i] = -1;
        }
      }
    }

    /* Each worker closes its own notification pipe read end
     * (Other workers' read ends were already closed in
     * status_worker_get_notif_fd) */
    if (worker_id >= 0 && worker_id < STATUS_MAX_WORKERS &&
        status_shared->worker_notification_pipe_read_fds[worker_id] != -1) {
      close(status_shared->worker_notification_pipe_read_fds[worker_id]);
      status_shared->worker_notification_pipe_read_fds[worker_id] = -1;
    }

    /* Only worker 0 destroys shared mutexes
     * Destroying a mutex that other workers might still be using causes
     * undefined behavior. In the fork model, worker 0 is the main process and
     * exits last. */
    if (worker_id == 0) {
      pthread_mutex_destroy(&status_shared->log_mutex);
      pthread_mutex_destroy(&status_shared->clients_mutex);
    }

    /* Each worker unmaps its own view of shared memory
     * This is safe - munmap() only affects the current process's address space
     */
    munmap(status_shared, sizeof(status_shared_t));
    status_shared = NULL;
  }

  /* Only worker 0 unlinks shared memory file
   * unlink() removes the shared memory file from the filesystem.
   * If called by a non-last worker, other workers would lose access to shared
   * memory. In the fork model, worker 0 is the main process and exits last. */
  if (worker_id == 0) {
    unlink(shm_path);
    logger(
        LOG_DEBUG,
        "Status tracking cleaned up (worker 0 - shared resources destroyed)");
  } else {
    logger(LOG_DEBUG, "Status tracking cleaned up (worker %d)", worker_id);
  }
}

/**
 * Register a new streaming client connection
 * Only called for media streaming clients, not for status/API requests
 * Allocates a free slot under mutex protection and returns the slot index
 */
int status_register_client(const char *client_addr_str,
                           const char *service_url) {
  int status_index = -1;

  if (!status_shared || !client_addr_str)
    return -1;

  /* Lock mutex to protect client slot allocation */
  pthread_mutex_lock(&status_shared->clients_mutex);

  /* Find free slot */
  for (int i = 0; i < STATUS_MAX_CLIENTS; i++) {
    if (!status_shared->clients[i].active) {
      /* Initialize client slot */
      memset(&status_shared->clients[i], 0, sizeof(client_stats_t));
      status_shared->clients[i].active = 1;
      status_shared->clients[i].worker_pid =
          getpid(); /* Store actual worker PID */
      status_shared->clients[i].worker_index = worker_id;
      status_shared->clients[i].connect_time = get_realtime_ms();
      status_shared->clients[i].disconnect_requested = 0;

      /* Copy client address string (format: "IP:port" or "[IPv6]:port") */
      strncpy(status_shared->clients[i].client_addr, client_addr_str,
              sizeof(status_shared->clients[i].client_addr) - 1);
      status_shared->clients[i]
          .client_addr[sizeof(status_shared->clients[i].client_addr) - 1] =
          '\0';
      status_shared->clients[i].state = CLIENT_STATE_CONNECTING;

      /* Generate unique client ID: "IP:port-workerN-seqM"
       * Use real client IP (not X-Forwarded-For) + port + worker index +
       * sequence counter */
      uint64_t seq = 0;
      if (worker_id >= 0 && worker_id < STATUS_MAX_WORKERS) {
        seq = status_shared->worker_stats[worker_id].client_id_counter++;
      }
      snprintf(status_shared->clients[i].client_id,
               sizeof(status_shared->clients[i].client_id),
               "%s-worker%d-seq%llu", client_addr_str, worker_id,
               (unsigned long long)seq);

      /* Copy service URL */
      if (service_url) {
        strncpy(status_shared->clients[i].service_url, service_url,
                sizeof(status_shared->clients[i].service_url) - 1);
        status_shared->clients[i]
            .service_url[sizeof(status_shared->clients[i].service_url) - 1] =
            '\0';
      }

      status_shared->total_clients++;
      status_index = i;
      break;
    }
  }

  /* Unlock mutex */
  pthread_mutex_unlock(&status_shared->clients_mutex);

  if (status_index < 0) {
    logger(LOG_ERROR, "No free client slots in status tracking");
    return -1;
  }

  /* Trigger event notification for new client */
  status_trigger_event(STATUS_EVENT_SSE_UPDATE);

  return status_index;
}

/**
 * Unregister a streaming client connection
 * Only called for media streaming clients that were previously registered
 */
void status_unregister_client(int status_index) {
  if (!status_shared)
    return;

  if (status_index < 0 || status_index >= STATUS_MAX_CLIENTS)
    return;

  if (!status_shared->clients[status_index].active)
    return;

  client_stats_t *client = &status_shared->clients[status_index];

  /* Accumulate this client's bytes_sent to global total before unregistering */
  status_shared->total_bytes_sent_cumulative += client->bytes_sent;

  if (client->worker_index >= 0 && client->worker_index < STATUS_MAX_WORKERS) {
    status_shared->worker_stats[client->worker_index].client_bytes_cumulative +=
        client->bytes_sent;
  }

  client->active = 0;
  client->state = CLIENT_STATE_DISCONNECTED;
  client->disconnect_requested = 0;
  client->worker_index = -1;
  status_shared->total_clients--;

  /* Trigger event notification for client disconnect */
  status_trigger_event(STATUS_EVENT_SSE_UPDATE);
}

/**
 * Get the notification pipe read fd for current worker (called after fork)
 * Also closes read fds for other workers to avoid fd leaks
 * @return notification pipe read fd on success, -1 on error
 */
int status_worker_get_notif_fd(void) {
  int i;

  if (!status_shared)
    return -1;

  if (worker_id < 0 || worker_id >= STATUS_MAX_WORKERS) {
    logger(LOG_ERROR, "Invalid worker_id %d", worker_id);
    return -1;
  }

  int notif_fd = status_shared->worker_notification_pipe_read_fds[worker_id];

  /* Close read ends of pipes for other workers (we only need our own) */
  for (i = 0; i < STATUS_MAX_WORKERS; i++) {
    if (i != worker_id &&
        status_shared->worker_notification_pipe_read_fds[i] != -1) {
      close(status_shared->worker_notification_pipe_read_fds[i]);
    }
  }

  return notif_fd;
}

/**
 * Trigger an event notification to wake up workers
 * @param event_type Type of event to trigger
 */
void status_trigger_event(status_event_type_t event_type) {
  uint8_t event_byte = (uint8_t)event_type;
  int i;

  if (!status_shared)
    return;

  /* Increment event counter */
  status_shared->event_counter++;

  /* Write event type to all active worker pipes to wake up workers */
  for (i = 0; i < config.workers && i < STATUS_MAX_WORKERS; i++) {
    int pipe_fd = status_shared->worker_notification_pipes[i];
    if (pipe_fd != -1) {
      ssize_t ret = write(pipe_fd, &event_byte, 1);
      /* Ignore return value - notification is best-effort
       * EAGAIN/EWOULDBLOCK is acceptable if pipe buffer is full
       * EBADF is acceptable if worker just cleaned up */
      (void)ret;
    }
  }
}

/**
 * Update client bytes and bandwidth by status index
 * Always triggers status event notification.
 */
void status_update_client_bytes(int status_index, uint64_t bytes_sent,
                                uint32_t current_bandwidth) {
  if (!status_shared)
    return;

  if (status_index < 0 || status_index >= STATUS_MAX_CLIENTS)
    return;

  if (!status_shared->clients[status_index].active)
    return;

  /* Update client statistics */
  status_shared->clients[status_index].bytes_sent = bytes_sent;
  status_shared->clients[status_index].current_bandwidth = current_bandwidth;
}

/**
 * Update client state by status index
 * Always triggers status event notification.
 */
void status_update_client_state(int status_index, client_state_type_t state) {
  if (!status_shared)
    return;

  if (status_index < 0 || status_index >= STATUS_MAX_CLIENTS)
    return;

  if (!status_shared->clients[status_index].active)
    return;

  /* Update client state */
  status_shared->clients[status_index].state = state;

  /* Always trigger event notification */
  status_trigger_event(STATUS_EVENT_SSE_UPDATE);
}

void status_update_client_queue(int status_index, size_t queue_bytes,
                                size_t queue_buffers, size_t queue_limit_bytes,
                                size_t queue_bytes_highwater,
                                size_t queue_buffers_highwater,
                                uint64_t dropped_packets,
                                uint64_t dropped_bytes,
                                uint32_t backpressure_events, int slow_active) {
  if (!status_shared)
    return;

  if (status_index < 0 || status_index >= STATUS_MAX_CLIENTS)
    return;

  if (!status_shared->clients[status_index].active)
    return;

  status_shared->clients[status_index].queue_bytes = queue_bytes;
  status_shared->clients[status_index].queue_buffers = (uint32_t)queue_buffers;
  status_shared->clients[status_index].queue_limit_bytes = queue_limit_bytes;
  status_shared->clients[status_index].queue_bytes_highwater =
      queue_bytes_highwater;
  status_shared->clients[status_index].queue_buffers_highwater =
      (uint32_t)queue_buffers_highwater;
  status_shared->clients[status_index].dropped_packets = dropped_packets;
  status_shared->clients[status_index].dropped_bytes = dropped_bytes;
  status_shared->clients[status_index].backpressure_events =
      backpressure_events;
  status_shared->clients[status_index].slow_active = slow_active;
}

/**
 * Add log entry to circular buffer
 */
void status_add_log_entry(enum loglevel level, const char *message) {
  int index;

  if (!status_shared || !message)
    return;

  /* Lock mutex to prevent race conditions in multi-worker environment */
  pthread_mutex_lock(&status_shared->log_mutex);

  /* Get next write index */
  index = status_shared->log_write_index;

  /* Store log entry */
  status_shared->log_entries[index].timestamp = get_realtime_ms();
  status_shared->log_entries[index].level = level;
  strncpy(status_shared->log_entries[index].message, message,
          sizeof(status_shared->log_entries[index].message) - 1);
  status_shared->log_entries[index]
      .message[sizeof(status_shared->log_entries[index].message) - 1] = '\0';

  /* Update write index (circular) */
  status_shared->log_write_index = (index + 1) % STATUS_MAX_LOG_ENTRIES;

  /* Update count */
  if (status_shared->log_count < STATUS_MAX_LOG_ENTRIES) {
    status_shared->log_count++;
  }

  /* Unlock mutex */
  pthread_mutex_unlock(&status_shared->log_mutex);

  /* Trigger SSE event for new log entries */
  status_trigger_event(STATUS_EVENT_SSE_UPDATE);
}

/* Removed format_bytes and format_bandwidth - formatting is done in JavaScript
 * on the frontend */

/**
 * Get log level name (public function for SSE)
 */
const char *status_get_log_level_name(enum loglevel level) {
  switch (level) {
  case LOG_FATAL:
    return "FATAL";
  case LOG_ERROR:
    return "ERROR";
  case LOG_WARN:
    return "WARN";
  case LOG_INFO:
    return "INFO";
  case LOG_DEBUG:
    return "DEBUG";
  default:
    return "UNKNOWN";
  }
}

/**
 * Build SSE JSON payload with status information (for event-driven SSE)
 * This function is used by worker.c to build SSE payloads for connections.
 *
 * @param buffer Output buffer
 * @param buffer_capacity Buffer size
 * @param p_sent_initial Pointer to sent_initial flag (in/out)
 * @param p_last_write_index Pointer to last write index (in/out)
 * @param p_last_log_count Pointer to last log count (in/out)
 * @return Number of bytes written to buffer
 */
int status_build_sse_json(char *buffer, size_t buffer_capacity,
                          int *p_sent_initial, int *p_last_write_index,
                          int *p_last_log_count) {
  if (!status_shared)
    return 0;

  int sent_initial = *p_sent_initial;
  int last_write_index = *p_last_write_index;
  int last_log_count = *p_last_log_count;
  int i, log_start, log_idx;
  uint64_t total_bytes = 0;
  uint32_t total_bw = 0;
  int streams_count = 0;
  uint64_t worker_active_bytes[STATUS_MAX_WORKERS];
  uint64_t worker_bandwidth_sum[STATUS_MAX_WORKERS];
  uint32_t worker_active_clients[STATUS_MAX_WORKERS];

  memset(worker_active_bytes, 0, sizeof(worker_active_bytes));
  memset(worker_bandwidth_sum, 0, sizeof(worker_bandwidth_sum));
  memset(worker_active_clients, 0, sizeof(worker_active_clients));

  int64_t current_time = get_realtime_ms();
  int64_t uptime_ms = current_time - status_shared->server_start_time;

  int len = snprintf(
      buffer, buffer_capacity,
      "data: "
      "{\"serverStartTime\":%lld,\"uptimeMs\":%lld,\"currentLogLevel\":%d,"
      "\"version\":\"" PACKAGE_VERSION "\",\"maxClients\":%d,\"clients\":[",
      (long long)status_shared->server_start_time, (long long)uptime_ms,
      status_shared->current_log_level, config.maxclients);

  /* Add client data (only real media streams: have a service_url) */
  int first_client = 1;
  for (i = 0; i < STATUS_MAX_CLIENTS; i++) {
    if (status_shared->clients[i].active &&
        status_shared->clients[i].service_url[0] != '\0') {
      if (!first_client)
        len += snprintf(buffer + len, buffer_capacity - (size_t)len, ",");
      first_client = 0;

      int64_t duration_ms =
          current_time - status_shared->clients[i].connect_time;

      /* Escape client_id for JSON */
      char escaped_client_id[256];
      json_escape_string(status_shared->clients[i].client_id, escaped_client_id,
                         sizeof(escaped_client_id));

      len += snprintf(
          buffer + len, buffer_capacity - (size_t)len,
          "{\"clientId\":\"%s\",\"workerPid\":%d,\"durationMs\":%lld,"
          "\"clientAddr\":\"%s\","
          "\"serviceUrl\":\"%s\",\"state\":%d,\"bytesSent\":%llu,"
          "\"currentBandwidth\":%u,\"queueBytes\":%zu,"
          "\"queueLimitBytes\":%zu,\"queueBytesHighwater\":%zu,"
          "\"droppedBytes\":%llu,\"slow\":%d}",
          escaped_client_id, status_shared->clients[i].worker_pid,
          (long long)duration_ms, status_shared->clients[i].client_addr,
          status_shared->clients[i].service_url,
          (int)status_shared->clients[i].state,
          (unsigned long long)status_shared->clients[i].bytes_sent,
          status_shared->clients[i].current_bandwidth,
          status_shared->clients[i].queue_bytes,
          status_shared->clients[i].queue_limit_bytes,
          status_shared->clients[i].queue_bytes_highwater,
          (unsigned long long)status_shared->clients[i].dropped_bytes,
          status_shared->clients[i].slow_active);

      streams_count++;
      total_bytes += status_shared->clients[i].bytes_sent;
      total_bw += status_shared->clients[i].current_bandwidth;

      int worker_index = status_shared->clients[i].worker_index;
      if (worker_index >= 0 && worker_index < STATUS_MAX_WORKERS) {
        worker_active_clients[worker_index]++;
        worker_active_bytes[worker_index] +=
            status_shared->clients[i].bytes_sent;
        worker_bandwidth_sum[worker_index] +=
            status_shared->clients[i].current_bandwidth;
      }
    }
  }

  /* Close clients array and add computed totals
   * total_bytes_sent = accumulated bytes from disconnected clients + current
   * active clients */
  uint64_t total_bytes_sent =
      status_shared->total_bytes_sent_cumulative + total_bytes;
  len += snprintf(
      buffer + len, buffer_capacity - (size_t)len,
      "],\"totalClients\":%d,\"totalBytesSent\":%llu,\"totalBandwidth\":%u",
      streams_count, (unsigned long long)total_bytes_sent, total_bw);

  /* Add per-worker breakdown */
  len +=
      snprintf(buffer + len, buffer_capacity - (size_t)len, ",\"workers\":[");
  int first_worker_entry = 1;
  for (i = 0; i < config.workers && i < STATUS_MAX_WORKERS; i++) {
    worker_stats_t *ws = &status_shared->worker_stats[i];
    if (!first_worker_entry)
      len += snprintf(buffer + len, buffer_capacity - (size_t)len, ",");
    first_worker_entry = 0;

    uint64_t w_pool_total = ws->pool_total_buffers;
    uint64_t w_pool_free = ws->pool_free_buffers;
    uint64_t w_pool_used =
        w_pool_total > w_pool_free ? w_pool_total - w_pool_free : 0;
    uint64_t w_ctrl_total = ws->control_pool_total_buffers;
    uint64_t w_ctrl_free = ws->control_pool_free_buffers;
    uint64_t w_ctrl_used =
        w_ctrl_total > w_ctrl_free ? w_ctrl_total - w_ctrl_free : 0;
    uint32_t w_active = worker_active_clients[i];
    uint64_t w_bandwidth = worker_bandwidth_sum[i];
    uint64_t w_total_bytes =
        ws->client_bytes_cumulative + worker_active_bytes[i];

    len += snprintf(
        buffer + len, buffer_capacity - (size_t)len,
        "{\"id\":%d,\"pid\":%d,\"activeClients\":%u,\"totalBandwidth\":%llu,"
        "\"totalBytes\":%llu,"
        "\"send\":{\"total\":%llu,\"completions\":%llu,\"copied\":%llu,"
        "\"eagain\":%llu,\"enobufs\":%llu,\"batch\":%llu},"
        "\"pool\":{\"total\":%llu,\"free\":%llu,\"used\":%llu,\"max\":%llu,"
        "\"expansions\":%llu,\"exhaustions\":%llu,\"shrinks\":%llu,"
        "\"utilization\":%.1f},"
        "\"controlPool\":{\"total\":%llu,\"free\":%llu,\"used\":%llu,\"max\":%"
        "llu,\"expansions\":%llu,\"exhaustions\":%llu,\"shrinks\":%llu,"
        "\"utilization\":%.1f}}",
        i, (int)ws->worker_pid, (unsigned int)w_active,
        (unsigned long long)w_bandwidth, (unsigned long long)w_total_bytes,
        (unsigned long long)ws->total_sends,
        (unsigned long long)ws->total_completions,
        (unsigned long long)ws->total_copied,
        (unsigned long long)ws->eagain_count,
        (unsigned long long)ws->enobufs_count,
        (unsigned long long)ws->batch_sends, (unsigned long long)w_pool_total,
        (unsigned long long)w_pool_free, (unsigned long long)w_pool_used,
        (unsigned long long)ws->pool_max_buffers,
        (unsigned long long)ws->pool_expansions,
        (unsigned long long)ws->pool_exhaustions,
        (unsigned long long)ws->pool_shrinks,
        w_pool_total > 0 ? (100.0 * w_pool_used / w_pool_total) : 0.0,
        (unsigned long long)w_ctrl_total, (unsigned long long)w_ctrl_free,
        (unsigned long long)w_ctrl_used,
        (unsigned long long)ws->control_pool_max_buffers,
        (unsigned long long)ws->control_pool_expansions,
        (unsigned long long)ws->control_pool_exhaustions,
        (unsigned long long)ws->control_pool_shrinks,
        w_ctrl_total > 0 ? (100.0 * w_ctrl_used / w_ctrl_total) : 0.0);
  }
  len += snprintf(buffer + len, buffer_capacity - (size_t)len, "]");

  /* Decide logs mode */
  const char *logs_mode = "none";
  int cur_wi = status_shared->log_write_index;
  int cur_count = status_shared->log_count;
  int new_entries = 0;
  if (!sent_initial) {
    logs_mode = "full";
  } else {
    int delta_idx = (cur_wi - last_write_index + STATUS_MAX_LOG_ENTRIES) %
                    STATUS_MAX_LOG_ENTRIES;
    new_entries = delta_idx;
    if (cur_count < STATUS_MAX_LOG_ENTRIES) {
      int count_delta = cur_count - last_log_count;
      if (count_delta < 0)
        count_delta = 0;
      if (new_entries > count_delta)
        new_entries = count_delta;
    }
    logs_mode = (new_entries > 0) ? "incremental" : "none";
  }

  /* Add logs section */
  len += snprintf(buffer + len, buffer_capacity - (size_t)len,
                  ",\"logsMode\":\"%s\",\"logs\":[", logs_mode);

  /* Add logs according to mode */
  if (!sent_initial) {
    /* Full dump: all available logs */
    int full_count = cur_count;
    if (full_count > 0) {
      if (cur_count < STATUS_MAX_LOG_ENTRIES)
        log_start = 0;
      else
        log_start = cur_wi;

      int first_log = 1;
      for (i = 0; i < full_count; i++) {
        log_idx =
            (log_start + cur_count - full_count + i) % STATUS_MAX_LOG_ENTRIES;
        if (!first_log)
          len += snprintf(buffer + len, buffer_capacity - (size_t)len, ",");
        first_log = 0;

        char escaped[STATUS_LOG_ENTRY_LEN * 2];
        json_escape_string(status_shared->log_entries[log_idx].message, escaped,
                           sizeof(escaped));

        len += snprintf(
            buffer + len, buffer_capacity - (size_t)len,
            "{\"timestamp\":%lld,\"levelName\":\"%s\",\"message\":\"%s\"}",
            (long long)status_shared->log_entries[log_idx].timestamp,
            status_get_log_level_name(
                status_shared->log_entries[log_idx].level),
            escaped);
      }
    }
    sent_initial = 1;
    last_write_index = cur_wi;
    last_log_count = cur_count;
  } else if (new_entries > 0) {
    /* Incremental: only new entries since last_write_index */
    int first_log = 1;
    int start_idx = (cur_wi - new_entries + STATUS_MAX_LOG_ENTRIES) %
                    STATUS_MAX_LOG_ENTRIES;
    for (i = 0; i < new_entries; i++) {
      log_idx = (start_idx + i) % STATUS_MAX_LOG_ENTRIES;
      if (!first_log)
        len += snprintf(buffer + len, buffer_capacity - (size_t)len, ",");
      first_log = 0;

      char escaped[STATUS_LOG_ENTRY_LEN * 2];
      json_escape_string(status_shared->log_entries[log_idx].message, escaped,
                         sizeof(escaped));

      len += snprintf(
          buffer + len, buffer_capacity - (size_t)len,
          "{\"timestamp\":%ld,\"level\":%d,\"levelName\":\"%s\",\"message\":\"%"
          "s\"}",
          (long)status_shared->log_entries[log_idx].timestamp,
          status_shared->log_entries[log_idx].level,
          status_get_log_level_name(status_shared->log_entries[log_idx].level),
          escaped);
    }
    last_write_index = cur_wi;
    last_log_count = cur_count;
  }

  len += snprintf(buffer + len, buffer_capacity - (size_t)len, "]}\n\n");

  /* Update output parameters */
  *p_sent_initial = sent_initial;
  *p_last_write_index = last_write_index;
  *p_last_log_count = last_log_count;

  /* Update global bandwidth statistics */
  status_shared->total_bandwidth = total_bw;

  return len;
}

/**
 * Handle API request to disconnect a client
 * RESTful: POST <status-path>/api/disconnect with form data body
 * "client_id=IP:port-workerN-seqM"
 *
 * In multi-worker architecture, this sets a disconnect flag in shared memory
 * and notifies the worker owning the connection to gracefully close it.
 */
void handle_disconnect_client(connection_t *c) {
  int found = 0;
  char response[512];
  char client_id_str[256] = {0};

  if (!status_shared) {
    send_http_headers(c, STATUS_503, "application/json", NULL);
    snprintf(response, sizeof(response),
             "{\"success\":false,\"error\":\"Status system not initialized\"}");
    connection_queue_output_and_flush(c, (const uint8_t *)response,
                                      strlen(response));
    return;
  }

  /* Check HTTP method */
  if (strcasecmp(c->http_req.method, "POST") != 0 &&
      strcasecmp(c->http_req.method, "DELETE") != 0) {
    send_http_headers(c, STATUS_400, "application/json", NULL);
    snprintf(response, sizeof(response),
             "{\"success\":false,\"error\":\"Method not allowed. Use POST or "
             "DELETE\"}");
    connection_queue_output_and_flush(c, (const uint8_t *)response,
                                      strlen(response));
    return;
  }

  /* Parse form data body to get client_id */
  if (c->http_req.body_len > 0) {
    if (http_parse_query_param(c->http_req.body, "client_id", client_id_str,
                               sizeof(client_id_str)) != 0) {
      send_http_headers(c, STATUS_400, "application/json", NULL);
      snprintf(response, sizeof(response),
               "{\"success\":false,\"error\":\"Missing 'client_id' parameter "
               "in request body\"}");
      connection_queue_output_and_flush(c, (const uint8_t *)response,
                                        strlen(response));
      return;
    }
  } else {
    send_http_headers(c, STATUS_400, "application/json", NULL);
    snprintf(response, sizeof(response),
             "{\"success\":false,\"error\":\"Missing request body\"}");
    connection_queue_output_and_flush(c, (const uint8_t *)response,
                                      strlen(response));
    return;
  }

  /* Validate client_id is not empty */
  if (client_id_str[0] == '\0') {
    send_http_headers(c, STATUS_400, "application/json", NULL);
    snprintf(response, sizeof(response),
             "{\"success\":false,\"error\":\"Empty client_id\"}");
    connection_queue_output_and_flush(c, (const uint8_t *)response,
                                      strlen(response));
    return;
  }

  /* Find client by client_id string */
  for (int i = 0; i < STATUS_MAX_CLIENTS; i++) {
    logger(LOG_DEBUG,
           "Checking client slot %d: active=%d, client_id=%s, to match=%s", i,
           status_shared->clients[i].active,
           status_shared->clients[i].client_id, client_id_str);
    if (status_shared->clients[i].active &&
        strcmp(status_shared->clients[i].client_id, client_id_str) == 0) {
      found = 1;
      /* Set disconnect flag - worker will check this and close the connection
       */
      status_shared->clients[i].disconnect_requested = 1;

      /* Trigger disconnect request event to wake up workers */
      status_trigger_event(STATUS_EVENT_DISCONNECT_REQUEST);
      break;
    }
  }

  send_http_headers(c, STATUS_200, "application/json", NULL);

  if (found) {
    snprintf(response, sizeof(response),
             "{\"success\":true,\"message\":\"Disconnect request sent\"}");
  } else {
    snprintf(response, sizeof(response),
             "{\"success\":false,\"error\":\"Client not found or already "
             "disconnected\"}");
  }

  connection_queue_output_and_flush(c, (const uint8_t *)response,
                                    strlen(response));
}

/**
 * Handle API request to change log level
 * RESTful: PUT <status-path>/api/log-level with form data body "level=2"
 */
void handle_set_log_level(connection_t *c) {
  int new_level;
  char response[512];
  char level_str[32] = {0};

  /* Check HTTP method */
  if (strcasecmp(c->http_req.method, "PUT") != 0 &&
      strcasecmp(c->http_req.method, "PATCH") != 0) {
    send_http_headers(c, STATUS_400, "application/json", NULL);
    snprintf(response, sizeof(response),
             "{\"success\":false,\"error\":\"Method not allowed. Use PUT or "
             "PATCH\"}");
    connection_queue_output_and_flush(c, (const uint8_t *)response,
                                      strlen(response));
    return;
  }

  /* Parse form data body to get level */
  if (c->http_req.body_len > 0) {
    if (http_parse_query_param(c->http_req.body, "level", level_str,
                               sizeof(level_str)) != 0) {
      send_http_headers(c, STATUS_400, "application/json", NULL);
      snprintf(response, sizeof(response),
               "{\"success\":false,\"error\":\"Missing 'level' parameter in "
               "request body\"}");
      connection_queue_output_and_flush(c, (const uint8_t *)response,
                                        strlen(response));
      return;
    }
  } else {
    send_http_headers(c, STATUS_400, "application/json", NULL);
    snprintf(response, sizeof(response),
             "{\"success\":false,\"error\":\"Missing request body\"}");
    connection_queue_output_and_flush(c, (const uint8_t *)response,
                                      strlen(response));
    return;
  }

  new_level = atoi(level_str);

  if (new_level < LOG_FATAL || new_level > LOG_DEBUG) {
    send_http_headers(c, STATUS_400, "application/json", NULL);
    snprintf(
        response, sizeof(response),
        "{\"success\":false,\"error\":\"Invalid log level (must be 0-4)\"}");
    connection_queue_output_and_flush(c, (const uint8_t *)response,
                                      strlen(response));
    return;
  }

  /* Update log level in shared memory and global config */
  if (status_shared) {
    status_shared->current_log_level = new_level;
  }
  send_http_headers(c, STATUS_200, "application/json", NULL);

  snprintf(response, sizeof(response),
           "{\"success\":true,\"message\":\"Log level changed to %s\"}",
           status_get_log_level_name(new_level));
  connection_queue_output_and_flush(c, (const uint8_t *)response,
                                    strlen(response));
}

/**
 * Initialize SSE connection for a client
 * Sends SSE headers and sets up connection state for SSE streaming
 */
int status_handle_sse_init(connection_t *c) {
  if (!c)
    return -1;

  /* Send SSE headers */
  send_http_headers(c, STATUS_200, "text/event-stream", NULL);

  c->sse_sent_initial = 0;
  c->sse_last_write_index = -1;
  c->sse_last_log_count = 0;
  c->next_sse_ts = get_time_ms();

  /* Build and send initial SSE payload immediately */
  char tmp[SSE_BUFFER_SIZE];
  int len =
      status_build_sse_json(tmp, sizeof(tmp), &c->sse_sent_initial,
                            &c->sse_last_write_index, &c->sse_last_log_count);

  if (len > 0) {
    connection_queue_output_and_flush(c, (const uint8_t *)tmp, (size_t)len);
  }

  c->state = CONN_SSE;

  return 0;
}

/**
 * Handle SSE notification event
 * Builds and enqueues SSE payloads for all active SSE connections
 */
int status_handle_sse_notification(connection_t *conn_head) {
  int updated_count = 0;

  if (!status_shared)
    return 0;

  /* Build and enqueue SSE payloads for all SSE connections
   * Note: Each connection has its own state (sse_sent_initial,
   * sse_last_write_index, sse_last_log_count) so we must build a separate
   * payload for each connection */
  for (connection_t *cc = conn_head; cc; cc = cc->next) {
    if (cc->state != CONN_SSE)
      continue;

    char tmp[SSE_BUFFER_SIZE];
    int len = status_build_sse_json(tmp, sizeof(tmp), &cc->sse_sent_initial,
                                    &cc->sse_last_write_index,
                                    &cc->sse_last_log_count);

    if (len > 0) {
      if (connection_queue_output_and_flush(cc, (const uint8_t *)tmp,
                                            (size_t)len) == 0) {
        cc->state = CONN_SSE;
        updated_count++;
      }
    }
  }

  return updated_count;
}

/**
 * Handle SSE heartbeat for a connection
 * Triggers status update to keep connection alive and update frontend
 * Only sends heartbeat when there are no active media clients
 * This ensures uptime is updated even when idle, while relying on event-driven
 * updates when clients are active
 */
int status_handle_sse_heartbeat(connection_t *c, int64_t now) {
  if (!c || c->state != CONN_SSE)
    return -1;

  /* Check if heartbeat is needed */
  if (c->next_sse_ts > now)
    return -1;

  /* Trigger periodic SSE update (once per second) */
  status_trigger_event(STATUS_EVENT_SSE_UPDATE);
  c->next_sse_ts = now + 1000;

  return 0;
}
