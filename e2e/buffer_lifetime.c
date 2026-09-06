/* Exercise production buffer ownership and send accounting with real sockets. */
#include "configuration.h"
#include "send_queue.h"
#include "status.h"
#include "utils.h"
#include <assert.h>
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

config_t config;
status_shared_t *status_shared;
int worker_id = -1;

int logger(loglevel_t level, const char *format, ...) {
  (void)level;
  (void)format;
  return 0;
}

static void expect_closed(int fd) {
  assert(fcntl(fd, F_GETFD) == -1);
  assert(errno == EBADF);
}

static void send_and_read(int *pair, send_queue_t *queue, size_t count, uint8_t value) {
  size_t sent = 0;
  assert(send_queue_send(pair[0], queue, count, &sent) == 0);
  assert(sent == count);
  uint8_t received[4096];
  assert(count <= sizeof(received));
  size_t offset = 0;
  while (offset < count) {
    ssize_t n = read(pair[1], received + offset, count - offset);
    assert(n > 0);
    offset += (size_t)n;
  }
  for (size_t i = 0; i < count; i++)
    assert(received[i] == value);
}

static void shared_batch(int snapshot, int fallback) {
  buffer_ref_t *owner = buffer_pool_alloc_batch();
  assert(owner);
  owner->data_offset = 12;
  owner->data_size = 4096;
  memset((uint8_t *)owner->data + owner->data_offset, 0x5a, owner->data_size);
  if (snapshot)
    buffer_ref_snapshot(owner);
  int snapshot_fd = buffer_ref_sendfile_fd(owner);
  send_queue_t queues[2] = {0};
  for (int i = 0; i < 2; i++) {
    buffer_ref_t *view = buffer_ref_view(owner);
    assert(view);
    if (fallback && i == 0)
      view->shared_fd = -2;
    assert(send_queue_add(&queues[i], view) == 0);
    buffer_ref_put(view);
  }
  buffer_ref_put(owner); /* Queues must remain valid after the source releases it. */
  assert(owner->refcount == 2);
  int pair[2];
  assert(socketpair(AF_UNIX, SOCK_STREAM, 0, pair) == 0);
  send_and_read(pair, &queues[0], 1024, 0x5a);
  assert(queues[0].total_bytes == 3072);
  assert(queues[0].memory_bytes == BUFFER_POOL_BATCH_SIZE);
  assert(queues[1].total_bytes == 4096);
  assert(queues[1].head->iov.iov_len == 4096);
  assert(buffer_ref_sendfile_fd(queues[1].head) == snapshot_fd);
  send_and_read(pair, &queues[0], 3072, 0x5a);
  assert(!queues[0].head && !queues[0].tail && !queues[0].num_queued && !queues[0].memory_bytes);
  assert(owner->refcount == 1);
  if (snapshot_fd >= 0)
    assert(fcntl(snapshot_fd, F_GETFD) >= 0);
  send_and_read(pair, &queues[1], 4096, 0x5a);
  assert(!queues[1].head && !queues[1].total_bytes && !queues[1].memory_bytes);
  assert(send_buffer_state.batch_pool.num_free == send_buffer_state.batch_pool.num_buffers);
  if (snapshot_fd >= 0)
    expect_closed(snapshot_fd);
  close(pair[0]);
  close(pair[1]);
}

static void mixed_queue(void) {
  int pair[2];
  assert(socketpair(AF_UNIX, SOCK_STREAM, 0, pair) == 0);
  send_queue_t queue = {0};
  for (int i = 0; i < 2; i++) {
    buffer_ref_t *ref = buffer_pool_alloc();
    assert(ref);
    ref->data_size = 1000;
    memset(ref->data, 0x6b, ref->data_size);
    assert(send_queue_add(&queue, ref) == 0);
    buffer_ref_put(ref);
  }
  send_and_read(pair, &queue, 1500, 0x6b); /* Cross an iovec boundary. */
  assert(queue.num_queued == 1 && queue.total_bytes == 500);
  assert(queue.memory_bytes == BUFFER_POOL_BUFFER_SIZE);
  char path[] = "/tmp/rtp2httpd-buffer-test-XXXXXX";
  int fd = mkstemp(path);
  assert(fd >= 0);
  unlink(path);
  assert(write(fd, "file", 4) == 4);
  assert(send_queue_add_file(&queue, fd, 0, 4) == 0);
  assert(queue.total_bytes == 500 && queue.num_queued == 2);
  send_and_read(pair, &queue, 500, 0x6b);
  assert(queue.total_bytes == 0 && queue.memory_bytes == BUFFER_POOL_BUFFER_SIZE);
  send_queue_cleanup(&queue); /* Disconnect while a file is pending. */
  expect_closed(fd);
  assert(!queue.head && !queue.tail && !queue.num_queued && !queue.memory_bytes);
  assert(send_buffer_state.pool.num_free == send_buffer_state.pool.num_buffers);
  close(pair[0]);
  close(pair[1]);
}

int main(void) {
  signal(SIGPIPE, SIG_IGN);
  config.buffer_pool_max_size = 1024;
  assert(send_buffer_init() == 0);
  shared_batch(0, 0);
  shared_batch(1, 0);
  shared_batch(1, 1);
  mixed_queue();
  send_buffer_cleanup();
  return 0;
}
