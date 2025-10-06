#ifdef HAVE_CONFIG_H
#include "config.h"
#endif /* HAVE_CONFIG_H */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <sys/select.h>
#include <sys/epoll.h>
#include <fcntl.h>
#include <errno.h>
#include <time.h>
#include <signal.h>
#include <netdb.h>
#include <arpa/inet.h>

#include "status.h"
#include "rtp2httpd.h"
#include "connection.h"
#include "http.h"
#include "zerocopy.h"

/* State description lookup table */
static const char *client_state_descriptions[] = {
    [CLIENT_STATE_CONNECTING] = "Connecting",
    [CLIENT_STATE_FCC_INIT] = "FCC Init",
    [CLIENT_STATE_FCC_REQUESTED] = "FCC Requested",
    [CLIENT_STATE_FCC_UNICAST_PENDING] = "FCC Unicast Pending",
    [CLIENT_STATE_FCC_UNICAST_ACTIVE] = "FCC Unicast Active",
    [CLIENT_STATE_FCC_MCAST_REQUESTED] = "FCC Multicast Requested",
    [CLIENT_STATE_FCC_MCAST_ACTIVE] = "FCC Multicast Active",
    [CLIENT_STATE_RTSP_INIT] = "RTSP Init",
    [CLIENT_STATE_RTSP_CONNECTING] = "RTSP Connecting",
    [CLIENT_STATE_RTSP_CONNECTED] = "RTSP Connected",
    [CLIENT_STATE_RTSP_SENDING_DESCRIBE] = "RTSP Sending DESCRIBE",
    [CLIENT_STATE_RTSP_AWAITING_DESCRIBE] = "RTSP Awaiting DESCRIBE",
    [CLIENT_STATE_RTSP_DESCRIBED] = "RTSP Described",
    [CLIENT_STATE_RTSP_SENDING_SETUP] = "RTSP Sending SETUP",
    [CLIENT_STATE_RTSP_AWAITING_SETUP] = "RTSP Awaiting SETUP",
    [CLIENT_STATE_RTSP_SETUP] = "RTSP Setup",
    [CLIENT_STATE_RTSP_SENDING_PLAY] = "RTSP Sending PLAY",
    [CLIENT_STATE_RTSP_AWAITING_PLAY] = "RTSP Awaiting PLAY",
    [CLIENT_STATE_RTSP_PLAYING] = "RTSP Playing",
    [CLIENT_STATE_RTSP_RECONNECTING] = "RTSP Reconnecting",
    [CLIENT_STATE_RTSP_SENDING_TEARDOWN] = "RTSP Sending TEARDOWN",
    [CLIENT_STATE_RTSP_AWAITING_TEARDOWN] = "RTSP Awaiting TEARDOWN",
    [CLIENT_STATE_RTSP_TEARDOWN_COMPLETE] = "RTSP Teardown Complete",
    [CLIENT_STATE_RTSP_PAUSED] = "RTSP Paused",
    [CLIENT_STATE_ERROR] = "Error",
    [CLIENT_STATE_DISCONNECTED] = "Disconnected"};

/**
 * Get state description string from state enum
 * @param state Client state enum value
 * @return String representation of state
 */
static const char *status_get_state_description(client_state_type_t state)
{
  if (state < ARRAY_SIZE(client_state_descriptions) && client_state_descriptions[state])
  {
    return client_state_descriptions[state];
  }
  return "Unknown";
}

/* Helper: escape JSON string into out buffer */
static void json_escape_string(const char *in, char *out, size_t out_sz)
{
  const unsigned char *src = (const unsigned char *)in;
  char *dst = out;
  if (out_sz == 0)
    return;
  while (*src && (size_t)(dst - out) < out_sz - 1)
  {
    unsigned char c = *src++;
    if (c == '"' || c == '\\')
    {
      if ((size_t)(dst - out) + 2 >= out_sz)
        break;
      *dst++ = '\\';
      *dst++ = (char)c;
    }
    else if (c == '\n' || c == '\r' || c == '\t' || c == '\b' || c == '\f')
    {
      if ((size_t)(dst - out) + 2 >= out_sz)
        break;
      *dst++ = '\\';
      *dst++ = (c == '\n') ? 'n' : (c == '\r') ? 'r'
                               : (c == '\t')   ? 't'
                               : (c == '\b')   ? 'b'
                                               : 'f';
    }
    else if (c < 0x20)
    {
      /* Control chars as \u00XX */
      size_t rem = out_sz - (size_t)(dst - out);
      if (rem < 7)
        break;
      int n = snprintf(dst, rem, "\\u%04X", c);
      if (n <= 0 || (size_t)n >= rem)
        break;
      dst += n;
    }
    else
    {
      *dst++ = (char)c;
    }
  }
  *dst = '\0';
}

/* Global pointer to shared memory */
status_shared_t *status_shared = NULL;

/* Shared memory file descriptor */
static int shm_fd = -1;

/* Name for shared memory object */
#define SHM_NAME "/rtp2httpd_status"

/**
 * Initialize status tracking system
 */
int status_init(void)
{
  /* Create shared memory object */
  shm_fd = shm_open(SHM_NAME, O_CREAT | O_RDWR, 0600);
  if (shm_fd == -1)
  {
    logger(LOG_ERROR, "Failed to create shared memory: %s", strerror(errno));
    return -1;
  }

  /* Set size of shared memory */
  if (ftruncate(shm_fd, sizeof(status_shared_t)) == -1)
  {
    logger(LOG_ERROR, "Failed to set shared memory size: %s", strerror(errno));
    close(shm_fd);
    shm_unlink(SHM_NAME);
    return -1;
  }

  /* Map shared memory */
  status_shared = mmap(NULL, sizeof(status_shared_t),
                       PROT_READ | PROT_WRITE, MAP_SHARED, shm_fd, 0);
  if (status_shared == MAP_FAILED)
  {
    logger(LOG_ERROR, "Failed to map shared memory: %s", strerror(errno));
    close(shm_fd);
    shm_unlink(SHM_NAME);
    return -1;
  }

  /* Initialize shared memory structure */
  memset(status_shared, 0, sizeof(status_shared_t));
  status_shared->server_start_time = get_realtime_ms();
  status_shared->current_log_level = config.verbosity;
  status_shared->event_counter = 0;

  /* Initialize log mutex for multi-process safety */
  pthread_mutexattr_t mutex_attr;
  pthread_mutexattr_init(&mutex_attr);
  pthread_mutexattr_setpshared(&mutex_attr, PTHREAD_PROCESS_SHARED);
  pthread_mutex_init(&status_shared->log_mutex, &mutex_attr);
  pthread_mutexattr_destroy(&mutex_attr);

  /* Create notification pipe for event-driven SSE updates */
  if (pipe(status_shared->notification_pipe) == -1)
  {
    logger(LOG_ERROR, "Failed to create notification pipe: %s", strerror(errno));
    munmap(status_shared, sizeof(status_shared_t));
    close(shm_fd);
    shm_unlink(SHM_NAME);
    return -1;
  }

  /* Set pipe to non-blocking mode */
  int flags = fcntl(status_shared->notification_pipe[0], F_GETFL, 0);
  fcntl(status_shared->notification_pipe[0], F_SETFL, flags | O_NONBLOCK);

  logger(LOG_INFO, "Status tracking initialized");
  return 0;
}

/**
 * Cleanup status tracking system
 */
void status_cleanup(void)
{
  if (status_shared != NULL && status_shared != MAP_FAILED)
  {
    /* Close notification pipe */
    if (status_shared->notification_pipe[0] != -1)
      close(status_shared->notification_pipe[0]);
    if (status_shared->notification_pipe[1] != -1)
      close(status_shared->notification_pipe[1]);

    /* Destroy log mutex */
    pthread_mutex_destroy(&status_shared->log_mutex);

    munmap(status_shared, sizeof(status_shared_t));
    status_shared = NULL;
  }

  if (shm_fd != -1)
  {
    close(shm_fd);
    shm_fd = -1;
  }

  shm_unlink(SHM_NAME);
  logger(LOG_DEBUG, "Status tracking cleaned up");
}

/**
 * Register a new client connection
 */
int status_register_client(pid_t pid, struct sockaddr_storage *client_addr, socklen_t addr_len)
{
  int i;
  char hbuf[NI_MAXHOST], sbuf[NI_MAXSERV];

  if (!status_shared)
    return -1;

  /* Get client address string */
  int r = getnameinfo((struct sockaddr *)client_addr, addr_len,
                      hbuf, sizeof(hbuf), sbuf, sizeof(sbuf),
                      NI_NUMERICHOST | NI_NUMERICSERV);
  if (r != 0)
  {
    snprintf(hbuf, sizeof(hbuf), "unknown");
    snprintf(sbuf, sizeof(sbuf), "0");
  }

  /* Find free slot */
  for (i = 0; i < STATUS_MAX_CLIENTS; i++)
  {
    if (!status_shared->clients[i].active)
    {
      /* Initialize client slot */
      memset(&status_shared->clients[i], 0, sizeof(client_stats_t));
      status_shared->clients[i].active = 1;
      status_shared->clients[i].pid = pid;
      status_shared->clients[i].worker_pid = getpid(); /* Store actual worker PID */
      status_shared->clients[i].connect_time = get_realtime_ms();
      /* Copy client address and port, truncating if necessary (intentional for storage) */
      size_t addr_str_len = strlen(hbuf);
      if (addr_str_len >= sizeof(status_shared->clients[i].client_addr))
        addr_str_len = sizeof(status_shared->clients[i].client_addr) - 1;
      memcpy(status_shared->clients[i].client_addr, hbuf, addr_str_len);
      status_shared->clients[i].client_addr[addr_str_len] = '\0';

      size_t port_str_len = strlen(sbuf);
      if (port_str_len >= sizeof(status_shared->clients[i].client_port))
        port_str_len = sizeof(status_shared->clients[i].client_port) - 1;
      memcpy(status_shared->clients[i].client_port, sbuf, port_str_len);
      status_shared->clients[i].client_port[port_str_len] = '\0';
      status_shared->clients[i].state = CLIENT_STATE_CONNECTING;

      status_shared->total_clients++;

      /* Trigger event notification for new client */
      status_trigger_event();

      return i;
    }
  }

  logger(LOG_ERROR, "No free client slots in status tracking");
  return -1;
}

/**
 * Unregister a client connection
 */
void status_unregister_client(pid_t pid)
{
  int i;

  if (!status_shared)
    return;

  for (i = 0; i < STATUS_MAX_CLIENTS; i++)
  {
    if (status_shared->clients[i].active && status_shared->clients[i].pid == pid)
    {
      /* Accumulate this client's bytes_sent to global total before unregistering
       * This ensures total_bytes_sent persists even after client disconnects */
      status_shared->total_bytes_sent += status_shared->clients[i].bytes_sent;

      status_shared->clients[i].active = 0;
      status_shared->clients[i].state = CLIENT_STATE_DISCONNECTED;
      status_shared->total_clients--;

      /* Trigger event notification for client disconnect */
      status_trigger_event();

      return;
    }
  }
}

/* Helper: find slot index by pid-like identifier */
static int status_find_slot_by_pid(pid_t pid)
{
  int i;
  if (!status_shared)
    return -1;
  for (i = 0; i < STATUS_MAX_CLIENTS; i++)
  {
    if (status_shared->clients[i].active && status_shared->clients[i].pid == pid)
      return i;
  }
  return -1;
}

/**
 * Trigger an event notification to wake up SSE handlers
 */
void status_trigger_event(void)
{
  char byte = 1;
  ssize_t ret;

  if (!status_shared)
    return;

  /* Increment event counter */
  status_shared->event_counter++;

  /* Write to pipe to wake up any waiting SSE handlers */
  if (status_shared->notification_pipe[1] != -1)
  {
    ret = write(status_shared->notification_pipe[1], &byte, 1);
    (void)ret; /* Ignore return value - notification is best-effort */
  }
}

/**
 * Update client bytes and bandwidth by pid-like identifier
 * Always triggers status event notification.
 */
void status_update_client_bytes(pid_t pid, uint64_t bytes_sent, uint32_t current_bandwidth)
{
  int slot;

  if (!status_shared)
    return;

  slot = status_find_slot_by_pid(pid);
  if (slot < 0)
    return;

  /* Update client statistics */
  status_shared->clients[slot].bytes_sent = bytes_sent;
  status_shared->clients[slot].current_bandwidth = current_bandwidth;

  /* Always trigger event notification */
  status_trigger_event();
}

/**
 * Update client state by pid-like identifier
 * Always triggers status event notification.
 */
void status_update_client_state(pid_t pid, client_state_type_t state)
{
  int slot;

  if (!status_shared)
    return;

  slot = status_find_slot_by_pid(pid);
  if (slot < 0)
    return;

  /* Update client state */
  status_shared->clients[slot].state = state;

  /* Always trigger event notification */
  status_trigger_event();
}

/**
 * Update client service URL by pid-like identifier
 */
void status_update_service_by_pid(pid_t pid, const char *service_url)
{
  int slot;

  if (!status_shared || !service_url)
    return;

  slot = status_find_slot_by_pid(pid);
  if (slot < 0)
    return;

  strncpy(status_shared->clients[slot].service_url, service_url,
          sizeof(status_shared->clients[slot].service_url) - 1);
  status_shared->clients[slot].service_url[sizeof(status_shared->clients[slot].service_url) - 1] = '\0';
}

/**
 * Add log entry to circular buffer
 */
void status_add_log_entry(enum loglevel level, const char *message)
{
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
  status_shared->log_entries[index].message[sizeof(status_shared->log_entries[index].message) - 1] = '\0';

  /* Update write index (circular) */
  status_shared->log_write_index = (index + 1) % STATUS_MAX_LOG_ENTRIES;

  /* Update count */
  if (status_shared->log_count < STATUS_MAX_LOG_ENTRIES)
  {
    status_shared->log_count++;
  }

  /* Unlock mutex */
  pthread_mutex_unlock(&status_shared->log_mutex);

  /* Trigger SSE event for new log entries */
  status_trigger_event();
}

/* Removed format_bytes and format_bandwidth - formatting is done in JavaScript on the frontend */

/**
 * Get log level name (public function for SSE)
 */
const char *status_get_log_level_name(enum loglevel level)
{
  switch (level)
  {
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
                          int *p_sent_initial,
                          int *p_last_write_index,
                          int *p_last_log_count)
{
  if (!status_shared)
    return 0;

  int sent_initial = *p_sent_initial;
  int last_write_index = *p_last_write_index;
  int last_log_count = *p_last_log_count;
  int i, log_start, log_idx;
  uint64_t total_bytes = 0;
  uint32_t total_bw = 0;
  int streams_count = 0;

  int64_t current_time = get_realtime_ms();
  int64_t uptime_ms = current_time - status_shared->server_start_time;

  int len = snprintf(buffer, buffer_capacity,
                     "data: {\"server_start_time\":%lld,\"uptime_ms\":%lld,\"current_log_level\":%d,\"max_clients\":%d,\"clients\":[",
                     (long long)status_shared->server_start_time,
                     (long long)uptime_ms,
                     status_shared->current_log_level,
                     config.maxclients);

  /* Add client data (only real media streams: have a service_url) */
  int first_client = 1;
  for (i = 0; i < STATUS_MAX_CLIENTS; i++)
  {
    if (status_shared->clients[i].active && status_shared->clients[i].service_url[0] != '\0')
    {
      if (!first_client)
        len += snprintf(buffer + len, buffer_capacity - (size_t)len, ",");
      first_client = 0;

      /* Get state description from lookup table */
      const char *state_desc = status_get_state_description(status_shared->clients[i].state);

      int64_t duration_ms = current_time - status_shared->clients[i].connect_time;

      len += snprintf(buffer + len, buffer_capacity - (size_t)len,
                      "{\"pid\":%d,\"worker_pid\":%d,\"connect_time\":%lld,\"duration_ms\":%lld,\"client_addr\":\"%s\",\"client_port\":\"%s\","
                      "\"service_url\":\"%s\",\"state_desc\":\"%s\",\"bytes_sent\":%llu,"
                      "\"current_bandwidth\":%u}",
                      status_shared->clients[i].pid,
                      status_shared->clients[i].worker_pid,
                      (long long)status_shared->clients[i].connect_time,
                      (long long)duration_ms,
                      status_shared->clients[i].client_addr,
                      status_shared->clients[i].client_port,
                      status_shared->clients[i].service_url,
                      state_desc,
                      (unsigned long long)status_shared->clients[i].bytes_sent,
                      status_shared->clients[i].current_bandwidth);

      streams_count++;
      total_bytes += status_shared->clients[i].bytes_sent;
      total_bw += status_shared->clients[i].current_bandwidth;
    }
  }

  /* Close clients array and add computed totals
   * total_bytes_sent = accumulated bytes from disconnected clients + current active clients */
  uint64_t cumulative_total_bytes = status_shared->total_bytes_sent + total_bytes;
  len += snprintf(buffer + len, buffer_capacity - (size_t)len,
                  "],\"total_clients\":%d,\"total_bytes_sent\":%llu,\"total_bandwidth\":%u",
                  streams_count,
                  (unsigned long long)cumulative_total_bytes,
                  total_bw);

  /* Get aggregated worker statistics from shared memory */
  worker_stats_t stats;
  status_get_worker_stats(&stats);

  /* Add buffer pool statistics (aggregated from all workers) */
  uint64_t pool_total = stats.pool_total_buffers;
  uint64_t pool_free = stats.pool_free_buffers;
  uint64_t pool_used = pool_total > pool_free ? pool_total - pool_free : 0;
  len += snprintf(buffer + len, buffer_capacity - (size_t)len,
                  ",\"pool\":{\"total\":%llu,\"free\":%llu,\"used\":%llu,\"max\":%llu,"
                  "\"expansions\":%llu,\"exhaustions\":%llu,\"shrinks\":%llu,\"utilization\":%.1f}",
                  (unsigned long long)pool_total,
                  (unsigned long long)pool_free,
                  (unsigned long long)pool_used,
                  (unsigned long long)stats.pool_max_buffers,
                  (unsigned long long)stats.pool_expansions,
                  (unsigned long long)stats.pool_exhaustions,
                  (unsigned long long)stats.pool_shrinks,
                  pool_total > 0 ? (100.0 * pool_used / pool_total) : 0.0);

  /* Add zero-copy send statistics */
  len += snprintf(buffer + len, buffer_capacity - (size_t)len,
                  ",\"send\":{\"total\":%llu,"
                  "\"completions\":%llu,\"copied\":%llu,"
                  "\"eagain\":%llu,\"enobufs\":%llu,"
                  "\"batch\":%llu,\"timeout_flush\":%llu}",
                  (unsigned long long)stats.total_sends,
                  (unsigned long long)stats.total_completions,
                  (unsigned long long)stats.total_copied,
                  (unsigned long long)stats.eagain_count,
                  (unsigned long long)stats.enobufs_count,
                  (unsigned long long)stats.batch_sends,
                  (unsigned long long)stats.timeout_flushes);

  /* Decide logs mode */
  const char *logs_mode = "none";
  int cur_wi = status_shared->log_write_index;
  int cur_count = status_shared->log_count;
  int new_entries = 0;
  if (!sent_initial)
  {
    logs_mode = "full";
  }
  else
  {
    int delta_idx = (cur_wi - last_write_index + STATUS_MAX_LOG_ENTRIES) % STATUS_MAX_LOG_ENTRIES;
    new_entries = delta_idx;
    if (cur_count < STATUS_MAX_LOG_ENTRIES)
    {
      int count_delta = cur_count - last_log_count;
      if (count_delta < 0)
        count_delta = 0;
      if (new_entries > count_delta)
        new_entries = count_delta;
    }
    logs_mode = (new_entries > 0) ? "incremental" : "none";
  }

  /* Add logs section */
  len += snprintf(buffer + len, buffer_capacity - (size_t)len, ",\"logs_mode\":\"%s\",\"logs\":[", logs_mode);

  /* Add logs according to mode */
  if (!sent_initial)
  {
    /* Full dump: all available logs */
    int full_count = cur_count;
    if (full_count > 0)
    {
      if (cur_count < STATUS_MAX_LOG_ENTRIES)
        log_start = 0;
      else
        log_start = cur_wi;

      int first_log = 1;
      for (i = 0; i < full_count; i++)
      {
        log_idx = (log_start + cur_count - full_count + i) % STATUS_MAX_LOG_ENTRIES;
        if (!first_log)
          len += snprintf(buffer + len, buffer_capacity - (size_t)len, ",");
        first_log = 0;

        char escaped[STATUS_LOG_ENTRY_LEN * 2];
        json_escape_string(status_shared->log_entries[log_idx].message, escaped, sizeof(escaped));

        len += snprintf(buffer + len, buffer_capacity - (size_t)len,
                        "{\"timestamp\":%lld,\"level\":%d,\"level_name\":\"%s\",\"message\":\"%s\"}",
                        (long long)status_shared->log_entries[log_idx].timestamp,
                        status_shared->log_entries[log_idx].level,
                        status_get_log_level_name(status_shared->log_entries[log_idx].level),
                        escaped);
      }
    }
    sent_initial = 1;
    last_write_index = cur_wi;
    last_log_count = cur_count;
  }
  else if (new_entries > 0)
  {
    /* Incremental: only new entries since last_write_index */
    int first_log = 1;
    int start_idx = (cur_wi - new_entries + STATUS_MAX_LOG_ENTRIES) % STATUS_MAX_LOG_ENTRIES;
    for (i = 0; i < new_entries; i++)
    {
      log_idx = (start_idx + i) % STATUS_MAX_LOG_ENTRIES;
      if (!first_log)
        len += snprintf(buffer + len, buffer_capacity - (size_t)len, ",");
      first_log = 0;

      char escaped[STATUS_LOG_ENTRY_LEN * 2];
      json_escape_string(status_shared->log_entries[log_idx].message, escaped, sizeof(escaped));

      len += snprintf(buffer + len, buffer_capacity - (size_t)len,
                      "{\"timestamp\":%ld,\"level\":%d,\"level_name\":\"%s\",\"message\":\"%s\"}",
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
 * RESTful: POST /api/disconnect with form data body "pid=12345"
 */
void handle_disconnect_client(connection_t *c)
{
  pid_t target_pid;
  int found = 0;
  char response[512];
  char pid_str[32] = {0};

  /* Check HTTP method */
  if (strcasecmp(c->http_req.method, "POST") != 0 && strcasecmp(c->http_req.method, "DELETE") != 0)
  {
    if (c->http_req.is_http_1_1)
      send_http_headers(c, STATUS_400, CONTENT_HTML);
    snprintf(response, sizeof(response),
             "{\"success\":false,\"error\":\"Method not allowed. Use POST or DELETE\"}");
    connection_queue_output(c, (const uint8_t *)response, strlen(response));
    return;
  }

  /* Parse form data body to get PID */
  if (c->http_req.body_len > 0)
  {
    if (http_parse_query_param(c->http_req.body, "pid", pid_str, sizeof(pid_str)) != 0)
    {
      if (c->http_req.is_http_1_1)
        send_http_headers(c, STATUS_400, CONTENT_HTML);
      snprintf(response, sizeof(response),
               "{\"success\":false,\"error\":\"Missing 'pid' parameter in request body\"}");
      connection_queue_output(c, (const uint8_t *)response, strlen(response));
      return;
    }
  }
  else
  {
    if (c->http_req.is_http_1_1)
      send_http_headers(c, STATUS_400, CONTENT_HTML);
    snprintf(response, sizeof(response),
             "{\"success\":false,\"error\":\"Missing request body\"}");
    connection_queue_output(c, (const uint8_t *)response, strlen(response));
    return;
  }

  target_pid = (pid_t)atoi(pid_str);

  /* Send kill signal to target process */
  if (kill(target_pid, SIGTERM) == 0)
  {
    found = 1;
  }

  if (c->http_req.is_http_1_1)
    send_http_headers(c, STATUS_200, CONTENT_HTML);

  if (found)
  {
    snprintf(response, sizeof(response),
             "{\"success\":true,\"message\":\"Client disconnected\"}");
  }
  else
  {
    snprintf(response, sizeof(response),
             "{\"success\":false,\"error\":\"Client not found or already disconnected\"}");
  }

  connection_queue_output(c, (const uint8_t *)response, strlen(response));
}

/**
 * Handle API request to change log level
 * RESTful: PUT /api/loglevel with form data body "level=2"
 */
void handle_set_log_level(connection_t *c)
{
  int new_level;
  char response[512];
  char level_str[32] = {0};

  /* Check HTTP method */
  if (strcasecmp(c->http_req.method, "PUT") != 0 && strcasecmp(c->http_req.method, "PATCH") != 0)
  {
    if (c->http_req.is_http_1_1)
      send_http_headers(c, STATUS_400, CONTENT_HTML);
    snprintf(response, sizeof(response),
             "{\"success\":false,\"error\":\"Method not allowed. Use PUT or PATCH\"}");
    connection_queue_output(c, (const uint8_t *)response, strlen(response));
    return;
  }

  /* Parse form data body to get level */
  if (c->http_req.body_len > 0)
  {
    if (http_parse_query_param(c->http_req.body, "level", level_str, sizeof(level_str)) != 0)
    {
      if (c->http_req.is_http_1_1)
        send_http_headers(c, STATUS_400, CONTENT_HTML);
      snprintf(response, sizeof(response),
               "{\"success\":false,\"error\":\"Missing 'level' parameter in request body\"}");
      connection_queue_output(c, (const uint8_t *)response, strlen(response));
      return;
    }
  }
  else
  {
    if (c->http_req.is_http_1_1)
      send_http_headers(c, STATUS_400, CONTENT_HTML);
    snprintf(response, sizeof(response),
             "{\"success\":false,\"error\":\"Missing request body\"}");
    connection_queue_output(c, (const uint8_t *)response, strlen(response));
    return;
  }

  new_level = atoi(level_str);

  if (new_level < LOG_FATAL || new_level > LOG_DEBUG)
  {
    if (c->http_req.is_http_1_1)
      send_http_headers(c, STATUS_400, CONTENT_HTML);
    snprintf(response, sizeof(response),
             "{\"success\":false,\"error\":\"Invalid log level (must be 0-4)\"}");
    connection_queue_output(c, (const uint8_t *)response, strlen(response));
    return;
  }

  /* Update log level in shared memory and global config */
  if (status_shared)
  {
    status_shared->current_log_level = new_level;
  }
  config.verbosity = new_level;

  if (c->http_req.is_http_1_1)
    send_http_headers(c, STATUS_200, CONTENT_HTML);

  snprintf(response, sizeof(response),
           "{\"success\":true,\"message\":\"Log level changed to %s\"}",
           status_get_log_level_name(new_level));
  connection_queue_output(c, (const uint8_t *)response, strlen(response));
}

/**
 * Handle HTTP request for status page
 */
void handle_status_page(connection_t *c)
{
/* Include the HTML content */
#include "status_page.h"

  if (c->http_req.is_http_1_1)
  {
    const char *headers =
        "HTTP/1.1 200 OK\r\n"
        "Content-Type: text/html; charset=utf-8\r\n"
        "Server: " PACKAGE "/" VERSION "\r\n"
        "\r\n";
    connection_queue_output(c, (const uint8_t *)headers, strlen(headers));
  }

  connection_queue_output(c, (const uint8_t *)status_page_html, strlen(status_page_html));
}

/**
 * Initialize SSE connection for a client
 * Sends SSE headers and sets up connection state for SSE streaming
 */
int status_handle_sse_init(connection_t *c)
{
  if (!c)
    return -1;

  /* Send SSE headers */
  send_http_headers(c, STATUS_200, CONTENT_SSE);

  c->sse_active = 1;
  c->sse_sent_initial = 0;
  c->sse_last_write_index = -1;
  c->sse_last_log_count = 0;
  c->next_sse_ts = get_time_ms();

  /* Build and send initial SSE payload immediately */
  char tmp[SSE_BUFFER_SIZE];
  int len = status_build_sse_json(tmp, sizeof(tmp),
                                  &c->sse_sent_initial,
                                  &c->sse_last_write_index,
                                  &c->sse_last_log_count);

  if (len > 0)
  {
    connection_queue_output(c, (const uint8_t *)tmp, (size_t)len);
  }

  c->state = CONN_SSE;

  return 0;
}

/**
 * Handle SSE notification event
 * Builds and enqueues SSE payloads for all active SSE connections
 */
int status_handle_sse_notification(connection_t *conn_head)
{
  int updated_count = 0;

  if (!status_shared)
    return 0;

  /* Build and enqueue SSE payloads for all SSE connections */
  for (connection_t *cc = conn_head; cc; cc = cc->next)
  {
    if (!cc->sse_active)
      continue;

    char tmp[SSE_BUFFER_SIZE];
    int len = status_build_sse_json(tmp, sizeof(tmp),
                                    &cc->sse_sent_initial,
                                    &cc->sse_last_write_index,
                                    &cc->sse_last_log_count);

    if (len > 0)
    {
      if (connection_queue_output(cc, (const uint8_t *)tmp, (size_t)len) == 0)
      {
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
int status_handle_sse_heartbeat(connection_t *c, int64_t now)
{
  if (!c || !c->sse_active)
    return -1;

  /* Check if heartbeat is needed */
  if (c->next_sse_ts > now)
    return -1;

  /* Count active media streaming clients (those with service_url) */
  int streams_count = 0;
  if (status_shared)
  {
    for (int i = 0; i < STATUS_MAX_CLIENTS; i++)
    {
      if (status_shared->clients[i].active && status_shared->clients[i].service_url[0] != '\0')
      {
        streams_count++;
      }
    }
  }

  /* Only trigger status update when there are no active media clients
   * When clients are active, rely on event-driven updates (connect/disconnect/state changes) */
  if (streams_count == 0)
  {
    /* Trigger status update event - this will update all SSE connections via notification pipe */
    status_trigger_event();
    c->next_sse_ts = now + 1000;
  }

  return 0;
}

/**
 * Get aggregated worker statistics from all workers
 * This function aggregates per-worker statistics from shared memory
 */
void status_get_worker_stats(worker_stats_t *stats)
{
  if (!stats)
    return;

  memset(stats, 0, sizeof(*stats));

  /* Aggregate statistics from all workers */
  if (status_shared)
  {
    for (int i = 0; i < config.workers && i < STATUS_MAX_WORKERS; i++)
    {
      /* Zero-copy send statistics */
      stats->total_sends += status_shared->worker_stats[i].total_sends;
      stats->total_completions += status_shared->worker_stats[i].total_completions;
      stats->total_copied += status_shared->worker_stats[i].total_copied;
      stats->eagain_count += status_shared->worker_stats[i].eagain_count;
      stats->enobufs_count += status_shared->worker_stats[i].enobufs_count;
      stats->batch_sends += status_shared->worker_stats[i].batch_sends;
      stats->timeout_flushes += status_shared->worker_stats[i].timeout_flushes;

      /* Buffer pool statistics */
      stats->pool_total_buffers += status_shared->worker_stats[i].pool_total_buffers;
      stats->pool_free_buffers += status_shared->worker_stats[i].pool_free_buffers;
      stats->pool_max_buffers = status_shared->worker_stats[i].pool_max_buffers;
      stats->pool_expansions += status_shared->worker_stats[i].pool_expansions;
      stats->pool_exhaustions += status_shared->worker_stats[i].pool_exhaustions;
      stats->pool_shrinks += status_shared->worker_stats[i].pool_shrinks;
    }
  }
}
