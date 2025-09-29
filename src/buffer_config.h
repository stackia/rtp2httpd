#ifndef __BUFFER_CONFIG_H__
#define __BUFFER_CONFIG_H__

/*
 * Centralized Buffer Size Configuration
 *
 * All buffer sizes in rtp2httpd can be configured at compile time
 * by defining these macros. Default values are chosen based on:
 * - Network protocols (MTU, typical packet sizes)
 * - Application requirements (URL lengths, header sizes)
 * - Performance considerations (memory usage vs. functionality)
 */

/* ========== NETWORK BUFFERS ========== */

/* RTP/UDP packet buffers - based on network MTU */
#ifndef RTP_PACKET_BUFFER_SIZE
#define RTP_PACKET_BUFFER_SIZE 1500 /* Standard Ethernet MTU */
#endif

/* RTCP buffer size - same as RTP for consistency */
#ifndef RTCP_BUFFER_SIZE
#define RTCP_BUFFER_SIZE 1500
#endif

/* ========== RTSP PROTOCOL BUFFERS ========== */

/* RTSP response buffer - for server responses and SDP descriptions */
#ifndef RTSP_RESPONSE_BUFFER_SIZE
#define RTSP_RESPONSE_BUFFER_SIZE 4096
#endif

/* RTSP TCP interleaved buffer - increased for high bitrate streams */
#ifndef RTSP_TCP_BUFFER_SIZE
#define RTSP_TCP_BUFFER_SIZE 8192
#endif

/* RTSP request buffer - for building outgoing requests */
#ifndef RTSP_REQUEST_BUFFER_SIZE
#define RTSP_REQUEST_BUFFER_SIZE 4096
#endif

/* RTSP headers buffer - for extra headers in requests */
#ifndef RTSP_HEADERS_BUFFER_SIZE
#define RTSP_HEADERS_BUFFER_SIZE 1024
#endif

/* ========== RTSP SESSION STRING BUFFERS ========== */

/* RTSP session ID - server-generated session identifier */
#ifndef RTSP_SESSION_ID_SIZE
#define RTSP_SESSION_ID_SIZE 128
#endif

/* RTSP server URL - complete RTSP URL */
#ifndef RTSP_SERVER_URL_SIZE
#define RTSP_SERVER_URL_SIZE 1024
#endif

/* RTSP server hostname - DNS name or IP address */
#ifndef RTSP_SERVER_HOST_SIZE
#define RTSP_SERVER_HOST_SIZE 256
#endif

/* RTSP server path - path component of URL with query string */
#ifndef RTSP_SERVER_PATH_SIZE
#define RTSP_SERVER_PATH_SIZE 1024
#endif

/* RTSP playseek range - for Range header in PLAY command */
#ifndef RTSP_PLAYSEEK_RANGE_SIZE
#define RTSP_PLAYSEEK_RANGE_SIZE 256
#endif

/* ========== HTTP PROTOCOL BUFFERS ========== */

/* HTTP client request buffer - for parsing incoming HTTP requests */
#ifndef HTTP_CLIENT_BUFFER_SIZE
#define HTTP_CLIENT_BUFFER_SIZE 1024
#endif

/* HTTP URL working buffer - for URL manipulation */
#ifndef HTTP_URL_BUFFER_SIZE
#define HTTP_URL_BUFFER_SIZE 1024
#endif

/* HTTP URL component buffers - for parsing multicast URLs */
#ifndef HTTP_ADDR_COMPONENT_SIZE
#define HTTP_ADDR_COMPONENT_SIZE 256
#endif

#ifndef HTTP_PORT_COMPONENT_SIZE
#define HTTP_PORT_COMPONENT_SIZE 16
#endif

/* HTTP URL parsing buffers - for complex URL operations */
#ifndef HTTP_URL_MAIN_PART_SIZE
#define HTTP_URL_MAIN_PART_SIZE 512
#endif

#ifndef HTTP_URL_FCC_VALUE_SIZE
#define HTTP_URL_FCC_VALUE_SIZE 512
#endif

#ifndef HTTP_SOURCE_STRING_SIZE
#define HTTP_SOURCE_STRING_SIZE 300
#endif

/* ========== FCC PROTOCOL BUFFERS ========== */

/* FCC response buffer - for server responses */
#ifndef FCC_RESPONSE_BUFFER_SIZE
#define FCC_RESPONSE_BUFFER_SIZE 4096
#endif

/* FCC packet buffers - for protocol packets */
#ifndef FCC_PACKET_BUFFER_SIZE
#define FCC_PACKET_BUFFER_SIZE 16
#endif

/* FCC receive buffer - same as RTP for consistency */
#ifndef FCC_RECV_BUFFER_SIZE
#define FCC_RECV_BUFFER_SIZE 1500
#endif

/* ========== STREAM PROCESSING BUFFERS ========== */

/* Stream receive buffer - for incoming media packets */
#ifndef STREAM_RECV_BUFFER_SIZE
#define STREAM_RECV_BUFFER_SIZE 1500
#endif

/* ========== RTSP FUNCTION-SPECIFIC BUFFERS ========== */

/* URL copy buffer - for URL parsing operations */
#ifndef RTSP_URL_COPY_SIZE
#define RTSP_URL_COPY_SIZE 1024
#endif

/* Time conversion buffers - for playseek time formatting */
#ifndef RTSP_TIME_STRING_SIZE
#define RTSP_TIME_STRING_SIZE 64
#endif

#ifndef RTSP_TIME_COMPONENT_SIZE
#define RTSP_TIME_COMPONENT_SIZE 32
#endif

/* Port string buffer - for port number conversion */
#ifndef RTSP_PORT_STRING_SIZE
#define RTSP_PORT_STRING_SIZE 16
#endif

/* Header parsing buffer - for individual header values */
#ifndef RTSP_HEADER_PREFIX_SIZE
#define RTSP_HEADER_PREFIX_SIZE 64
#endif

/* ========== VALIDATION MACROS ========== */

/* Compile-time validation to ensure reasonable buffer sizes */
#if RTP_PACKET_BUFFER_SIZE < 1024
#warning "RTP_PACKET_BUFFER_SIZE is very small, may cause packet truncation"
#endif

#if RTSP_TCP_BUFFER_SIZE < 4096
#warning "RTSP_TCP_BUFFER_SIZE is small, may cause issues with high bitrate streams"
#endif

#if HTTP_CLIENT_BUFFER_SIZE < 512
#warning "HTTP_CLIENT_BUFFER_SIZE is very small, may cause HTTP parsing issues"
#endif

/* ========== USAGE EXAMPLES ========== */

/*
 * To customize buffer sizes at compile time:
 *
 * gcc -DRTP_PACKET_BUFFER_SIZE=2048 \
 *     -DRTSP_TCP_BUFFER_SIZE=16384 \
 *     -DHTTP_CLIENT_BUFFER_SIZE=2048 \
 *     ...
 *
 * Or in Makefile:
 * CFLAGS += -DRTP_PACKET_BUFFER_SIZE=2048
 * CFLAGS += -DRTSP_TCP_BUFFER_SIZE=16384
 */

#endif /* __BUFFER_CONFIG_H__ */
