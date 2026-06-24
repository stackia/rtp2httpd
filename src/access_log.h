#ifndef __ACCESS_LOG_H__
#define __ACCESS_LOG_H__

typedef struct connection_s connection_t;
typedef struct service_s service_t;

void access_log_write_connection(connection_t *c, service_t *service, int status_index);
void access_log_reopen(void);
void access_log_cleanup(void);

#endif /* __ACCESS_LOG_H__ */
