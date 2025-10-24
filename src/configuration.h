#ifndef __CONFIGURATION_H__
#define __CONFIGURATION_H__

#include <stdio.h>
#include <stdint.h>

/* Configuration parsing functions */
void parse_bind_sec(char *line);
void parse_services_sec(char *line);
void parse_global_sec(char *line);
int parse_config_file(const char *path);
void restore_conf_defaults(void);
void usage(FILE *f, char *progname);
void parse_bind_cmd(char *optarg);

/* Command line parsing */
void parse_cmd_line(int argc, char *argv[]);

/* Memory management */
struct bindaddr_s *new_empty_bindaddr(void);
void free_bindaddr(struct bindaddr_s *);

/* External M3U reloading */
int reload_external_m3u(void);

/* Async external M3U reloading (non-blocking, for worker processes)
 * epfd: epoll file descriptor for async I/O
 * Returns: 0 if async fetch started, -1 on error or if not configured
 */
int reload_external_m3u_async(int epfd);

#endif /* __CONFIGURATION_H__ */
