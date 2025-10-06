#ifndef __STATUS_H__
#define __STATUS_H__

#include <stdint.h>
#include <sys/types.h>
#include <time.h>
#include <pthread.h>
#include "rtp2httpd.h"

/* Forward declarations */
struct connection_s;

/* Maximum number of clients we can track in shared memory */
#define STATUS_MAX_CLIENTS 256

/* Maximum number of workers for per-worker statistics */
#define STATUS_MAX_WORKERS 32

/* Maximum number of log entries to keep in circular buffer */
#define STATUS_MAX_LOG_ENTRIES 100
#define STATUS_LOG_ENTRY_LEN 1024

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
  pid_t pid;                  /* Synthetic connection ID (for internal tracking) */
  pid_t worker_pid;           /* Actual worker thread/process PID */
  int active;                 /* 1 if slot is active, 0 if free */
  int64_t connect_time;       /* Connection timestamp in milliseconds */
  char client_addr[64];       /* Client IP address */
  char client_port[16];       /* Client port */
  char service_url[256];      /* Service URL being accessed */
  client_state_type_t state;  /* Current connection state */
  uint64_t bytes_sent;        /* Total bytes sent to client */
  uint32_t current_bandwidth; /* Current bandwidth in bytes/sec */
} client_stats_t;

/* Log entry structure for circular buffer */
typedef struct
{
  int64_t timestamp; /* Timestamp in milliseconds */
  enum loglevel level;
  char message[STATUS_LOG_ENTRY_LEN];
} log_entry_t;

/**
 * Per-worker zero-copy statistics
 * Each worker writes to its own slot to avoid contention
 * No atomic operations needed - readers aggregate all workers
 */
typedef struct
{
  uint64_t total_sends;       /* Total number of sendmsg() calls */
  uint64_t total_completions; /* Total MSG_ZEROCOPY completions */
  uint64_t total_copied;      /* Times kernel copied instead of zero-copy */
  uint64_t eagain_count;      /* Number of EAGAIN/EWOULDBLOCK errors */
  uint64_t enobufs_count;     /* Number of ENOBUFS errors */
  uint64_t batch_sends;       /* Number of batched sends (size threshold) */
  uint64_t timeout_flushes;   /* Number of timeout-triggered flushes */
} worker_zerocopy_stats_t;

/* Shared memory structure for status information */
typedef struct
{
  /* Global statistics */
  int total_clients;
  uint64_t total_bytes_sent;
  uint32_t total_bandwidth;
  int64_t server_start_time; /* Server start time in milliseconds */

  /* Log level control */
  enum loglevel current_log_level;

  /* Event notification for SSE updates */
  volatile int event_counter; /* Incremented when events occur (connect/disconnect/state change) */
  int notification_pipe[2];   /* Pipe for waking up SSE handlers */

  /* Log circular buffer */
  pthread_mutex_t log_mutex; /* Mutex to protect log buffer writes */
  int log_write_index;
  int log_count;
  log_entry_t log_entries[STATUS_MAX_LOG_ENTRIES];

  /* Per-worker zero-copy statistics (lock-free, each worker writes to its own slot) */
  worker_zerocopy_stats_t worker_stats[STATUS_MAX_WORKERS]; /* Per-worker statistics */

  /* Per-client statistics array */
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
 * Register a new client connection in shared memory
 * Called by parent process when accepting a new client
 * @param pid Child process ID
 * @param client_addr Client address structure
 * @param addr_len Address structure length
 * @return Client slot index, or -1 on error
 */
int status_register_client(pid_t pid, struct sockaddr_storage *client_addr, socklen_t addr_len);

/**
 * Unregister a client connection from shared memory
 * Called by parent process when child exits
 * @param pid Child process ID
 */
void status_unregister_client(pid_t pid);

/**
 * Update client bytes and bandwidth by synthetic connection id (pid field)
 * Use this in multi-connection-per-process model.
 * Always triggers status event notification.
 * @param pid Synthetic id used at registration time
 * @param bytes_sent Total bytes sent
 * @param current_bandwidth Current bandwidth in bytes/sec
 */
void status_update_client_bytes(pid_t pid, uint64_t bytes_sent, uint32_t current_bandwidth);

/**
 * Update client state by synthetic connection id (pid field)
 * Use this in multi-connection-per-process model.
 * Always triggers status event notification.
 * @param pid Synthetic id used at registration time
 * @param state Current state
 */
void status_update_client_state(pid_t pid, client_state_type_t state);

/**
 * Update client service URL by synthetic connection id (pid field)
 * Use this in multi-connection-per-process model.
 * @param pid Synthetic id used at registration time
 * @param service_url Service URL string
 */
void status_update_service_by_pid(pid_t pid, const char *service_url);

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
void handle_status_page(struct connection_s *c);

/**
 * Handle API request to disconnect a client
 * RESTful: POST/DELETE /api/disconnect with form data body "pid=12345"
 * @param c Connection object
 */
void handle_disconnect_client(struct connection_s *c);

/**
 * Handle API request to change log level
 * RESTful: PUT/PATCH /api/loglevel with form data body "level=2"
 * @param c Connection object
 */
void handle_set_log_level(struct connection_s *c);

/**
 * Trigger an event notification to wake up SSE handlers
 * Called when significant events occur (connect/disconnect/state change)
 */
void status_trigger_event(void);

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
int status_handle_sse_init(struct connection_s *c);

/**
 * Handle SSE notification event
 * Builds and enqueues SSE payloads for all active SSE connections
 *
 * @param conn_head Head of connection list
 * @return Number of connections updated
 */
int status_handle_sse_notification(struct connection_s *conn_head);

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
int status_handle_sse_heartbeat(struct connection_s *c, int64_t now);

/**
 * Get aggregated zero-copy statistics from all workers
 * This function aggregates per-worker statistics from shared memory
 * @param stats Output: pointer to worker_zerocopy_stats_t structure to fill
 */
void status_get_zerocopy_stats(worker_zerocopy_stats_t *stats);

#endif /* __STATUS_H__ */
