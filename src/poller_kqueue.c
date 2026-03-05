#if defined(__APPLE__) || defined(__FreeBSD__) || defined(__OpenBSD__) || \
    defined(__NetBSD__)

#include "poller.h"
#include <errno.h>
#include <stdlib.h>
#include <string.h>
#include <sys/event.h>
#include <sys/time.h>
#include <unistd.h>

int poller_create(void) { return kqueue(); }

void poller_close(int pfd) { close(pfd); }

int poller_add(int pfd, int fd, uint32_t events) {
  struct kevent changes[2];
  int nchanges = 0;

  if (events & POLLER_IN) {
    EV_SET(&changes[nchanges], fd, EVFILT_READ, EV_ADD | EV_CLEAR, 0, 0, NULL);
    nchanges++;
  }
  if (events & POLLER_OUT) {
    EV_SET(&changes[nchanges], fd, EVFILT_WRITE, EV_ADD | EV_CLEAR, 0, 0,
           NULL);
    nchanges++;
  }

  if (nchanges == 0) {
    /* At minimum, add a read filter so the fd is tracked */
    EV_SET(&changes[0], fd, EVFILT_READ, EV_ADD | EV_CLEAR, 0, 0, NULL);
    nchanges = 1;
  }

  return kevent(pfd, changes, nchanges, NULL, 0, NULL);
}

int poller_mod(int pfd, int fd, uint32_t events) {
  struct kevent changes[4];
  int nchanges = 0;

  /*
   * kqueue doesn't have a modify operation - we add/delete filters.
   * EV_ADD on an existing filter updates it; EV_DELETE removes it.
   */
  if (events & POLLER_IN) {
    EV_SET(&changes[nchanges], fd, EVFILT_READ, EV_ADD | EV_CLEAR, 0, 0, NULL);
  } else {
    EV_SET(&changes[nchanges], fd, EVFILT_READ, EV_DELETE, 0, 0, NULL);
  }
  nchanges++;

  if (events & POLLER_OUT) {
    EV_SET(&changes[nchanges], fd, EVFILT_WRITE, EV_ADD | EV_CLEAR, 0, 0,
           NULL);
  } else {
    EV_SET(&changes[nchanges], fd, EVFILT_WRITE, EV_DELETE, 0, 0, NULL);
  }
  nchanges++;

  /* Ignore ENOENT errors from deleting non-existent filters */
  int result = kevent(pfd, changes, nchanges, NULL, 0, NULL);
  if (result < 0 && errno == ENOENT) {
    /* One of the filters didn't exist - retry individually */
    for (int i = 0; i < nchanges; i++) {
      int r = kevent(pfd, &changes[i], 1, NULL, 0, NULL);
      if (r < 0 && errno != ENOENT) {
        return -1;
      }
    }
    return 0;
  }
  return result;
}

int poller_del(int pfd, int fd) {
  struct kevent changes[2];
  int nchanges = 0;

  /* Remove both read and write filters */
  EV_SET(&changes[nchanges], fd, EVFILT_READ, EV_DELETE, 0, 0, NULL);
  nchanges++;
  EV_SET(&changes[nchanges], fd, EVFILT_WRITE, EV_DELETE, 0, 0, NULL);
  nchanges++;

  /* Delete individually, ignoring ENOENT for filters that weren't added */
  for (int i = 0; i < nchanges; i++) {
    int r = kevent(pfd, &changes[i], 1, NULL, 0, NULL);
    if (r < 0 && errno != ENOENT) {
      return -1;
    }
  }
  return 0;
}

int poller_wait(int pfd, poller_event_t *events, int max_events,
                int timeout_ms) {
  struct kevent kev_buf[1024];
  struct kevent *kev_events =
      max_events <= 1024 ? kev_buf : malloc(max_events * sizeof(struct kevent));
  struct timespec ts;
  struct timespec *pts = NULL;

  if (timeout_ms >= 0) {
    ts.tv_sec = timeout_ms / 1000;
    ts.tv_nsec = (timeout_ms % 1000) * 1000000L;
    pts = &ts;
  }

  int n = kevent(pfd, NULL, 0, kev_events, max_events, pts);
  if (n < 0) {
    return -1;
  }

  /*
   * kqueue returns one event per filter per fd.  Multiple kqueue events may
   * map to the same fd (e.g., EVFILT_READ and EVFILT_WRITE firing
   * simultaneously).  We coalesce them into a single poller_event_t per fd
   * so callers see the same "one event per fd" semantics as epoll.
   */
  int out = 0;
  for (int i = 0; i < n; i++) {
    int fd = (int)kev_events[i].ident;
    uint32_t ev = 0;

    if (kev_events[i].filter == EVFILT_READ) {
      ev |= POLLER_IN;
      /* EV_EOF on a read filter means the peer closed the connection */
      if (kev_events[i].flags & EV_EOF) {
        ev |= POLLER_RDHUP;
        /* If fflags contains an error, also set HUP */
        if (kev_events[i].fflags != 0) {
          ev |= POLLER_HUP;
        }
      }
    } else if (kev_events[i].filter == EVFILT_WRITE) {
      ev |= POLLER_OUT;
      if (kev_events[i].flags & EV_EOF) {
        ev |= POLLER_HUP;
      }
    }

    if (kev_events[i].flags & EV_ERROR) {
      ev |= POLLER_ERR;
    }

    /* Try to coalesce with previous event for the same fd */
    int coalesced = 0;
    for (int j = out - 1; j >= 0 && j >= out - 4; j--) {
      if (events[j].fd == fd) {
        events[j].events |= ev;
        coalesced = 1;
        break;
      }
    }

    if (!coalesced) {
      events[out].fd = fd;
      events[out].events = ev;
      out++;
    }
  }

  if (kev_events != kev_buf)
    free(kev_events);

  return out;
}

#endif /* __APPLE__ || __FreeBSD__ || __OpenBSD__ || __NetBSD__ */
