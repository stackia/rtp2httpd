#include "status.h"
#include "connection.h"
#include "http.h"
#include "rtp2httpd.h"
#include "supervisor.h"
#include "utils.h"
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/socket.h>
#include <unistd.h>

/* Global pointer to shared memory */
status_shared_t *status_shared = NULL;

/* Path for shared memory file in /tmp */
static char shm_path[256] = {0};

typedef enum { STATUS_LOG_EVENT_ADD = 1 } status_log_event_type_t;

typedef enum { STATUS_CONTROL_EVENT_CLEAR_LOGS = 1 } status_control_event_type_t;

typedef struct {
  uint32_t type;
  int64_t timestamp;
  loglevel_t level;
  char message[STATUS_LOG_ENTRY_LEN];
} status_log_event_t;

typedef struct {
  uint32_t type;
} status_control_event_t;

static int log_event_recv_fd = -1;
static int log_event_send_fd = -1;
static int control_event_recv_fd = -1;
static int control_event_send_fd = -1;

static int append_sse_data(char *buffer, size_t buffer_capacity, size_t *buffer_length, const char *format, ...)
    __attribute__((format(printf, 4, 5)));

static void set_fd_nonblocking(int fd) {
  int flags = fcntl(fd, F_GETFL, 0);
  if (flags >= 0)
    fcntl(fd, F_SETFL, flags | O_NONBLOCK);
}

static int append_sse_data(char *buffer, size_t buffer_capacity, size_t *buffer_length, const char *format, ...) {
  if (*buffer_length >= buffer_capacity)
    return -1;

  size_t remaining_capacity = buffer_capacity - *buffer_length;
  va_list arguments;
  va_start(arguments, format);
  int formatted_length = vsnprintf(buffer + *buffer_length, remaining_capacity, format, arguments);
  va_end(arguments);

  if (formatted_length < 0 || (size_t)formatted_length >= remaining_capacity)
    return -1;

  *buffer_length += (size_t)formatted_length;
  return 0;
}

static void reset_client_payload(client_stats_t *client) {
  memset(&client->payload, 0, sizeof(client->payload));
  client->payload.worker_index = -1;
  client->payload.state = CLIENT_STATE_DISCONNECTED;
  atomic_store_explicit(&client->disconnect_requested, 0, memory_order_relaxed);
  atomic_store_explicit(&client->data_version, 0, memory_order_relaxed);
}

static void lock_client_admission(uint32_t owner_pid) {
  uint32_t expected_owner = 0;
  while (!atomic_compare_exchange_weak_explicit(&status_shared->client_admission_owner_pid, &expected_owner, owner_pid,
                                                memory_order_acquire, memory_order_relaxed)) {
    expected_owner = 0;
    usleep(100);
  }
}

static void unlock_client_admission(uint32_t owner_pid) {
  uint32_t expected_owner = owner_pid;
  atomic_compare_exchange_strong_explicit(&status_shared->client_admission_owner_pid, &expected_owner, 0,
                                          memory_order_release, memory_order_relaxed);
}

static int client_capacity_is_available(void) {
  uint32_t reserved_slots = 0;

  for (int client_index = 0; client_index < STATUS_MAX_CLIENTS; client_index++) {
    if (atomic_load_explicit(&status_shared->clients[client_index].owner_pid, memory_order_acquire) != 0)
      reserved_slots++;
  }

  return reserved_slots < (uint32_t)config.maxclients;
}

static void client_write_begin(client_stats_t *client) {
  atomic_fetch_add_explicit(&client->data_version, 1, memory_order_acq_rel);
}

static void client_write_end(client_stats_t *client) {
  atomic_fetch_add_explicit(&client->data_version, 1, memory_order_release);
}

static int snapshot_client(const client_stats_t *client, client_stats_payload_t *snapshot, uint32_t *owner_pid,
                           uint32_t *generation) {
  for (int attempt = 0; attempt < 3; attempt++) {
    if (!atomic_load_explicit(&client->active, memory_order_acquire))
      return 0;
    uint32_t version_before = atomic_load_explicit(&client->data_version, memory_order_acquire);
    if (version_before & 1U)
      continue;
    uint32_t generation_before = atomic_load_explicit(&client->generation, memory_order_acquire);
    *owner_pid = atomic_load_explicit(&client->owner_pid, memory_order_relaxed);
    memcpy(snapshot, &client->payload, sizeof(*snapshot));
    atomic_thread_fence(memory_order_acq_rel);
    uint32_t version_after = atomic_load_explicit(&client->data_version, memory_order_acquire);
    uint32_t generation_after = atomic_load_explicit(&client->generation, memory_order_acquire);
    if (version_before == version_after && !(version_after & 1U) && generation_before == generation_after &&
        atomic_load_explicit(&client->active, memory_order_acquire)) {
      if (generation)
        *generation = generation_after;
      return 1;
    }
  }
  return 0;
}

static void invalidate_log_ring(void) {
  for (int i = 0; i < STATUS_MAX_LOG_ENTRIES; i++)
    atomic_store_explicit(&status_shared->log_entries[i].sequence, 0, memory_order_relaxed);
}

static void clear_log_ring(void) {
  invalidate_log_ring();
  atomic_store_explicit(&status_shared->log_sequence, 0, memory_order_release);
  uint32_t epoch = atomic_fetch_add_explicit(&status_shared->log_epoch, 1, memory_order_acq_rel) + 1;
  if (epoch == 0)
    atomic_store_explicit(&status_shared->log_epoch, 1, memory_order_release);
}

static void append_log_entry(int64_t timestamp, loglevel_t level, const char *message) {
  uint32_t sequence = atomic_load_explicit(&status_shared->log_sequence, memory_order_relaxed);
  if (sequence == UINT32_MAX) {
    clear_log_ring();
    sequence = 0;
  }
  sequence++;
  log_entry_t *entry = &status_shared->log_entries[(sequence - 1) % STATUS_MAX_LOG_ENTRIES];
  atomic_store_explicit(&entry->sequence, 0, memory_order_release);
  entry->timestamp = timestamp;
  entry->level = level;
  strncpy(entry->message, message, sizeof(entry->message) - 1);
  entry->message[sizeof(entry->message) - 1] = '\0';
  atomic_store_explicit(&entry->sequence, sequence, memory_order_release);
  atomic_store_explicit(&status_shared->log_sequence, sequence, memory_order_release);
}

int status_init(void) {
  int fd;

  /* PID-keyed path: EEXIST can only be a stale leftover from a prior instance
   * with the same PID (no live process can hold our PID in this namespace),
   * so unlink-and-retry is safe. */
  snprintf(shm_path, sizeof(shm_path), "/tmp/rtp2httpd_status_%d", getpid());
  fd = open(shm_path, O_CREAT | O_RDWR | O_EXCL, 0600);
  if (fd == -1 && errno == EEXIST) {
    logger(LOG_WARN, "Stale shared memory file %s found, removing and retrying", shm_path);
    if (unlink(shm_path) == -1 && errno != ENOENT) {
      logger(LOG_ERROR, "Failed to unlink stale shared memory file: %s", strerror(errno));
      return -1;
    }
    fd = open(shm_path, O_CREAT | O_RDWR | O_EXCL, 0600);
  }
  if (fd == -1) {
    logger(LOG_ERROR, "Failed to create shared memory file: %s", strerror(errno));
    return -1;
  }

  /* Set size of shared memory */
  if (ftruncate(fd, sizeof(status_shared_t)) == -1) {
    logger(LOG_ERROR, "Failed to set shared memory size: %s", strerror(errno));
    close(fd);
    unlink(shm_path);
    return -1;
  }

  /* Map shared memory.
   * logger() probes status_shared with a NULL check, not a MAP_FAILED check,
   * so we must reset to NULL before logging or any failure path that calls
   * logger() will dereference (void*)-1. */
  void *mapped = mmap(NULL, sizeof(status_shared_t), PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
  if (mapped == MAP_FAILED) {
    int err = errno;
    status_shared = NULL;
    logger(LOG_ERROR, "Failed to map shared memory: %s", strerror(err));
    close(fd);
    unlink(shm_path);
    return -1;
  }
  status_shared = mapped;

  /* Close file descriptor immediately after mmap()
   * Per POSIX: "closing the file descriptor does not unmap the region"
   * This is best practice and avoids fd management issues after fork() */
  close(fd);

  /* Initialize shared memory structure */
  memset(status_shared, 0, sizeof(status_shared_t));
  status_shared->server_start_time = get_realtime_ms();
  status_shared->current_log_level = config.verbosity;
  status_shared->event_counter = 0;
  atomic_init(&status_shared->client_admission_owner_pid, 0);
  atomic_init(&status_shared->log_epoch, 1);
  atomic_init(&status_shared->log_sequence, 0);

  for (int i = 0; i < STATUS_MAX_CLIENTS; i++) {
    atomic_init(&status_shared->clients[i].owner_pid, 0);
    atomic_init(&status_shared->clients[i].active, 0);
    atomic_init(&status_shared->clients[i].generation, 0);
    atomic_init(&status_shared->clients[i].disconnect_requested, 0);
    atomic_init(&status_shared->clients[i].data_version, 0);
    status_shared->clients[i].payload.worker_index = -1;
  }
  for (int i = 0; i < STATUS_MAX_LOG_ENTRIES; i++)
    atomic_init(&status_shared->log_entries[i].sequence, 0);

  if (!atomic_is_lock_free(&status_shared->client_admission_owner_pid) ||
      !atomic_is_lock_free(&status_shared->clients[0].owner_pid) ||
      !atomic_is_lock_free(&status_shared->clients[0].active) ||
      !atomic_is_lock_free(&status_shared->clients[0].generation) ||
      !atomic_is_lock_free(&status_shared->clients[0].disconnect_requested) ||
      !atomic_is_lock_free(&status_shared->clients[0].data_version) ||
      !atomic_is_lock_free(&status_shared->log_epoch) ||
      !atomic_is_lock_free(&status_shared->log_entries[0].sequence) ||
      !atomic_is_lock_free(&status_shared->log_sequence)) {
    status_shared = NULL;
    munmap(mapped, sizeof(status_shared_t));
    unlink(shm_path);
    logger(LOG_ERROR, "Required 32-bit shared-memory atomics are not lock-free");
    return -1;
  }

  int log_fds[2];
  if (socketpair(AF_UNIX, SOCK_DGRAM, 0, log_fds) == -1) {
    int err = errno;
    status_shared = NULL;
    munmap(mapped, sizeof(status_shared_t));
    unlink(shm_path);
    logger(LOG_ERROR, "Failed to create status log socketpair: %s", strerror(err));
    return -1;
  }
  log_event_recv_fd = log_fds[0];
  log_event_send_fd = log_fds[1];
  set_fd_nonblocking(log_event_recv_fd);
  set_fd_nonblocking(log_event_send_fd);

  int control_fds[2];
  if (socketpair(AF_UNIX, SOCK_DGRAM, 0, control_fds) == -1) {
    int err = errno;
    close(log_event_recv_fd);
    close(log_event_send_fd);
    log_event_recv_fd = -1;
    log_event_send_fd = -1;
    status_shared = NULL;
    munmap(mapped, sizeof(status_shared_t));
    unlink(shm_path);
    logger(LOG_ERROR, "Failed to create status control socketpair: %s", strerror(err));
    return -1;
  }
  control_event_recv_fd = control_fds[0];
  control_event_send_fd = control_fds[1];
  set_fd_nonblocking(control_event_recv_fd);
  set_fd_nonblocking(control_event_send_fd);

  /* Initialize pipe fds to -1 (invalid) */
  for (int i = 0; i < STATUS_MAX_WORKERS; i++) {
    status_shared->worker_notification_pipe_read_fds[i] = -1;
    status_shared->worker_notification_pipes[i] = -1;
  }

  /* Pre-create notification pipes for all possible workers (STATUS_MAX_WORKERS)
   * This is done BEFORE fork so all processes inherit the same pipe fds.
   * Pre-creating all pipes allows future config reload to change worker count
   * without needing to recreate pipes. */
  for (int i = 0; i < STATUS_MAX_WORKERS; i++) {
    int pipe_fds[2];
    if (pipe(pipe_fds) == -1) {
      logger(LOG_ERROR, "Failed to create notification pipe for worker %d: %s", i, strerror(errno));
      /* Clean up already created pipes */
      for (int j = 0; j < i; j++) {
        if (status_shared->worker_notification_pipe_read_fds[j] != -1)
          close(status_shared->worker_notification_pipe_read_fds[j]);
        if (status_shared->worker_notification_pipes[j] != -1)
          close(status_shared->worker_notification_pipes[j]);
      }
      close(log_event_recv_fd);
      close(log_event_send_fd);
      log_event_recv_fd = -1;
      log_event_send_fd = -1;
      close(control_event_recv_fd);
      close(control_event_send_fd);
      control_event_recv_fd = -1;
      control_event_send_fd = -1;
      munmap(status_shared, sizeof(status_shared_t));
      status_shared = NULL;
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

  logger(LOG_INFO, "Status tracking initialized");
  return 0;
}

/**
 * Cleanup status tracking system
 *
 * This function is called by each process on exit. Since fork() creates
 * independent copies of file descriptors, each process can safely close
 * its own fd copies without affecting other processes.
 *
 * Each process closes:
 * - All pipe write ends (its own copies)
 * - All pipe read ends (its own copies, most already closed in
 *   status_worker_get_notif_fd)
 * - Its view of shared memory (munmap)
 *
 * Only the final cleanup process (supervisor or single worker) unlinks the
 * shared memory file.
 *
 * In supervisor mode, the supervisor waits for all workers to exit before
 * calling this function, ensuring it's the last process.
 */
void status_cleanup(void) {
  /* Determine if this process should do final cleanup:
   * - In supervisor mode: supervisor (worker_id == -1) does final cleanup
   * - In single-worker mode: worker 0 does final cleanup */
  int is_final_cleanup = (worker_id == -1) || (worker_id == 0 && config.workers <= 1);

  if (worker_id == SUPERVISOR_WORKER_ID)
    status_supervisor_drain_logs();

  if (log_event_recv_fd >= 0) {
    close(log_event_recv_fd);
    log_event_recv_fd = -1;
  }
  if (log_event_send_fd >= 0) {
    close(log_event_send_fd);
    log_event_send_fd = -1;
  }
  if (control_event_recv_fd >= 0) {
    close(control_event_recv_fd);
    control_event_recv_fd = -1;
  }
  if (control_event_send_fd >= 0) {
    close(control_event_send_fd);
    control_event_send_fd = -1;
  }

  if (status_shared != NULL && status_shared != MAP_FAILED) {
    /* Close all pipe fds (this process's copies)
     * Since fork() duplicates fds, closing here only affects this process */
    for (int i = 0; i < STATUS_MAX_WORKERS; i++) {
      if (status_shared->worker_notification_pipes[i] != -1) {
        close(status_shared->worker_notification_pipes[i]);
      }
      if (status_shared->worker_notification_pipe_read_fds[i] != -1) {
        close(status_shared->worker_notification_pipe_read_fds[i]);
      }
    }

    /* Each process unmaps its own view of shared memory
     * This is safe - munmap() only affects the current process's address space
     */
    munmap(status_shared, sizeof(status_shared_t));
    status_shared = NULL;
  }

  /* Only the final cleanup process unlinks shared memory file
   * unlink() removes the shared memory file from the filesystem */
  if (is_final_cleanup) {
    unlink(shm_path);
    if (worker_id == -1) {
      logger(LOG_DEBUG, "Status tracking cleaned up (supervisor - shared resources "
                        "destroyed)");
    } else {
      logger(LOG_DEBUG, "Status tracking cleaned up (single worker - shared resources "
                        "destroyed)");
    }
  } else {
    logger(LOG_DEBUG, "Status tracking cleaned up (worker %d)", worker_id);
  }
}

void status_worker_init(void) {
  if (log_event_recv_fd >= 0) {
    close(log_event_recv_fd);
    log_event_recv_fd = -1;
  }
  if (control_event_recv_fd >= 0) {
    close(control_event_recv_fd);
    control_event_recv_fd = -1;
  }
}

int status_register_client(const char *client_addr_str, const char *service_url) {
  int status_index = -1;
  uint32_t owner_pid = (uint32_t)getpid();

  if (!status_shared || !client_addr_str)
    return -1;

  lock_client_admission(owner_pid);
  if (!client_capacity_is_available()) {
    unlock_client_admission(owner_pid);
    logger(LOG_WARN, "Maximum client limit reached");
    return -1;
  }

  /* Reserve a slot by PID. owner_pid remains set while the slot is being
   * initialized so the supervisor can recover a worker killed mid-register. */
  for (int i = 0; i < STATUS_MAX_CLIENTS; i++) {
    client_stats_t *client = &status_shared->clients[i];
    uint32_t expected = 0;
    if (!atomic_compare_exchange_strong_explicit(&client->owner_pid, &expected, owner_pid, memory_order_acq_rel,
                                                 memory_order_relaxed))
      continue;

    status_index = i;
    break;
  }
  unlock_client_admission(owner_pid);

  if (status_index < 0) {
    logger(LOG_ERROR, "No free client slots in status tracking");
    return -1;
  }

  client_stats_t *client = &status_shared->clients[status_index];
  reset_client_payload(client);
  uint32_t generation = atomic_fetch_add_explicit(&client->generation, 1, memory_order_acq_rel) + 1;
  if (generation == 0)
    atomic_fetch_add_explicit(&client->generation, 1, memory_order_acq_rel);
  client->payload.worker_index = worker_id;
  client->payload.connect_time = get_realtime_ms();
  client->payload.state = CLIENT_STATE_CONNECTING;

  /* Copy client address string (format: "IP:port", "[IPv6]:port", or
   * "localhost" for Unix socket clients) */
  strncpy(client->payload.client_addr, client_addr_str, sizeof(client->payload.client_addr) - 1);
  client->payload.client_addr[sizeof(client->payload.client_addr) - 1] = '\0';

  /* Generate unique client ID: "IP:port-workerN-seqM"
   * Use real client IP (not X-Forwarded-For) + port + worker index +
   * sequence counter */
  uint64_t seq = 0;
  if (worker_id >= 0 && worker_id < STATUS_MAX_WORKERS)
    seq = status_shared->worker_stats[worker_id].client_id_counter++;
  snprintf(client->payload.client_id, sizeof(client->payload.client_id), "%s-worker%d-seq%llu", client_addr_str,
           worker_id, (unsigned long long)seq);

  /* Copy service URL */
  if (service_url) {
    strncpy(client->payload.service_url, service_url, sizeof(client->payload.service_url) - 1);
    client->payload.service_url[sizeof(client->payload.service_url) - 1] = '\0';
  }

  atomic_store_explicit(&client->active, 1, memory_order_release);

  /* Trigger event notification for new client */
  status_trigger_event(STATUS_EVENT_SSE_UPDATE);

  return status_index;
}

void status_unregister_client(int status_index) {
  if (!status_shared)
    return;

  if (status_index < 0 || status_index >= STATUS_MAX_CLIENTS)
    return;

  client_stats_t *client = &status_shared->clients[status_index];
  if (atomic_load_explicit(&client->owner_pid, memory_order_acquire) != (uint32_t)getpid())
    return;

  if (!atomic_exchange_explicit(&client->active, 0, memory_order_acq_rel))
    return;

  /* Accumulate this client's bytes_sent in its single-writer worker shard. */
  int client_worker_index = client->payload.worker_index;
  uint64_t bytes_sent = client->payload.bytes_sent;

  if (client_worker_index >= 0 && client_worker_index < STATUS_MAX_WORKERS) {
    status_shared->client_bytes_cumulative[client_worker_index] += bytes_sent;
  }

  reset_client_payload(client);
  atomic_store_explicit(&client->owner_pid, 0, memory_order_seq_cst);

  /* Trigger event notification for client disconnect */
  status_trigger_event(STATUS_EVENT_SSE_UPDATE);
}

int status_reap_worker(pid_t dead_pid, int worker_index) {
  if (!status_shared || dead_pid <= 0)
    return 0;

  uint32_t dead_owner = (uint32_t)dead_pid;
  int reclaimed = 0;
  for (int i = 0; i < STATUS_MAX_CLIENTS; i++) {
    client_stats_t *client = &status_shared->clients[i];
    if (atomic_load_explicit(&client->owner_pid, memory_order_acquire) != dead_owner)
      continue;

    if (atomic_exchange_explicit(&client->active, 0, memory_order_acq_rel)) {
      int client_worker_index = client->payload.worker_index;
      if (client_worker_index >= 0 && client_worker_index < STATUS_MAX_WORKERS)
        status_shared->client_bytes_cumulative[client_worker_index] += client->payload.bytes_sent;
    }
    reset_client_payload(client);
    atomic_store_explicit(&client->owner_pid, 0, memory_order_seq_cst);
    reclaimed++;
  }

  uint32_t expected_admission_owner = dead_owner;
  atomic_compare_exchange_strong_explicit(&status_shared->client_admission_owner_pid, &expected_admission_owner, 0,
                                          memory_order_release, memory_order_relaxed);

  if (worker_index >= 0 && worker_index < STATUS_MAX_WORKERS &&
      status_shared->worker_stats[worker_index].worker_pid == dead_pid) {
    memset(&status_shared->worker_stats[worker_index], 0, sizeof(worker_stats_t));
  }

  if (reclaimed > 0) {
    logger(LOG_INFO, "Reclaimed %d status client slot(s) from worker %d (pid %d)", reclaimed, worker_index,
           (int)dead_pid);
    status_trigger_event(STATUS_EVENT_SSE_UPDATE);
  }
  return reclaimed;
}

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
    if (i != worker_id && status_shared->worker_notification_pipe_read_fds[i] != -1) {
      close(status_shared->worker_notification_pipe_read_fds[i]);
    }
  }

  return notif_fd;
}

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

void status_update_client_bytes(int status_index, uint64_t bytes_sent, uint32_t current_bandwidth) {
  if (!status_shared)
    return;

  if (status_index < 0 || status_index >= STATUS_MAX_CLIENTS)
    return;

  client_stats_t *client = &status_shared->clients[status_index];
  if (atomic_load_explicit(&client->owner_pid, memory_order_acquire) != (uint32_t)getpid() ||
      !atomic_load_explicit(&client->active, memory_order_acquire))
    return;

  client_write_begin(client);
  client->payload.bytes_sent = bytes_sent;
  client->payload.current_bandwidth = current_bandwidth;
  client_write_end(client);
}

void status_update_client_state(int status_index, client_state_type_t state) {
  if (!status_shared)
    return;

  if (status_index < 0 || status_index >= STATUS_MAX_CLIENTS)
    return;

  client_stats_t *client = &status_shared->clients[status_index];
  if (atomic_load_explicit(&client->owner_pid, memory_order_acquire) != (uint32_t)getpid() ||
      !atomic_load_explicit(&client->active, memory_order_acquire))
    return;

  client_write_begin(client);
  client->payload.state = state;
  client_write_end(client);

  /* Always trigger event notification */
  status_trigger_event(STATUS_EVENT_SSE_UPDATE);
}

void status_update_client_queue(int status_index, size_t queue_bytes, size_t queue_buffers, size_t queue_limit_bytes,
                                size_t queue_bytes_highwater, size_t queue_buffers_highwater, uint64_t dropped_packets,
                                uint64_t dropped_bytes, uint32_t backpressure_events, int slow_active) {
  if (!status_shared)
    return;

  if (status_index < 0 || status_index >= STATUS_MAX_CLIENTS)
    return;

  client_stats_t *client = &status_shared->clients[status_index];
  if (atomic_load_explicit(&client->owner_pid, memory_order_acquire) != (uint32_t)getpid() ||
      !atomic_load_explicit(&client->active, memory_order_acquire))
    return;

  client_write_begin(client);
  client->payload.queue_bytes = queue_bytes;
  client->payload.queue_buffers = (uint32_t)queue_buffers;
  client->payload.queue_limit_bytes = queue_limit_bytes;
  client->payload.queue_bytes_highwater = queue_bytes_highwater;
  client->payload.queue_buffers_highwater = (uint32_t)queue_buffers_highwater;
  client->payload.dropped_packets = dropped_packets;
  client->payload.dropped_bytes = dropped_bytes;
  client->payload.backpressure_events = backpressure_events;
  client->payload.slow_active = slow_active;
  client_write_end(client);
}

void status_add_log_entry(enum loglevel level, const char *message) {
  if (!status_shared || !message)
    return;

  if (worker_id == SUPERVISOR_WORKER_ID) {
    append_log_entry(get_realtime_ms(), level, message);
    status_trigger_event(STATUS_EVENT_SSE_UPDATE);
    return;
  }

  if (log_event_send_fd < 0)
    return;

  status_log_event_t event;
  memset(&event, 0, sizeof(event));
  event.type = STATUS_LOG_EVENT_ADD;
  event.timestamp = get_realtime_ms();
  event.level = level;
  strncpy(event.message, message, sizeof(event.message) - 1);
  (void)send(log_event_send_fd, &event, sizeof(event), MSG_DONTWAIT);
}

void status_supervisor_drain_logs(void) {
  if (!status_shared || worker_id != SUPERVISOR_WORKER_ID)
    return;

  int changed = 0;
  if (log_event_recv_fd >= 0) {
    for (;;) {
      status_log_event_t event;
      ssize_t received = recv(log_event_recv_fd, &event, sizeof(event), MSG_DONTWAIT);
      if (received < 0) {
        if (errno == EINTR)
          continue;
        break;
      }
      if ((size_t)received != sizeof(event))
        continue;
      if (event.type == STATUS_LOG_EVENT_ADD) {
        event.message[sizeof(event.message) - 1] = '\0';
        append_log_entry(event.timestamp, event.level, event.message);
        changed = 1;
      }
    }
  }

  if (control_event_recv_fd >= 0) {
    for (;;) {
      status_control_event_t event;
      ssize_t received = recv(control_event_recv_fd, &event, sizeof(event), MSG_DONTWAIT);
      if (received < 0) {
        if (errno == EINTR)
          continue;
        break;
      }
      if ((size_t)received != sizeof(event))
        continue;
      if (event.type == STATUS_CONTROL_EVENT_CLEAR_LOGS) {
        clear_log_ring();
        changed = 1;
      }
    }
  }

  if (changed)
    status_trigger_event(STATUS_EVENT_SSE_UPDATE);
}

/* Removed format_bytes and format_bandwidth - formatting is done in JavaScript
 * on the frontend */

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

int status_build_sse_json(char *buffer, size_t buffer_capacity, int *p_sent_initial, uint32_t *p_last_log_epoch,
                          uint32_t *p_last_log_sequence) {
  if (!status_shared)
    return 0;

  int sent_initial = *p_sent_initial;
  uint32_t last_log_epoch = *p_last_log_epoch;
  uint32_t last_log_sequence = *p_last_log_sequence;
  int i;
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

  size_t len = 0;
  if (append_sse_data(buffer, buffer_capacity, &len,
                      "data: "
                      "{\"serverStartTime\":%lld,\"uptimeMs\":%lld,\"currentLogLevel\":%d,"
                      "\"version\":\"%s\",\"maxClients\":%d,\"clients\":[",
                      (long long)status_shared->server_start_time, (long long)uptime_ms,
                      status_shared->current_log_level, VERSION, config.maxclients) < 0)
    return 0;

  /* Add client data (only real media streams: have a service_url) */
  int first_client = 1;
  for (i = 0; i < STATUS_MAX_CLIENTS; i++) {
    client_stats_payload_t client;
    uint32_t owner_pid = 0;
    if (snapshot_client(&status_shared->clients[i], &client, &owner_pid, NULL) && client.service_url[0] != '\0') {
      if (!first_client && append_sse_data(buffer, buffer_capacity, &len, ",") < 0)
        return 0;
      first_client = 0;

      int64_t duration_ms = current_time - client.connect_time;

      /* Escape client-controlled strings before embedding them in JSON. */
      char escaped_client_id[sizeof(client.client_id) * 6 + 1];
      char escaped_client_addr[sizeof(client.client_addr) * 6 + 1];
      char escaped_service_url[sizeof(client.service_url) * 6 + 1];
      json_escape_string_to_buffer(client.client_id, escaped_client_id, sizeof(escaped_client_id));
      json_escape_string_to_buffer(client.client_addr, escaped_client_addr, sizeof(escaped_client_addr));
      json_escape_string_to_buffer(client.service_url, escaped_service_url, sizeof(escaped_service_url));

      if (append_sse_data(buffer, buffer_capacity, &len,
                          "{\"clientId\":\"%s\",\"workerPid\":%d,\"durationMs\":%lld,"
                          "\"clientAddr\":\"%s\","
                          "\"serviceUrl\":\"%s\",\"state\":%d,\"bytesSent\":%llu,"
                          "\"currentBandwidth\":%u,\"queueBytes\":%zu,"
                          "\"queueLimitBytes\":%zu,\"queueBytesHighwater\":%zu,"
                          "\"droppedBytes\":%llu,\"slow\":%d}",
                          escaped_client_id, (int)owner_pid, (long long)duration_ms, escaped_client_addr,
                          escaped_service_url, (int)client.state, (unsigned long long)client.bytes_sent,
                          client.current_bandwidth, client.queue_bytes, client.queue_limit_bytes,
                          client.queue_bytes_highwater, (unsigned long long)client.dropped_bytes,
                          client.slow_active) < 0)
        return 0;

      streams_count++;
      total_bytes += client.bytes_sent;
      total_bw += client.current_bandwidth;

      int worker_index = client.worker_index;
      if (worker_index >= 0 && worker_index < STATUS_MAX_WORKERS) {
        worker_active_clients[worker_index]++;
        worker_active_bytes[worker_index] += client.bytes_sent;
        worker_bandwidth_sum[worker_index] += client.current_bandwidth;
      }
    }
  }

  /* Close clients array and add computed totals
   * total_bytes_sent = accumulated bytes from disconnected clients + current
   * active clients */
  uint64_t total_bytes_sent = total_bytes;
  for (i = 0; i < STATUS_MAX_WORKERS; i++)
    total_bytes_sent += status_shared->client_bytes_cumulative[i];
  if (append_sse_data(buffer, buffer_capacity, &len,
                      "],\"totalClients\":%d,\"totalBytesSent\":%llu,\"totalBandwidth\":%u", streams_count,
                      (unsigned long long)total_bytes_sent, total_bw) < 0)
    return 0;

  /* Add per-worker breakdown */
  if (append_sse_data(buffer, buffer_capacity, &len, ",\"workers\":[") < 0)
    return 0;
  int first_worker_entry = 1;
  for (i = 0; i < config.workers && i < STATUS_MAX_WORKERS; i++) {
    worker_stats_t *ws = &status_shared->worker_stats[i];
    if (!first_worker_entry && append_sse_data(buffer, buffer_capacity, &len, ",") < 0)
      return 0;
    first_worker_entry = 0;

    uint64_t w_pool_total = ws->pool_total_buffers;
    uint64_t w_pool_free = ws->pool_free_buffers;
    uint64_t w_pool_used = w_pool_total > w_pool_free ? w_pool_total - w_pool_free : 0;
    uint64_t w_ctrl_total = ws->control_pool_total_buffers;
    uint64_t w_ctrl_free = ws->control_pool_free_buffers;
    uint64_t w_ctrl_used = w_ctrl_total > w_ctrl_free ? w_ctrl_total - w_ctrl_free : 0;
    uint32_t w_active = worker_active_clients[i];
    uint64_t w_bandwidth = worker_bandwidth_sum[i];
    /* The shared shard also includes bytes from clients reclaimed after a
     * worker crash, while worker_stats can be reset during reaping. */
    uint64_t w_total_bytes = status_shared->client_bytes_cumulative[i] + worker_active_bytes[i];

    if (append_sse_data(
            buffer, buffer_capacity, &len,
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
            i, (int)ws->worker_pid, (unsigned int)w_active, (unsigned long long)w_bandwidth,
            (unsigned long long)w_total_bytes, (unsigned long long)ws->total_sends,
            (unsigned long long)ws->total_completions, (unsigned long long)ws->total_copied,
            (unsigned long long)ws->eagain_count, (unsigned long long)ws->enobufs_count,
            (unsigned long long)ws->batch_sends, (unsigned long long)w_pool_total, (unsigned long long)w_pool_free,
            (unsigned long long)w_pool_used, (unsigned long long)ws->pool_max_buffers,
            (unsigned long long)ws->pool_expansions, (unsigned long long)ws->pool_exhaustions,
            (unsigned long long)ws->pool_shrinks, w_pool_total > 0 ? (100.0 * w_pool_used / w_pool_total) : 0.0,
            (unsigned long long)w_ctrl_total, (unsigned long long)w_ctrl_free, (unsigned long long)w_ctrl_used,
            (unsigned long long)ws->control_pool_max_buffers, (unsigned long long)ws->control_pool_expansions,
            (unsigned long long)ws->control_pool_exhaustions, (unsigned long long)ws->control_pool_shrinks,
            w_ctrl_total > 0 ? (100.0 * w_ctrl_used / w_ctrl_total) : 0.0) < 0)
      return 0;
  }
  if (append_sse_data(buffer, buffer_capacity, &len, "]") < 0)
    return 0;

  uint32_t current_log_epoch = atomic_load_explicit(&status_shared->log_epoch, memory_order_acquire);
  uint32_t current_log_sequence = atomic_load_explicit(&status_shared->log_sequence, memory_order_acquire);
  int full_logs = !sent_initial || current_log_epoch != last_log_epoch || current_log_sequence < last_log_sequence ||
                  current_log_sequence - last_log_sequence > STATUS_MAX_LOG_ENTRIES;
  uint32_t first_sequence = 0;
  if (full_logs) {
    first_sequence = current_log_sequence > STATUS_MAX_LOG_ENTRIES ? current_log_sequence - STATUS_MAX_LOG_ENTRIES + 1
                                                                   : (current_log_sequence > 0 ? 1 : 0);
  } else if (current_log_sequence > last_log_sequence) {
    first_sequence = last_log_sequence + 1;
  }
  const char *logs_mode = full_logs ? "full" : (first_sequence ? "incremental" : "none");

  /* Add logs section */
  if (append_sse_data(buffer, buffer_capacity, &len, ",\"logsMode\":\"%s\",\"logs\":[", logs_mode) < 0)
    return 0;

  int first_log = 1;
  for (uint32_t sequence = first_sequence; sequence > 0 && sequence <= current_log_sequence; sequence++) {
    log_entry_t *entry = &status_shared->log_entries[(sequence - 1) % STATUS_MAX_LOG_ENTRIES];
    uint32_t sequence_before = atomic_load_explicit(&entry->sequence, memory_order_acquire);
    if (sequence_before != sequence)
      continue;
    int64_t timestamp = entry->timestamp;
    loglevel_t level = entry->level;
    char message[STATUS_LOG_ENTRY_LEN];
    memcpy(message, entry->message, sizeof(message));
    message[sizeof(message) - 1] = '\0';
    atomic_thread_fence(memory_order_acq_rel);
    if (atomic_load_explicit(&entry->sequence, memory_order_acquire) != sequence)
      continue;

    if (!first_log && append_sse_data(buffer, buffer_capacity, &len, ",") < 0)
      return 0;
    first_log = 0;
    char escaped[STATUS_LOG_ENTRY_LEN * 2];
    json_escape_string_to_buffer(message, escaped, sizeof(escaped));
    if (full_logs) {
      if (append_sse_data(buffer, buffer_capacity, &len, "{\"timestamp\":%lld,\"levelName\":\"%s\",\"message\":\"%s\"}",
                          (long long)timestamp, status_get_log_level_name(level), escaped) < 0)
        return 0;
    } else {
      if (append_sse_data(buffer, buffer_capacity, &len,
                          "{\"timestamp\":%lld,\"level\":%d,\"levelName\":\"%s\",\"message\":\"%s\"}",
                          (long long)timestamp, level, status_get_log_level_name(level), escaped) < 0)
        return 0;
    }
  }
  sent_initial = 1;
  last_log_epoch = current_log_epoch;
  last_log_sequence = current_log_sequence;

  if (append_sse_data(buffer, buffer_capacity, &len, "]}\n\n") < 0)
    return 0;

  /* Update output parameters */
  *p_sent_initial = sent_initial;
  *p_last_log_epoch = last_log_epoch;
  *p_last_log_sequence = last_log_sequence;

  /* Update global bandwidth statistics */
  status_shared->total_bandwidth = total_bw;

  return (int)len;
}

void handle_disconnect_client(connection_t *c) {
  int found = 0;
  char response[512];
  char client_id_str[256] = {0};

  if (!status_shared) {
    send_http_headers(c, STATUS_503, "application/json", NULL);
    snprintf(response, sizeof(response), "{\"success\":false,\"error\":\"Status system not initialized\"}");
    connection_queue_output_and_flush(c, (const uint8_t *)response, strlen(response));
    return;
  }

  /* Check HTTP method */
  if (strcasecmp(c->http_req.method, "POST") != 0 && strcasecmp(c->http_req.method, "DELETE") != 0) {
    send_http_headers(c, STATUS_400, "application/json", NULL);
    snprintf(response, sizeof(response),
             "{\"success\":false,\"error\":\"Method not allowed. Use POST or "
             "DELETE\"}");
    connection_queue_output_and_flush(c, (const uint8_t *)response, strlen(response));
    return;
  }

  /* Parse form data body to get client_id */
  if (c->http_req.body_len > 0) {
    if (http_parse_query_param(c->http_req.body, "client_id", client_id_str, sizeof(client_id_str)) != 0) {
      send_http_headers(c, STATUS_400, "application/json", NULL);
      snprintf(response, sizeof(response),
               "{\"success\":false,\"error\":\"Missing 'client_id' parameter "
               "in request body\"}");
      connection_queue_output_and_flush(c, (const uint8_t *)response, strlen(response));
      return;
    }
  } else {
    send_http_headers(c, STATUS_400, "application/json", NULL);
    snprintf(response, sizeof(response), "{\"success\":false,\"error\":\"Missing request body\"}");
    connection_queue_output_and_flush(c, (const uint8_t *)response, strlen(response));
    return;
  }

  /* Validate client_id is not empty */
  if (client_id_str[0] == '\0') {
    send_http_headers(c, STATUS_400, "application/json", NULL);
    snprintf(response, sizeof(response), "{\"success\":false,\"error\":\"Empty client_id\"}");
    connection_queue_output_and_flush(c, (const uint8_t *)response, strlen(response));
    return;
  }

  /* Find client by client_id string */
  for (int i = 0; i < STATUS_MAX_CLIENTS; i++) {
    client_stats_payload_t client;
    uint32_t owner_pid;
    uint32_t generation;
    if (!snapshot_client(&status_shared->clients[i], &client, &owner_pid, &generation))
      continue;
    logger(LOG_DEBUG, "Checking client slot %d: active=1, client_id=%s, to match=%s", i, client.client_id,
           client_id_str);
    if (strcmp(client.client_id, client_id_str) == 0) {
      client_stats_t *shared_client = &status_shared->clients[i];
      atomic_store_explicit(&shared_client->disconnect_requested, generation, memory_order_release);

      found = atomic_load_explicit(&shared_client->active, memory_order_acquire) &&
              atomic_load_explicit(&shared_client->generation, memory_order_acquire) == generation;
      if (!found)
        continue;

      /* Trigger disconnect request event to wake up workers */
      status_trigger_event(STATUS_EVENT_DISCONNECT_REQUEST);
      break;
    }
  }

  send_http_headers(c, STATUS_200, "application/json", NULL);

  if (found) {
    snprintf(response, sizeof(response), "{\"success\":true,\"message\":\"Disconnect request sent\"}");
  } else {
    snprintf(response, sizeof(response),
             "{\"success\":false,\"error\":\"Client not found or already "
             "disconnected\"}");
  }

  connection_queue_output_and_flush(c, (const uint8_t *)response, strlen(response));
}

void handle_clear_logs(connection_t *c) {
  char response[256];

  /* Check HTTP method */
  if (strcasecmp(c->http_req.method, "POST") != 0) {
    send_http_headers(c, STATUS_400, "application/json", NULL);
    snprintf(response, sizeof(response), "{\"success\":false,\"error\":\"Method not allowed. Use POST\"}");
    connection_queue_output_and_flush(c, (const uint8_t *)response, strlen(response));
    return;
  }

  if (!status_shared) {
    send_http_headers(c, STATUS_503, "application/json", NULL);
    snprintf(response, sizeof(response), "{\"success\":false,\"error\":\"Status system not initialized\"}");
    connection_queue_output_and_flush(c, (const uint8_t *)response, strlen(response));
    return;
  }

  status_control_event_t event;
  memset(&event, 0, sizeof(event));
  event.type = STATUS_CONTROL_EVENT_CLEAR_LOGS;
  ssize_t bytes_sent = -1;
  if (control_event_send_fd >= 0)
    bytes_sent = send(control_event_send_fd, &event, sizeof(event), MSG_DONTWAIT);

  if (bytes_sent != (ssize_t)sizeof(event)) {
    send_http_headers(c, STATUS_503, "application/json", NULL);
    snprintf(response, sizeof(response), "{\"success\":false,\"error\":\"Failed to queue log clear request\"}");
    connection_queue_output_and_flush(c, (const uint8_t *)response, strlen(response));
    return;
  }

  /* Trigger SSE update to notify clients */
  status_trigger_event(STATUS_EVENT_SSE_UPDATE);

  send_http_headers(c, STATUS_200, "application/json", NULL);
  snprintf(response, sizeof(response), "{\"success\":true,\"message\":\"Logs cleared\"}");
  connection_queue_output_and_flush(c, (const uint8_t *)response, strlen(response));
}

void handle_set_log_level(connection_t *c) {
  int new_level;
  char response[512];
  char level_str[32] = {0};

  /* Check HTTP method */
  if (strcasecmp(c->http_req.method, "PUT") != 0 && strcasecmp(c->http_req.method, "PATCH") != 0) {
    send_http_headers(c, STATUS_400, "application/json", NULL);
    snprintf(response, sizeof(response),
             "{\"success\":false,\"error\":\"Method not allowed. Use PUT or "
             "PATCH\"}");
    connection_queue_output_and_flush(c, (const uint8_t *)response, strlen(response));
    return;
  }

  /* Parse form data body to get level */
  if (c->http_req.body_len > 0) {
    if (http_parse_query_param(c->http_req.body, "level", level_str, sizeof(level_str)) != 0) {
      send_http_headers(c, STATUS_400, "application/json", NULL);
      snprintf(response, sizeof(response),
               "{\"success\":false,\"error\":\"Missing 'level' parameter in "
               "request body\"}");
      connection_queue_output_and_flush(c, (const uint8_t *)response, strlen(response));
      return;
    }
  } else {
    send_http_headers(c, STATUS_400, "application/json", NULL);
    snprintf(response, sizeof(response), "{\"success\":false,\"error\":\"Missing request body\"}");
    connection_queue_output_and_flush(c, (const uint8_t *)response, strlen(response));
    return;
  }

  new_level = atoi(level_str);

  if (new_level < LOG_FATAL || new_level > LOG_DEBUG) {
    send_http_headers(c, STATUS_400, "application/json", NULL);
    snprintf(response, sizeof(response), "{\"success\":false,\"error\":\"Invalid log level (must be 0-4)\"}");
    connection_queue_output_and_flush(c, (const uint8_t *)response, strlen(response));
    return;
  }

  /* Update log level in shared memory and global config */
  if (status_shared) {
    status_shared->current_log_level = new_level;
  }
  send_http_headers(c, STATUS_200, "application/json", NULL);

  snprintf(response, sizeof(response), "{\"success\":true,\"message\":\"Log level changed to %s\"}",
           status_get_log_level_name(new_level));
  connection_queue_output_and_flush(c, (const uint8_t *)response, strlen(response));
}

void handle_reload_config(connection_t *c) {
  char response[256];

  /* Check HTTP method */
  if (strcasecmp(c->http_req.method, "POST") != 0) {
    send_http_headers(c, STATUS_400, "application/json", NULL);
    snprintf(response, sizeof(response), "{\"success\":false,\"error\":\"Method not allowed. Use POST\"}");
    connection_queue_output_and_flush(c, (const uint8_t *)response, strlen(response));
    return;
  }

  /* Get supervisor PID (parent process) */
  pid_t supervisor_pid = getppid();

  /* Send SIGHUP to supervisor */
  if (kill(supervisor_pid, SIGHUP) == 0) {
    send_http_headers(c, STATUS_200, "application/json", NULL);
    snprintf(response, sizeof(response), "{\"success\":true,\"message\":\"Configuration reload triggered\"}");
  } else {
    send_http_headers(c, STATUS_500, "application/json", NULL);
    snprintf(response, sizeof(response),
             "{\"success\":false,\"error\":\"Failed to send signal to "
             "supervisor: %s\"}",
             strerror(errno));
  }
  connection_queue_output_and_flush(c, (const uint8_t *)response, strlen(response));
}

void handle_restart_workers(connection_t *c) {
  char response[256];

  /* Check HTTP method */
  if (strcasecmp(c->http_req.method, "POST") != 0) {
    send_http_headers(c, STATUS_400, "application/json", NULL);
    snprintf(response, sizeof(response), "{\"success\":false,\"error\":\"Method not allowed. Use POST\"}");
    connection_queue_output_and_flush(c, (const uint8_t *)response, strlen(response));
    return;
  }

  /* Get supervisor PID (parent process) */
  pid_t supervisor_pid = getppid();

  /* Send SIGUSR1 to supervisor */
  if (kill(supervisor_pid, SIGUSR1) == 0) {
    send_http_headers(c, STATUS_200, "application/json", NULL);
    snprintf(response, sizeof(response), "{\"success\":true,\"message\":\"Worker restart triggered\"}");
  } else {
    send_http_headers(c, STATUS_500, "application/json", NULL);
    snprintf(response, sizeof(response),
             "{\"success\":false,\"error\":\"Failed to send signal to "
             "supervisor: %s\"}",
             strerror(errno));
  }
  connection_queue_output_and_flush(c, (const uint8_t *)response, strlen(response));
}

int status_handle_sse_init(connection_t *c) {
  if (!c)
    return -1;

  /* Send SSE headers */
  send_http_headers(c, STATUS_200, "text/event-stream", NULL);

  c->sse_sent_initial = 0;
  c->sse_last_log_epoch = 0;
  c->sse_last_log_sequence = 0;
  c->next_sse_ts = get_time_ms();

  /* Build and send initial SSE payload immediately */
  char tmp[SSE_BUFFER_SIZE];
  int len =
      status_build_sse_json(tmp, sizeof(tmp), &c->sse_sent_initial, &c->sse_last_log_epoch, &c->sse_last_log_sequence);

  if (len > 0) {
    connection_queue_output_and_flush(c, (const uint8_t *)tmp, (size_t)len);
  }

  c->state = CONN_SSE;

  return 0;
}

int status_handle_sse_notification(connection_t *conn_head) {
  int updated_count = 0;

  if (!status_shared)
    return 0;

  /* Build and enqueue SSE payloads for all SSE connections
   * Note: Each connection has its own state (sse_sent_initial,
   * per-connection log cursors, so we must build a separate
   * payload for each connection */
  for (connection_t *cc = conn_head; cc; cc = cc->next) {
    if (cc->state != CONN_SSE)
      continue;

    char tmp[SSE_BUFFER_SIZE];
    int len = status_build_sse_json(tmp, sizeof(tmp), &cc->sse_sent_initial, &cc->sse_last_log_epoch,
                                    &cc->sse_last_log_sequence);

    if (len > 0) {
      if (connection_queue_output_and_flush(cc, (const uint8_t *)tmp, (size_t)len) == 0) {
        cc->state = CONN_SSE;
        updated_count++;
      }
    }
  }

  return updated_count;
}

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
