#ifndef __STATUS_H__
#define __STATUS_H__

#include <stdint.h>
#include <sys/types.h>
#include <time.h>
#include <pthread.h>
#include "rtp2httpd.h"

/* Forward declarations */
typedef struct connection_s connection_t;

/* Maximum number of clients we can track in shared memory */
#define STATUS_MAX_CLIENTS 256

/* Event types for worker notification */
typedef enum
{
  STATUS_EVENT_SSE_UPDATE = 1,        /* SSE update event (client connect/disconnect/state change) */
  STATUS_EVENT_DISCONNECT_REQUEST = 2 /* Disconnect request from API */
} status_event_type_t;

/* Maximum number of workers for per-worker statistics */
#define STATUS_MAX_WORKERS 32

/* Maximum number of log entries to keep in circular buffer */
#define STATUS_MAX_LOG_ENTRIES 100
#define STATUS_LOG_ENTRY_LEN 1024

#define SSE_BUFFER_SIZE 262144 /* 256k */

/* Client state types for status display */
typedef enum
{
  CLIENT_STATE_CONNECTING = 0,
  CLIENT_STATE_FCC_INIT,
  CLIENT_STATE_FCC_REQUESTED,
  CLIENT_STATE_FCC_UNICAST_PENDING,
  CLIENT_STATE_FCC_UNICAST_ACTIVE,
  CLIENT_STATE_FCC_MCAST_REQUESTED,
  CLIENT_STATE_FCC_MCAST_ACTIVE,
  CLIENT_STATE_RTSP_INIT,
  CLIENT_STATE_RTSP_CONNECTING,
  CLIENT_STATE_RTSP_CONNECTED,
  CLIENT_STATE_RTSP_SENDING_OPTIONS,
  CLIENT_STATE_RTSP_AWAITING_OPTIONS,
  CLIENT_STATE_RTSP_SENDING_DESCRIBE,
  CLIENT_STATE_RTSP_AWAITING_DESCRIBE,
  CLIENT_STATE_RTSP_DESCRIBED,
  CLIENT_STATE_RTSP_SENDING_SETUP,
  CLIENT_STATE_RTSP_AWAITING_SETUP,
  CLIENT_STATE_RTSP_SETUP,
  CLIENT_STATE_RTSP_SENDING_PLAY,
  CLIENT_STATE_RTSP_AWAITING_PLAY,
  CLIENT_STATE_RTSP_PLAYING,
  CLIENT_STATE_RTSP_RECONNECTING,
  CLIENT_STATE_RTSP_SENDING_TEARDOWN,
  CLIENT_STATE_RTSP_AWAITING_TEARDOWN,
  CLIENT_STATE_RTSP_TEARDOWN_COMPLETE,
  CLIENT_STATE_RTSP_PAUSED,
  CLIENT_STATE_ERROR,
  CLIENT_STATE_DISCONNECTED
} client_state_type_t;

/* Per-client statistics stored in shared memory */
typedef struct
{
  int active;                        /* 1 if slot is active, 0 if free */
  pid_t worker_pid;                  /* Actual worker thread/process PID */
  int worker_index;                  /* Worker index (0-based, matches worker_id) */
  int64_t connect_time;              /* Connection timestamp in milliseconds */
  char client_addr[64];              /* Client IP address */
  char client_port[16];              /* Client port */
  char service_url[256];             /* Service URL being accessed */
  client_state_type_t state;         /* Current connection state */
  uint64_t bytes_sent;               /* Total bytes sent to client */
  uint32_t current_bandwidth;        /* Current bandwidth in bytes/sec */
  volatile int disconnect_requested; /* Set to 1 when disconnect is requested from API */
  size_t queue_bytes;                /* Current queued bytes */
  uint32_t queue_buffers;            /* Current queued buffers */
  size_t queue_limit_bytes;          /* Dynamic queue limit snapshot */
  size_t queue_bytes_highwater;      /* Peak queued bytes */
  uint32_t queue_buffers_highwater;  /* Peak queued buffers */
  uint64_t dropped_packets;          /* Total dropped packets */
  uint64_t dropped_bytes;            /* Total dropped bytes */
  uint32_t backpressure_events;      /* Times backpressure triggered */
  int slow_active;
} client_stats_t;

/* Log entry structure for circular buffer */
typedef struct
{
  int64_t timestamp; /* Timestamp in milliseconds */
  enum loglevel level;
  char message[STATUS_LOG_ENTRY_LEN];
} log_entry_t;

/**
 * Per-worker statistics
 * Each worker writes to its own slot to avoid contention
 * No atomic operations needed - readers aggregate all workers
 */
typedef struct
{
  pid_t worker_pid; /* Worker process PID */

  /* Client traffic statistics */
  uint64_t client_bytes_cumulative; /* Bytes sent to clients that have disconnected */

  /* Zero-copy send statistics */
  uint64_t total_sends;       /* Total number of sendmsg() calls */
  uint64_t total_completions; /* Total MSG_ZEROCOPY completions */
  uint64_t total_copied;      /* Times kernel copied instead of zero-copy */
  uint64_t eagain_count;      /* Number of EAGAIN/EWOULDBLOCK errors */
  uint64_t enobufs_count;     /* Number of ENOBUFS errors */
  uint64_t batch_sends;       /* Number of batched sends (size threshold) */

  /* Buffer pool statistics */
  uint64_t pool_total_buffers; /* Total number of buffers in pool */
  uint64_t pool_free_buffers;  /* Number of free buffers */
  uint64_t pool_max_buffers;   /* Maximum allowed buffers */
  uint64_t pool_expansions;    /* Number of times pool expanded */
  uint64_t pool_exhaustions;   /* Number of times pool was exhausted */
  uint64_t pool_shrinks;       /* Number of times pool shrank */

  /* Control/API buffer pool statistics */
  uint64_t control_pool_total_buffers;
  uint64_t control_pool_free_buffers;
  uint64_t control_pool_max_buffers;
  uint64_t control_pool_expansions;
  uint64_t control_pool_exhaustions;
  uint64_t control_pool_shrinks;
} worker_stats_t;

/* Shared memory structure for status information */
typedef struct
{
  /* Global statistics */
  int total_clients;
  uint64_t total_bytes_sent_cumulative; /* Bytes sent to clients that have disconnected */
  uint32_t total_bandwidth;
  int64_t server_start_time; /* Server start time in milliseconds */

  /* Log level control */
  enum loglevel current_log_level;

  /* Event notification for SSE updates */
  volatile int event_counter; /* Incremented when events occur (connect/disconnect/state change) */

  /* Per-worker notification pipes for SSE updates
   * Pipes are created BEFORE fork so all workers can access all write ends
   * When an event occurs, any worker can write to all other workers' pipes
   * Read ends are used by each worker in their epoll loop */
  int worker_notification_pipe_read_fds[STATUS_MAX_WORKERS]; /* Read ends of worker pipes, -1 if closed */
  int worker_notification_pipes[STATUS_MAX_WORKERS];         /* Write ends of worker pipes, -1 if inactive */

  /* Log circular buffer */
  pthread_mutex_t log_mutex; /* Mutex to protect log buffer writes */
  int log_write_index;
  int log_count;
  log_entry_t log_entries[STATUS_MAX_LOG_ENTRIES];

  /* Per-worker statistics (lock-free, each worker writes to its own slot) */
  worker_stats_t worker_stats[STATUS_MAX_WORKERS]; /* Per-worker statistics */

  /* Per-client statistics array */
  pthread_mutex_t clients_mutex; /* Mutex to protect client slot allocation */
  client_stats_t clients[STATUS_MAX_CLIENTS];
} status_shared_t;

/* Global pointer to shared memory segment */
extern status_shared_t *status_shared;

/**
 * Initialize status tracking system
 * Creates shared memory segment for IPC between parent and child processes
 * @return 0 on success, -1 on error
 */
int status_init(void);

/**
 * Cleanup status tracking system
 * Destroys shared memory segment
 */
void status_cleanup(void);

/**
 * Register a new streaming client connection in shared memory
 * Only called for media streaming clients, not for status/API requests
 * Called after routing determines the connection is for a media service
 * Allocates a free slot in the clients array under mutex protection
 * @param client_addr Client address structure
 * @param addr_len Address structure length
 * @param service_url Service URL string (e.g., HTTP request path)
 * @return Client slot index (status_index) on success, -1 on error
 */
int status_register_client(struct sockaddr_storage *client_addr, socklen_t addr_len,
                           const char *service_url);

/**
 * Unregister a streaming client connection from shared memory
 * Only called for media streaming clients that were previously registered
 * @param status_index Client slot index returned by status_register_client()
 */
void status_unregister_client(int status_index);

/**
 * Update client bytes and bandwidth by status index
 * Always triggers status event notification.
 * @param status_index Client slot index returned by status_register_client()
 * @param bytes_sent Total bytes sent
 * @param current_bandwidth Current bandwidth in bytes/sec
 */
void status_update_client_bytes(int status_index, uint64_t bytes_sent, uint32_t current_bandwidth);

/**
 * Update client state by status index
 * Always triggers status event notification.
 * @param status_index Client slot index returned by status_register_client()
 * @param state Current state
 */
void status_update_client_state(int status_index, client_state_type_t state);

void status_update_client_queue(int status_index,
                                size_t queue_bytes,
                                size_t queue_buffers,
                                size_t queue_limit_bytes,
                                size_t queue_bytes_highwater,
                                size_t queue_buffers_highwater,
                                uint64_t dropped_packets,
                                uint64_t dropped_bytes,
                                uint32_t backpressure_events,
                                int slow_active);

/**
 * Add log entry to circular buffer
 * Called by logger function to store logs for status page
 * @param level Log level
 * @param message Log message
 */
void status_add_log_entry(enum loglevel level, const char *message);

/**
 * Handle HTTP request for status page
 * Serves the HTML/CSS/JavaScript status page
 * @param c Connection object
 */
void handle_status_page(connection_t *c);

/**
 * Handle API request to disconnect a client
 * RESTful: POST/DELETE <status-path>/api/disconnect with form data body "client_id=123"
 * Sets disconnect flag in shared memory and notifies worker to close connection
 * @param c Connection object
 */
void handle_disconnect_client(connection_t *c);

/**
 * Handle API request to change log level
 * RESTful: PUT/PATCH <status-path>/api/log-level with form data body "level=2"
 * @param c Connection object
 */
void handle_set_log_level(connection_t *c);

/**
 * Get the notification pipe read fd for current worker (called after fork)
 * Also closes read fds for other workers to avoid fd leaks
 * @return notification pipe read fd on success, -1 on error
 */
int status_worker_get_notif_fd(void);

/**
 * Trigger an event notification to wake up workers
 * Called when significant events occur (connect/disconnect/state change/disconnect request)
 * @param event_type Type of event to trigger
 */
void status_trigger_event(status_event_type_t event_type);

/**
 * Get log level name string
 * @param level Log level enum value
 * @return String representation of log level
 */
const char *status_get_log_level_name(enum loglevel level);

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
                          int *p_last_log_count);

/**
 * Initialize SSE connection for a client
 * Sends SSE headers and sets up connection state for SSE streaming
 *
 * @param c Connection object
 * @return 0 on success, -1 on error
 */
int status_handle_sse_init(connection_t *c);

/**
 * Handle SSE notification event
 * Builds and enqueues SSE payloads for all active SSE connections
 *
 * @param conn_head Head of connection list
 * @return Number of connections updated
 */
int status_handle_sse_notification(connection_t *conn_head);

/**
 * Handle SSE heartbeat for a connection
 * Triggers status update to keep connection alive and update frontend
 * Only sends heartbeat when there are no active media clients (every 1s)
 * When clients are active, relies on event-driven updates
 *
 * @param c Connection object
 * @param now Current timestamp in milliseconds
 * @return 0 if processed, -1 if not needed
 */
int status_handle_sse_heartbeat(connection_t *c, int64_t now);

#endif /* __STATUS_H__ */
