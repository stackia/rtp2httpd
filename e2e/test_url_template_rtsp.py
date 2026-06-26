"""
E2E tests for RTSP resolver-layer time and seek URL template handling.
"""

import re
import time

import pytest

from helpers import (
    MockRTSPServer,
    MockRTSPServerUDP,
    R2HProcess,
    find_free_port,
    stream_get,
)

_TIMEOUT = 10.0
_STREAM_TIMEOUT = 20.0

# Known epoch values for test assertions (UTC):
# 2024-01-01 12:00:00 UTC = 1704110400
# 2024-01-01 13:00:00 UTC = 1704114000
_BEGIN_EPOCH = 1704110400
_END_EPOCH = 1704114000
_DURATION = _END_EPOCH - _BEGIN_EPOCH  # 3600


@pytest.fixture(scope="module")
def shared_r2h(r2h_binary):
    """A single rtp2httpd instance shared by URL template tests."""
    port = find_free_port()
    r2h = R2HProcess(r2h_binary, port, extra_args=["-v", "4", "-m", "100"])
    r2h.start()
    yield r2h
    r2h.stop()


def _extract_query_param(path, param_name):
    """Extract a query parameter value from a path or URI."""
    match = re.search(r"[?&]%s=([^&]+)" % re.escape(param_name), path)
    assert match, "Expected %s= in path, got: %s" % (param_name, path)
    return match.group(1)


def _get_describe_uri(rtsp):
    """Extract the URI from the first DESCRIBE request."""
    describe_reqs = [r for r in rtsp.requests_detailed if r["method"] == "DESCRIBE"]
    assert len(describe_reqs) > 0, "Expected DESCRIBE request"
    return describe_reqs[0]["uri"]


@pytest.mark.rtsp
class TestRTSPPathTemplate:
    """Verify template substitution in RTSP URIs."""

    def test_begin_end_in_describe_uri(self, shared_r2h):
        """${(b)...}/${(e)...} in RTSP URL should be substituted in DESCRIBE URI."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            url = (
                "/rtsp/127.0.0.1:%d"
                "/path/${(b)yyyyMMddHHmmss}/${(e)yyyyMMddHHmmss}/stream"
                "?playseek=20240101120000-20240101130000"
            ) % rtsp.port
            status, _, body = stream_get(
                "127.0.0.1",
                shared_r2h.port,
                url,
                read_bytes=4096,
                timeout=_STREAM_TIMEOUT,
            )
            assert status == 200

            describe_reqs = [r for r in rtsp.requests_detailed if r["method"] == "DESCRIBE"]
            assert len(describe_reqs) > 0, "Expected DESCRIBE request"
            uri = describe_reqs[0]["uri"]
            assert "20240101120000" in uri, "Begin template should be substituted in DESCRIBE URI, got: %s" % uri
            assert "20240101130000" in uri, "End template should be substituted in DESCRIBE URI, got: %s" % uri
            assert "${" not in uri, "No unresolved templates should remain in URI, got: %s" % uri
        finally:
            rtsp.stop()

    def test_utc_in_rtsp_uri(self, shared_r2h):
        """{utc} in RTSP URL should be substituted with ISO8601."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            url = ("/rtsp/127.0.0.1:%d/stream/{utc}?playseek=20240101120000-20240101130000") % rtsp.port
            status, _, body = stream_get(
                "127.0.0.1",
                shared_r2h.port,
                url,
                read_bytes=4096,
                timeout=_STREAM_TIMEOUT,
            )
            assert status == 200

            describe_reqs = [r for r in rtsp.requests_detailed if r["method"] == "DESCRIBE"]
            assert len(describe_reqs) > 0
            uri = describe_reqs[0]["uri"]
            assert "2024-01-01T12:00:00.000Z" in uri, "Expected ISO8601 in URI, got: %s" % uri
        finally:
            rtsp.stop()

    def test_template_with_custom_seek_name(self, shared_r2h):
        """Template substitution with r2h-seek-name in RTSP."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            url = (
                "/rtsp/127.0.0.1:%d"
                "/path/${(b)yyyyMMddHHmmss}/stream"
                "?r2h-seek-name=myseek&myseek=20240101120000-20240101130000"
            ) % rtsp.port
            status, _, body = stream_get(
                "127.0.0.1",
                shared_r2h.port,
                url,
                read_bytes=4096,
                timeout=_STREAM_TIMEOUT,
            )
            assert status == 200

            describe_reqs = [r for r in rtsp.requests_detailed if r["method"] == "DESCRIBE"]
            assert len(describe_reqs) > 0
            uri = describe_reqs[0]["uri"]
            assert "20240101120000" in uri, "Template should be substituted in RTSP URI, got: %s" % uri
            assert "${" not in uri, "No unresolved templates, got: %s" % uri
            assert "r2h-seek-name" not in uri, "r2h-seek-name should be stripped, got: %s" % uri
        finally:
            rtsp.stop()

    def test_rtsp_duration_placeholder(self, shared_r2h):
        """{duration} in RTSP URL should be substituted."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            url = ("/rtsp/127.0.0.1:%d/stream/{duration}?playseek=20240101120000-20240101130000") % rtsp.port
            status, _, body = stream_get(
                "127.0.0.1",
                shared_r2h.port,
                url,
                read_bytes=4096,
                timeout=_STREAM_TIMEOUT,
            )
            assert status == 200

            describe_reqs = [r for r in rtsp.requests_detailed if r["method"] == "DESCRIBE"]
            assert len(describe_reqs) > 0
            uri = describe_reqs[0]["uri"]
            assert "/stream/3600" in uri, "Duration should be 3600 in RTSP URI, got: %s" % uri
        finally:
            rtsp.stop()

    def test_template_expands_when_recent_clock_path_fires(self, shared_r2h):
        """${...} placeholders in the RTSP URL must still expand even when
        the recent-clock path fires (r2h-seek-mode=range + begin within the
        window). Regression guard for a bug where the recent-clock branch
        forwarded a NULL parse_result to the URL resolver, leaving
        placeholders unresolved in the DESCRIBE URI."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            start_ts = int(time.time()) - 1500  # 25 min ago, within 1h window
            # UTC-format yyyyMMddHHmmss + no UA TZ + range(3600): begin_tm_utc
            # echoes the same string back via ${(b)yyyyMMddHHmmss}, and the
            # recent-clock path also fires (verified via PLAY Range header).
            utc_str = time.strftime("%Y%m%d%H%M%S", time.gmtime(start_ts))
            url = ("/rtsp/127.0.0.1:%d/path/${(b)yyyyMMddHHmmss}/stream?playseek=%s&r2h-seek-mode=range(3600)") % (
                rtsp.port,
                utc_str,
            )

            stream_get("127.0.0.1", shared_r2h.port, url, read_bytes=4096, timeout=_STREAM_TIMEOUT)

            uri = _get_describe_uri(rtsp)
            assert "${" not in uri, "Template placeholder left unresolved in DESCRIBE URI: %s" % uri
            assert ("/path/%s/stream" % utc_str) in uri, (
                "Begin template should be substituted in DESCRIBE URI, got: %s" % uri
            )
            # Cross-check the recent-clock path actually fired.
            play_reqs = [r for r in rtsp.requests_detailed if r["method"] == "PLAY"]
            expected_clock = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime(start_ts))
            assert play_reqs[0]["headers"].get("Range") == "clock=%s-" % expected_clock
        finally:
            rtsp.stop()


@pytest.mark.rtsp
class TestRTSPQueryAppendMode:
    """RTSP query-append seek handling without URL templates."""

    def test_query_append_no_template(self, shared_r2h):
        """RTSP URL without template should append playseek as query param."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            url = ("/rtsp/127.0.0.1:%d/stream?playseek=20240101120000-20240101130000") % rtsp.port
            status, _, body = stream_get(
                "127.0.0.1",
                shared_r2h.port,
                url,
                read_bytes=4096,
                timeout=_STREAM_TIMEOUT,
            )
            assert status == 200

            describe_reqs = [r for r in rtsp.requests_detailed if r["method"] == "DESCRIBE"]
            assert len(describe_reqs) > 0
            uri = describe_reqs[0]["uri"]
            assert "playseek=" in uri, "Query-append RTSP should have playseek in URI, got: %s" % uri
        finally:
            rtsp.stop()

    def test_playseek_udp(self, shared_r2h):
        """playseek query-append should work over RTSP UDP transport."""
        rtsp = MockRTSPServerUDP()
        rtsp.start()
        try:
            url = ("/rtsp/127.0.0.1:%d/stream?playseek=20240101120000-20240101130000") % rtsp.port
            status, _, body = stream_get(
                "127.0.0.1",
                shared_r2h.port,
                url,
                read_bytes=4096,
                timeout=_STREAM_TIMEOUT,
            )
            assert status == 200
            assert len(body) > 0
        finally:
            rtsp.stop()

    def test_tvdr_forwarded_in_uri(self, shared_r2h):
        """tvdr should be forwarded in the RTSP DESCRIBE URI."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            url = ("/rtsp/127.0.0.1:%d/stream?tvdr=20240601080000-20240601090000") % rtsp.port
            status, _, _ = stream_get(
                "127.0.0.1",
                shared_r2h.port,
                url,
                read_bytes=4096,
                timeout=_STREAM_TIMEOUT,
            )
            assert status == 200

            uri = _get_describe_uri(rtsp)
            assert "tvdr=" in uri, "tvdr should be forwarded in DESCRIBE URI"
        finally:
            rtsp.stop()

    def test_playseek_correct_path_in_uri(self, shared_r2h):
        """RTSP query-append should preserve the upstream server path."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            url = ("/rtsp/127.0.0.1:%d/live/channel1?playseek=20240101120000-20240101130000") % rtsp.port
            stream_get(
                "127.0.0.1",
                shared_r2h.port,
                url,
                read_bytes=2048,
                timeout=_STREAM_TIMEOUT,
            )

            uri = _get_describe_uri(rtsp)
            assert "/live/channel1" in uri
        finally:
            rtsp.stop()

    def test_custom_seek_forwarded_in_uri(self, shared_r2h):
        """Custom seek parameters should be forwarded in RTSP query-append mode."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            url = ("/rtsp/127.0.0.1:%d/stream?r2h-seek-name=myseek&myseek=20240301100000-20240301110000") % rtsp.port
            status, _, _ = stream_get(
                "127.0.0.1",
                shared_r2h.port,
                url,
                read_bytes=4096,
                timeout=_STREAM_TIMEOUT,
            )
            assert status == 200

            uri = _get_describe_uri(rtsp)
            assert "myseek=" in uri, "Custom seek param should be in DESCRIBE URI"
            assert "r2h-seek-name" not in uri, "r2h-seek-name should be stripped"
        finally:
            rtsp.stop()


@pytest.mark.rtsp
class TestRTSPQueryAppendOffsetAndFormat:
    """Offset, timezone, and format preservation for RTSP query-append."""

    def test_positive_offset(self, shared_r2h):
        """r2h-seek-offset=3600 should add 1 hour to RTSP playseek values."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            url = ("/rtsp/127.0.0.1:%d/stream?playseek=20240101120000-20240101130000&r2h-seek-offset=3600") % rtsp.port
            stream_get(
                "127.0.0.1",
                shared_r2h.port,
                url,
                read_bytes=4096,
                timeout=_STREAM_TIMEOUT,
            )

            uri = _get_describe_uri(rtsp)
            assert _extract_query_param(uri, "playseek") == "20240101130000-20240101140000"
        finally:
            rtsp.stop()

    def test_offset_pair(self, shared_r2h):
        """r2h-seek-offset=a,b should add separate begin/end offsets in RTSP."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            url = (
                "/rtsp/127.0.0.1:%d/stream?playseek=20240101120000-20240101130000&r2h-seek-offset=30,-60"
            ) % rtsp.port
            stream_get(
                "127.0.0.1",
                shared_r2h.port,
                url,
                read_bytes=4096,
                timeout=_STREAM_TIMEOUT,
            )

            uri = _get_describe_uri(rtsp)
            assert _extract_query_param(uri, "playseek") == "20240101120030-20240101125900"
        finally:
            rtsp.stop()

    def test_negative_offset(self, shared_r2h):
        """r2h-seek-offset=-30 should subtract 30 seconds from RTSP playseek."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            url = ("/rtsp/127.0.0.1:%d/stream?playseek=20240101120000-20240101130000&r2h-seek-offset=-30") % rtsp.port
            stream_get(
                "127.0.0.1",
                shared_r2h.port,
                url,
                read_bytes=4096,
                timeout=_STREAM_TIMEOUT,
            )

            uri = _get_describe_uri(rtsp)
            assert _extract_query_param(uri, "playseek") == "20240101115930-20240101125930"
        finally:
            rtsp.stop()

    def test_offset_stripped_from_uri(self, shared_r2h):
        """r2h-seek-offset should not be forwarded to the RTSP server."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            url = ("/rtsp/127.0.0.1:%d/stream?playseek=20240101120000-20240101130000&r2h-seek-offset=3600") % rtsp.port
            stream_get(
                "127.0.0.1",
                shared_r2h.port,
                url,
                read_bytes=4096,
                timeout=_STREAM_TIMEOUT,
            )

            uri = _get_describe_uri(rtsp)
            assert "r2h-seek-offset" not in uri
        finally:
            rtsp.stop()

    def test_offset_with_unix_timestamp(self, shared_r2h):
        """r2h-seek-offset should work with Unix timestamps in RTSP."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            url = ("/rtsp/127.0.0.1:%d/stream?playseek=1704096000-1704099600&r2h-seek-offset=3600") % rtsp.port
            stream_get(
                "127.0.0.1",
                shared_r2h.port,
                url,
                read_bytes=4096,
                timeout=_STREAM_TIMEOUT,
            )

            uri = _get_describe_uri(rtsp)
            assert _extract_query_param(uri, "playseek") == "1704099600-1704103200"
        finally:
            rtsp.stop()

    def test_tz_utc_plus_8_converts_yyyyMMddHHmmss(self, shared_r2h):
        """TZ/UTC+8 should subtract 8 hours from yyyyMMddHHmmss in RTSP mode."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            url = ("/rtsp/127.0.0.1:%d/stream?playseek=20240101120000-20240101130000") % rtsp.port
            stream_get(
                "127.0.0.1",
                shared_r2h.port,
                url,
                read_bytes=4096,
                timeout=_STREAM_TIMEOUT,
                headers={"User-Agent": "TestPlayer/1.0 TZ/UTC+8"},
            )

            uri = _get_describe_uri(rtsp)
            assert _extract_query_param(uri, "playseek") == "20240101040000-20240101050000"
        finally:
            rtsp.stop()

    def test_tz_utc_minus_5_converts_yyyyMMddHHmmss(self, shared_r2h):
        """TZ/UTC-5 should add 5 hours to yyyyMMddHHmmss in RTSP mode."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            url = ("/rtsp/127.0.0.1:%d/stream?playseek=20240101120000-20240101130000") % rtsp.port
            stream_get(
                "127.0.0.1",
                shared_r2h.port,
                url,
                read_bytes=4096,
                timeout=_STREAM_TIMEOUT,
                headers={"User-Agent": "TestPlayer/1.0 TZ/UTC-5"},
            )

            uri = _get_describe_uri(rtsp)
            assert _extract_query_param(uri, "playseek") == "20240101170000-20240101180000"
        finally:
            rtsp.stop()

    def test_no_tz_no_conversion(self, shared_r2h):
        """Without TZ/ in User-Agent, RTSP times should not be converted."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            url = ("/rtsp/127.0.0.1:%d/stream?playseek=20240101120000-20240101130000") % rtsp.port
            stream_get(
                "127.0.0.1",
                shared_r2h.port,
                url,
                read_bytes=4096,
                timeout=_STREAM_TIMEOUT,
                headers={"User-Agent": "TestPlayer/1.0"},
            )

            uri = _get_describe_uri(rtsp)
            assert _extract_query_param(uri, "playseek") == "20240101120000-20240101130000"
        finally:
            rtsp.stop()

    def test_unix_timestamp_skips_tz_conversion(self, shared_r2h):
        """Unix timestamps should not be timezone-converted in RTSP mode."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            url = ("/rtsp/127.0.0.1:%d/stream?playseek=1704096000-1704099600") % rtsp.port
            stream_get(
                "127.0.0.1",
                shared_r2h.port,
                url,
                read_bytes=4096,
                timeout=_STREAM_TIMEOUT,
                headers={"User-Agent": "TestPlayer/1.0 TZ/UTC+8"},
            )

            uri = _get_describe_uri(rtsp)
            assert _extract_query_param(uri, "playseek") == "1704096000-1704099600"
        finally:
            rtsp.stop()

    def test_tz_with_offset_combined(self, shared_r2h):
        """TZ/UTC+8 combined with r2h-seek-offset should apply both in RTSP."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            url = ("/rtsp/127.0.0.1:%d/stream?playseek=20240101120000-20240101130000&r2h-seek-offset=3600") % rtsp.port
            stream_get(
                "127.0.0.1",
                shared_r2h.port,
                url,
                read_bytes=4096,
                timeout=_STREAM_TIMEOUT,
                headers={"User-Agent": "TestPlayer/1.0 TZ/UTC+8"},
            )

            uri = _get_describe_uri(rtsp)
            assert _extract_query_param(uri, "playseek") == "20240101050000-20240101060000"
        finally:
            rtsp.stop()

    def test_gmt_suffix_preserved(self, shared_r2h):
        """yyyyMMddHHmmssGMT format should preserve the GMT suffix in RTSP."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            url = (
                "/rtsp/127.0.0.1:%d/stream?playseek=20240101120000GMT-20240101130000GMT&r2h-seek-offset=3600"
            ) % rtsp.port
            stream_get(
                "127.0.0.1",
                shared_r2h.port,
                url,
                read_bytes=4096,
                timeout=_STREAM_TIMEOUT,
            )

            uri = _get_describe_uri(rtsp)
            assert _extract_query_param(uri, "playseek") == "20240101130000GMT-20240101140000GMT"
        finally:
            rtsp.stop()

    def test_unix_timestamp_format_preserved(self, shared_r2h):
        """Unix timestamp format should stay as Unix timestamp in RTSP."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            url = ("/rtsp/127.0.0.1:%d/stream?playseek=1704096000-1704099600") % rtsp.port
            stream_get(
                "127.0.0.1",
                shared_r2h.port,
                url,
                read_bytes=4096,
                timeout=_STREAM_TIMEOUT,
            )

            uri = _get_describe_uri(rtsp)
            assert _extract_query_param(uri, "playseek") == "1704096000-1704099600"
        finally:
            rtsp.stop()

    def test_gmt_suffix_ignores_ua_tz(self, shared_r2h):
        """yyyyMMddHHmmssGMT is a self-contained UTC marker; UA TZ must NOT
        shift the value in RTSP either, mirroring the ISO-8601 `Z` contract."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            url = ("/rtsp/127.0.0.1:%d/stream?playseek=20240101120000GMT-20240101130000GMT") % rtsp.port
            stream_get(
                "127.0.0.1",
                shared_r2h.port,
                url,
                read_bytes=4096,
                timeout=_STREAM_TIMEOUT,
                headers={"User-Agent": "TestPlayer/1.0 TZ/UTC+8"},
            )

            uri = _get_describe_uri(rtsp)
            assert _extract_query_param(uri, "playseek") == "20240101120000GMT-20240101130000GMT"
        finally:
            rtsp.stop()

    def test_iso8601_z_ignores_range_mode_tz(self, shared_r2h):
        """Companion to the UA-TZ self-contained-TZ tests above: when the seek
        input is ISO-8601 with an embedded `Z` suffix, neither UA TZ NOR
        r2h-seek-mode=range(<TZ>) may shift the parsed instant. Exercises
        the recent-clock path (PLAY Range: clock=...) since range(<TZ>) is
        the only entry point for the explicit-TZ recompute branch."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            start_ts = int(time.time()) - 1500  # 25 min ago, within 1h window
            iso_str = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime(start_ts))
            # range(UTC+9) AND a UA TZ that disagrees with both the range TZ
            # and the embedded `Z` — the `Z` wins regardless.
            url = "/rtsp/127.0.0.1:%d/stream?playseek=%s&r2h-seek-mode=range(UTC%%2B9/3600)" % (rtsp.port, iso_str)

            stream_get(
                "127.0.0.1",
                shared_r2h.port,
                url,
                read_bytes=4096,
                timeout=_STREAM_TIMEOUT,
                headers={"User-Agent": "TestPlayer/1.0 TZ/UTC+8"},
            )

            play_reqs = [r for r in rtsp.requests_detailed if r["method"] == "PLAY"]
            expected_clock = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime(start_ts))
            assert play_reqs[0]["headers"].get("Range") == "clock=%s-" % expected_clock, (
                "Embedded `Z` must take precedence over both range(<TZ>) and UA TZ — "
                "got Range header %r" % play_reqs[0]["headers"].get("Range")
            )
        finally:
            rtsp.stop()

    def test_gmt_suffix_ignores_range_mode_tz(self, shared_r2h):
        """Companion to test_gmt_suffix_ignores_ua_tz: same self-contained-TZ
        contract on the recent-clock path. range(<TZ>) is the only entry
        point for the explicit-TZ recompute branch, so it's the only way
        to fully prove the GMT suffix is authoritative everywhere."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            start_ts = int(time.time()) - 1500  # 25 min ago, within 1h window
            gmt_str = time.strftime("%Y%m%d%H%M%S", time.gmtime(start_ts)) + "GMT"
            url = "/rtsp/127.0.0.1:%d/stream?playseek=%s&r2h-seek-mode=range(UTC%%2B9/3600)" % (rtsp.port, gmt_str)

            stream_get(
                "127.0.0.1",
                shared_r2h.port,
                url,
                read_bytes=4096,
                timeout=_STREAM_TIMEOUT,
                headers={"User-Agent": "TestPlayer/1.0 TZ/UTC+8"},
            )

            play_reqs = [r for r in rtsp.requests_detailed if r["method"] == "PLAY"]
            expected_clock = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime(start_ts))
            assert play_reqs[0]["headers"].get("Range") == "clock=%s-" % expected_clock, (
                "GMT suffix must take precedence over both range(<TZ>) and UA TZ — "
                "got Range header %r" % play_reqs[0]["headers"].get("Range")
            )
        finally:
            rtsp.stop()
