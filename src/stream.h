#ifndef __STREAM_H__
#define __STREAM_H__

#include "rtp2httpd.h"

/* Stream receive states */
#define RECV_STATE_INIT 0
#define RECV_STATE_FCC_REQUESTED 1
#define RECV_STATE_MCAST_REQUESTED 2
#define RECV_STATE_MCAST_ACCEPTED 3

/**
 * Start RTP stream processing for a client
 *
 * This function handles the complete flow of:
 * - FCC (Fast Channel Change) protocol if enabled
 * - Multicast group joining
 * - RTP packet reception and forwarding
 * - State machine management
 *
 * @param client Client socket file descriptor
 * @param service Service configuration
 */
void start_rtp_stream(int client, struct services_s *service);

#endif /* __STREAM_H__ */
