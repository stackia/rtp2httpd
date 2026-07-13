#ifndef __PID_FILE_H__
#define __PID_FILE_H__

/**
 * Activate the configured supervisor PID file during startup.
 *
 * @param path PID file path, or NULL/empty to disable PID file handling
 * @return 0 on success, -1 on error
 */
int pid_file_activate(const char *path);

/**
 * Prepare a PID file change without disturbing the currently active file.
 * Call pid_file_commit() after all configuration reload side effects succeed,
 * or pid_file_rollback() if the reload is rejected.
 *
 * @param path New PID file path, or NULL/empty to disable PID file handling
 * @return 0 on success, -1 on error
 */
int pid_file_prepare(const char *path);
void pid_file_commit(void);
void pid_file_rollback(void);

/** Close inherited PID file descriptors in a newly forked worker. */
void pid_file_close_in_worker(void);

/** Remove the active supervisor PID file and release its lock. */
void pid_file_cleanup(void);

#endif /* __PID_FILE_H__ */
