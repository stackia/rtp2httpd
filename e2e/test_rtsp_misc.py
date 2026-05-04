"""
E2E tests for miscellaneous RTSP features.

Covers HEAD requests, unreachable server handling, r2h-duration
(stream duration query), and timeout handling.

Note: r2h-seek-mode opt-in semantics, recent-clock playback, and
configured-service query-merge precedence live in test_rtsp_seek_mode.py.
"""

import json
import socket
import time

import pytest

from helpers import (
    MockRTSPServer,
    MockRTSPServerNoMedia,
    MockRTSPServerNoTeardownResponse,
    MockRTSPServerSilent,
    R2HProcess,
    find_free_port,
    http_get,
    http_request,
    stream_get,
)

pytestmark = pytest.mark.rtsp

_STREAM_TIMEOUT = 20.0

# Timeout constants matching C code (3s each)
_RTSP_HANDSHAKE_TIMEOUT = 3
_RTSP_FIRST_MEDIA_TIMEOUT = 3
_RTSP_TEARDOWN_TIMEOUT = 3

# Tolerance window for timeout assertions
_TIMEOUT_MIN_FACTOR = 0.8
_TIMEOUT_MAX_FACTOR = 3.0


def _get_status_clients(port: int, timeout: float = 3.0) -> list[dict]:
    """Fetch the SSE status endpoint and parse the first data event to
    extract the active clients list."""
    try:
        sock = socket.create_connection(("127.0.0.1", port), timeout=timeout)
    except OSError, socket.timeout:
        return []
    data = b""
    try:
        sock.sendall(b"GET /status/sse HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n")
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            remaining = deadline - time.monotonic()
            sock.settimeout(min(remaining, 1.0))
            try:
                chunk = sock.recv(8192)
            except socket.timeout:
                continue
            if not chunk:
                break
            data += chunk
            if b"\ndata: {" in data and b'"clients"' in data:
                break
    except socket.timeout, OSError:
        pass
    finally:
        sock.close()

    text = data.decode(errors="replace")
    for line in text.split("\n"):
        line = line.strip()
        if line.startswith("data: {"):
            json_str = line[len("data: ") :]
            try:
                obj = json.loads(json_str)
                return obj.get("clients", [])
            except json.JSONDecodeError:
                pass
    return []


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
            "127.0.0.1",
            shared_r2h.port,
            "HEAD",
            "/rtsp/127.0.0.1:554/test",
            timeout=3.0,
        )
        assert status == 200
        assert len(body) == 0


class TestRTSPInvalidServer:
    def test_rtsp_unreachable(self, shared_r2h):
        dead_port = find_free_port()
        status, _, _ = stream_get(
            "127.0.0.1",
            shared_r2h.port,
            "/rtsp/127.0.0.1:%d/test" % dead_port,
            read_bytes=512,
            timeout=8.0,
        )
        assert status in (0, 500, 502, 503)


# ===================================================================
# RTSP timeout handling
# ===================================================================


class TestRTSPHandshakeTimeout:
    """When the RTSP server never responds, the proxy should time out."""

    @pytest.mark.slow
    def test_rtsp_response_timeout(self, r2h_binary):
        """MockRTSPServerSilent doesn't respond — should get 503 within timeout."""
        r2h_port = find_free_port()
        r2h = R2HProcess(r2h_binary, r2h_port, extra_args=["-v", "4", "-m", "100"])
        r2h.start()
        try:
            rtsp = MockRTSPServerSilent()
            rtsp.start()
            try:
                t0 = time.monotonic()
                status, _, _ = stream_get(
                    "127.0.0.1",
                    r2h_port,
                    "/rtsp/127.0.0.1:%d/stream" % rtsp.port,
                    read_bytes=256,
                    timeout=_RTSP_HANDSHAKE_TIMEOUT * _TIMEOUT_MAX_FACTOR + 5,
                )
                elapsed = time.monotonic() - t0

                assert status == 503, f"Expected 503, got {status}"
                assert elapsed >= _RTSP_HANDSHAKE_TIMEOUT * _TIMEOUT_MIN_FACTOR, (
                    f"Timed out too quickly: {elapsed:.1f}s"
                )
                assert elapsed <= _RTSP_HANDSHAKE_TIMEOUT * _TIMEOUT_MAX_FACTOR + 2, (
                    f"Timed out too slowly: {elapsed:.1f}s"
                )
            finally:
                rtsp.stop()
        finally:
            r2h.stop()


class TestRTSPFirstMediaTimeout:
    """When RTSP enters PLAY but no media arrives, should time out."""

    @pytest.mark.slow
    def test_no_media_after_play_timeout(self, r2h_binary):
        """MockRTSPServerNoMedia completes handshake but sends no media —
        should get 503 within the first-media timeout."""
        r2h_port = find_free_port()
        r2h = R2HProcess(r2h_binary, r2h_port, extra_args=["-v", "4", "-m", "100"])
        r2h.start()
        try:
            rtsp = MockRTSPServerNoMedia()
            rtsp.start()
            try:
                t0 = time.monotonic()
                status, _, _ = stream_get(
                    "127.0.0.1",
                    r2h_port,
                    "/rtsp/127.0.0.1:%d/stream" % rtsp.port,
                    read_bytes=256,
                    timeout=_RTSP_FIRST_MEDIA_TIMEOUT * _TIMEOUT_MAX_FACTOR + 5,
                )
                elapsed = time.monotonic() - t0

                assert status == 503, f"Expected 503, got {status}"
                assert elapsed >= _RTSP_FIRST_MEDIA_TIMEOUT * _TIMEOUT_MIN_FACTOR, (
                    f"Timed out too quickly: {elapsed:.1f}s"
                )
                assert elapsed <= _RTSP_FIRST_MEDIA_TIMEOUT * _TIMEOUT_MAX_FACTOR + 5, (
                    f"Timed out too slowly: {elapsed:.1f}s"
                )
            finally:
                rtsp.stop()
        finally:
            r2h.stop()


class TestRTSPTeardownTimeout:
    """When TEARDOWN gets no response, the connection should be cleaned up."""

    @pytest.mark.slow
    def test_teardown_timeout_cleanup(self, r2h_binary):
        """MockRTSPServerNoTeardownResponse — TEARDOWN connections
        should be cleaned up within the teardown timeout."""
        r2h_port = find_free_port()
        r2h = R2HProcess(r2h_binary, r2h_port, extra_args=["-v", "4", "-m", "100"])
        r2h.start()
        try:
            rtsp = MockRTSPServerNoTeardownResponse(num_packets=500)
            rtsp.start()
            try:
                # Start streaming to trigger RTSP handshake + PLAY
                status, _, body = stream_get(
                    "127.0.0.1",
                    r2h_port,
                    "/rtsp/127.0.0.1:%d/stream" % rtsp.port,
                    read_bytes=2048,
                    timeout=15.0,
                )
                assert status == 200, f"Expected 200, got {status}"
                assert len(body) > 0

                # After stream_get returns, client disconnected.
                # rtp2httpd will send TEARDOWN to the mock server.
                # The mock won't respond, so TEARDOWN should timeout.
                # Wait for the teardown timeout plus some slack.
                time.sleep(_RTSP_TEARDOWN_TIMEOUT + 2)

                # Verify via SSE status that no streaming clients remain.
                # The server has a crash-restart mechanism, so just checking
                # /status 200 isn't sufficient — we must verify the client
                # list is empty.
                clients = _get_status_clients(r2h_port)
                assert len(clients) == 0, (
                    f"Expected 0 active clients after teardown timeout, got {len(clients)}: {clients}"
                )
            finally:
                rtsp.stop()
        finally:
            r2h.stop()


# ===================================================================
# r2h-duration (stream duration query)
# ===================================================================


class TestRTSPDurationQuery:
    """r2h-duration=1 queries stream duration via DESCRIBE without playing."""

    def test_duration_returns_json(self, shared_r2h):
        """r2h-duration=1 should return JSON with duration from SDP
        a=range:npt= without sending SETUP or PLAY."""
        sdp_with_range = (
            "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=T\r\n"
            "c=IN IP4 0.0.0.0\r\nt=0 0\r\n"
            "a=range:npt=0.000-3600.500\r\n"
            "m=video 0 RTP/AVP 33\r\na=control:*\r\n"
        )
        rtsp = MockRTSPServer(num_packets=500, custom_sdp=sdp_with_range)
        rtsp.start()
        try:
            status, hdrs, body = http_get(
                "127.0.0.1",
                shared_r2h.port,
                "/rtsp/127.0.0.1:%d/stream?r2h-duration=1" % rtsp.port,
                timeout=_STREAM_TIMEOUT,
            )
            assert status == 200, "Expected 200 for r2h-duration, got %d" % status
            body_str = body.decode(errors="replace")
            assert '"duration"' in body_str, "Response should contain duration JSON, got: %s" % body_str
            assert "3600.500" in body_str, "Duration should be 3600.500, got: %s" % body_str
        finally:
            rtsp.stop()

    def test_duration_no_setup_or_play(self, shared_r2h):
        """r2h-duration should only do OPTIONS + DESCRIBE, no SETUP/PLAY."""
        sdp_with_range = (
            "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=T\r\n"
            "c=IN IP4 0.0.0.0\r\nt=0 0\r\n"
            "a=range:npt=0.000-1800.000\r\n"
            "m=video 0 RTP/AVP 33\r\na=control:*\r\n"
        )
        rtsp = MockRTSPServer(num_packets=500, custom_sdp=sdp_with_range)
        rtsp.start()
        try:
            http_get(
                "127.0.0.1",
                shared_r2h.port,
                "/rtsp/127.0.0.1:%d/stream?r2h-duration=1" % rtsp.port,
                timeout=_STREAM_TIMEOUT,
            )

            methods = rtsp.requests_received
            assert "OPTIONS" in methods, "Expected OPTIONS"
            assert "DESCRIBE" in methods, "Expected DESCRIBE"
            assert "SETUP" not in methods, "r2h-duration should NOT send SETUP, got: %s" % methods
            assert "PLAY" not in methods, "r2h-duration should NOT send PLAY, got: %s" % methods
        finally:
            rtsp.stop()

    def test_duration_stripped_from_rtsp_uri(self, shared_r2h):
        """r2h-duration is an rtp2httpd meta-parameter and should be
        stripped from the RTSP URI sent to the server."""
        sdp_with_range = (
            "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=T\r\n"
            "c=IN IP4 0.0.0.0\r\nt=0 0\r\n"
            "a=range:npt=0.000-7200.000\r\n"
            "m=video 0 RTP/AVP 33\r\na=control:*\r\n"
        )
        rtsp = MockRTSPServer(num_packets=500, custom_sdp=sdp_with_range)
        rtsp.start()
        try:
            http_get(
                "127.0.0.1",
                shared_r2h.port,
                "/rtsp/127.0.0.1:%d/stream?r2h-duration=1" % rtsp.port,
                timeout=_STREAM_TIMEOUT,
            )

            describe_reqs = [r for r in rtsp.requests_detailed if r["method"] == "DESCRIBE"]
            assert len(describe_reqs) > 0, "Expected DESCRIBE"
            uri = describe_reqs[0]["uri"]
            assert "r2h-duration" not in uri, "r2h-duration should be stripped from RTSP URI, got: %s" % uri
        finally:
            rtsp.stop()


class TestRTSPStartSeek:
    """r2h-start handling for RTSP time-based seeking."""

    def test_start_adds_range_header(self, shared_r2h):
        """r2h-start should be forwarded as Range: npt=<value>- in PLAY."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            url = "/rtsp/127.0.0.1:%d/stream?r2h-start=120.5" % rtsp.port
            stream_get(
                "127.0.0.1",
                shared_r2h.port,
                url,
                read_bytes=4096,
                timeout=_STREAM_TIMEOUT,
            )

            play_reqs = [r for r in rtsp.requests_detailed if r["method"] == "PLAY"]
            assert len(play_reqs) > 0, "Expected PLAY request"
            play_headers = play_reqs[0]["headers"]
            assert "Range" in play_headers, "PLAY should have Range header"
            assert "120.5" in play_headers["Range"]
        finally:
            rtsp.stop()

    def test_start_stripped_from_rtsp_uri(self, shared_r2h):
        """r2h-start should be stripped from the RTSP URI sent upstream."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            url = "/rtsp/127.0.0.1:%d/stream?r2h-start=60" % rtsp.port
            stream_get(
                "127.0.0.1",
                shared_r2h.port,
                url,
                read_bytes=4096,
                timeout=_STREAM_TIMEOUT,
            )

            describe_reqs = [r for r in rtsp.requests_detailed if r["method"] == "DESCRIBE"]
            assert len(describe_reqs) > 0, "Expected DESCRIBE"
            assert "r2h-start" not in describe_reqs[0]["uri"]
        finally:
            rtsp.stop()

    def test_start_with_other_params(self, shared_r2h):
        """r2h-start should be stripped while other query params are preserved."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            url = "/rtsp/127.0.0.1:%d/stream?token=abc&r2h-start=30&sid=123" % rtsp.port
            stream_get(
                "127.0.0.1",
                shared_r2h.port,
                url,
                read_bytes=4096,
                timeout=_STREAM_TIMEOUT,
            )

            describe_reqs = [r for r in rtsp.requests_detailed if r["method"] == "DESCRIBE"]
            assert len(describe_reqs) > 0, "Expected DESCRIBE"
            uri = describe_reqs[0]["uri"]
            assert "r2h-start" not in uri
            assert "token=abc" in uri
            assert "sid=123" in uri
        finally:
            rtsp.stop()

    def test_no_range_header_without_start(self, shared_r2h):
        """Without r2h-start, PLAY should not have a Range header."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            url = "/rtsp/127.0.0.1:%d/stream" % rtsp.port
            stream_get(
                "127.0.0.1",
                shared_r2h.port,
                url,
                read_bytes=4096,
                timeout=_STREAM_TIMEOUT,
            )

            play_reqs = [r for r in rtsp.requests_detailed if r["method"] == "PLAY"]
            assert len(play_reqs) > 0, "Expected PLAY request"
            assert "Range" not in play_reqs[0]["headers"]
        finally:
            rtsp.stop()
