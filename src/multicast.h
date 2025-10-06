#ifndef __MULTICAST_H__
#define __MULTICAST_H__

#include "rtp2httpd.h"

/**
 * Bind socket to upstream interface if configured
 *
 * @param sock Socket file descriptor to bind
 * @param ifr Pointer to interface request structure for binding
 */
void bind_to_upstream_interface(int sock, const struct ifreq *ifr);

/**
 * Join a multicast group and return socket
 *
 * @param service Service structure containing multicast address info
 * @return Socket file descriptor on success, exits on failure
 */
int join_mcast_group(service_t *service);

#endif /* __MULTICAST_H__ */
