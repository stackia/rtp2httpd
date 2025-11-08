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

#endif /* __CONFIGURATION_H__ */
