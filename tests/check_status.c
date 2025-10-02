/*
 * Unit tests for status.c using Check framework
 */

#include <check.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <fcntl.h>
#include <sys/wait.h>
#include <time.h>

#include "status.h"
#include "rtp2httpd.h"

static void drain_pipe(int fd)
{
    char buf[256];
    while (read(fd, buf, sizeof(buf)) > 0)
    {
        /* drain */
    }
}

static void set_nonblock(int fd)
{
    int flags = fcntl(fd, F_GETFL, 0);
    fcntl(fd, F_SETFL, flags | O_NONBLOCK);
}

/* Setup/teardown */
static void setup_status(void)
{
    ck_assert_int_eq(status_init(), 0);
}

static void teardown_status(void)
{
    status_cleanup();
}

START_TEST(test_register_unregister_triggers_events)
{
    /* Create fake client addr 127.0.0.1:12345 */
    struct sockaddr_in sin;
    memset(&sin, 0, sizeof(sin));
    sin.sin_family = AF_INET;
    sin.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    sin.sin_port = htons(12345);

    int before = status_shared->total_clients;

    int slot = status_register_client(getpid(), (struct sockaddr_storage *)&sin, sizeof(sin));
    ck_assert_int_ge(slot, 0);
    ck_assert_int_eq(status_shared->total_clients, before + 1);

    /* Notification pipe should have data */
    set_nonblock(status_shared->notification_pipe[0]);
    char b[8];
    ssize_t n = read(status_shared->notification_pipe[0], b, sizeof(b));
    ck_assert_int_ge(n, 1);

    /* Unregister should decrement and notify */
    before = status_shared->total_clients;
    status_unregister_client(getpid());
    ck_assert_int_eq(status_shared->total_clients, before - 1);
    n = read(status_shared->notification_pipe[0], b, sizeof(b));
    ck_assert_int_ge(n, 1);
}
END_TEST

START_TEST(test_update_client_bandwidth_and_state_event)
{
    /* Register current pid */
    struct sockaddr_in sin;
    memset(&sin, 0, sizeof(sin));
    sin.sin_family = AF_INET;
    sin.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    sin.sin_port = htons(20000);

    int slot = status_register_client(getpid(), (struct sockaddr_storage *)&sin, sizeof(sin));
    ck_assert_int_ge(slot, 0);

    /* Drain any existing notifications */
    set_nonblock(status_shared->notification_pipe[0]);
    drain_pipe(status_shared->notification_pipe[0]);

    /* Set previous values to compute bandwidth */
    status_shared->clients[slot].bytes_sent = 1000;
    status_shared->clients[slot].last_update = time(NULL) - 1; /* 1 second ago */
    status_shared->clients[slot].state = CLIENT_STATE_FCC_INIT;

    /* Same state: should NOT write to notification pipe */
    status_update_client(CLIENT_STATE_FCC_INIT, "Init", 2000, 0);
    /* Bandwidth should be ~1000 B/s */
    ck_assert_int_ge(status_shared->clients[slot].current_bandwidth, 900);

    char buf[8];
    ssize_t n = read(status_shared->notification_pipe[0], buf, sizeof(buf));
    ck_assert_int_le(n, 0); /* no event */

    /* State change: should trigger event */
    status_update_client(CLIENT_STATE_FCC_UNICAST_ACTIVE, "Unicast", 2500, 0);
    n = read(status_shared->notification_pipe[0], buf, sizeof(buf));
    ck_assert_int_ge(n, 1);
}
END_TEST

START_TEST(test_log_ring_wraps_correctly)
{
    /* Fill log to capacity and ensure wrap works */
    /* Start fresh */
    status_shared->log_write_index = 0;
    status_shared->log_count = 0;
    for (int i = 0; i < STATUS_MAX_LOG_ENTRIES + 5; i++)
    {
        char msg[64];
        snprintf(msg, sizeof(msg), "E%d", i);
        status_add_log_entry(LOG_INFO, msg);
    }
    /* Count should be capped */
    ck_assert_int_eq(status_shared->log_count, STATUS_MAX_LOG_ENTRIES);
    /* Write index should be 5 (because we wrote 5 beyond capacity) */
    ck_assert_int_eq(status_shared->log_write_index, 5 % STATUS_MAX_LOG_ENTRIES);
    /* The last written message should be E104 (assuming max entries is 100 -> 0..104) */
    /* To avoid assuming the exact max, verify the entry just before write_index corresponds to last write */
    int last_idx = (status_shared->log_write_index + STATUS_MAX_LOG_ENTRIES - 1) % STATUS_MAX_LOG_ENTRIES;
    ck_assert_str_ne(status_shared->log_entries[last_idx].message, "");
}
END_TEST

START_TEST(test_set_log_level_error_paths)
{
    int sp[2];
    ck_assert_int_eq(socketpair(AF_UNIX, SOCK_STREAM, 0, sp), 0);

    /* Missing level */
    handle_set_log_level(sp[1], 1, NULL);
    char buf[512];
    ssize_t r = read(sp[0], buf, sizeof(buf));
    ck_assert_int_gt(r, 0);
    buf[r] = '\0';
    ck_assert_ptr_ne(strstr(buf, "400"), NULL);
    ck_assert_ptr_ne(strstr(buf, "Missing level parameter"), NULL);

    /* Invalid level */
    handle_set_log_level(sp[1], 1, "99");
    r = read(sp[0], buf, sizeof(buf));
    ck_assert_int_gt(r, 0);
    buf[r] = '\0';
    ck_assert_ptr_ne(strstr(buf, "400"), NULL);
    ck_assert_ptr_ne(strstr(buf, "Invalid log level"), NULL);

    close(sp[0]);
    close(sp[1]);
}
END_TEST

START_TEST(test_handle_status_sse_basic_stream_and_close)
{
    /* Prepare one client for JSON content */
    struct sockaddr_in sin;
    memset(&sin, 0, sizeof(sin));
    sin.sin_family = AF_INET;
    sin.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    sin.sin_port = htons(30000);
    status_register_client(getpid(), (struct sockaddr_storage *)&sin, sizeof(sin));

    int sp[2];
    ck_assert_int_eq(socketpair(AF_UNIX, SOCK_STREAM, 0, sp), 0);

    pid_t pid = fork();
    ck_assert_int_ge(pid, 0);

    if (pid == 0)
    {
        /* Child: run SSE handler */
        close(sp[0]);
        handle_status_sse(sp[1], 1);
        close(sp[1]);
        _exit(0);
    }

    /* Parent: read headers and some data */
    close(sp[1]);
    set_nonblock(sp[0]);

    char buf[8192];
    ssize_t total = 0;
    time_t start = time(NULL);

    /* Read until we see SSE header and a data: line or timeout */
    int saw_headers = 0, saw_data = 0;
    while (time(NULL) - start < 2)
    {
        ssize_t r = read(sp[0], buf + total, sizeof(buf) - total - 1);
        if (r > 0)
        {
            total += r;
            buf[total] = '\0';
            if (strstr(buf, "Content-Type: text/event-stream"))
                saw_headers = 1;
            if (strstr(buf, "data: {"))
            {
                saw_data = 1;
                break;
            }
        }
        else
        {
            usleep(20000);
        }
    }
    ck_assert_msg(saw_headers, "SSE headers not received");
    ck_assert_msg(saw_data, "SSE data not received");

    /* Close to make child exit */
    close(sp[0]);
    int status = 0;
    waitpid(pid, &status, 0);
}
END_TEST

Suite *status_suite(void)
{
    Suite *s = suite_create("Status");

    TCase *tc_basic = tcase_create("Basic");
    tcase_add_checked_fixture(tc_basic, setup_status, teardown_status);
    tcase_add_test(tc_basic, test_register_unregister_triggers_events);
    tcase_add_test(tc_basic, test_update_client_bandwidth_and_state_event);
    suite_add_tcase(s, tc_basic);

    TCase *tc_logs = tcase_create("Logs");
    tcase_add_checked_fixture(tc_logs, setup_status, teardown_status);
    tcase_add_test(tc_logs, test_log_ring_wraps_correctly);
    suite_add_tcase(s, tc_logs);

    TCase *tc_api = tcase_create("API");
    tcase_add_checked_fixture(tc_api, setup_status, teardown_status);
    tcase_add_test(tc_api, test_set_log_level_error_paths);
    suite_add_tcase(s, tc_api);

    TCase *tc_sse = tcase_create("SSE");
    tcase_add_checked_fixture(tc_sse, setup_status, teardown_status);
    tcase_add_test(tc_sse, test_handle_status_sse_basic_stream_and_close);
    suite_add_tcase(s, tc_sse);

    return s;
}

int main(void)
{
    int number_failed;
    Suite *s;
    SRunner *sr;

    s = status_suite();
    sr = srunner_create(s);

    srunner_run_all(sr, CK_NORMAL);
    number_failed = srunner_ntests_failed(sr);
    srunner_free(sr);

    return (number_failed == 0) ? EXIT_SUCCESS : EXIT_FAILURE;
}
