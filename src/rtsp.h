#ifndef __RTSP_H__
#define __RTSP_H__

#include <stdint.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include "rtp2httpd.h"
#include "buffer_config.h"

/* RTSP message types */
#define RTSP_METHOD_DESCRIBE "DESCRIBE"
#define RTSP_METHOD_SETUP "SETUP"
#define RTSP_METHOD_PLAY "PLAY"
#define RTSP_METHOD_TEARDOWN "TEARDOWN"
#define RTSP_METHOD_GET_PARAMETER "GET_PARAMETER"
#define RTSP_METHOD_SET_PARAMETER "SET_PARAMETER"

/* RTSP protocol states */
typedef enum
{
    RTSP_STATE_INIT = 0,
    RTSP_STATE_CONNECTED,
    RTSP_STATE_DESCRIBED,
    RTSP_STATE_SETUP,
    RTSP_STATE_PLAYING,
    RTSP_STATE_PAUSED,
    RTSP_STATE_ERROR
} rtsp_state_t;

/* Transport mode types */
typedef enum
{
    RTSP_TRANSPORT_UDP = 0, /* Traditional UDP transport */
    RTSP_TRANSPORT_TCP      /* TCP interleaved transport */
} rtsp_transport_mode_t;

/* Transport protocol types */
typedef enum
{
    RTSP_PROTOCOL_RTP = 0, /* RTP - Media over RTP (needs RTP unwrapping) */
    RTSP_PROTOCOL_MP2T,    /* MP2T - Direct MPEG-2 TS (no RTP unwrapping) */
} rtsp_transport_protocol_t;

/* RTSP session structure */
typedef struct
{
    int socket;                                    /* TCP socket to RTSP server */
    rtsp_state_t state;                            /* Current RTSP state */
    uint32_t cseq;                                 /* RTSP sequence number */
    char session_id[RTSP_SESSION_ID_SIZE];         /* RTSP session ID */
    char server_url[RTSP_SERVER_URL_SIZE];         /* Full RTSP URL */
    char server_host[RTSP_SERVER_HOST_SIZE];       /* RTSP server hostname */
    int server_port;                               /* RTSP server port */
    char server_path[RTSP_SERVER_PATH_SIZE];       /* RTSP path with query string */
    char playseek_range[RTSP_PLAYSEEK_RANGE_SIZE]; /* Range for RTSP PLAY command */
    int redirect_count;                            /* Number of redirects followed */

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

    /* RTP packet tracking for loss detection */
    uint16_t current_seqn;     /* Last received RTP sequence number */
    uint16_t not_first_packet; /* Flag indicating first packet received */

    /* Buffering */
    uint8_t response_buffer[RTSP_RESPONSE_BUFFER_SIZE]; /* Buffer for RTSP responses */
    uint8_t rtp_buffer[RTP_PACKET_BUFFER_SIZE];         /* Buffer for RTP packets */
    uint8_t tcp_buffer[RTSP_TCP_BUFFER_SIZE];           /* Buffer for TCP interleaved data (increased for high bitrate streams) */
    int tcp_buffer_pos;                                 /* Current position in TCP buffer */
} rtsp_session_t;

/* Function prototypes */

/**
 * Initialize RTSP session structure
 * @param session RTSP session to initialize
 */
void rtsp_session_init(rtsp_session_t *session);

/**
 * Parse RTSP server URL and initialize session (RTSP protocol layer)
 * Parses RTSP URL components (host, port, path) and converts playseek to Range header format
 * @param session RTSP session to populate
 * @param rtsp_url Full RTSP URL (rtsp://host:port/path)
 * @param playseek_param Optional playseek parameter for time range
 * @param user_agent Optional User-Agent header for timezone detection
 * @return 0 on success, -1 on error
 */
int rtsp_parse_server_url(rtsp_session_t *session, const char *rtsp_url, const char *playseek_param, const char *user_agent);

/**
 * Connect to RTSP server
 * @param session RTSP session
 * @return 0 on success, -1 on error
 */
int rtsp_connect(rtsp_session_t *session);

/**
 * Send RTSP DESCRIBE request
 * @param session RTSP session
 * @return 0 on success, -1 on error
 */
int rtsp_describe(rtsp_session_t *session);

/**
 * Send RTSP SETUP request
 * @param session RTSP session
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
 * Handle incoming RTP data and forward to HTTP client
 * @param session RTSP session
 * @param client_fd HTTP client socket
 * @return Number of bytes processed, -1 on error
 */
int rtsp_handle_rtp_data(rtsp_session_t *session, int client_fd);

/**
 * Handle TCP interleaved RTP data and forward to HTTP client
 * @param session RTSP session
 * @param client_fd HTTP client socket
 * @return Number of bytes processed, -1 on error
 */
int rtsp_handle_tcp_interleaved_data(rtsp_session_t *session, int client_fd);

/**
 * Handle UDP RTP data and forward to HTTP client (legacy mode)
 * @param session RTSP session
 * @param client_fd HTTP client socket
 * @return Number of bytes processed, -1 on error
 */
int rtsp_handle_udp_rtp_data(rtsp_session_t *session, int client_fd);

/**
 * Send RTSP TEARDOWN and cleanup session
 * @param session RTSP session
 */
void rtsp_session_cleanup(rtsp_session_t *session);

#endif /* __RTSP_H__ */
