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

  /* Fatal: workers dereference status_shared without NULL checks; continuing
   * would just SIGSEGV-loop the supervisor. */
  if (status_init() != 0) {
    logger(LOG_FATAL, "Failed to initialize status tracking, exiting");
    return 1;
  }

  logger(LOG_INFO, "Starting rtp2httpd with %d worker(s)", config.workers);
  return supervisor_run();
}
