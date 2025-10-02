/*
 * Minimal tests covering stream-related status triggering behavior.
 * We avoid heavy mocking of epoll/RTSP/FCC by validating the contract:
 * - status_update_client triggers event only on state changes.
 */

#include <check.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <fcntl.h>
#include <time.h>
#include <signal.h>
#include <sys/wait.h>

#include "status.h"
#include "rtp2httpd.h"
#include "stream.h"

static void set_nonblock(int fd)
{
    int flags = fcntl(fd, F_GETFL, 0);
    fcntl(fd, F_SETFL, flags | O_NONBLOCK);
}

static void setup_env(void)
{
    ck_assert_int_eq(status_init(), 0);
}

static void teardown_env(void)
{
    status_cleanup();
}

/* RTSP/FCC minimal stubs for runtime-path test */
void rtsp_session_init(rtsp_session_t *r)
{
    memset(r, 0, sizeof(*r));
    r->state = RTSP_STATE_INIT;
}
int rtsp_parse_server_url(rtsp_session_t *r, const char *url, const char *ps, const char *ua)
{
    (void)r;
    (void)url;
    (void)ps;
    (void)ua;
    return -1;
}
int rtsp_connect(rtsp_session_t *r)
{
    (void)r;
    return -1;
}
int rtsp_describe(rtsp_session_t *r)
{
    (void)r;
    return -1;
}
int rtsp_setup(rtsp_session_t *r)
{
    (void)r;
    return -1;
}
int rtsp_play(rtsp_session_t *r)
{
    (void)r;
    return -1;
}
void rtsp_session_cleanup(rtsp_session_t *r) { (void)r; }

void fcc_session_init(fcc_session_t *f)
{
    memset(f, 0, sizeof(*f));
    f->state = FCC_STATE_INIT;
}
void fcc_session_cleanup(fcc_session_t *f, struct services_s *s)
{
    (void)f;
    (void)s;
}
int fcc_handle_server_response(struct stream_context_s *ctx, uint8_t *buf, int len, struct sockaddr_in *peer)
{
    (void)ctx;
    (void)buf;
    (void)len;
    (void)peer;
    return -1;
}
int fcc_handle_sync_notification(struct stream_context_s *ctx)
{
    (void)ctx;
    return -1;
}
int fcc_handle_unicast_media(struct stream_context_s *ctx, uint8_t *buf, int len)
{
    (void)ctx;
    (void)buf;
    (void)len;
    return -1;
}
int fcc_handle_mcast_active(struct stream_context_s *ctx, uint8_t *buf, int len)
{
    (void)ctx;
    (void)buf;
    (void)len;
    return -1;
}
int fcc_handle_mcast_transition(struct stream_context_s *ctx, uint8_t *buf, int len)
{
    (void)ctx;
    (void)buf;
    (void)len;
    return -1;
}
int fcc_initialize_and_request(struct stream_context_s *ctx)
{
    (void)ctx;
    return -1;
}
int fcc_session_set_state(fcc_session_t *fcc, fcc_state_t new_state, const char *reason)
{
    (void)fcc;
    (void)new_state;
    (void)reason;
    return 0;
}

int join_mcast_group(struct services_s *service, int epoll_fd)
{
    (void)service;
    (void)epoll_fd;
    return -1;
}
int rtsp_handle_rtp_data(rtsp_session_t *r, int client_fd)
{
    (void)r;
    (void)client_fd;
    return -1;
}

START_TEST(test_status_update_event_on_state_change_only)
{
    struct sockaddr_in sin;
    memset(&sin, 0, sizeof(sin));
    sin.sin_family = AF_INET;
    sin.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    sin.sin_port = htons(40000);

    int slot = status_register_client(getpid(), (struct sockaddr_storage *)&sin, sizeof(sin));
    ck_assert_int_ge(slot, 0);

    /* Drain notifications */
    set_nonblock(status_shared->notification_pipe[0]);
    char buf[16];
    while (read(status_shared->notification_pipe[0], buf, sizeof(buf)) > 0)
    {
    }

    status_shared->clients[slot].state = CLIENT_STATE_RTSP_INIT;
    status_shared->clients[slot].last_update = time(NULL);
    status_shared->clients[slot].bytes_sent = 100;

    /* Same state -> no event */
    status_update_client(CLIENT_STATE_RTSP_INIT, "init", 150, 0);
    ssize_t n = read(status_shared->notification_pipe[0], buf, sizeof(buf));
    ck_assert_int_le(n, 0);

    /* Different state -> event */
    status_update_client(CLIENT_STATE_RTSP_DESCRIBED, "desc", 200, 0);
    n = read(status_shared->notification_pipe[0], buf, sizeof(buf));
    ck_assert_int_ge(n, 1);
}
END_TEST

START_TEST(test_start_media_stream_rtsp_missing_url_exits)
{
    /* Initialize status shared memory used by start_media_stream */
    ck_assert_int_eq(status_init(), 0);

    int sp[2];
    ck_assert_int_eq(socketpair(AF_UNIX, SOCK_STREAM, 0, sp), 0);

    struct services_s *svc = calloc(1, sizeof(*svc));
    svc->service_type = SERVICE_RTSP;
    svc->rtsp_url = NULL; /* trigger error path */

    pid_t pid = fork();
    ck_assert_int_ge(pid, 0);
    if (pid == 0)
    {
        start_media_stream(sp[1], svc);
        _exit(0);
    }

    int status = 0;
    waitpid(pid, &status, 0);
    ck_assert_int_ne(WIFEXITED(status), 0);
    ck_assert_int_eq(WEXITSTATUS(status), RETVAL_RTP_FAILED);

    close(sp[0]);
    close(sp[1]);
    status_cleanup();
}

END_TEST

Suite *stream_suite(void)
{
    Suite *s = suite_create("Stream");
    TCase *tc = tcase_create("StateChange");
    tcase_add_checked_fixture(tc, setup_env, teardown_env);
    tcase_add_test(tc, test_status_update_event_on_state_change_only);
    suite_add_tcase(s, tc);

    TCase *tc_rt = tcase_create("RuntimeMissingURL");
    tcase_add_test(tc_rt, test_start_media_stream_rtsp_missing_url_exits);
    suite_add_tcase(s, tc_rt);
    return s;
}

int main(void)
{
    int number_failed;
    Suite *s;
    SRunner *sr;

    s = stream_suite();
    sr = srunner_create(s);

    srunner_run_all(sr, CK_NORMAL);
    number_failed = srunner_ntests_failed(sr);
    srunner_free(sr);

    return (number_failed == 0) ? EXIT_SUCCESS : EXIT_FAILURE;
}
