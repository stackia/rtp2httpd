#ifndef WORKER_H
#define WORKER_H

#include "connection.h"

/**
 * fd -> connection map using hashmap for O(1) lookups
 */

/**
 * Initialize the fd map (hashmap-based)
 */
void fdmap_init(void);

/**
 * Set fd -> connection mapping
 * @param fd File descriptor
 * @param c Connection pointer
 */
void fdmap_set(int fd, connection_t *c);

/**
 * Get connection by fd
 * @param fd File descriptor
 * @return Connection pointer or NULL
 */
connection_t *fdmap_get(int fd);

/**
 * Delete fd from map
 * @param fd File descriptor
 */
void fdmap_del(int fd);

/**
 * Cleanup and free the fd map (call on worker exit)
 */
void fdmap_cleanup(void);

/**
 * Run the worker event loop
 * @param listen_sockets Array of listening socket fds
 * @param num_sockets Number of listening sockets
 * @param notif_fd Notification pipe fd for SSE events (-1 if disabled)
 * @return 0 on clean exit, non-zero on error
 */
int worker_run_event_loop(int *listen_sockets, int num_sockets, int notif_fd);

/**
 * Close and free a connection, removing it from the list
 * @param c Connection to close
 */
void worker_close_and_free_connection(connection_t *c);

/**
 * Safely cleanup a socket from epoll and fdmap
 * Order: fdmap_del -> epoll_ctl -> close
 * @param epoll_fd Epoll file descriptor
 * @param sock Socket file descriptor to cleanup
 */
void worker_cleanup_socket_from_epoll(int epoll_fd, int sock);

#endif /* WORKER_H */
