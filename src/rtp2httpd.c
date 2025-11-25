#include "rtp2httpd.h"
#include "configuration.h"
#include "status.h"
#include "supervisor.h"
#include "utils.h"
#include <unistd.h>

/* GLOBALS */
int worker_id = 0; /* Worker ID for this process (0-based) */

int main(int argc, char *argv[]) {
  parse_cmd_line(argc, argv);

  /* Initialize status tracking system (before fork, shared memory) */
  if (status_init() != 0) {
    logger(LOG_ERROR, "Failed to initialize status tracking");
    /* Continue anyway - status page won't work but streaming will */
  }

  if (config.workers > 1) {
    /* Multi-worker mode: run as supervisor */
    logger(LOG_INFO, "Starting supervisor with %d workers (SO_REUSEPORT)",
           config.workers);
    return supervisor_run();
  } else {
    /* Single worker mode: run worker directly */
    logger(LOG_INFO, "Starting single worker (pid=%d)", (int)getpid());
    return run_worker();
  }
}
