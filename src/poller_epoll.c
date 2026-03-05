#ifdef __linux__

#include "poller.h"
#include <stdlib.h>
#include <sys/epoll.h>
#include <unistd.h>

int poller_create(void) { return epoll_create1(EPOLL_CLOEXEC); }

void poller_close(int pfd) { close(pfd); }

int poller_add(int pfd, int fd, uint32_t events) {
  struct epoll_event ev;
  ev.events = 0;
  ev.data.fd = fd;
  if (events & POLLER_IN)
    ev.events |= EPOLLIN;
  if (events & POLLER_OUT)
    ev.events |= EPOLLOUT;
  if (events & POLLER_ERR)
    ev.events |= EPOLLERR;
  if (events & POLLER_HUP)
    ev.events |= EPOLLHUP;
  if (events & POLLER_RDHUP)
    ev.events |= EPOLLRDHUP;
  return epoll_ctl(pfd, EPOLL_CTL_ADD, fd, &ev);
}

int poller_mod(int pfd, int fd, uint32_t events) {
  struct epoll_event ev;
  ev.events = 0;
  ev.data.fd = fd;
  if (events & POLLER_IN)
    ev.events |= EPOLLIN;
  if (events & POLLER_OUT)
    ev.events |= EPOLLOUT;
  if (events & POLLER_ERR)
    ev.events |= EPOLLERR;
  if (events & POLLER_HUP)
    ev.events |= EPOLLHUP;
  if (events & POLLER_RDHUP)
    ev.events |= EPOLLRDHUP;
  return epoll_ctl(pfd, EPOLL_CTL_MOD, fd, &ev);
}

int poller_del(int pfd, int fd) {
  return epoll_ctl(pfd, EPOLL_CTL_DEL, fd, NULL);
}

int poller_wait(int pfd, poller_event_t *events, int max_events,
                int timeout_ms) {
  struct epoll_event ep_buf[1024];
  struct epoll_event *ep_events =
      max_events <= 1024 ? ep_buf
                         : malloc(max_events * sizeof(struct epoll_event));
  int n = epoll_wait(pfd, ep_events, max_events, timeout_ms);
  for (int i = 0; i < n; i++) {
    events[i].fd = ep_events[i].data.fd;
    events[i].events = 0;
    if (ep_events[i].events & EPOLLIN)
      events[i].events |= POLLER_IN;
    if (ep_events[i].events & EPOLLOUT)
      events[i].events |= POLLER_OUT;
    if (ep_events[i].events & EPOLLERR)
      events[i].events |= POLLER_ERR;
    if (ep_events[i].events & EPOLLHUP)
      events[i].events |= POLLER_HUP;
    if (ep_events[i].events & EPOLLRDHUP)
      events[i].events |= POLLER_RDHUP;
  }
  if (ep_events != ep_buf)
    free(ep_events);
  return n;
}

#endif /* __linux__ */
