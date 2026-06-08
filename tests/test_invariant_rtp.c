#include <check.h>
#include <stdlib.h>
#include <string.h>

/* Import the RTP parsing function from the production code */
extern int rtp_parse(const unsigned char *buf, int len, unsigned char **payload, int *payload_len);

START_TEST(test_rtp_parse_rejects_short_buffers)
{
    /* Invariant: rtp_parse must never read beyond the provided buffer length.
     * It must safely reject packets that are too short to contain valid headers. */
    unsigned char *payload = NULL;
    int payload_len = 0;
    int ret;

    /* Case 1: Zero-length buffer (exploit case - triggers OOB at line 31) */
    unsigned char empty[] = {0};
    ret = rtp_parse(empty, 0, &payload, &payload_len);
    ck_assert_int_le(ret, 0);

    /* Case 2: 3-byte buffer - too short for seq_be read at buf+2 */
    unsigned char short3[] = {0x80, 0x00, 0x01};
    ret = rtp_parse(short3, 3, &payload, &payload_len);
    ck_assert_int_le(ret, 0);

    /* Case 3: Header with extension bit set but truncated before ext_len
     * RTP header: V=2, P=0, X=1, CC=0, M=0, PT=0, seq=1, ts=0, ssrc=0
     * Minimum fixed header is 12 bytes; extension needs 4 more bytes minimum */
    unsigned char ext_trunc[] = {0x90, 0x00, 0x00, 0x01,
                                  0x00, 0x00, 0x00, 0x00,
                                  0x00, 0x00, 0x00, 0x00,
                                  0xBE, 0xDE}; /* only 14 bytes, ext_len at offset 14 missing */
    ret = rtp_parse(ext_trunc, 14, &payload, &payload_len);
    ck_assert_int_le(ret, 0);

    /* Case 4: Valid minimal RTP packet (no extension, no CSRC) - 12 byte header + 4 payload */
    unsigned char valid[] = {0x80, 0x00, 0x00, 0x01,
                             0x00, 0x00, 0x00, 0x00,
                             0x00, 0x00, 0x00, 0x00,
                             0xDE, 0xAD, 0xBE, 0xEF};
    ret = rtp_parse(valid, 16, &payload, &payload_len);
    ck_assert_int_ge(ret, 0);
}
END_TEST

Suite *security_suite(void)
{
    Suite *s;
    TCase *tc_core;

    s = suite_create("Security");
    tc_core = tcase_create("Core");

    tcase_add_test(tc_core, test_rtp_parse_rejects_short_buffers);
    suite_add_tcase(s, tc_core);

    return s;
}

int main(void)
{
    int number_failed;
    Suite *s;
    SRunner *sr;

    s = security_suite();
    sr = srunner_create(s);

    srunner_run_all(sr, CK_NORMAL);
    number_failed = srunner_ntests_failed(sr);
    srunner_free(sr);

    return (number_failed == 0) ? EXIT_SUCCESS : EXIT_FAILURE;
}