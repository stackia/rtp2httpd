#ifndef __HTTPCLIENTS_H__
#define __HTTPCLIENTS_H__

/*
 * Service for connected client.
 * Run in forked thread.
 *
 * @param s connected socket
 */
void client_service(int s);

#endif /* __HTTPCLIENTS_H__ */
