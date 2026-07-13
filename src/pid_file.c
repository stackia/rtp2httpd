#include "pid_file.h"
#include "utils.h"
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

typedef struct {
  int fd;
  char *path;
  dev_t device;
  ino_t inode;
} pid_file_state_t;

static pid_file_state_t active_pid_file = {.fd = -1};
static pid_file_state_t pending_pid_file = {.fd = -1};
static int pid_file_update_prepared = 0;

static void pid_file_state_init(pid_file_state_t *state) {
  memset(state, 0, sizeof(*state));
  state->fd = -1;
}

static int pid_file_path_matches_state(const char *path, const pid_file_state_t *state) {
  struct stat st;

  if (!path || lstat(path, &st) < 0)
    return 0;

  return S_ISREG(st.st_mode) && st.st_dev == state->device && st.st_ino == state->inode;
}

static int pid_file_path_matches(const pid_file_state_t *state) {
  return pid_file_path_matches_state(state->path, state);
}

static void pid_file_state_clear(pid_file_state_t *state, int remove_file) {
  if (remove_file && state->path && pid_file_path_matches(state)) {
    if (unlink(state->path) < 0 && errno != ENOENT) {
      logger(LOG_WARN, "Failed to remove PID file %s: %s", state->path, strerror(errno));
    }
  }

  if (state->fd >= 0)
    close(state->fd);
  free(state->path);
  pid_file_state_init(state);
}

static int write_all(int fd, const char *data, size_t length) {
  size_t written = 0;

  while (written < length) {
    ssize_t result = write(fd, data + written, length - written);
    if (result < 0) {
      if (errno == EINTR)
        continue;
      return -1;
    }
    if (result == 0) {
      errno = EIO;
      return -1;
    }
    written += (size_t)result;
  }

  return 0;
}

static int pid_file_state_open(pid_file_state_t *state, const char *path) {
  struct flock lock;
  struct stat st;
  char contents[64];
  int flags = O_RDWR | O_CREAT;
  int length;
  int fd;

#ifdef O_NOFOLLOW
  flags |= O_NOFOLLOW;
#else
  if (lstat(path, &st) == 0 && S_ISLNK(st.st_mode)) {
    logger(LOG_FATAL, "PID file path must not be a symbolic link: %s", path);
    return -1;
  }
#endif

  fd = open(path, flags, 0644);
  if (fd < 0) {
    logger(LOG_FATAL, "Failed to open PID file %s: %s", path, strerror(errno));
    return -1;
  }

  if (fstat(fd, &st) < 0) {
    logger(LOG_FATAL, "Failed to inspect PID file %s: %s", path, strerror(errno));
    close(fd);
    return -1;
  }
  if (!S_ISREG(st.st_mode)) {
    logger(LOG_FATAL, "PID file path is not a regular file: %s", path);
    close(fd);
    return -1;
  }

  memset(&lock, 0, sizeof(lock));
  lock.l_type = F_WRLCK;
  lock.l_whence = SEEK_SET;
  if (fcntl(fd, F_SETLK, &lock) < 0) {
    if (errno == EACCES || errno == EAGAIN) {
      logger(LOG_FATAL, "PID file is already locked by another process: %s", path);
    } else {
      logger(LOG_FATAL, "Failed to lock PID file %s: %s", path, strerror(errno));
    }
    close(fd);
    return -1;
  }

  state->path = strdup(path);
  if (!state->path) {
    logger(LOG_FATAL, "Failed to allocate PID file path");
    close(fd);
    return -1;
  }
  state->fd = fd;
  state->device = st.st_dev;
  state->inode = st.st_ino;

  if (ftruncate(fd, 0) < 0 || lseek(fd, 0, SEEK_SET) < 0) {
    logger(LOG_FATAL, "Failed to truncate PID file %s: %s", path, strerror(errno));
    pid_file_state_clear(state, 1);
    return -1;
  }

  length = snprintf(contents, sizeof(contents), "%d\n", (int)getpid());
  if (length < 0 || (size_t)length >= sizeof(contents)) {
    errno = EIO;
    logger(LOG_FATAL, "Failed to format PID file contents for %s", path);
    pid_file_state_clear(state, 1);
    return -1;
  }
  if (write_all(fd, contents, (size_t)length) < 0 || fsync(fd) < 0) {
    logger(LOG_FATAL, "Failed to write PID file %s: %s", path, strerror(errno));
    pid_file_state_clear(state, 1);
    return -1;
  }

  logger(LOG_INFO, "Wrote supervisor PID %d to %s", (int)getpid(), path);
  return 0;
}

int pid_file_activate(const char *path) {
  if (!path || path[0] == '\0')
    return 0;

  if (pid_file_state_open(&active_pid_file, path) < 0) {
    pid_file_state_clear(&active_pid_file, 1);
    return -1;
  }
  return 0;
}

int pid_file_prepare(const char *path) {
  pid_file_rollback();

  if ((!path || path[0] == '\0') && !active_pid_file.path)
    return 0;
  if (path && active_pid_file.path && pid_file_path_matches_state(path, &active_pid_file))
    return 0;

  if (path && path[0] != '\0' && pid_file_state_open(&pending_pid_file, path) < 0) {
    pid_file_state_clear(&pending_pid_file, 1);
    return -1;
  }

  pid_file_update_prepared = 1;
  return 0;
}

void pid_file_commit(void) {
  if (!pid_file_update_prepared)
    return;

  pid_file_state_clear(&active_pid_file, 1);
  active_pid_file = pending_pid_file;
  pid_file_state_init(&pending_pid_file);
  pid_file_update_prepared = 0;
}

void pid_file_rollback(void) {
  pid_file_state_clear(&pending_pid_file, 1);
  pid_file_update_prepared = 0;
}

void pid_file_close_in_worker(void) {
  pid_file_state_clear(&pending_pid_file, 0);
  pid_file_state_clear(&active_pid_file, 0);
  pid_file_update_prepared = 0;
}

void pid_file_cleanup(void) {
  pid_file_rollback();
  pid_file_state_clear(&active_pid_file, 1);
}
