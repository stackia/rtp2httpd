#ifndef __STREAM_H__
#define __STREAM_H__

#include "rtp2httpd.h"
#include "buffer_config.h"

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
