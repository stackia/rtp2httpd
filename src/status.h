#ifndef __STATUS_H__
#define __STATUS_H__

#include <stdint.h>
#include <sys/types.h>
#include <time.h>
#include "rtp2httpd.h"

/* Maximum number of clients we can track in shared memory */
#define STATUS_MAX_CLIENTS 256

/* Maximum length of state description string */
#define STATUS_STATE_DESC_LEN 64

/* Maximum number of log entries to keep in circular buffer */
#define STATUS_MAX_LOG_ENTRIES 1000
#define STATUS_LOG_ENTRY_LEN 1024

/* Client state types for status display */
typedef enum
{
  CLIENT_STATE_CONNECTING = 0,
  CLIENT_STATE_FCC_INIT,
  CLIENT_STATE_FCC_REQUESTED,
  CLIENT_STATE_FCC_UNICAST_ACTIVE,
  CLIENT_STATE_FCC_MCAST_TRANSITION,
  CLIENT_STATE_FCC_MCAST_ACTIVE,
  CLIENT_STATE_RTSP_INIT,
  CLIENT_STATE_RTSP_CONNECTED,
  CLIENT_STATE_RTSP_DESCRIBED,
  CLIENT_STATE_RTSP_SETUP,
  CLIENT_STATE_RTSP_PLAYING,
  CLIENT_STATE_MULTICAST_ACTIVE,
  CLIENT_STATE_ERROR,
  CLIENT_STATE_DISCONNECTED
} client_state_type_t;

/* Per-client statistics stored in shared memory */
typedef struct
{
  pid_t pid;                              /* Process ID of client handler */
  int active;                             /* 1 if slot is active, 0 if free */
  time_t connect_time;                    /* Connection timestamp */
  char client_addr[64];                   /* Client IP address */
  char client_port[16];                   /* Client port */
  char service_url[256];                  /* Service URL being accessed */
  client_state_type_t state;              /* Current connection state */
  char state_desc[STATUS_STATE_DESC_LEN]; /* Human-readable state description */
  uint64_t bytes_sent;                    /* Total bytes sent to client */
  uint64_t packets_sent;                  /* Total packets sent */
  uint32_t current_bandwidth;             /* Current bandwidth in bytes/sec */
  time_t last_update;                     /* Last statistics update time */
} client_stats_t;

/* Log entry structure for circular buffer */
typedef struct
{
  time_t timestamp;
  enum loglevel level;
  char message[STATUS_LOG_ENTRY_LEN];
} log_entry_t;

/* Shared memory structure for status information */
typedef struct
{
  /* Global statistics */
  int total_clients;
  uint64_t total_bytes_sent;
  uint32_t total_bandwidth;
  time_t server_start_time;

  /* Log level control */
  enum loglevel current_log_level;

  /* Event notification for SSE updates */
  volatile int event_counter; /* Incremented when events occur (connect/disconnect/state change) */
  int notification_pipe[2];   /* Pipe for waking up SSE handlers */

  /* Log circular buffer */
  int log_write_index;
  int log_count;
  log_entry_t log_entries[STATUS_MAX_LOG_ENTRIES];

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
 * Update client state and statistics
 * Called by child process to update its status
 * @param state Current state
 * @param state_desc Human-readable state description
 * @param bytes_sent Total bytes sent
 * @param packets_sent Total packets sent
 */
void status_update_client(client_state_type_t state, const char *state_desc,
                          uint64_t bytes_sent, uint64_t packets_sent);

/**
 * Update client service URL
 * Called by child process when service is determined
 * @param service_url Service URL string
 */
void status_update_service(const char *service_url);

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
 * @param client_socket Client socket descriptor
 * @param is_http_1_1 Whether request is HTTP/1.1
 */
void handle_status_page(int client_socket, int is_http_1_1);

/**
 * Handle SSE (Server-Sent Events) endpoint for real-time updates
 * Streams status updates to connected clients
 * @param client_socket Client socket descriptor
 * @param is_http_1_1 Whether request is HTTP/1.1
 */
void handle_status_sse(int client_socket, int is_http_1_1);

/**
 * Handle API request to disconnect a client
 * @param client_socket Client socket descriptor
 * @param is_http_1_1 Whether request is HTTP/1.1
 * @param pid_str PID of client to disconnect (as string)
 */
void handle_disconnect_client(int client_socket, int is_http_1_1, const char *pid_str);

/**
 * Handle API request to change log level
 * @param client_socket Client socket descriptor
 * @param is_http_1_1 Whether request is HTTP/1.1
 * @param level_str New log level (as string)
 */
void handle_set_log_level(int client_socket, int is_http_1_1, const char *level_str);

/**
 * Get current process's client slot index
 * @return Client slot index, or -1 if not found
 */
int status_get_my_slot(void);

/**
 * Trigger an event notification to wake up SSE handlers
 * Called when significant events occur (connect/disconnect/state change)
 */
void status_trigger_event(void);

#endif /* __STATUS_H__ */
