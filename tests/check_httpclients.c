/*
 * Unit tests for httpclients.c routing using Check framework
 * We avoid over-mocking by using socketpair and forking handle_http_client.
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

#include "rtp2httpd.h"
#include "status.h"
#include "httpclients.h"

/* Provide stub for start_media_stream to satisfy linker (we won't hit this path) */
void start_media_stream(int client, struct services_s *service)
{
    (void)client;
    (void)service;
    /* If ever called, just exit cleanly */
    exit(RETVAL_CLEAN);
}

static void set_nonblock(int fd)
{
    int flags = fcntl(fd, F_GETFL, 0);
    fcntl(fd, F_SETFL, flags | O_NONBLOCK);
}

static pid_t spawn_http_handler(int fd)
{
    pid_t pid = fork();
    ck_assert_int_ge(pid, 0);
    if (pid == 0)
    {
        handle_http_client(fd);
        _exit(0);
    }
    return pid;
}

static ssize_t read_all_nonblock(int fd, char *buf, size_t buflen, int ms_timeout)
{
    ssize_t total = 0;
    set_nonblock(fd);
    int elapsed = 0;
    while ((size_t)total < buflen - 1 && elapsed < ms_timeout)
    {
        ssize_t r = read(fd, buf + total, buflen - 1 - total);
        if (r > 0)
        {
            total += r;
            buf[total] = '\0';
            /* For simple tests we can break when headers are received */
            if (strstr(buf, "\r\n\r\n"))
                break;
        }
        else
        {
            usleep(10000);
            elapsed += 10;
        }
    }
    buf[total] = '\0';
    return total;
}

/* Setup/teardown to init status for SSE usage */
static void setup_status_env(void)
{
    ck_assert_int_eq(status_init(), 0);
}
static void teardown_status_env(void)
{
    status_cleanup();
}

START_TEST(test_get_root_serves_status_page)
{
    int sp[2];
    ck_assert_int_eq(socketpair(AF_UNIX, SOCK_STREAM, 0, sp), 0);

    /* Write minimal HTTP/1.1 GET request */
    const char *req = "GET / HTTP/1.1\r\nHost: test\r\n\r\n";
    write(sp[0], req, strlen(req));

    pid_t pid = spawn_http_handler(sp[1]);

    char buf[4096];
    ssize_t n = read_all_nonblock(sp[0], buf, sizeof(buf), 500);
    ck_assert_int_gt(n, 0);
    ck_assert_ptr_ne(strstr(buf, "200 OK"), NULL);
    ck_assert_ptr_ne(strstr(buf, "text/html"), NULL);

    close(sp[0]);
    int status = 0;
    waitpid(pid, &status, 0);
}
END_TEST

START_TEST(test_api_loglevel_changes)
{
    int sp[2];
    ck_assert_int_eq(socketpair(AF_UNIX, SOCK_STREAM, 0, sp), 0);

    const char *req = "GET /api/loglevel?level=2 HTTP/1.1\r\nHost: test\r\n\r\n";
    write(sp[0], req, strlen(req));

    pid_t pid = spawn_http_handler(sp[1]);

    char buf[4096];
    ssize_t n = read_all_nonblock(sp[0], buf, sizeof(buf), 500);
    ck_assert_int_gt(n, 0);
    ck_assert_ptr_ne(strstr(buf, "200 OK"), NULL);
    ck_assert_ptr_ne(strstr(buf, "success\":true"), NULL);
    /* Verify via shared memory since handler runs in child process */
    ck_assert_ptr_ne(status_shared, NULL);
    ck_assert_int_eq(status_shared->current_log_level, 2);

    close(sp[0]);
    int status = 0;
    waitpid(pid, &status, 0);
}
END_TEST

START_TEST(test_unsupported_method_returns_501)
{
    int sp[2];
    ck_assert_int_eq(socketpair(AF_UNIX, SOCK_STREAM, 0, sp), 0);

    const char *req = "POST / HTTP/1.1\r\nHost: test\r\n\r\n";
    write(sp[0], req, strlen(req));

    pid_t pid = spawn_http_handler(sp[1]);

    char buf[4096];
    ssize_t n = read_all_nonblock(sp[0], buf, sizeof(buf), 500);
    ck_assert_int_gt(n, 0);
    ck_assert_ptr_ne(strstr(buf, "501 Not Implemented"), NULL);

    close(sp[0]);
    int status = 0;
    waitpid(pid, &status, 0);
}
END_TEST

START_TEST(test_nonexistent_service_returns_404)
{
    int sp[2];
    ck_assert_int_eq(socketpair(AF_UNIX, SOCK_STREAM, 0, sp), 0);

    const char *req = "GET /no-such-service HTTP/1.1\r\nHost: test\r\n\r\n";
    write(sp[0], req, strlen(req));

    pid_t pid = spawn_http_handler(sp[1]);

    char buf[4096];
    ssize_t n = read_all_nonblock(sp[0], buf, sizeof(buf), 500);
    ck_assert_int_gt(n, 0);
    ck_assert_ptr_ne(strstr(buf, "404 Service Not Found"), NULL);

    close(sp[0]);
    int status = 0;
    waitpid(pid, &status, 0);
}
END_TEST

START_TEST(test_head_request_headers_only)
{
    /* Configure a dummy service to hit HEAD path */
    struct services_s *svc = calloc(1, sizeof(*svc));
    svc->url = strdup("test");
    svc->service_type = SERVICE_MRTP;
    services = svc;

    int sp[2];
    ck_assert_int_eq(socketpair(AF_UNIX, SOCK_STREAM, 0, sp), 0);
    const char *req = "HEAD /test HTTP/1.1\r\nHost: test\r\n\r\n";
    write(sp[0], req, strlen(req));
    pid_t pid = spawn_http_handler(sp[1]);

    char buf[4096];
    ssize_t n = read_all_nonblock(sp[0], buf, sizeof(buf), 500);
    ck_assert_int_gt(n, 0);
    ck_assert_ptr_ne(strstr(buf, "200 OK"), NULL);

    close(sp[0]);
    int status = 0;
    waitpid(pid, &status, 0);
    /* cleanup */
    free(svc->url);
    free(svc);
    services = NULL;
}
END_TEST

START_TEST(test_service_at_capacity_returns_503)
{
    struct services_s *svc = calloc(1, sizeof(*svc));
    svc->url = strdup("test");
    svc->service_type = SERVICE_MRTP;
    services = svc;

    extern int client_count;
    extern int conf_maxclients;
    conf_maxclients = 0;
    client_count = 1;

    int sp[2];
    ck_assert_int_eq(socketpair(AF_UNIX, SOCK_STREAM, 0, sp), 0);
    const char *req = "GET /test HTTP/1.1\r\nHost: test\r\n\r\n";
    write(sp[0], req, strlen(req));
    pid_t pid = spawn_http_handler(sp[1]);

    char buf[4096];
    ssize_t n = read_all_nonblock(sp[0], buf, sizeof(buf), 500);
    ck_assert_int_gt(n, 0);
    ck_assert_ptr_ne(strstr(buf, "503 Service Unavailable"), NULL);

    close(sp[0]);
    int status = 0;
    waitpid(pid, &status, 0);
    free(svc->url);
    free(svc);
    services = NULL;
}
END_TEST

START_TEST(test_hostname_mismatch_returns_400)
{
    extern char *conf_hostname;
    conf_hostname = strdup("good");
    int sp[2];
    ck_assert_int_eq(socketpair(AF_UNIX, SOCK_STREAM, 0, sp), 0);
    const char *req = "GET /any HTTP/1.1\r\nHost: bad\r\n\r\n";
    write(sp[0], req, strlen(req));

    pid_t pid = spawn_http_handler(sp[1]);
    char buf[4096];
    ssize_t n = read_all_nonblock(sp[0], buf, sizeof(buf), 500);
    ck_assert_int_gt(n, 0);
    ck_assert_ptr_ne(strstr(buf, "400 Bad Request"), NULL);

    close(sp[0]);
    int status = 0;
    waitpid(pid, &status, 0);
    free(conf_hostname);
    conf_hostname = NULL;
}
END_TEST

START_TEST(test_api_disconnect_missing_pid)
{
    int sp[2];
    ck_assert_int_eq(socketpair(AF_UNIX, SOCK_STREAM, 0, sp), 0);
    const char *req = "GET /api/disconnect HTTP/1.1\r\nHost: test\r\n\r\n";
    write(sp[0], req, strlen(req));
    pid_t pid = spawn_http_handler(sp[1]);
    char buf[4096];
    ssize_t n = read_all_nonblock(sp[0], buf, sizeof(buf), 500);
    ck_assert_int_gt(n, 0);
    ck_assert_ptr_ne(strstr(buf, "400 Bad Request"), NULL);

    close(sp[0]);
    int status = 0;
    waitpid(pid, &status, 0);
}
END_TEST

Suite *httpclients_suite(void)
{
    Suite *s = suite_create("HTTPClients");

    TCase *tc_status = tcase_create("StatusAndAPI");
    tcase_add_checked_fixture(tc_status, setup_status_env, teardown_status_env);
    tcase_add_test(tc_status, test_get_root_serves_status_page);
    tcase_add_test(tc_status, test_api_loglevel_changes);
    tcase_add_test(tc_status, test_unsupported_method_returns_501);
    tcase_add_test(tc_status, test_nonexistent_service_returns_404);
    tcase_add_test(tc_status, test_head_request_headers_only);
    tcase_add_test(tc_status, test_service_at_capacity_returns_503);
    tcase_add_test(tc_status, test_hostname_mismatch_returns_400);
    tcase_add_test(tc_status, test_api_disconnect_missing_pid);
    suite_add_tcase(s, tc_status);

    return s;
}

int main(void)
{
    int number_failed;
    Suite *s;
    SRunner *sr;

    s = httpclients_suite();
    sr = srunner_create(s);

    srunner_run_all(sr, CK_NORMAL);
    number_failed = srunner_ntests_failed(sr);
    srunner_free(sr);

    return (number_failed == 0) ? EXIT_SUCCESS : EXIT_FAILURE;
}
