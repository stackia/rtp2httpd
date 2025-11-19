#ifndef __RTSP_H__
#define __RTSP_H__

#include <stdint.h>
#include <sys/types.h>

#define RTSP_DISABLE_TCP_TRANSPORT 0 /* To debug UDP transport, set to 1 */

/* ========== RTSP BUFFER SIZE CONFIGURATION ========== */

/* RTCP buffer size - same as RTP buffer pool for consistency */
#define RTCP_BUFFER_SIZE 1536

/* RTSP response buffer - for server responses and SDP descriptions */
#define RTSP_RESPONSE_BUFFER_SIZE 4096

/* RTSP request buffer - for building outgoing requests */
#define RTSP_REQUEST_BUFFER_SIZE 4096

/* RTSP headers buffer - for extra headers in requests */
#define RTSP_HEADERS_BUFFER_SIZE 1024

/* RTSP session ID - server-generated session identifier */
#define RTSP_SESSION_ID_SIZE 128

/* RTSP server URL - complete RTSP URL */
#define RTSP_SERVER_URL_SIZE 1024

/* RTSP server hostname - DNS name or IP address */
#define RTSP_SERVER_HOST_SIZE 256

/* RTSP server path - path component of URL with query string */
#define RTSP_SERVER_PATH_SIZE 1024

#define RTSP_CREDENTIAL_SIZE 128

/* RTSP playseek range - for Range header in PLAY command */
#define RTSP_PLAYSEEK_RANGE_SIZE 256

/* URL copy buffer - for URL parsing operations */
#define RTSP_URL_COPY_SIZE 1024

/* Time conversion buffers - for playseek time formatting */
#define RTSP_TIME_STRING_SIZE 64
#define RTSP_TIME_COMPONENT_SIZE 32

/* Port string buffer - for port number conversion */
#define RTSP_PORT_STRING_SIZE 16

/* Header parsing buffer - for individual header values */
#define RTSP_HEADER_PREFIX_SIZE 64

/* ========== RTSP MESSAGE TYPES ========== */

#define RTSP_METHOD_OPTIONS "OPTIONS"
#define RTSP_METHOD_DESCRIBE "DESCRIBE"
#define RTSP_METHOD_SETUP "SETUP"
#define RTSP_METHOD_PLAY "PLAY"
#define RTSP_METHOD_TEARDOWN "TEARDOWN"
#define RTSP_METHOD_GET_PARAMETER "GET_PARAMETER"
#define RTSP_METHOD_SET_PARAMETER "SET_PARAMETER"

/* RTSP authentication types */
typedef enum {
  RTSP_AUTH_NONE = 0,
  RTSP_AUTH_BASIC,
  RTSP_AUTH_DIGEST
} rtsp_auth_type_t;

/* RTSP protocol states - fully async state machine */
typedef enum {
  RTSP_STATE_INIT = 0,
  RTSP_STATE_CONNECTING,        /* Async TCP connection in progress */
  RTSP_STATE_CONNECTED,         /* Connected, ready to send OPTIONS */
  RTSP_STATE_SENDING_OPTIONS,   /* Sending OPTIONS request */
  RTSP_STATE_AWAITING_OPTIONS,  /* Waiting for OPTIONS response */
  RTSP_STATE_SENDING_DESCRIBE,  /* Sending DESCRIBE request */
  RTSP_STATE_AWAITING_DESCRIBE, /* Waiting for DESCRIBE response */
  RTSP_STATE_DESCRIBED,         /* DESCRIBE complete, ready to send SETUP */
  RTSP_STATE_SENDING_SETUP,     /* Sending SETUP request */
  RTSP_STATE_AWAITING_SETUP,    /* Waiting for SETUP response */
  RTSP_STATE_SETUP,             /* SETUP complete, ready to send PLAY */
  RTSP_STATE_SENDING_PLAY,      /* Sending PLAY request */
  RTSP_STATE_AWAITING_PLAY,     /* Waiting for PLAY response */
  RTSP_STATE_PLAYING,           /* PLAY complete, streaming active */
  RTSP_STATE_RECONNECTING,      /* Reconnecting to send TEARDOWN */
  RTSP_STATE_SENDING_TEARDOWN,  /* Sending TEARDOWN request */
  RTSP_STATE_AWAITING_TEARDOWN, /* Waiting for TEARDOWN response */
  RTSP_STATE_TEARDOWN_COMPLETE, /* TEARDOWN complete, ready to close */
  RTSP_STATE_PAUSED,
  RTSP_STATE_ERROR
} rtsp_state_t;

/* Transport mode types */
typedef enum {
  RTSP_TRANSPORT_UDP = 0, /* Traditional UDP transport */
  RTSP_TRANSPORT_TCP      /* TCP interleaved transport */
} rtsp_transport_mode_t;

/* Transport protocol types */
typedef enum {
  RTSP_PROTOCOL_RTP = 0, /* RTP - Media over RTP (needs RTP unwrapping) */
  RTSP_PROTOCOL_MP2T,    /* MP2T - Direct MPEG-2 TS (no RTP unwrapping) */
} rtsp_transport_protocol_t;

/* RTSP session structure */
typedef struct {
  int socket;                /* TCP socket to RTSP server */
  int epoll_fd;              /* Epoll file descriptor for socket registration */
  struct connection_s *conn; /* Connection pointer for fdmap registration */
  rtsp_state_t state;        /* Current RTSP state */
  int status_index; /* Index in status_shared->clients array for state updates
                     */
  uint32_t cseq;    /* RTSP sequence number */
  char session_id[RTSP_SESSION_ID_SIZE];   /* RTSP session ID */
  char server_url[RTSP_SERVER_URL_SIZE];   /* Full RTSP URL */
  char server_host[RTSP_SERVER_HOST_SIZE]; /* RTSP server hostname */
  int server_port;                         /* RTSP server port */
  char server_path[RTSP_SERVER_PATH_SIZE]; /* RTSP path with query string */
  int redirect_count;                      /* Number of redirects followed */

  /* Authentication state */
  char username[RTSP_CREDENTIAL_SIZE]; /* RTSP username for authentication */
  char password[RTSP_CREDENTIAL_SIZE]; /* RTSP password for authentication */
  rtsp_auth_type_t auth_type; /* Authentication type required by server */
  char auth_realm[RTSP_CREDENTIAL_SIZE];  /* Digest auth realm */
  char auth_nonce[RTSP_CREDENTIAL_SIZE];  /* Digest auth nonce */
  char auth_opaque[RTSP_CREDENTIAL_SIZE]; /* Digest auth opaque */
  int auth_retry_count; /* Number of auth retries (prevent infinite loops) */

  /* Transport mode configuration */
  rtsp_transport_mode_t transport_mode;         /* Current transport mode */
  rtsp_transport_protocol_t transport_protocol; /* Current transport protocol */

  /* TCP interleaved transport info */
  int rtp_channel;  /* RTP interleaved channel (usually 0) */
  int rtcp_channel; /* RTCP interleaved channel (usually 1) */

  /* RTP/UDP transport info (preserved for future use) */
  int rtp_socket;       /* Local RTP receiving socket */
  int rtcp_socket;      /* Local RTCP receiving socket */
  int local_rtp_port;   /* Local RTP port */
  int local_rtcp_port;  /* Local RTCP port */
  int server_rtp_port;  /* Server RTP port */
  int server_rtcp_port; /* Server RTCP port */
  char server_source_addr[RTSP_SERVER_HOST_SIZE]; /* Server UDP source address
                                                     for NAT traversal */

  /* RTP packet tracking for loss detection */
  uint16_t current_seqn;     /* Last received RTP sequence number */
  uint16_t not_first_packet; /* Flag indicating first packet received */

  /* Statistics */
  uint64_t packets_dropped; /* Packets dropped due to backpressure */

  /* Cleanup state */
  int cleanup_done; /* Flag: cleanup has been completed */

  /* Non-blocking I/O state */
  char pending_request[RTSP_REQUEST_BUFFER_SIZE]; /* Request being sent */
  size_t pending_request_len;  /* Total length of pending request */
  size_t pending_request_sent; /* Bytes already sent */
  size_t response_buffer_pos;  /* Current position in response buffer */
  int awaiting_response;       /* Flag: waiting for response */

  /* Keepalive tracking */
  int keepalive_interval_ms; /* Keepalive interval (0 = disabled) */
  int64_t last_keepalive_ms; /* Timestamp of last keepalive */
  int keepalive_pending;     /* Pending keepalive request queued for send */
  int awaiting_keepalive_response; /* Awaiting keepalive response */
  int use_get_parameter; /* Use GET_PARAMETER for keepalive (1), fallback to
                            OPTIONS (0) */

  /* Teardown and cleanup state */
  int teardown_requested;      /* Flag: TEARDOWN has been requested (cleanup
                                  initiated) */
  int teardown_reconnect_done; /* Flag: Already attempted reconnect for TEARDOWN
                                */
  rtsp_state_t state_before_teardown; /* State before TEARDOWN was initiated */

  /* Buffering */
  uint8_t response_buffer[RTSP_RESPONSE_BUFFER_SIZE]; /* Buffer for RTSP
                                                         responses (control
                                                         plane, not media) */
} rtsp_session_t;

/* Function prototypes */

/**
 * Initialize RTSP session structure
 * @param session RTSP session to initialize
 */
void rtsp_session_init(rtsp_session_t *session);

/**
 * Parse RTSP server URL and initialize session (RTSP protocol layer)
 * Parses RTSP URL components (host, port, path) and converts seek parameter to
 * Range header format
 * @param session RTSP session to populate
 * @param rtsp_url Full RTSP URL (rtsp://host:port/path)
 * @param seek_param_name Optional seek parameter name (e.g., "playseek",
 * "tvdr")
 * @param seek_param_value Optional seek parameter value for time range
 * @param user_agent Optional User-Agent header for timezone detection
 * @param fallback_username Optional username to reuse when URL lacks
 * credentials
 * @param fallback_password Optional password to reuse when URL lacks
 * credentials
 * @return 0 on success, -1 on error
 */
int rtsp_parse_server_url(rtsp_session_t *session, const char *rtsp_url,
                          const char *seek_param_name,
                          const char *seek_param_value, int seek_offset_seconds,
                          const char *user_agent, const char *fallback_username,
                          const char *fallback_password);

/**
 * Connect to RTSP server (non-blocking)
 * @param session RTSP session (must have epoll_fd set)
 * @return 0 on success (connection in progress), -1 on error
 */
int rtsp_connect(rtsp_session_t *session);

/**
 * Handle socket events (readable/writable) for async I/O state machine
 * Called when socket has EPOLLIN or EPOLLOUT events
 * Handles both RTSP handshake and RTP data in PLAYING state
 * @param session RTSP session
 * @param events Epoll events (EPOLLIN, EPOLLOUT, etc.)
 * @return Number of bytes forwarded to client (>0), 0 if no data forwarded, -1
 * on error
 */
int rtsp_handle_socket_event(rtsp_session_t *session, uint32_t events);

/**
 * Send RTSP DESCRIBE request
 * @param session RTSP session
 * @return 0 on success, -1 on error
 */
int rtsp_describe(rtsp_session_t *session);

/**
 * Send RTSP SETUP request
 * @param session RTSP session (must have epoll_fd set)
 * @return 0 on success, -1 on error
 */
int rtsp_setup(rtsp_session_t *session);

/**
 * Send RTSP PLAY request with optional range
 * @param session RTSP session
 * @return 0 on success, -1 on error
 */
int rtsp_play(rtsp_session_t *session);

/**
 * Handle TCP interleaved RTP data and forward to HTTP client via connection
 * output buffer
 * @param session RTSP session
 * @param conn Connection object for output buffering
 * @return Number of bytes forwarded, -1 on error
 */
int rtsp_handle_tcp_interleaved_data(rtsp_session_t *session,
                                     struct connection_s *conn);

/**
 * Handle UDP RTP data and forward to HTTP client via connection output buffer
 * @param session RTSP session
 * @param conn Connection object for output buffering
 * @return Number of bytes forwarded, -1 on error
 */
int rtsp_handle_udp_rtp_data(rtsp_session_t *session,
                             struct connection_s *conn);

/**
 * Send RTSP TEARDOWN and cleanup session
 * @param session RTSP session
 * @return 0 if cleanup completed immediately, 1 if async TEARDOWN initiated
 * (cleanup deferred)
 */
int rtsp_session_cleanup(rtsp_session_t *session);

/**
 * Check if RTSP session is in async TEARDOWN state
 * @param session RTSP session
 * @return 1 if in async TEARDOWN, 0 otherwise
 */
int rtsp_session_is_async_teardown(rtsp_session_t *session);

/**
 * Schedule an RTSP OPTIONS keepalive request if the session is idle.
 * @param session RTSP session
 * @return 0 on success, -1 if keepalive could not be queued
 */
int rtsp_send_keepalive(rtsp_session_t *session);

#endif /* __RTSP_H__ */
