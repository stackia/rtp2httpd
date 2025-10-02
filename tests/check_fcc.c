#include <check.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/socket.h>
#include <arpa/inet.h>

#include "fcc.h"
#include "rtp.h"
#include "http.h"
#include "stream.h"
#include "rtp2httpd.h"

/* Provide minimal stubs for external dependencies from fcc.c */
int bind_to_upstream_interface(int sockfd)
{
    (void)sockfd;
    return 0;
}
enum fcc_nat_traversal conf_fcc_nat_traversal = FCC_NAT_T_DISABLED;
int join_mcast_group(struct services_s *service, int epoll_fd)
{
    (void)service;
    (void)epoll_fd;
    return 0;
}

static ssize_t read_with_timeout(int fd, char *buf, size_t maxlen, int timeout_ms)
{
    fd_set rfds;
    FD_ZERO(&rfds);
    FD_SET(fd, &rfds);
    struct timeval tv;
    tv.tv_sec = timeout_ms / 1000;
    tv.tv_usec = (timeout_ms % 1000) * 1000;
    int r = select(fd + 1, &rfds, NULL, NULL, &tv);
    if (r <= 0)
        return 0;
    return read(fd, buf, maxlen);
}

static void build_basic_rtp(uint8_t *buf, size_t *len_out, uint16_t seqn, const uint8_t *payload, size_t plen)
{
    size_t i = 0;
    buf[i++] = 0x80; /* V=2 */
    buf[i++] = 96;   /* PT */
    buf[i++] = (seqn >> 8) & 0xFF;
    buf[i++] = (seqn) & 0xFF;
    /* Timestamp + SSRC */
    buf[i++] = buf[i++] = buf[i++] = buf[i++] = 0;
    buf[i++] = buf[i++] = buf[i++] = buf[i++] = 0;
    memcpy(buf + i, payload, plen);
    *len_out = i + plen;
}

START_TEST(test_fcc_session_init_and_set_state)
{
    fcc_session_t fcc;
    fcc_session_init(&fcc);
    ck_assert_int_eq(fcc.state, FCC_STATE_INIT);
    int r = fcc_session_set_state(&fcc, FCC_STATE_REQUESTED, "req");
    ck_assert_int_eq(r, 1);
    ck_assert_int_eq(fcc.state, FCC_STATE_REQUESTED);
    r = fcc_session_set_state(&fcc, FCC_STATE_REQUESTED, "req-again");
    ck_assert_int_eq(r, 0);
}
END_TEST

START_TEST(test_fcc_handle_unicast_media_and_duplicates)
{
    int sp[2];
    ck_assert_int_eq(socketpair(AF_UNIX, SOCK_STREAM, 0, sp), 0);

    struct stream_context_s ctx;
    memset(&ctx, 0, sizeof(ctx));
    ctx.client_fd = sp[1];

    uint8_t pkt[128];
    size_t len;
    build_basic_rtp(pkt, &len, 10, (const uint8_t *)"DATA", 4);

    /* First packet written */
    int rr = fcc_handle_unicast_media(&ctx, pkt, (int)len);
    ck_assert_int_eq(rr, 0);
    char buf[16];
    ssize_t r = read_with_timeout(sp[0], buf, sizeof(buf), 200);
    ck_assert_int_eq(r, 4);

    /* Duplicate should be dropped */
    rr = fcc_handle_unicast_media(&ctx, pkt, (int)len);
    r = read_with_timeout(sp[0], buf, sizeof(buf), 200);
    ck_assert_int_eq(r, 0);

    /* Next seqn should pass */
    build_basic_rtp(pkt, &len, 11, (const uint8_t *)"X", 1);
    rr = fcc_handle_unicast_media(&ctx, pkt, (int)len);
    ck_assert_int_eq(rr, 0);
    r = read_with_timeout(sp[0], buf, sizeof(buf), 200);
    ck_assert_int_eq(r, 1);
    ck_assert_int_eq(buf[0], 'X');

    close(sp[0]);
    close(sp[1]);
}
END_TEST

START_TEST(test_fcc_mcast_transition_and_active_flush)
{
    int sp[2];
    ck_assert_int_eq(socketpair(AF_UNIX, SOCK_STREAM, 0, sp), 0);

    struct stream_context_s ctx;
    memset(&ctx, 0, sizeof(ctx));
    ctx.client_fd = sp[1];
    /* Avoid sending termination packets */
    ctx.fcc.fcc_term_sent = 1;

    uint8_t pkt[256];
    size_t len;
    build_basic_rtp(pkt, &len, 100, (const uint8_t *)"ABCDEF", 6);

    int rr = fcc_handle_mcast_transition(&ctx, pkt, (int)len);
    ck_assert_int_eq(rr, 0);
    ck_assert_ptr_ne(ctx.fcc.mcast_pending_buf, NULL);
    ck_assert(ctx.fcc.mcast_pbuf_current > ctx.fcc.mcast_pending_buf);

    rr = fcc_handle_mcast_active(&ctx, pkt, (int)len);
    ck_assert_int_eq(rr, 0);

    char buf[64];
    ssize_t r = read(sp[0], buf, sizeof(buf));
    ck_assert_int_ge(r, 6); /* pending + current write may be combined */

    close(sp[0]);
    close(sp[1]);
}
END_TEST

Suite *fcc_suite(void)
{
    Suite *s = suite_create("FCC");
    TCase *tc = tcase_create("Basic");
    tcase_add_test(tc, test_fcc_session_init_and_set_state);
    tcase_add_test(tc, test_fcc_handle_unicast_media_and_duplicates);
    tcase_add_test(tc, test_fcc_mcast_transition_and_active_flush);
    suite_add_tcase(s, tc);
    return s;
}

int main(void)
{
    int nf;
    Suite *s = fcc_suite();
    SRunner *sr = srunner_create(s);
    srunner_run_all(sr, CK_NORMAL);
    nf = srunner_ntests_failed(sr);
    srunner_free(sr);
    return (nf == 0) ? EXIT_SUCCESS : EXIT_FAILURE;
}
