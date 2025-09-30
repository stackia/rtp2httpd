#ifndef __MULTICAST_H__
#define __MULTICAST_H__

#include "rtp2httpd.h"

/**
 * Bind socket to upstream interface if configured
 *
 * @param sock Socket file descriptor to bind
 */
void bind_to_upstream_interface(int sock);

/**
 * Join a multicast group and return socket
 *
 * @param service Service structure containing multicast address info
 * @param epoll_fd Epoll file descriptor to register the socket with
 * @return Socket file descriptor on success, exits on failure
 */
int join_mcast_group(struct services_s *service, int epoll_fd);

#endif /* __MULTICAST_H__ */
