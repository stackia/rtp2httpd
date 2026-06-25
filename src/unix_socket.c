#include "unix_socket.h"
#include "utils.h"
#include <errno.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>

#define MAX_UNIX_LISTENERS 32

static int unix_listen_sockets[MAX_UNIX_LISTENERS];
static char *unix_listen_paths[MAX_UNIX_LISTENERS];
static int unix_listen_count = 0;

static int find_current_unix_listener(const char *path) {
  for (int i = 0; i < unix_listen_count; i++) {
    if (unix_listen_paths[i] && strcmp(unix_listen_paths[i], path) == 0)
      return i;
  }
  return -1;
}

static int temp_unix_listener_path_exists(char **paths, int count, const char *path) {
  for (int i = 0; i < count; i++) {
    if (paths[i] && strcmp(paths[i], path) == 0)
      return 1;
  }
  return 0;
}

static int unix_socket_path_is_active(const char *path) {
  struct sockaddr_un addr;
  int sock = socket(AF_UNIX, SOCK_STREAM, 0);
  int saved_errno;

  if (sock < 0) {
    logger(LOG_FATAL, "Cannot create probe socket for Unix socket %s: %s", path, strerror(errno));
    return -1;
  }

  memset(&addr, 0, sizeof(addr));
  addr.sun_family = AF_UNIX;
  strncpy(addr.sun_path, path, sizeof(addr.sun_path) - 1);

  if (connect(sock, (struct sockaddr *)&addr, sizeof(addr)) == 0) {
    close(sock);
    return 1;
  }

  saved_errno = errno;
  close(sock);

  if (saved_errno == ECONNREFUSED || saved_errno == ENOENT)
    return 0;

  logger(LOG_FATAL, "Cannot verify Unix socket path is stale: %s: %s", path, strerror(saved_errno));
  return -1;
}

static void cleanup_temp_unix_listeners(int *sockets, char **paths, int *owned, int count) {
  for (int i = 0; i < count; i++) {
    if (owned[i] && sockets[i] >= 0) {
      close(sockets[i]);
      sockets[i] = -1;
      if (paths[i])
        unlink(paths[i]);
    }
    if (paths[i]) {
      free(paths[i]);
      paths[i] = NULL;
    }
  }
}

static int build_unix_listener_set(bindaddr_t *bind_list, int *sockets, char **paths, int *owned, int *reused,
                                   int *count) {
  bindaddr_t *bind_addr;

  *count = 0;
  for (int i = 0; i < MAX_UNIX_LISTENERS; i++) {
    sockets[i] = -1;
    paths[i] = NULL;
    owned[i] = 0;
    reused[i] = 0;
  }

  for (bind_addr = bind_list; bind_addr; bind_addr = bind_addr->next) {
    struct sockaddr_un addr;
    struct stat st;
    int sock = -1;
    char *path_copy = NULL;
    int current_idx;

    if (bind_addr->type != BIND_ADDR_UNIX)
      continue;

    if (!bind_addr->path || bind_addr->path[0] != '/') {
      logger(LOG_FATAL, "Invalid Unix socket path: %s", bind_addr->path ? bind_addr->path : "(null)");
      cleanup_temp_unix_listeners(sockets, paths, owned, *count);
      return -1;
    }

    if (strlen(bind_addr->path) >= sizeof(addr.sun_path)) {
      logger(LOG_FATAL, "Unix socket path is too long: %s", bind_addr->path);
      cleanup_temp_unix_listeners(sockets, paths, owned, *count);
      return -1;
    }

    if (*count >= MAX_UNIX_LISTENERS) {
      logger(LOG_FATAL, "Too many Unix socket listeners (max %d)", MAX_UNIX_LISTENERS);
      cleanup_temp_unix_listeners(sockets, paths, owned, *count);
      return -1;
    }

    if (temp_unix_listener_path_exists(paths, *count, bind_addr->path)) {
      logger(LOG_FATAL, "Duplicate Unix socket listener path: %s", bind_addr->path);
      cleanup_temp_unix_listeners(sockets, paths, owned, *count);
      return -1;
    }

    current_idx = find_current_unix_listener(bind_addr->path);
    if (current_idx >= 0) {
      path_copy = strdup(bind_addr->path);
      if (!path_copy) {
        logger(LOG_FATAL, "Failed to allocate Unix socket path");
        cleanup_temp_unix_listeners(sockets, paths, owned, *count);
        return -1;
      }
      sockets[*count] = unix_listen_sockets[current_idx];
      paths[*count] = path_copy;
      owned[*count] = 0;
      reused[current_idx] = 1;
      (*count)++;
      logger(LOG_INFO, "Keeping Unix socket listener %s", bind_addr->path);
      continue;
    }

    if (lstat(bind_addr->path, &st) == 0) {
      if (!S_ISSOCK(st.st_mode)) {
        logger(LOG_FATAL, "Unix socket path exists and is not a socket: %s", bind_addr->path);
        cleanup_temp_unix_listeners(sockets, paths, owned, *count);
        return -1;
      }
      int active = unix_socket_path_is_active(bind_addr->path);
      if (active < 0) {
        cleanup_temp_unix_listeners(sockets, paths, owned, *count);
        return -1;
      }
      if (active) {
        logger(LOG_FATAL, "Unix socket path is already in use: %s", bind_addr->path);
        cleanup_temp_unix_listeners(sockets, paths, owned, *count);
        return -1;
      }
      if (unlink(bind_addr->path) < 0) {
        logger(LOG_FATAL, "Failed to remove stale Unix socket %s: %s", bind_addr->path, strerror(errno));
        cleanup_temp_unix_listeners(sockets, paths, owned, *count);
        return -1;
      }
    } else if (errno != ENOENT) {
      logger(LOG_FATAL, "Failed to inspect Unix socket path %s: %s", bind_addr->path, strerror(errno));
      cleanup_temp_unix_listeners(sockets, paths, owned, *count);
      return -1;
    }

    path_copy = strdup(bind_addr->path);
    if (!path_copy) {
      logger(LOG_FATAL, "Failed to allocate Unix socket path");
      cleanup_temp_unix_listeners(sockets, paths, owned, *count);
      return -1;
    }

    sock = socket(AF_UNIX, SOCK_STREAM, 0);
    if (sock < 0) {
      logger(LOG_FATAL, "Cannot create Unix socket %s: %s", bind_addr->path, strerror(errno));
      free(path_copy);
      cleanup_temp_unix_listeners(sockets, paths, owned, *count);
      return -1;
    }

    memset(&addr, 0, sizeof(addr));
    addr.sun_family = AF_UNIX;
    strncpy(addr.sun_path, bind_addr->path, sizeof(addr.sun_path) - 1);

    if (bind(sock, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
      logger(LOG_FATAL, "Cannot bind Unix socket %s: %s", bind_addr->path, strerror(errno));
      close(sock);
      free(path_copy);
      cleanup_temp_unix_listeners(sockets, paths, owned, *count);
      return -1;
    }

    if (listen(sock, 128) < 0) {
      logger(LOG_FATAL, "Cannot listen on Unix socket %s: %s", bind_addr->path, strerror(errno));
      close(sock);
      unlink(bind_addr->path);
      free(path_copy);
      cleanup_temp_unix_listeners(sockets, paths, owned, *count);
      return -1;
    }

    sockets[*count] = sock;
    paths[*count] = path_copy;
    owned[*count] = 1;
    (*count)++;
    logger(LOG_INFO, "Listening on Unix socket %s", bind_addr->path);
  }

  return 0;
}

int unix_socket_listeners_replace(bindaddr_t *bind_list) {
  int sockets[MAX_UNIX_LISTENERS];
  char *paths[MAX_UNIX_LISTENERS];
  int owned[MAX_UNIX_LISTENERS];
  int reused[MAX_UNIX_LISTENERS];
  int count = 0;

  if (build_unix_listener_set(bind_list, sockets, paths, owned, reused, &count) < 0)
    return -1;

  for (int i = 0; i < unix_listen_count; i++) {
    if (reused[i]) {
      if (unix_listen_paths[i]) {
        free(unix_listen_paths[i]);
        unix_listen_paths[i] = NULL;
      }
      continue;
    }
    if (unix_listen_sockets[i] >= 0) {
      close(unix_listen_sockets[i]);
      unix_listen_sockets[i] = -1;
    }
    if (unix_listen_paths[i]) {
      struct stat st;
      if (lstat(unix_listen_paths[i], &st) == 0 && S_ISSOCK(st.st_mode)) {
        if (unlink(unix_listen_paths[i]) < 0) {
          logger(LOG_WARN, "Failed to unlink Unix socket %s: %s", unix_listen_paths[i], strerror(errno));
        }
      }
      free(unix_listen_paths[i]);
      unix_listen_paths[i] = NULL;
    }
  }

  for (int i = 0; i < count; i++) {
    unix_listen_sockets[i] = sockets[i];
    unix_listen_paths[i] = paths[i];
  }
  unix_listen_count = count;

  return 0;
}

void unix_socket_listeners_cleanup(void) {
  for (int i = 0; i < unix_listen_count; i++) {
    if (unix_listen_sockets[i] >= 0) {
      close(unix_listen_sockets[i]);
      unix_listen_sockets[i] = -1;
    }
    if (unix_listen_paths[i]) {
      struct stat st;
      if (lstat(unix_listen_paths[i], &st) == 0 && S_ISSOCK(st.st_mode)) {
        if (unlink(unix_listen_paths[i]) < 0) {
          logger(LOG_WARN, "Failed to unlink Unix socket %s: %s", unix_listen_paths[i], strerror(errno));
        }
      }
      free(unix_listen_paths[i]);
      unix_listen_paths[i] = NULL;
    }
  }
  unix_listen_count = 0;
}

int unix_socket_listeners_count(void) { return unix_listen_count; }

int unix_socket_listeners_append(int *sockets, int max_sockets, int *count, int *nfds) {
  if (*count + unix_listen_count > max_sockets)
    return -1;

  for (int i = 0; i < unix_listen_count; i++) {
    sockets[*count] = unix_listen_sockets[i];
    if (sockets[*count] > *nfds)
      *nfds = sockets[*count];
    (*count)++;
  }

  return 0;
}
