#include "http_fetch.h"
#include "hashmap.h"
#include "utils.h"
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/epoll.h>
#include <sys/stat.h>
#include <unistd.h>

#define HTTP_FETCH_BUFFER_SIZE 8192 /* Read buffer size for async fetch */
#define MAX_HTTP_CONTENT (20 * 1024 * 1024) /* 10MB max */
#define MAX_URL_LENGTH 2048

/* HTTP fetch tool types */
typedef enum {
  HTTP_TOOL_CURL = 0,
  HTTP_TOOL_UCLIENT_FETCH,
  HTTP_TOOL_WGET,
  HTTP_TOOL_NONE
} http_fetch_tool_t;

/* Cached detected HTTP fetch tool */
static http_fetch_tool_t detected_tool = HTTP_TOOL_NONE;
static int tool_detection_done = 0;

/* Async HTTP fetch context */
struct http_fetch_ctx_s {
  FILE *pipe_fp;                        /* popen file pointer */
  int pipe_fd;                          /* pipe file descriptor for epoll */
  int epfd;                             /* epoll fd */
  char *url;                            /* URL being fetched */
  char *temp_file;                      /* temporary file path */
  char *buffer;                         /* accumulated data buffer */
  size_t buffer_size;                   /* allocated buffer size */
  size_t buffer_used;                   /* bytes written to buffer */
  http_fetch_callback_t callback;       /* completion callback */
  http_fetch_fd_callback_t fd_callback; /* fd-based completion callback */
  void *user_data;                      /* user-provided data */
  int use_fd; /* 1 to use fd callback (zero-copy), 0 to use memory callback */
};

/* Global hashmap for fast fd-based lookup */
static struct hashmap *fetch_fd_map = NULL;

/* Hash function for fd-based hashmap lookup */
static uint64_t hash_fetch_fd(const void *item, uint64_t seed0,
                              uint64_t seed1) {
  http_fetch_ctx_t *const *ctx_ptr = item;
  http_fetch_ctx_t *ctx = *ctx_ptr;
  return hashmap_xxhash3(&ctx->pipe_fd, sizeof(int), seed0, seed1);
}

/* Compare function for fd-based hashmap lookup */
static int compare_fetch_fds(const void *a, const void *b, void *udata) {
  http_fetch_ctx_t *const *ctx_a = a;
  http_fetch_ctx_t *const *ctx_b = b;
  (void)udata; /* unused */
  return (*ctx_a)->pipe_fd - (*ctx_b)->pipe_fd;
}

/* Initialize hashmap for fd-based lookup */
static void http_fetch_init_map(void) {
  if (fetch_fd_map)
    return;

  /* Create hashmap with initial capacity of 8 */
  fetch_fd_map = hashmap_new(
      sizeof(http_fetch_ctx_t *), /* element size: pointer to context */
      0,                          /* initial capacity */
      0, 0,                       /* seeds (use default) */
      hash_fetch_fd,              /* hash function */
      compare_fetch_fds,          /* compare function */
      NULL,                       /* no element free function */
      NULL                        /* no user data */
  );
}

/* Detect available HTTP fetch tool */
static http_fetch_tool_t detect_http_fetch_tool(void) {
  int ret;

  /* Return cached result if already detected */
  if (tool_detection_done) {
    return detected_tool;
  }

  /* Check for curl by using which command */
  ret = system("which curl >/dev/null 2>&1");
  if (ret == 0) {
    logger(LOG_INFO, "HTTP fetch tool detected: curl");
    detected_tool = HTTP_TOOL_CURL;
    tool_detection_done = 1;
    return detected_tool;
  }

  /* Check for uclient-fetch by using which command */
  ret = system("which uclient-fetch >/dev/null 2>&1");
  if (ret == 0) {
    logger(LOG_INFO, "HTTP fetch tool detected: uclient-fetch");
    detected_tool = HTTP_TOOL_UCLIENT_FETCH;
    tool_detection_done = 1;
    return detected_tool;
  }

  /* Check for wget by using which command */
  ret = system("which wget >/dev/null 2>&1");
  if (ret == 0) {
    logger(LOG_INFO, "HTTP fetch tool detected: wget");
    detected_tool = HTTP_TOOL_WGET;
    tool_detection_done = 1;
    return detected_tool;
  }

  /* No suitable tool found */
  logger(
      LOG_ERROR,
      "No HTTP fetch tool found. Please install curl, uclient-fetch or wget.");
  detected_tool = HTTP_TOOL_NONE;
  tool_detection_done = 1;
  return detected_tool;
}

/* Build fetch command based on available tool */
static int build_fetch_command(char *buf, size_t bufsize, const char *url,
                               const char *output_file, int timeout) {
  http_fetch_tool_t tool = detect_http_fetch_tool();
  int ret;

  if (tool == HTTP_TOOL_NONE) {
    logger(LOG_ERROR, "No HTTP fetch tool available");
    return -1;
  }

  if (tool == HTTP_TOOL_CURL) {
    ret = snprintf(buf, bufsize,
                   "curl -L -f -s -S -k --max-time %d --connect-timeout 10 -o "
                   "'%s' '%s' 2>&1; echo \"EXIT_CODE:$?\"",
                   timeout, output_file, url);
  } else if (tool == HTTP_TOOL_UCLIENT_FETCH) {
    ret = snprintf(buf, bufsize,
                   "uclient-fetch --no-check-certificate -q -T %d -O '%s' '%s' "
                   "2>&1; echo \"EXIT_CODE:$?\"",
                   timeout, output_file, url);
  } else /* HTTP_TOOL_WGET */
  {
    ret = snprintf(buf, bufsize,
                   "wget --no-check-certificate -q -T %d -O '%s' '%s' 2>&1; "
                   "echo \"EXIT_CODE:$?\"",
                   timeout, output_file, url);
  }

  if (ret >= (int)bufsize) {
    logger(LOG_ERROR, "Fetch command too long for URL: %s", url);
    return -1;
  }

  return 0;
}

/* Find HTTP fetch context by file descriptor */
http_fetch_ctx_t *http_fetch_find_by_fd(int fd) {
  if (!fetch_fd_map)
    return NULL;

  /* Create a temporary context with the fd we're looking for */
  http_fetch_ctx_t temp_ctx = {.pipe_fd = fd};
  http_fetch_ctx_t *temp_ptr = &temp_ctx;

  /* Look up in hashmap */
  const void *result = hashmap_get(fetch_fd_map, &temp_ptr);
  if (!result)
    return NULL;

  return *(http_fetch_ctx_t *const *)result;
}

/* Remove context from hashmap */
static void http_fetch_remove_from_map(http_fetch_ctx_t *ctx) {
  if (!ctx)
    return;

  /* Remove from hashmap if pipe_fd is valid */
  if (fetch_fd_map && ctx->pipe_fd >= 0) {
    hashmap_delete(fetch_fd_map, &ctx);
  }
}

/* Cleanup and free fetch context */
static void http_fetch_free(http_fetch_ctx_t *ctx) {
  if (!ctx)
    return;

  /* Remove from epoll if registered */
  if (ctx->epfd >= 0 && ctx->pipe_fd >= 0) {
    epoll_ctl(ctx->epfd, EPOLL_CTL_DEL, ctx->pipe_fd, NULL);
  }

  /* Close pipe */
  if (ctx->pipe_fp) {
    pclose(ctx->pipe_fp);
    ctx->pipe_fp = NULL;
    ctx->pipe_fd = -1;
  }

  /* Remove temporary file if exists */
  if (ctx->temp_file) {
    unlink(ctx->temp_file);
    free(ctx->temp_file);
  }

  /* Free buffers */
  if (ctx->url)
    free(ctx->url);
  if (ctx->buffer)
    free(ctx->buffer);

  free(ctx);
}

/* Internal helper to start async HTTP fetch */
static http_fetch_ctx_t *
http_fetch_start_async_internal(const char *url, http_fetch_callback_t callback,
                                http_fetch_fd_callback_t fd_callback,
                                void *user_data, int epfd) {
  char fetch_cmd[MAX_URL_LENGTH + 256];
  char temp_file_template[] = "/tmp/rtp2httpd_http_fetch_XXXXXX";
  int temp_fd;
  struct epoll_event ev;

  if (!url || (!callback && !fd_callback) || epfd < 0) {
    logger(LOG_ERROR, "Invalid parameters for async HTTP fetch");
    return NULL;
  }

  /* Handle file:// URLs with synchronous read (fast, no epoll needed) */
  if (strncmp(url, "file://", 7) == 0) {
    const char *file_path = url + 7; /* Skip file:// prefix */

    /* Create temporary context for callback */
    http_fetch_ctx_t *ctx = calloc(1, sizeof(*ctx));
    if (!ctx) {
      logger(LOG_ERROR, "Failed to allocate context for file:// URL");
      return NULL;
    }

    ctx->url = strdup(url);
    ctx->callback = callback;
    ctx->fd_callback = fd_callback;
    ctx->user_data = user_data;
    ctx->epfd = -1; /* No epoll needed */
    ctx->use_fd = (fd_callback != NULL);

    /* Read file and invoke callback immediately */
    if (ctx->use_fd) {
      /* fd-based callback: open file and return fd */
      int fd = open(file_path, O_RDONLY);
      if (fd < 0) {
        logger(LOG_ERROR, "Failed to open file: %s - %s", file_path,
               strerror(errno));
        fd_callback(ctx, -1, 0, user_data);
        free(ctx->url);
        free(ctx);
        return NULL;
      }

      /* Get file size */
      struct stat st;
      if (fstat(fd, &st) < 0) {
        logger(LOG_ERROR, "Failed to stat file: %s - %s", file_path,
               strerror(errno));
        close(fd);
        fd_callback(ctx, -1, 0, user_data);
        free(ctx->url);
        free(ctx);
        return NULL;
      }

      logger(LOG_DEBUG,
             "file:// fetch completed synchronously (fd=%d, %zu bytes): %s", fd,
             (size_t)st.st_size, url);

      /* Invoke callback with fd (caller must close) */
      fd_callback(ctx, fd, (size_t)st.st_size, user_data);

      /* Free context immediately */
      free(ctx->url);
      free(ctx);
      return NULL; /* NULL = immediate completion, no context to track */
    } else {
      /* Memory-based callback: read entire file into memory */
      FILE *fp = fopen(file_path, "r");
      if (!fp) {
        logger(LOG_ERROR, "Failed to open file: %s - %s", file_path,
               strerror(errno));
        callback(ctx, NULL, 0, user_data);
        free(ctx->url);
        free(ctx);
        return NULL;
      }

      /* Get file size */
      fseek(fp, 0, SEEK_END);
      long file_size = ftell(fp);
      fseek(fp, 0, SEEK_SET);

      if (file_size < 0) {
        logger(LOG_ERROR, "Failed to get file size: %s", file_path);
        fclose(fp);
        callback(ctx, NULL, 0, user_data);
        free(ctx->url);
        free(ctx);
        return NULL;
      }

      if (file_size > MAX_HTTP_CONTENT) {
        logger(LOG_ERROR, "File too large (%ld bytes, max %ld): %s", file_size,
               (long)MAX_HTTP_CONTENT, file_path);
        fclose(fp);
        callback(ctx, NULL, 0, user_data);
        free(ctx->url);
        free(ctx);
        return NULL;
      }

      /* Allocate buffer */
      char *content = malloc(file_size + 1);
      if (!content) {
        logger(LOG_ERROR, "Failed to allocate %ld bytes for file content",
               file_size);
        fclose(fp);
        callback(ctx, NULL, 0, user_data);
        free(ctx->url);
        free(ctx);
        return NULL;
      }

      /* Read file */
      size_t read_size = fread(content, 1, file_size, fp);
      content[read_size] = '\0';
      fclose(fp);

      logger(LOG_DEBUG, "file:// fetch completed synchronously (%zu bytes): %s",
             read_size, url);

      /* Invoke callback with content (caller must free) */
      callback(ctx, content, read_size, user_data);

      /* Free context immediately */
      free(ctx->url);
      free(ctx);
      return NULL; /* NULL = immediate completion */
    }
  }

  /* Create context */
  http_fetch_ctx_t *ctx = calloc(1, sizeof(*ctx));
  if (!ctx) {
    logger(LOG_ERROR, "Failed to allocate HTTP fetch context");
    return NULL;
  }

  ctx->url = strdup(url);
  ctx->callback = callback;
  ctx->fd_callback = fd_callback;
  ctx->user_data = user_data;
  ctx->epfd = epfd;
  ctx->pipe_fd = -1;
  ctx->use_fd = (fd_callback != NULL);

  /* Create temporary file */
  temp_fd = mkstemp(temp_file_template);
  if (temp_fd == -1) {
    logger(LOG_ERROR, "Failed to create temporary file for async HTTP fetch");
    http_fetch_free(ctx);
    return NULL;
  }
  close(temp_fd);
  ctx->temp_file = strdup(temp_file_template);

  /* Build fetch command - output to temp file, errors to stdout for monitoring
   */
  if (build_fetch_command(fetch_cmd, sizeof(fetch_cmd), url, ctx->temp_file,
                          30) < 0) {
    http_fetch_free(ctx);
    return NULL;
  }

  logger(LOG_DEBUG, "Starting async HTTP fetch: %s", url);

  /* Start fetch process with popen */
  ctx->pipe_fp = popen(fetch_cmd, "r");
  if (!ctx->pipe_fp) {
    logger(LOG_ERROR, "Failed to start fetch process: %s", strerror(errno));
    http_fetch_free(ctx);
    return NULL;
  }

  /* Get file descriptor from FILE* */
  ctx->pipe_fd = fileno(ctx->pipe_fp);
  if (ctx->pipe_fd < 0) {
    logger(LOG_ERROR, "Failed to get file descriptor from popen");
    http_fetch_free(ctx);
    return NULL;
  }

  /* Set non-blocking mode */
  int flags = fcntl(ctx->pipe_fd, F_GETFL, 0);
  if (flags < 0 || fcntl(ctx->pipe_fd, F_SETFL, flags | O_NONBLOCK) < 0) {
    logger(LOG_ERROR, "Failed to set non-blocking mode on pipe: %s",
           strerror(errno));
    http_fetch_free(ctx);
    return NULL;
  }

  /* Allocate initial buffer for curl output (errors/progress) */
  ctx->buffer_size = HTTP_FETCH_BUFFER_SIZE;
  ctx->buffer = malloc(ctx->buffer_size);
  if (!ctx->buffer) {
    logger(LOG_ERROR, "Failed to allocate buffer for async HTTP fetch");
    http_fetch_free(ctx);
    return NULL;
  }
  ctx->buffer_used = 0;

  /* Register pipe fd with epoll */
  memset(&ev, 0, sizeof(ev));
  ev.events = EPOLLIN | EPOLLHUP | EPOLLERR;
  ev.data.fd = ctx->pipe_fd;

  if (epoll_ctl(epfd, EPOLL_CTL_ADD, ctx->pipe_fd, &ev) < 0) {
    logger(LOG_ERROR, "Failed to add async HTTP fetch to epoll: %s",
           strerror(errno));
    http_fetch_free(ctx);
    return NULL;
  }

  /* Initialize hashmap if needed */
  http_fetch_init_map();

  /* Add to hashmap for fast fd-based lookup */
  if (fetch_fd_map) {
    http_fetch_ctx_t *ctx_ptr = ctx;
    hashmap_set(fetch_fd_map, &ctx_ptr);
  }

  logger(LOG_DEBUG, "Async HTTP fetch started, pipe_fd=%d", ctx->pipe_fd);
  return ctx;
}

/* Handle epoll event for async HTTP fetch */
int http_fetch_handle_event(http_fetch_ctx_t *ctx) {
  char read_buf[HTTP_FETCH_BUFFER_SIZE];
  ssize_t nread;

  if (!ctx)
    return -1;

  /* Read available data from pipe (curl stderr output) */
  while ((nread = read(ctx->pipe_fd, read_buf, sizeof(read_buf))) > 0) {
    /* Grow buffer if needed */
    while (ctx->buffer_used + nread + 1 > ctx->buffer_size) {
      size_t new_size = ctx->buffer_size * 2;
      if (new_size > MAX_HTTP_CONTENT) {
        logger(LOG_ERROR, "Async HTTP fetch output too large");
        http_fetch_cancel(ctx);
        return -1;
      }
      char *new_buf = realloc(ctx->buffer, new_size);
      if (!new_buf) {
        logger(LOG_ERROR, "Failed to grow buffer for async HTTP fetch");
        http_fetch_cancel(ctx);
        return -1;
      }
      ctx->buffer = new_buf;
      ctx->buffer_size = new_size;
    }

    /* Append to buffer */
    memcpy(ctx->buffer + ctx->buffer_used, read_buf, nread);
    ctx->buffer_used += nread;
  }

  if (nread < 0 && errno != EAGAIN && errno != EWOULDBLOCK) {
    logger(LOG_ERROR, "Error reading from async HTTP fetch pipe: %s",
           strerror(errno));
    http_fetch_cancel(ctx);
    return -1;
  }

  /* Check if pipe has closed (curl process finished) */
  if (nread == 0) {
    FILE *fp;
    char *content = NULL;
    long file_size;
    size_t read_size;
    int exit_code = -1;

    logger(LOG_DEBUG, "Async HTTP fetch pipe closed, checking results");

    /* Null-terminate buffer */
    if (ctx->buffer_used < ctx->buffer_size) {
      ctx->buffer[ctx->buffer_used] = '\0';
    }

    /* Parse exit code from output */
    char *exit_marker = strstr(ctx->buffer, "EXIT_CODE:");
    if (exit_marker) {
      exit_code = atoi(exit_marker + 10);
    }

    /* Check fetch exit code */
    if (exit_code != 0) {
      logger(LOG_ERROR, "Async HTTP fetch failed (exit code %d): %s", exit_code,
             ctx->url);
      logger(LOG_DEBUG, "Fetch output: %.*s", (int)ctx->buffer_used,
             ctx->buffer);
      http_fetch_cancel(ctx);
      return -1;
    }

    /* Handle fd-based callback (zero-copy) */
    if (ctx->use_fd) {
      int content_fd;

      /* Open downloaded file */
      content_fd = open(ctx->temp_file, O_RDONLY);
      if (content_fd < 0) {
        logger(LOG_ERROR, "Failed to open downloaded file: %s", ctx->temp_file);
        http_fetch_cancel(ctx);
        return -1;
      }

      /* Get file size */
      file_size = lseek(content_fd, 0, SEEK_END);
      lseek(content_fd, 0, SEEK_SET);

      if (file_size < 0 || file_size > MAX_HTTP_CONTENT) {
        logger(LOG_ERROR, "Invalid or too large downloaded file (size: %ld)",
               file_size);
        close(content_fd);
        http_fetch_cancel(ctx);
        return -1;
      }

      logger(LOG_DEBUG,
             "Async HTTP fetch completed successfully (%ld bytes, fd=%d): %s",
             file_size, content_fd, ctx->url);

      http_fetch_remove_from_map(ctx);

      /* Call fd-based callback with file descriptor
       * Note: temp_file will be unlinked by http_fetch_free,
       * but the fd remains valid until the caller closes it */
      ctx->fd_callback(ctx, content_fd, (size_t)file_size, ctx->user_data);

      /* Cleanup context */
      http_fetch_free(ctx);
      return 1;
    }

    /* Handle memory-based callback (traditional) */
    /* Read downloaded file */
    fp = fopen(ctx->temp_file, "r");
    if (!fp) {
      logger(LOG_ERROR, "Failed to open downloaded file: %s", ctx->temp_file);
      http_fetch_cancel(ctx);
      return -1;
    }

    /* Get file size */
    fseek(fp, 0, SEEK_END);
    file_size = ftell(fp);
    fseek(fp, 0, SEEK_SET);

    if (file_size < 0 || file_size > MAX_HTTP_CONTENT) {
      logger(LOG_ERROR, "Invalid or too large downloaded file (size: %ld)",
             file_size);
      fclose(fp);
      http_fetch_cancel(ctx);
      return -1;
    }

    /* Allocate memory for content */
    content = malloc(file_size + 1);
    if (!content) {
      logger(LOG_ERROR, "Failed to allocate memory for HTTP content");
      fclose(fp);
      http_fetch_cancel(ctx);
      return -1;
    }

    /* Read file content */
    read_size = fread(content, 1, file_size, fp);
    content[read_size] = '\0';
    fclose(fp);

    logger(LOG_DEBUG, "Async HTTP fetch completed successfully (%zu bytes): %s",
           read_size, ctx->url);

    http_fetch_remove_from_map(ctx);

    /* Call completion callback with actual content size */
    ctx->callback(ctx, content, read_size, ctx->user_data);

    /* Cleanup context */
    http_fetch_free(ctx);
    return 1;
  }

  /* More data expected */
  return 0;
}

/* Cancel and cleanup async HTTP fetch */
void http_fetch_cancel(http_fetch_ctx_t *ctx) {
  if (!ctx)
    return;

  logger(LOG_DEBUG, "Cancelling async HTTP fetch: %s", ctx->url);

  http_fetch_remove_from_map(ctx);

  /* Invoke callback with NULL/error to signal cancellation */
  if (ctx->use_fd && ctx->fd_callback) {
    ctx->fd_callback(ctx, -1, 0, ctx->user_data);
  } else if (ctx->callback) {
    ctx->callback(ctx, NULL, 0, ctx->user_data);
  }

  /* Cleanup */
  http_fetch_free(ctx);
}

/* Start async HTTP fetch using popen (memory-based) */
http_fetch_ctx_t *http_fetch_start_async(const char *url,
                                         http_fetch_callback_t callback,
                                         void *user_data, int epfd) {
  return http_fetch_start_async_internal(url, callback, NULL, user_data, epfd);
}

/* Start async HTTP fetch using popen (fd-based, zero-copy) */
http_fetch_ctx_t *http_fetch_start_async_fd(const char *url,
                                            http_fetch_fd_callback_t callback,
                                            void *user_data, int epfd) {
  return http_fetch_start_async_internal(url, NULL, callback, user_data, epfd);
}
