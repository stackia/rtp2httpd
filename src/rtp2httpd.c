#include "rtp2httpd.h"
#include "configuration.h"
#include "status.h"
#include "supervisor.h"
#include "utils.h"
#include <unistd.h>

/* GLOBALS */
int worker_id = SUPERVISOR_WORKER_ID; /* Worker ID for this process (0-based) */

int main(int argc, char *argv[]) {
  parse_cmd_line(argc, argv);

  /* Initialize status tracking system (before fork, shared memory) */
  if (status_init() != 0) {
    logger(LOG_ERROR, "Failed to initialize status tracking");
    /* Continue anyway - status page won't work but streaming will */
  }

  logger(LOG_INFO, "Starting rtp2httpd with %d worker(s)", config.workers);
  return supervisor_run();
}
