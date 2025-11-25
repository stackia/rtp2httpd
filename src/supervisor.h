#ifndef __SUPERVISOR_H__
#define __SUPERVISOR_H__

#define SUPERVISOR_WORKER_ID (-1)

/**
 * Supervisor module for multi-process worker management
 *
 * The supervisor is responsible for:
 * - Spawning and managing worker processes
 * - Monitoring worker health and restarting crashed workers
 * - Rate-limiting restarts to prevent restart storms
 *
 * Future extensions (not yet implemented):
 * - SIGHUP handling for configuration reload
 */

/**
 * Run the supervisor process
 *
 * This function forks worker processes and monitors them.
 * When a worker exits unexpectedly, it will be restarted.
 * The supervisor exits when it receives SIGTERM/SIGINT.
 *
 * Child processes use prctl(PR_SET_PDEATHSIG, SIGTERM) to ensure
 * they exit when the supervisor exits, so no explicit signal
 * forwarding is needed.
 *
 * @return 0 on success, non-zero on error
 */
int supervisor_run(void);

/**
 * Run the worker process business logic
 *
 * This function contains the main worker logic extracted from main():
 * - Creates and binds listening sockets
 * - Runs the event loop
 * - Cleans up resources on exit
 *
 * @return 0 on success, non-zero on error
 */
int run_worker(void);

#endif /* __SUPERVISOR_H__ */
