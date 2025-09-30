#ifndef __HTTPCLIENTS_H__
#define __HTTPCLIENTS_H__

/**
 * Handle HTTP client connection in forked process.
 * Parses HTTP request, validates it, finds matching service, and starts streaming.
 *
 * @param client_socket Connected client socket descriptor
 */
void handle_http_client(int client_socket);

#endif /* __HTTPCLIENTS_H__ */
