#ifndef __MULTICAST_H__
#define __MULTICAST_H__

#include "service.h"
#include <stdint.h>

/* Forward declarations */
typedef struct stream_context_s stream_context_t;
typedef struct connection_s connection_t;
struct buffer_ref_s;

/**
 * Multicast session context - encapsulates all multicast-related state
 */
typedef struct mcast_session_s {
  int initialized;          /* Flag: session has been initialized */
  int sock;                 /* Multicast socket (-1 if not joined) */
  int64_t last_data_time;   /* Timestamp of last received data (ms) */
  int64_t last_rejoin_time; /* Timestamp of last periodic rejoin (ms) */
} mcast_session_t;

/**
 * Initialize multicast session
 * @param session Multicast session to initialize
 */
void mcast_session_init(mcast_session_t *session);

/**
 * Cleanup multicast session and release resources
 * @param session Multicast session to cleanup
 * @param epoll_fd Epoll file descriptor for socket cleanup
 */
void mcast_session_cleanup(mcast_session_t *session, int epoll_fd);

/**
 * Join multicast group and register with epoll
 * @param session Multicast session
 * @param ctx Stream context (for service, epoll_fd, conn)
 * @return 0 on success, -1 on error
 */
int mcast_session_join(mcast_session_t *session, stream_context_t *ctx);

/**
 * Handle multicast socket events
 * @param session Multicast session
 * @param ctx Stream context
 * @param now Current timestamp in milliseconds
 * @return processed bytes on success, -1 on error
 */
int mcast_session_handle_event(mcast_session_t *session, stream_context_t *ctx,
                               int64_t now);

/**
 * Periodic tick for multicast session (timeout/rejoin checks)
 * @param session Multicast session
 * @param service Service configuration
 * @param now Current timestamp in milliseconds
 * @return 0 on success, -1 if connection should be closed (timeout)
 */
int mcast_session_tick(mcast_session_t *session, service_t *service,
                       int64_t now);

#endif /* __MULTICAST_H__ */
