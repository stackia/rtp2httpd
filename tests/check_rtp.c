#include <check.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/socket.h>
#include <sys/select.h>
#include <arpa/inet.h>

#include "rtp.h"
#include "http.h"
#include "rtp2httpd.h"

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

START_TEST(test_get_rtp_payload_basic)
{
    uint8_t pkt[64];
    size_t len;
    uint8_t *pl;
    int sz;
    uint8_t payload[] = {'A', 'B', 'C'};
    build_basic_rtp(pkt, &len, 1, payload, sizeof(payload));
    ck_assert_int_eq(get_rtp_payload(pkt, (int)len, &pl, &sz), 0);
    ck_assert_int_eq(sz, 3);
    ck_assert_int_eq(pl[0], 'A');
    ck_assert_int_eq(pl[1], 'B');
    ck_assert_int_eq(pl[2], 'C');
}
END_TEST

START_TEST(test_get_rtp_payload_with_csrc_ext_padding)
{
    uint8_t buf[128];
    int pos = 0;
    uint8_t *pl;
    int sz;
    /* V=2, X=1 (ext), P=1 (padding), CC=1 */
    buf[pos++] = 0xB1; /* 1011 0001 */
    buf[pos++] = 96;
    buf[pos++] = 0;
    buf[pos++] = 10; /* seq */
    memset(buf + pos, 0, 8);
    pos += 8; /* ts+ssrc */
    /* One CSRC */
    memset(buf + pos, 0, 4);
    pos += 4;
    /* Extension header: 16-bit id + 16-bit length (in 32-bit words) */
    buf[pos++] = 0;
    buf[pos++] = 1; /* id */
    buf[pos++] = 0;
    buf[pos++] = 1; /* length = 1 word (4 bytes) */
    /* 4 bytes extension data */
    memset(buf + pos, 0xEE, 4);
    pos += 4;
    /* Payload ABCDEF */
    memcpy(buf + pos, "ABCDEF", 6);
    pos += 6;
    /* Padding: 2 bytes */
    buf[pos++] = 0;
    buf[pos++] = 2; /* last byte = padding length */

    ck_assert_int_eq(get_rtp_payload(buf, pos, &pl, &sz), 0);
    /* Total payload area 8 (6 data + 2 padding), minus last padding length 2 -> 6 */
    ck_assert_int_eq(sz, 6);
    ck_assert_int_eq(pl[0], 'A');
    ck_assert_int_eq(pl[3], 'D');
}
END_TEST

START_TEST(test_get_rtp_payload_malformed_version)
{
    uint8_t pkt[16];
    memset(pkt, 0, sizeof(pkt));
    pkt[0] = 0x00; /* wrong version */
    uint8_t *pl;
    int sz;
    ck_assert_int_eq(get_rtp_payload(pkt, sizeof(pkt), &pl, &sz), -1);
}
END_TEST

START_TEST(test_get_rtp_payload_truncated_extension)
{
    uint8_t buf[20];
    int pos = 0;
    uint8_t *pl;
    int sz;
    buf[pos++] = 0x90; /* V=2, X=1, no CSRC */
    buf[pos++] = 96;
    buf[pos++] = 0;
    buf[pos++] = 1;
    memset(buf + pos, 0, 8);
    pos += 8;
    /* Extension header claims data but buffer ends */
    buf[pos++] = 0;
    buf[pos++] = 1; /* id */
    buf[pos++] = 0;
    buf[pos++] = 1; /* length=1 word */
    ck_assert_int_eq(get_rtp_payload(buf, pos, &pl, &sz), -1);
}
END_TEST

START_TEST(test_get_rtp_payload_invalid_length)
{
    uint8_t buf[12];
    memset(buf, 0, sizeof(buf));
    buf[0] = 0x80; /* V=2 */
    /* No payload -> invalid */
    uint8_t *pl;
    int sz;
    ck_assert_int_eq(get_rtp_payload(buf, sizeof(buf), &pl, &sz), -1);
}
END_TEST

START_TEST(test_write_rtp_payload_and_duplicate_detection)
{
    int sp[2];
    ck_assert_int_eq(socketpair(AF_UNIX, SOCK_STREAM, 0, sp), 0);
    uint8_t pkt[128];
    size_t len;
    uint16_t old_seq = 0;
    uint16_t not_first = 0;

    build_basic_rtp(pkt, &len, 100, (const uint8_t *)"HELLO", 5);
    write_rtp_payload_to_client(sp[1], (int)len, pkt, &old_seq, &not_first);
    char buf[16];
    ssize_t r = read_with_timeout(sp[0], buf, sizeof(buf), 200);
    ck_assert_int_eq(r, 5);
    ck_assert_int_eq(strncmp(buf, "HELLO", 5), 0);

    /* Duplicate packet should not be written */
    write_rtp_payload_to_client(sp[1], (int)len, pkt, &old_seq, &not_first);
    r = read_with_timeout(sp[0], buf, sizeof(buf), 200);
    ck_assert_int_eq(r, 0);

    /* Next sequence should be written */
    build_basic_rtp(pkt, &len, 101, (const uint8_t *)"X", 1);
    write_rtp_payload_to_client(sp[1], (int)len, pkt, &old_seq, &not_first);
    r = read_with_timeout(sp[0], buf, sizeof(buf), 200);
    ck_assert_int_eq(r, 1);
    ck_assert_int_eq(buf[0], 'X');

    close(sp[0]);
    close(sp[1]);
}
END_TEST

Suite *rtp_suite(void)
{
    Suite *s = suite_create("RTP");
    TCase *tc = tcase_create("Payload");
    tcase_add_test(tc, test_get_rtp_payload_basic);
    tcase_add_test(tc, test_get_rtp_payload_with_csrc_ext_padding);
    tcase_add_test(tc, test_get_rtp_payload_malformed_version);
    tcase_add_test(tc, test_get_rtp_payload_truncated_extension);
    tcase_add_test(tc, test_get_rtp_payload_invalid_length);
    tcase_add_test(tc, test_write_rtp_payload_and_duplicate_detection);
    suite_add_tcase(s, tc);
    return s;
}

int main(void)
{
    int nf;
    Suite *s = rtp_suite();
    SRunner *sr = srunner_create(s);
    srunner_run_all(sr, CK_NORMAL);
    nf = srunner_ntests_failed(sr);
    srunner_free(sr);
    return (nf == 0) ? EXIT_SUCCESS : EXIT_FAILURE;
}
