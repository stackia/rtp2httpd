"""
E2E tests for miscellaneous RTSP features.

Covers HEAD requests, unreachable server handling, and r2h-duration
(stream duration query).
"""

import pytest

from helpers import (
    MockRTSPServer,
    R2HProcess,
    find_free_port,
    http_get,
    http_request,
    stream_get,
)

pytestmark = pytest.mark.rtsp

_STREAM_TIMEOUT = 20.0


@pytest.fixture(scope="module")
def shared_r2h(r2h_binary):
    """A single rtp2httpd instance shared by all misc RTSP tests."""
    port = find_free_port()
    r2h = R2HProcess(r2h_binary, port, extra_args=["-v", "4", "-m", "100"])
    r2h.start()
    yield r2h
    r2h.stop()


# ===================================================================
# HEAD request and error handling
# ===================================================================


class TestRTSPHeadRequest:
    def test_head_rtsp(self, shared_r2h):
        status, _, body = http_request(
            "127.0.0.1", shared_r2h.port, "HEAD",
            "/rtsp/127.0.0.1:554/test", timeout=3.0,
        )
        assert status == 200
        assert len(body) == 0


class TestRTSPInvalidServer:
    def test_rtsp_unreachable(self, shared_r2h):
        dead_port = find_free_port()
        status, _, _ = stream_get(
            "127.0.0.1", shared_r2h.port,
            "/rtsp/127.0.0.1:%d/test" % dead_port,
            read_bytes=512, timeout=8.0,
        )
        assert status in (0, 500, 502, 503)


# ===================================================================
# r2h-duration (stream duration query)
# ===================================================================


class TestRTSPDurationQuery:
    """r2h-duration=1 queries stream duration via DESCRIBE without playing."""

    def test_duration_returns_json(self, shared_r2h):
        """r2h-duration=1 should return JSON with duration from SDP
        a=range:npt= without sending SETUP or PLAY."""
        sdp_with_range = ("v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=T\r\n"
                          "c=IN IP4 0.0.0.0\r\nt=0 0\r\n"
                          "a=range:npt=0.000-3600.500\r\n"
                          "m=video 0 RTP/AVP 33\r\na=control:*\r\n")
        rtsp = MockRTSPServer(num_packets=500, custom_sdp=sdp_with_range)
        rtsp.start()
        try:
            status, hdrs, body = http_get(
                "127.0.0.1", shared_r2h.port,
                "/rtsp/127.0.0.1:%d/stream?r2h-duration=1" % rtsp.port,
                timeout=_STREAM_TIMEOUT,
            )
            assert status == 200, "Expected 200 for r2h-duration, got %d" % status
            body_str = body.decode(errors="replace")
            assert '"duration"' in body_str, \
                "Response should contain duration JSON, got: %s" % body_str
            assert "3600.500" in body_str, \
                "Duration should be 3600.500, got: %s" % body_str
        finally:
            rtsp.stop()

    def test_duration_no_setup_or_play(self, shared_r2h):
        """r2h-duration should only do OPTIONS + DESCRIBE, no SETUP/PLAY."""
        sdp_with_range = ("v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=T\r\n"
                          "c=IN IP4 0.0.0.0\r\nt=0 0\r\n"
                          "a=range:npt=0.000-1800.000\r\n"
                          "m=video 0 RTP/AVP 33\r\na=control:*\r\n")
        rtsp = MockRTSPServer(num_packets=500, custom_sdp=sdp_with_range)
        rtsp.start()
        try:
            http_get(
                "127.0.0.1", shared_r2h.port,
                "/rtsp/127.0.0.1:%d/stream?r2h-duration=1" % rtsp.port,
                timeout=_STREAM_TIMEOUT,
            )

            methods = rtsp.requests_received
            assert "OPTIONS" in methods, "Expected OPTIONS"
            assert "DESCRIBE" in methods, "Expected DESCRIBE"
            assert "SETUP" not in methods, \
                "r2h-duration should NOT send SETUP, got: %s" % methods
            assert "PLAY" not in methods, \
                "r2h-duration should NOT send PLAY, got: %s" % methods
        finally:
            rtsp.stop()

    def test_duration_stripped_from_rtsp_uri(self, shared_r2h):
        """r2h-duration is an rtp2httpd meta-parameter and should be
        stripped from the RTSP URI sent to the server."""
        sdp_with_range = ("v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=T\r\n"
                          "c=IN IP4 0.0.0.0\r\nt=0 0\r\n"
                          "a=range:npt=0.000-7200.000\r\n"
                          "m=video 0 RTP/AVP 33\r\na=control:*\r\n")
        rtsp = MockRTSPServer(num_packets=500, custom_sdp=sdp_with_range)
        rtsp.start()
        try:
            http_get(
                "127.0.0.1", shared_r2h.port,
                "/rtsp/127.0.0.1:%d/stream?r2h-duration=1" % rtsp.port,
                timeout=_STREAM_TIMEOUT,
            )

            describe_reqs = [r for r in rtsp.requests_detailed
                             if r["method"] == "DESCRIBE"]
            assert len(describe_reqs) > 0, "Expected DESCRIBE"
            uri = describe_reqs[0]["uri"]
            assert "r2h-duration" not in uri, \
                "r2h-duration should be stripped from RTSP URI, got: %s" % uri
        finally:
            rtsp.stop()
