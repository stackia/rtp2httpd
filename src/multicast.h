#ifndef __MULTICAST_H__
#define __MULTICAST_H__

#include "service.h"
#include <stdint.h>

/* Forward declarations */
typedef struct stream_context_s stream_context_t;
typedef struct connection_s connection_t;
typedef struct mcast_source_s mcast_source_t;
struct buffer_ref_s;

/**
 * Per-client subscription to a source shared within this worker.
 */
typedef struct mcast_session_s {
  int initialized;
  int sock;     /* Borrowed main socket (-1 if not subscribed) */
  int fec_sock; /* Borrowed FEC socket; owned by the shared source */
  int failed;   /* Subscriber-local FCC failure */
  int batched;  /* Receives shared, already ordered payload batches */
  mcast_source_t *source;
  stream_context_t *ctx;
  struct mcast_session_s *next;
  struct mcast_session_s *packet_next; /* FCC/FEC/snapshot subscribers only */
} mcast_session_t;

/**
 * Initialize multicast session
 * @param session Multicast session to initialize
 */
void mcast_session_init(mcast_session_t *session);

/**
 * Detach a subscriber; the last subscriber releases the shared sockets.
 * @param session Multicast session to cleanup
 */
void mcast_session_cleanup(mcast_session_t *session);

/**
 * Attach to an existing matching source or join and register a new one.
 * @param session Multicast session
 * @param ctx Stream context (for service, epoll_fd, conn)
 * @return 0 on success, -1 on error
 */
int mcast_session_join(mcast_session_t *session, stream_context_t *ctx);

/**
 * Receive once and distribute to all subscribers of this source.
 * @param session Multicast session
 * @param fd Ready main or FEC socket
 * @param now Current timestamp in milliseconds
 * @return 0 on success, -1 for an invalid session; delivery errors are checked by tick
 */
int mcast_session_handle_event(mcast_session_t *session, int fd, int64_t now);

/**
 * Periodic tick for multicast session (timeout/rejoin checks)
 * @param session Multicast session
 * @param now Current timestamp in milliseconds
 * @return 0 on success, -1 if connection should be closed (timeout)
 */
int mcast_session_tick(mcast_session_t *session, int64_t now);

/* Release worker receive scratch buffers before destroying the buffer pools. */
void mcast_worker_cleanup(void);
/* Bound a poller timeout by pending receives (-1 means no existing deadline). */
int mcast_worker_timeout(int64_t now, int timeout);
/* Service each due source once; subscriber teardown stays in the worker. */
void mcast_worker_receive(int64_t now);

#endif /* __MULTICAST_H__ */
