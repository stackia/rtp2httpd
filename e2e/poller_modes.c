/* Kernel integration regression: changing modes must replace old semantics. */
#include "poller.h"
#include <assert.h>
#include <unistd.h>

static void expect_readable(int pfd, int fd) {
  poller_event_t event;
  assert(poller_wait(pfd, &event, 1, 100) == 1);
  assert(event.fd == fd);
  assert(event.events & POLLER_IN);
}

static void expect_quiet(int pfd) {
  poller_event_t event;
  assert(poller_wait(pfd, &event, 1, 0) == 0);
}

int main(void) {
  int pipefd[2];
  assert(pipe(pipefd) == 0);
  int pfd = poller_create();
  assert(pfd >= 0);
  assert(poller_add(pfd, pipefd[0], POLLER_IN | POLLER_ONESHOT) == 0);
  char byte;

  for (int cycle = 0; cycle < 16; cycle++) {
    assert(write(pipefd[1], "a", 1) == 1);
    expect_readable(pfd, pipefd[0]);
    expect_quiet(pfd);
    assert(read(pipefd[0], &byte, 1) == 1);

    /* New arrivals while disabled must wait for an explicit rearm. */
    assert(write(pipefd[1], "b", 1) == 1);
    expect_quiet(pfd);
    assert(poller_mod(pfd, pipefd[0], POLLER_IN | POLLER_ONESHOT) == 0);
    expect_readable(pfd, pipefd[0]);
    assert(read(pipefd[0], &byte, 1) == 1);

    /* Exercise data queued both before and after the mode transition. */
    if (cycle & 1)
      assert(write(pipefd[1], "c", 1) == 1);
    assert(poller_reset(pfd, pipefd[0], POLLER_IN | POLLER_LEVEL) == 0);
    if (!(cycle & 1))
      assert(write(pipefd[1], "c", 1) == 1);
    for (int i = 0; i < 4; i++)
      expect_readable(pfd, pipefd[0]);
    assert(read(pipefd[0], &byte, 1) == 1);
    expect_quiet(pfd);
    assert(write(pipefd[1], "d", 1) == 1);
    expect_readable(pfd, pipefd[0]);
    assert(read(pipefd[0], &byte, 1) == 1);

    /* Switching back must restore edge/one-shot semantics. */
    assert(poller_reset(pfd, pipefd[0], POLLER_IN | POLLER_ONESHOT) == 0);
    expect_quiet(pfd);
  }
  assert(poller_del(pfd, pipefd[0]) == 0);
  assert(write(pipefd[1], "e", 1) == 1);
  expect_quiet(pfd);
  close(pipefd[0]);
  close(pipefd[1]);
  poller_close(pfd);
  return 0;
}
