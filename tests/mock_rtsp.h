#ifndef TESTS_MOCK_RTSP_H
#define TESTS_MOCK_RTSP_H

#include <stddef.h>
#include <stdint.h>

void mock_reset_network(void);
void mock_set_socket_return(int ret);
void mock_set_connect_return(int ret);
void mock_set_send_return(int ret);
void mock_set_recv_return(int ret);
void mock_set_recv_data(const char *data, size_t size);
const char *mock_get_send_buffer(void);
void mock_setup_hostname(const char *hostname, const char *ip_addr);

void setup_mock_rtsp_response(const char *status_line, const char *headers, const char *body);
void setup_mock_rtsp_describe_response(void);
void setup_mock_rtsp_setup_response(void);
void setup_mock_rtsp_play_response(void);
void setup_mock_rtsp_redirect_response(const char *location);
void setup_mock_rtsp_error_response(int error_code, const char *error_message);

int write_to_client(int client_fd, const uint8_t *data, size_t size);
int write_rtp_payload_to_client(int client_fd, int packet_size, const uint8_t *packet_data,
                                uint16_t *current_seqn, uint16_t *not_first_packet);

#endif /* TESTS_MOCK_RTSP_H */
