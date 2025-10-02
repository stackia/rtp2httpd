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
#include <fcntl.h>
#include <errno.h>
#include <time.h>
#include <signal.h>
#include <netdb.h>
#include <arpa/inet.h>

#include "status.h"
#include "rtp2httpd.h"
#include "http.h"

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
  status_shared->server_start_time = time(NULL);
  status_shared->current_log_level = conf_verbosity;
  status_shared->event_counter = 0;

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

  logger(LOG_DEBUG, "Status tracking initialized");
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
      status_shared->clients[i].connect_time = time(NULL);
      strncpy(status_shared->clients[i].client_addr, hbuf, sizeof(status_shared->clients[i].client_addr) - 1);
      strncpy(status_shared->clients[i].client_port, sbuf, sizeof(status_shared->clients[i].client_port) - 1);
      status_shared->clients[i].state = CLIENT_STATE_CONNECTING;
      strncpy(status_shared->clients[i].state_desc, "Connecting", sizeof(status_shared->clients[i].state_desc) - 1);
      status_shared->clients[i].last_update = time(NULL);

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
      status_shared->clients[i].active = 0;
      status_shared->clients[i].state = CLIENT_STATE_DISCONNECTED;
      status_shared->total_clients--;

      /* Trigger event notification for client disconnect */
      status_trigger_event();

      return;
    }
  }
}

/**
 * Get current process's client slot index
 */
int status_get_my_slot(void)
{
  int i;
  pid_t my_pid = getpid();

  if (!status_shared)
    return -1;

  for (i = 0; i < STATUS_MAX_CLIENTS; i++)
  {
    if (status_shared->clients[i].active && status_shared->clients[i].pid == my_pid)
    {
      return i;
    }
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
 * Update client state and statistics
 */
void status_update_client(client_state_type_t state, const char *state_desc,
                          uint64_t bytes_sent, uint64_t packets_sent)
{
  int slot;
  time_t now;
  client_state_type_t old_state;
  int state_changed = 0;

  if (!status_shared)
    return;

  slot = status_get_my_slot();
  if (slot < 0)
    return;

  now = time(NULL);
  old_state = status_shared->clients[slot].state;

  /* Calculate bandwidth if enough time has passed */
  if (status_shared->clients[slot].last_update > 0)
  {
    time_t elapsed = now - status_shared->clients[slot].last_update;
    if (elapsed > 0)
    {
      uint64_t bytes_diff = bytes_sent - status_shared->clients[slot].bytes_sent;
      status_shared->clients[slot].current_bandwidth = (uint32_t)(bytes_diff / elapsed);
    }
  }

  /* Check if state changed */
  if (state != old_state)
    state_changed = 1;

  /* Update client statistics */
  status_shared->clients[slot].state = state;
  if (state_desc)
  {
    strncpy(status_shared->clients[slot].state_desc, state_desc,
            sizeof(status_shared->clients[slot].state_desc) - 1);
    status_shared->clients[slot].state_desc[sizeof(status_shared->clients[slot].state_desc) - 1] = '\0';
  }
  status_shared->clients[slot].bytes_sent = bytes_sent;
  status_shared->clients[slot].packets_sent = packets_sent;
  status_shared->clients[slot].last_update = now;

  /* Trigger event if state changed */
  if (state_changed)
    status_trigger_event();
}

/**
 * Update client service URL
 */
void status_update_service(const char *service_url)
{
  int slot;

  if (!status_shared || !service_url)
    return;

  slot = status_get_my_slot();
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

  /* Get next write index */
  index = status_shared->log_write_index;

  /* Store log entry */
  status_shared->log_entries[index].timestamp = time(NULL);
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
}

/* Removed format_bytes and format_bandwidth - formatting is done in JavaScript on the frontend */

/**
 * Get log level name
 */
static const char *get_log_level_name(enum loglevel level)
{
  switch (level)
  {
  case LOG_FATAL:
    return "FATAL";
  case LOG_ERROR:
    return "ERROR";
  case LOG_INFO:
    return "INFO";
  case LOG_DEBUG:
    return "DEBUG";
  default:
    return "UNKNOWN";
  }
}

/**
 * Handle API request to disconnect a client
 */
void handle_disconnect_client(int client_socket, int is_http_1_1, const char *pid_str)
{
  pid_t target_pid;
  int found = 0;
  char response[512];

  if (!pid_str)
  {
    if (is_http_1_1)
      send_http_headers(client_socket, STATUS_400, CONTENT_HTML);
    snprintf(response, sizeof(response),
             "{\"success\":false,\"error\":\"Missing PID parameter\"}");
    write_to_client(client_socket, (const uint8_t *)response, strlen(response));
    return;
  }

  target_pid = (pid_t)atoi(pid_str);

  /* Send kill signal to target process */
  if (kill(target_pid, SIGTERM) == 0)
  {
    found = 1;
  }

  if (is_http_1_1)
    send_http_headers(client_socket, STATUS_200, CONTENT_HTML);

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

  write_to_client(client_socket, (const uint8_t *)response, strlen(response));
}

/**
 * Handle API request to change log level
 */
void handle_set_log_level(int client_socket, int is_http_1_1, const char *level_str)
{
  int new_level;
  char response[512];

  if (!level_str)
  {
    if (is_http_1_1)
      send_http_headers(client_socket, STATUS_400, CONTENT_HTML);
    snprintf(response, sizeof(response),
             "{\"success\":false,\"error\":\"Missing level parameter\"}");
    write_to_client(client_socket, (const uint8_t *)response, strlen(response));
    return;
  }

  new_level = atoi(level_str);

  if (new_level < LOG_FATAL || new_level > LOG_DEBUG)
  {
    if (is_http_1_1)
      send_http_headers(client_socket, STATUS_400, CONTENT_HTML);
    snprintf(response, sizeof(response),
             "{\"success\":false,\"error\":\"Invalid log level (must be 0-3)\"}");
    write_to_client(client_socket, (const uint8_t *)response, strlen(response));
    return;
  }

  /* Update log level in shared memory and global config */
  if (status_shared)
  {
    status_shared->current_log_level = new_level;
  }
  conf_verbosity = new_level;

  if (is_http_1_1)
    send_http_headers(client_socket, STATUS_200, CONTENT_HTML);

  snprintf(response, sizeof(response),
           "{\"success\":true,\"message\":\"Log level changed to %s\"}",
           get_log_level_name(new_level));
  write_to_client(client_socket, (const uint8_t *)response, strlen(response));
}

/**
 * Handle HTTP request for status page
 */
void handle_status_page(int client_socket, int is_http_1_1)
{
/* Include the HTML content */
#include "status_page.h"

  if (is_http_1_1)
  {
    const char *headers =
        "HTTP/1.1 200 OK\r\n"
        "Content-Type: text/html; charset=utf-8\r\n"
        "Server: " PACKAGE "/" VERSION "\r\n"
        "\r\n";
    write_to_client(client_socket, (const uint8_t *)headers, strlen(headers));
  }

  write_to_client(client_socket, (const uint8_t *)status_page_html, strlen(status_page_html));
}

/**
 * Handle SSE endpoint for real-time updates
 */
void handle_status_sse(int client_socket, int is_http_1_1)
{
  size_t buffer_capacity = (size_t)STATUS_MAX_LOG_ENTRIES * STATUS_LOG_ENTRY_LEN * 2 + 65536;
  char *buffer = (char *)malloc(buffer_capacity);
  int allocated = 1;
  if (!buffer)
  {
    static char fallback[65536];
    buffer = fallback;
    buffer_capacity = sizeof(fallback);
    allocated = 0;
  }
  int i, log_start, log_idx;
  int last_write_index = -1;
  int last_log_count = 0;
  int sent_initial = 0;
  uint64_t total_bytes = 0;
  uint32_t total_bw = 0;
  (void)is_http_1_1; /* Unused parameter */

  if (!status_shared)
  {
    logger(LOG_ERROR, "Status shared memory not initialized");
    return;
  }

  /* Send SSE headers */
  const char *headers =
      "HTTP/1.1 200 OK\r\n"
      "Content-Type: text/event-stream\r\n"
      "Cache-Control: no-cache\r\n"
      "Connection: keep-alive\r\n"
      "Server: " PACKAGE "/" VERSION "\r\n"
      "\r\n";
  write_to_client(client_socket, (const uint8_t *)headers, strlen(headers));

  /* Send updates every 2 seconds */
  while (1)
  {
    total_bytes = 0;
    total_bw = 0;
    int streams_count = 0;

    /* Build JSON response - start with fields we already know, then clients */
    int len = snprintf(buffer, buffer_capacity,
                       "data: {\"server_start_time\":%ld,\"current_log_level\":%d,\"max_clients\":%d,\"clients\":[",
                       (long)status_shared->server_start_time,
                       status_shared->current_log_level,
                       conf_maxclients);

    /* Add client data (only real media streams: have a service_url) */
    int first_client = 1;
    for (i = 0; i < STATUS_MAX_CLIENTS; i++)
    {
      if (status_shared->clients[i].active && status_shared->clients[i].service_url[0] != '\0')
      {
        if (!first_client)
        {
          len += snprintf(buffer + len, buffer_capacity - len, ",");
        }
        first_client = 0;

        len += snprintf(buffer + len, buffer_capacity - len,
                        "{\"pid\":%d,\"connect_time\":%ld,\"client_addr\":\"%s\",\"client_port\":\"%s\","
                        "\"service_url\":\"%s\",\"state_desc\":\"%s\",\"bytes_sent\":%llu,"
                        "\"packets_sent\":%llu,\"current_bandwidth\":%u}",
                        status_shared->clients[i].pid,
                        (long)status_shared->clients[i].connect_time,
                        status_shared->clients[i].client_addr,
                        status_shared->clients[i].client_port,
                        status_shared->clients[i].service_url,
                        status_shared->clients[i].state_desc,
                        (unsigned long long)status_shared->clients[i].bytes_sent,
                        (unsigned long long)status_shared->clients[i].packets_sent,
                        status_shared->clients[i].current_bandwidth);

        streams_count++;
        total_bytes += status_shared->clients[i].bytes_sent;
        total_bw += status_shared->clients[i].current_bandwidth;
      }
    }

    /* Close clients array and add computed totals (count only media streams) */
    len += snprintf(buffer + len, buffer_capacity - len,
                    "],\"total_clients\":%d,\"total_bytes_sent\":%llu,\"total_bandwidth\":%u",
                    streams_count,
                    (unsigned long long)total_bytes,
                    total_bw);

    /* Decide logs mode and open logs array */
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
    len += snprintf(buffer + len, buffer_capacity - len, ",\"logs_mode\":\"%s\",\"logs\":[", logs_mode);

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
          {
            len += snprintf(buffer + len, buffer_capacity - len, ",");
          }
          first_log = 0;

          /* Escape JSON-breaking characters in log message */
          char escaped_msg[STATUS_LOG_ENTRY_LEN * 2];
          json_escape_string(status_shared->log_entries[log_idx].message, escaped_msg, sizeof(escaped_msg));

          len += snprintf(buffer + len, buffer_capacity - len,
                          "{\"timestamp\":%ld,\"level\":%d,\"level_name\":\"%s\",\"message\":\"%s\"}",
                          (long)status_shared->log_entries[log_idx].timestamp,
                          status_shared->log_entries[log_idx].level,
                          get_log_level_name(status_shared->log_entries[log_idx].level),
                          escaped_msg);
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
        {
          len += snprintf(buffer + len, buffer_capacity - len, ",");
        }
        first_log = 0;

        /* Escape JSON-breaking characters in log message */
        char escaped_msg[STATUS_LOG_ENTRY_LEN * 2];
        json_escape_string(status_shared->log_entries[log_idx].message, escaped_msg, sizeof(escaped_msg));

        len += snprintf(buffer + len, buffer_capacity - len,
                        "{\"timestamp\":%ld,\"level\":%d,\"level_name\":\"%s\",\"message\":\"%s\"}",
                        (long)status_shared->log_entries[log_idx].timestamp,
                        status_shared->log_entries[log_idx].level,
                        get_log_level_name(status_shared->log_entries[log_idx].level),
                        escaped_msg);
      }
      last_write_index = cur_wi;
      last_log_count = cur_count;
    }

    len += snprintf(buffer + len, buffer_capacity - len, "]}\n\n");

    /* Update global statistics */
    status_shared->total_bytes_sent = total_bytes;
    status_shared->total_bandwidth = total_bw;

    /* Send the event */
    if (write(client_socket, buffer, len) <= 0)
    {
      /* Client disconnected */
      break;
    }

    /* Wait for next event or timeout (1 second for bandwidth updates) */
    fd_set readfds;
    struct timeval timeout;
    int max_fd;
    char drain_buf[256];

    FD_ZERO(&readfds);
    FD_SET(status_shared->notification_pipe[0], &readfds);
    max_fd = status_shared->notification_pipe[0];

    timeout.tv_sec = 1; /* 1 second timeout for regular bandwidth updates */
    timeout.tv_usec = 0;

    int ret = select(max_fd + 1, &readfds, NULL, NULL, &timeout);

    if (ret > 0 && FD_ISSET(status_shared->notification_pipe[0], &readfds))
    {
      /* Drain the pipe */
      while (read(status_shared->notification_pipe[0], drain_buf, sizeof(drain_buf)) > 0)
        ;
    }
    /* If ret == 0, timeout occurred - send update anyway for bandwidth stats */
    /* If ret < 0, error occurred but we'll continue anyway */
  }
  /* Cleanup allocated buffer */
  if (allocated)
    free(buffer);
}
