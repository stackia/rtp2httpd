#ifndef __STREAM_H__
#define __STREAM_H__

#include "rtp2httpd.h"
#include "buffer_config.h"
#include "fcc.h"
#include "rtsp.h"

/* Stream processing context */
typedef struct stream_context_s
{
  int client_fd;
  int epoll_fd;
  struct services_s *service;
  fcc_session_t fcc;
  int mcast_sock;
  uint8_t recv_buffer[STREAM_RECV_BUFFER_SIZE];
  rtsp_session_t rtsp; /* RTSP session for SERVICE_RTSP */
} stream_context_t;

/**
 * Start media stream processing for a client
 *
 * This function handles the complete flow of:
 * - FCC (Fast Channel Change) protocol if enabled for RTP services
 * - Multicast group joining
 * - Media packet reception and forwarding (RTP or raw UDP)
 * - State machine management
 *
 * @param client Client socket file descriptor
 * @param service Service configuration (SERVICE_MRTP or SERVICE_MUDP)
 */
void start_media_stream(int client, struct services_s *service);

#endif /* __STREAM_H__ */
