"""
E2E tests for RTSP seek parameters.

Covers playseek, tvdr, custom seek name (r2h-seek-name), and
r2h-start (Range header forwarding).
"""

import pytest

from helpers import (
    MockRTSPServer,
    MockRTSPServerUDP,
    R2HProcess,
    find_free_port,
    stream_get,
)

pytestmark = pytest.mark.rtsp

_STREAM_TIMEOUT = 20.0


@pytest.fixture(scope="module")
def shared_r2h(r2h_binary):
    """A single rtp2httpd instance shared by all seek tests."""
    port = find_free_port()
    r2h = R2HProcess(r2h_binary, port, extra_args=["-v", "4", "-m", "100"])
    r2h.start()
    yield r2h
    r2h.stop()


# ===================================================================
# Playseek / timeshift
# ===================================================================


class TestRTSPPlayseek:
    """Verify playseek parameter is forwarded in RTSP requests."""

    def test_playseek_tcp(self, shared_r2h):
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            status, _, body = stream_get(
                "127.0.0.1", shared_r2h.port,
                "/rtsp/127.0.0.1:%d/stream?playseek=20240101120000-20240101130000" % rtsp.port,
                read_bytes=4096, timeout=_STREAM_TIMEOUT,
            )
            assert status == 200
            assert len(body) > 0
        finally:
            rtsp.stop()

    def test_playseek_udp(self, shared_r2h):
        rtsp = MockRTSPServerUDP()
        rtsp.start()
        try:
            status, _, body = stream_get(
                "127.0.0.1", shared_r2h.port,
                "/rtsp/127.0.0.1:%d/stream?playseek=20240101120000-20240101130000" % rtsp.port,
                read_bytes=4096, timeout=_STREAM_TIMEOUT,
            )
            assert status == 200
            assert len(body) > 0
        finally:
            rtsp.stop()


# ===================================================================
# Playseek forwarding verification
# ===================================================================


class TestRTSPPlayseekForwarding:
    """Verify that playseek parameters are forwarded in the RTSP URI."""

    def test_playseek_forwarded_in_describe_uri(self, shared_r2h):
        """playseek parameter should be forwarded in the DESCRIBE URI."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            status, _, body = stream_get(
                "127.0.0.1", shared_r2h.port,
                "/rtsp/127.0.0.1:%d/stream?playseek=20240101120000-20240101130000" % rtsp.port,
                read_bytes=4096, timeout=_STREAM_TIMEOUT,
            )
            assert status == 200

            # Verify DESCRIBE URI contains the playseek parameter
            describe_reqs = [r for r in rtsp.requests_detailed if r["method"] == "DESCRIBE"]
            assert len(describe_reqs) > 0, "Expected DESCRIBE request"
            uri = describe_reqs[0]["uri"]
            assert "/stream" in uri, "DESCRIBE URI should contain the path"
            assert "playseek=" in uri, \
                "playseek should be forwarded in DESCRIBE URI, got: %s" % uri
        finally:
            rtsp.stop()

    def test_playseek_correct_path_in_uri(self, shared_r2h):
        """The RTSP URI should contain the correct server path."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            stream_get(
                "127.0.0.1", shared_r2h.port,
                "/rtsp/127.0.0.1:%d/live/channel1?playseek=20240101120000-20240101130000" % rtsp.port,
                read_bytes=2048, timeout=_STREAM_TIMEOUT,
            )

            # DESCRIBE URI should include the full path
            describe_reqs = [r for r in rtsp.requests_detailed if r["method"] == "DESCRIBE"]
            assert len(describe_reqs) > 0
            uri = describe_reqs[0]["uri"]
            assert "/live/channel1" in uri
        finally:
            rtsp.stop()


# ===================================================================
# tvdr parameter (alternative to playseek)
# ===================================================================


class TestRTSPTvdr:
    """Verify tvdr parameter works as an alternative seek parameter."""

    def test_tvdr_forwarded_in_uri(self, shared_r2h):
        """tvdr parameter should be forwarded in the RTSP URI."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            status, _, body = stream_get(
                "127.0.0.1", shared_r2h.port,
                "/rtsp/127.0.0.1:%d/stream?tvdr=20240601080000-20240601090000" % rtsp.port,
                read_bytes=4096, timeout=_STREAM_TIMEOUT,
            )
            assert status == 200

            describe_reqs = [r for r in rtsp.requests_detailed if r["method"] == "DESCRIBE"]
            assert len(describe_reqs) > 0, "Expected DESCRIBE request"
            uri = describe_reqs[0]["uri"]
            assert "tvdr=" in uri, \
                "tvdr should be forwarded in DESCRIBE URI, got: %s" % uri
        finally:
            rtsp.stop()


# ===================================================================
# Custom seek parameter name (r2h-seek-name)
# ===================================================================


class TestRTSPCustomSeekName:
    """Verify r2h-seek-name allows specifying a custom seek parameter."""

    def test_custom_seek_forwarded_in_uri(self, shared_r2h):
        """The custom seek parameter should be forwarded in the RTSP URI."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            status, _, body = stream_get(
                "127.0.0.1", shared_r2h.port,
                "/rtsp/127.0.0.1:%d/stream?r2h-seek-name=myseek&myseek=20240301100000-20240301110000" % rtsp.port,
                read_bytes=4096, timeout=_STREAM_TIMEOUT,
            )
            assert status == 200

            describe_reqs = [r for r in rtsp.requests_detailed if r["method"] == "DESCRIBE"]
            assert len(describe_reqs) > 0, "Expected DESCRIBE request"
            uri = describe_reqs[0]["uri"]
            # The custom seek param should be forwarded
            assert "myseek=" in uri, \
                "Custom seek param should be in DESCRIBE URI, got: %s" % uri
        finally:
            rtsp.stop()

    def test_r2h_seek_name_stripped_from_uri(self, shared_r2h):
        """r2h-seek-name is an rtp2httpd meta-parameter and should be
        stripped from the RTSP URI, while the actual seek param stays."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            stream_get(
                "127.0.0.1", shared_r2h.port,
                "/rtsp/127.0.0.1:%d/stream?r2h-seek-name=myseek&myseek=20240301100000-20240301110000" % rtsp.port,
                read_bytes=2048, timeout=_STREAM_TIMEOUT,
            )

            describe_reqs = [r for r in rtsp.requests_detailed if r["method"] == "DESCRIBE"]
            assert len(describe_reqs) > 0
            uri = describe_reqs[0]["uri"]
            # r2h-seek-name is internal to rtp2httpd, should not reach RTSP server
            assert "r2h-seek-name" not in uri, \
                "r2h-seek-name should be stripped from URI, got: %s" % uri
            # But the actual seek param should be present
            assert "myseek=" in uri
        finally:
            rtsp.stop()


# ===================================================================
# r2h-start (seek / Range header)
# ===================================================================


class TestRTSPStartSeek:
    """r2h-start=<npt> adds Range header to PLAY for seeking."""

    def test_start_adds_range_header(self, shared_r2h):
        """r2h-start should be forwarded as Range: npt=<value>- in PLAY."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            stream_get(
                "127.0.0.1", shared_r2h.port,
                "/rtsp/127.0.0.1:%d/stream?r2h-start=120.5" % rtsp.port,
                read_bytes=4096, timeout=_STREAM_TIMEOUT,
            )

            play_reqs = [r for r in rtsp.requests_detailed
                         if r["method"] == "PLAY"]
            assert len(play_reqs) > 0, "Expected PLAY request"
            play_headers = play_reqs[0]["headers"]
            assert "Range" in play_headers, \
                "PLAY should have Range header, headers: %s" % play_headers
            assert "120.5" in play_headers["Range"], \
                "Range should contain npt start value, got: %s" % play_headers["Range"]
        finally:
            rtsp.stop()

    def test_start_stripped_from_rtsp_uri(self, shared_r2h):
        """r2h-start is an rtp2httpd meta-parameter and should be stripped
        from the RTSP URI sent to the server."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            stream_get(
                "127.0.0.1", shared_r2h.port,
                "/rtsp/127.0.0.1:%d/stream?r2h-start=60" % rtsp.port,
                read_bytes=4096, timeout=_STREAM_TIMEOUT,
            )

            describe_reqs = [r for r in rtsp.requests_detailed
                             if r["method"] == "DESCRIBE"]
            assert len(describe_reqs) > 0, "Expected DESCRIBE"
            uri = describe_reqs[0]["uri"]
            assert "r2h-start" not in uri, \
                "r2h-start should be stripped from RTSP URI, got: %s" % uri
        finally:
            rtsp.stop()

    def test_start_with_other_params(self, shared_r2h):
        """r2h-start should be stripped but other query params preserved."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            stream_get(
                "127.0.0.1", shared_r2h.port,
                "/rtsp/127.0.0.1:%d/stream?token=abc&r2h-start=30&sid=123" % rtsp.port,
                read_bytes=4096, timeout=_STREAM_TIMEOUT,
            )

            describe_reqs = [r for r in rtsp.requests_detailed
                             if r["method"] == "DESCRIBE"]
            assert len(describe_reqs) > 0, "Expected DESCRIBE"
            uri = describe_reqs[0]["uri"]
            assert "r2h-start" not in uri, \
                "r2h-start should be stripped, got: %s" % uri
            assert "token=abc" in uri, \
                "Other params should be preserved, got: %s" % uri
            assert "sid=123" in uri, \
                "Other params should be preserved, got: %s" % uri
        finally:
            rtsp.stop()

    def test_no_range_header_without_start(self, shared_r2h):
        """Without r2h-start, PLAY should not have a Range header."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            stream_get(
                "127.0.0.1", shared_r2h.port,
                "/rtsp/127.0.0.1:%d/stream" % rtsp.port,
                read_bytes=4096, timeout=_STREAM_TIMEOUT,
            )

            play_reqs = [r for r in rtsp.requests_detailed
                         if r["method"] == "PLAY"]
            assert len(play_reqs) > 0, "Expected PLAY request"
            play_headers = play_reqs[0]["headers"]
            assert "Range" not in play_headers, \
                "PLAY without r2h-start should not have Range, got: %s" % play_headers
        finally:
            rtsp.stop()


# ===================================================================
# r2h-seek-offset (additional seconds offset)
# ===================================================================


def _get_describe_uri(rtsp):
    """Extract the URI from the first DESCRIBE request."""
    describe_reqs = [r for r in rtsp.requests_detailed
                     if r["method"] == "DESCRIBE"]
    assert len(describe_reqs) > 0, "Expected DESCRIBE request"
    return describe_reqs[0]["uri"]


def _extract_seek_value(uri, param_name):
    """Extract a seek parameter value from a URI query string."""
    import re
    match = re.search(r'[?&]%s=([^&]+)' % re.escape(param_name), uri)
    assert match, "Expected %s= in URI, got: %s" % (param_name, uri)
    return match.group(1)


class TestRTSPSeekOffset:
    """Verify r2h-seek-offset applies additional seconds offset."""

    def test_positive_offset(self, shared_r2h):
        """r2h-seek-offset=3600 should add 1 hour to playseek times."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            stream_get(
                "127.0.0.1", shared_r2h.port,
                "/rtsp/127.0.0.1:%d/stream?playseek=20240101120000-20240101130000&r2h-seek-offset=3600" % rtsp.port,
                read_bytes=4096, timeout=_STREAM_TIMEOUT,
            )

            uri = _get_describe_uri(rtsp)
            val = _extract_seek_value(uri, "playseek")
            assert val == "20240101130000-20240101140000", \
                "Expected +1h offset, got: %s" % val
        finally:
            rtsp.stop()

    def test_negative_offset(self, shared_r2h):
        """r2h-seek-offset=-30 should subtract 30 seconds from playseek."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            stream_get(
                "127.0.0.1", shared_r2h.port,
                "/rtsp/127.0.0.1:%d/stream?playseek=20240101120000-20240101130000&r2h-seek-offset=-30" % rtsp.port,
                read_bytes=4096, timeout=_STREAM_TIMEOUT,
            )

            uri = _get_describe_uri(rtsp)
            val = _extract_seek_value(uri, "playseek")
            assert val == "20240101115930-20240101125930", \
                "Expected -30s offset, got: %s" % val
        finally:
            rtsp.stop()

    def test_offset_stripped_from_uri(self, shared_r2h):
        """r2h-seek-offset should be stripped from the RTSP URI."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            stream_get(
                "127.0.0.1", shared_r2h.port,
                "/rtsp/127.0.0.1:%d/stream?playseek=20240101120000-20240101130000&r2h-seek-offset=3600" % rtsp.port,
                read_bytes=4096, timeout=_STREAM_TIMEOUT,
            )

            uri = _get_describe_uri(rtsp)
            assert "r2h-seek-offset" not in uri, \
                "r2h-seek-offset should be stripped, got: %s" % uri
        finally:
            rtsp.stop()

    def test_offset_with_unix_timestamp(self, shared_r2h):
        """r2h-seek-offset should work with Unix timestamps."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            # 1704096000 = 2024-01-01T12:00:00 UTC
            stream_get(
                "127.0.0.1", shared_r2h.port,
                "/rtsp/127.0.0.1:%d/stream?playseek=1704096000-1704099600&r2h-seek-offset=3600" % rtsp.port,
                read_bytes=4096, timeout=_STREAM_TIMEOUT,
            )

            uri = _get_describe_uri(rtsp)
            val = _extract_seek_value(uri, "playseek")
            assert val == "1704099600-1704103200", \
                "Expected +3600 on Unix timestamps, got: %s" % val
        finally:
            rtsp.stop()


# ===================================================================
# Timezone conversion (User-Agent TZ/ marker)
# ===================================================================


class TestRTSPTimezone:
    """Verify timezone conversion based on User-Agent TZ/ marker."""

    def test_tz_utc_plus_8_converts_yyyyMMddHHmmss(self, shared_r2h):
        """TZ/UTC+8 should subtract 8 hours from yyyyMMddHHmmss format."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            stream_get(
                "127.0.0.1", shared_r2h.port,
                "/rtsp/127.0.0.1:%d/stream?playseek=20240101120000-20240101130000" % rtsp.port,
                read_bytes=4096, timeout=_STREAM_TIMEOUT,
                headers={"User-Agent": "TestPlayer/1.0 TZ/UTC+8"},
            )

            uri = _get_describe_uri(rtsp)
            val = _extract_seek_value(uri, "playseek")
            assert val == "20240101040000-20240101050000", \
                "TZ/UTC+8: 12:00 CST should become 04:00 UTC, got: %s" % val
        finally:
            rtsp.stop()

    def test_tz_utc_minus_5_converts_yyyyMMddHHmmss(self, shared_r2h):
        """TZ/UTC-5 should add 5 hours to yyyyMMddHHmmss format."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            stream_get(
                "127.0.0.1", shared_r2h.port,
                "/rtsp/127.0.0.1:%d/stream?playseek=20240101120000-20240101130000" % rtsp.port,
                read_bytes=4096, timeout=_STREAM_TIMEOUT,
                headers={"User-Agent": "TestPlayer/1.0 TZ/UTC-5"},
            )

            uri = _get_describe_uri(rtsp)
            val = _extract_seek_value(uri, "playseek")
            assert val == "20240101170000-20240101180000", \
                "TZ/UTC-5: 12:00 EST should become 17:00 UTC, got: %s" % val
        finally:
            rtsp.stop()

    def test_no_tz_no_conversion(self, shared_r2h):
        """Without TZ/ in User-Agent, yyyyMMddHHmmss should not be converted."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            stream_get(
                "127.0.0.1", shared_r2h.port,
                "/rtsp/127.0.0.1:%d/stream?playseek=20240101120000-20240101130000" % rtsp.port,
                read_bytes=4096, timeout=_STREAM_TIMEOUT,
                headers={"User-Agent": "TestPlayer/1.0"},
            )

            uri = _get_describe_uri(rtsp)
            val = _extract_seek_value(uri, "playseek")
            assert val == "20240101120000-20240101130000", \
                "No TZ: times should stay unchanged, got: %s" % val
        finally:
            rtsp.stop()

    def test_unix_timestamp_skips_tz_conversion(self, shared_r2h):
        """Unix timestamps should not be affected by User-Agent timezone."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            stream_get(
                "127.0.0.1", shared_r2h.port,
                "/rtsp/127.0.0.1:%d/stream?playseek=1704096000-1704099600" % rtsp.port,
                read_bytes=4096, timeout=_STREAM_TIMEOUT,
                headers={"User-Agent": "TestPlayer/1.0 TZ/UTC+8"},
            )

            uri = _get_describe_uri(rtsp)
            val = _extract_seek_value(uri, "playseek")
            assert val == "1704096000-1704099600", \
                "Unix timestamps should not be timezone-converted, got: %s" % val
        finally:
            rtsp.stop()

    def test_tz_with_offset_combined(self, shared_r2h):
        """TZ/UTC+8 combined with r2h-seek-offset should apply both."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            # 12:00 CST → 04:00 UTC, then +3600 → 05:00 UTC
            stream_get(
                "127.0.0.1", shared_r2h.port,
                "/rtsp/127.0.0.1:%d/stream?playseek=20240101120000-20240101130000&r2h-seek-offset=3600" % rtsp.port,
                read_bytes=4096, timeout=_STREAM_TIMEOUT,
                headers={"User-Agent": "TestPlayer/1.0 TZ/UTC+8"},
            )

            uri = _get_describe_uri(rtsp)
            val = _extract_seek_value(uri, "playseek")
            assert val == "20240101050000-20240101060000", \
                "TZ+8 then +3600s: expected 05:00-06:00 UTC, got: %s" % val
        finally:
            rtsp.stop()


# ===================================================================
# Time format preservation
# ===================================================================


class TestRTSPTimeFormatPreservation:
    """Verify that output format matches input format."""

    def test_gmt_suffix_preserved(self, shared_r2h):
        """yyyyMMddHHmmssGMT format should preserve the GMT suffix."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            stream_get(
                "127.0.0.1", shared_r2h.port,
                "/rtsp/127.0.0.1:%d/stream?playseek=20240101120000GMT-20240101130000GMT&r2h-seek-offset=3600" % rtsp.port,
                read_bytes=4096, timeout=_STREAM_TIMEOUT,
            )

            uri = _get_describe_uri(rtsp)
            val = _extract_seek_value(uri, "playseek")
            assert val == "20240101130000GMT-20240101140000GMT", \
                "GMT suffix should be preserved, got: %s" % val
        finally:
            rtsp.stop()

    def test_unix_timestamp_format_preserved(self, shared_r2h):
        """Unix timestamp format should stay as Unix timestamp."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            stream_get(
                "127.0.0.1", shared_r2h.port,
                "/rtsp/127.0.0.1:%d/stream?playseek=1704096000-1704099600" % rtsp.port,
                read_bytes=4096, timeout=_STREAM_TIMEOUT,
            )

            uri = _get_describe_uri(rtsp)
            val = _extract_seek_value(uri, "playseek")
            assert val == "1704096000-1704099600", \
                "Unix timestamp format should be preserved, got: %s" % val
        finally:
            rtsp.stop()

    def test_gmt_suffix_with_tz_conversion(self, shared_r2h):
        """yyyyMMddHHmmssGMT with TZ/UTC+8 should convert and keep GMT suffix."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            stream_get(
                "127.0.0.1", shared_r2h.port,
                "/rtsp/127.0.0.1:%d/stream?playseek=20240101120000GMT-20240101130000GMT" % rtsp.port,
                read_bytes=4096, timeout=_STREAM_TIMEOUT,
                headers={"User-Agent": "TestPlayer/1.0 TZ/UTC+8"},
            )

            uri = _get_describe_uri(rtsp)
            val = _extract_seek_value(uri, "playseek")
            assert val == "20240101040000GMT-20240101050000GMT", \
                "GMT format + TZ/UTC+8: expected 04:00-05:00 with GMT, got: %s" % val
        finally:
            rtsp.stop()
