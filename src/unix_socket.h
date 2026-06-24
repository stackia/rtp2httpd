#ifndef __UNIX_SOCKET_H__
#define __UNIX_SOCKET_H__

#include "configuration.h"

int unix_socket_listeners_replace(bindaddr_t *bind_list);
void unix_socket_listeners_cleanup(void);
int unix_socket_listeners_count(void);
int unix_socket_listeners_append(int *sockets, int max_sockets, int *count, int *nfds);

#endif
