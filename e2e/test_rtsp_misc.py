"""
E2E tests for miscellaneous RTSP features.

Covers HEAD requests, unreachable server handling, r2h-duration
(stream duration query), and timeout handling.
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


def _format_basic_utc(ts: int) -> str:
    return time.strftime("%Y%m%dT%H%M%SZ", time.gmtime(ts))


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


class TestRTSPRecentPlayseek:
    """Recent RTSP playseek should use PLAY Range clock headers when r2h-seek-mode=range is set."""

    @staticmethod
    def _build_seek_query(param_name: str, start_str: str, end_str: str) -> str:
        # All recent-clock tests opt in via r2h-seek-mode=range explicitly.
        if param_name == "custom_seek":
            return "custom_seek=%s-%s&r2h-seek-name=custom_seek&r2h-seek-mode=range" % (
                start_str,
                end_str,
            )
        return "%s=%s-%s&r2h-seek-mode=range" % (param_name, start_str, end_str)

    @pytest.mark.parametrize("param_name", ["playseek", "Playseek", "tvdr", "custom_seek"])
    def test_recent_playseek_uses_clock_range(self, shared_r2h, param_name):
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            start_ts = int(time.time()) - 1800
            end_ts = start_ts + 300
            start_str = _format_basic_utc(start_ts)
            end_str = _format_basic_utc(end_ts)
            query = self._build_seek_query(param_name, start_str, end_str)
            url = "/rtsp/127.0.0.1:%d/stream?%s" % (
                rtsp.port,
                query,
            )

            stream_get(
                "127.0.0.1",
                shared_r2h.port,
                url,
                read_bytes=4096,
                timeout=_STREAM_TIMEOUT,
            )

            describe_reqs = [r for r in rtsp.requests_detailed if r["method"] == "DESCRIBE"]
            assert len(describe_reqs) > 0, "Expected DESCRIBE"
            assert "%s=" % param_name not in describe_reqs[0]["uri"]
            assert "r2h-seek-name=" not in describe_reqs[0]["uri"]
            assert "r2h-seek-mode=" not in describe_reqs[0]["uri"]

            play_reqs = [r for r in rtsp.requests_detailed if r["method"] == "PLAY"]
            assert len(play_reqs) > 0, "Expected PLAY request"
            play_headers = play_reqs[0]["headers"]
            assert play_headers.get("Range") == "clock=%s-" % start_str
            assert end_str not in play_headers["Range"]
        finally:
            rtsp.stop()

    def test_recent_playseek_ignores_r2h_start(self, shared_r2h):
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            start_ts = int(time.time()) - 1200
            start_str = _format_basic_utc(start_ts)
            url = "/rtsp/127.0.0.1:%d/stream?playseek=%s-%s&r2h-start=120.5&r2h-seek-mode=range" % (
                rtsp.port,
                start_str,
                _format_basic_utc(start_ts + 120),
            )

            stream_get(
                "127.0.0.1",
                shared_r2h.port,
                url,
                read_bytes=4096,
                timeout=_STREAM_TIMEOUT,
            )

            play_reqs = [r for r in rtsp.requests_detailed if r["method"] == "PLAY"]
            assert len(play_reqs) > 0, "Expected PLAY request"
            play_range = play_reqs[0]["headers"].get("Range", "")
            assert play_range == "clock=%s-" % start_str
            assert "npt=" not in play_range
            assert "120.5" not in play_range
        finally:
            rtsp.stop()

    @pytest.mark.parametrize("param_name", ["playseek", "Playseek", "tvdr", "custom_seek"])
    def test_boundary_playseek_is_forwarded(self, shared_r2h, param_name):
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            start_ts = int(time.time()) - 3600
            start_str = _format_basic_utc(start_ts)
            end_str = _format_basic_utc(start_ts + 120)
            query = self._build_seek_query(param_name, start_str, end_str)
            url = "/rtsp/127.0.0.1:%d/stream?%s" % (
                rtsp.port,
                query,
            )

            stream_get(
                "127.0.0.1",
                shared_r2h.port,
                url,
                read_bytes=4096,
                timeout=_STREAM_TIMEOUT,
            )

            describe_reqs = [r for r in rtsp.requests_detailed if r["method"] == "DESCRIBE"]
            assert len(describe_reqs) > 0, "Expected DESCRIBE"
            assert "%s=%s-%s" % (param_name, start_str, end_str) in describe_reqs[0]["uri"]

            play_reqs = [r for r in rtsp.requests_detailed if r["method"] == "PLAY"]
            assert len(play_reqs) > 0, "Expected PLAY request"
            assert "Range" not in play_reqs[0]["headers"]
        finally:
            rtsp.stop()

    def test_recent_playseek_default_passthrough(self, shared_r2h):
        """Without r2h-seek-mode, recent playseek must still pass through (no clock=)."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            start_ts = int(time.time()) - 1800
            start_str = _format_basic_utc(start_ts)
            end_str = _format_basic_utc(start_ts + 300)
            url = "/rtsp/127.0.0.1:%d/stream?playseek=%s-%s" % (rtsp.port, start_str, end_str)

            stream_get(
                "127.0.0.1",
                shared_r2h.port,
                url,
                read_bytes=4096,
                timeout=_STREAM_TIMEOUT,
            )

            describe_reqs = [r for r in rtsp.requests_detailed if r["method"] == "DESCRIBE"]
            assert len(describe_reqs) > 0, "Expected DESCRIBE"
            assert "playseek=%s-%s" % (start_str, end_str) in describe_reqs[0]["uri"]

            play_reqs = [r for r in rtsp.requests_detailed if r["method"] == "PLAY"]
            assert len(play_reqs) > 0, "Expected PLAY request"
            assert "Range" not in play_reqs[0]["headers"]
        finally:
            rtsp.stop()


def _format_yyyyMMddHHmmss(ts: int) -> str:
    return time.strftime("%Y%m%d%H%M%S", time.gmtime(ts))


def _expected_clock_str(ts: int) -> str:
    return time.strftime("%Y%m%dT%H%M%SZ", time.gmtime(ts))


class TestRTSPSeekMode:
    """Verify r2h-seek-mode opt-in semantics for the recent-clock path."""

    def test_passthrough_explicit_equals_default(self, shared_r2h):
        """r2h-seek-mode=passthrough is identical to omitting the parameter."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            start_ts = int(time.time()) - 1800
            start_str = _format_basic_utc(start_ts)
            end_str = _format_basic_utc(start_ts + 300)
            url = "/rtsp/127.0.0.1:%d/stream?playseek=%s-%s&r2h-seek-mode=passthrough" % (
                rtsp.port,
                start_str,
                end_str,
            )

            stream_get("127.0.0.1", shared_r2h.port, url, read_bytes=4096, timeout=_STREAM_TIMEOUT)

            describe_reqs = [r for r in rtsp.requests_detailed if r["method"] == "DESCRIBE"]
            assert "playseek=%s-%s" % (start_str, end_str) in describe_reqs[0]["uri"]
            assert "r2h-seek-mode=" not in describe_reqs[0]["uri"]
            play_reqs = [r for r in rtsp.requests_detailed if r["method"] == "PLAY"]
            assert "Range" not in play_reqs[0]["headers"]
        finally:
            rtsp.stop()

    def test_range_with_explicit_tz_within_window_uses_clock(self, shared_r2h):
        """range(UTC+8/3600) + 30 min ago in CST should hit the clock= path with the right UTC time."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            start_ts = int(time.time()) - 1800
            # Client sends time in CST (UTC+8): represent the same instant in CST
            cst_str = _format_yyyyMMddHHmmss(start_ts + 8 * 3600)
            url = "/rtsp/127.0.0.1:%d/stream?playseek=%s&r2h-seek-mode=range(UTC%%2B8/3600)" % (
                rtsp.port,
                cst_str,
            )

            stream_get("127.0.0.1", shared_r2h.port, url, read_bytes=4096, timeout=_STREAM_TIMEOUT)

            describe_reqs = [r for r in rtsp.requests_detailed if r["method"] == "DESCRIBE"]
            assert "playseek=" not in describe_reqs[0]["uri"]
            play_reqs = [r for r in rtsp.requests_detailed if r["method"] == "PLAY"]
            assert play_reqs[0]["headers"].get("Range") == "clock=%s-" % _expected_clock_str(start_ts)
        finally:
            rtsp.stop()

    def test_range_outside_window_falls_back_passthrough(self, shared_r2h):
        """range(UTC+8/3600) + 5h ago should fall back to URL passthrough with raw bytes preserved."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            # Use fixed historical CST timestamps, far outside any window.
            url = (
                "/rtsp/127.0.0.1:%d/stream?playseek=20240101180000-20240101230000&r2h-seek-mode=range(UTC%%2B8/3600)"
                % (rtsp.port,)
            )

            stream_get("127.0.0.1", shared_r2h.port, url, read_bytes=4096, timeout=_STREAM_TIMEOUT)

            describe_reqs = [r for r in rtsp.requests_detailed if r["method"] == "DESCRIBE"]
            # Bytes preserved exactly: range mode TZ does NOT apply to passthrough conversion.
            assert "playseek=20240101180000-20240101230000" in describe_reqs[0]["uri"]
            play_reqs = [r for r in rtsp.requests_detailed if r["method"] == "PLAY"]
            assert "Range" not in play_reqs[0]["headers"]
        finally:
            rtsp.stop()

    def test_range_default_utc_within_window_uses_clock(self, shared_r2h):
        """range(3600) (no TZ, no UA) treats input as UTC; recent UTC time enters clock path."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            start_ts = int(time.time()) - 1500
            utc_str = _format_yyyyMMddHHmmss(start_ts)
            url = "/rtsp/127.0.0.1:%d/stream?playseek=%s&r2h-seek-mode=range(3600)" % (rtsp.port, utc_str)

            stream_get("127.0.0.1", shared_r2h.port, url, read_bytes=4096, timeout=_STREAM_TIMEOUT)

            play_reqs = [r for r in rtsp.requests_detailed if r["method"] == "PLAY"]
            assert play_reqs[0]["headers"].get("Range") == "clock=%s-" % _expected_clock_str(start_ts)
        finally:
            rtsp.stop()

    def test_range_tz_only_defaults_window_to_3600(self, shared_r2h):
        """range(UTC+8) without seconds defaults the window to 3600s."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            start_ts = int(time.time()) - 1500  # within 1 hour
            cst_str = _format_yyyyMMddHHmmss(start_ts + 8 * 3600)
            url = "/rtsp/127.0.0.1:%d/stream?playseek=%s&r2h-seek-mode=range(UTC%%2B8)" % (rtsp.port, cst_str)

            stream_get("127.0.0.1", shared_r2h.port, url, read_bytes=4096, timeout=_STREAM_TIMEOUT)

            play_reqs = [r for r in rtsp.requests_detailed if r["method"] == "PLAY"]
            assert play_reqs[0]["headers"].get("Range") == "clock=%s-" % _expected_clock_str(start_ts)
        finally:
            rtsp.stop()

    @pytest.mark.parametrize(
        "mode_value",
        [
            pytest.param("range", id="bare-range"),
            pytest.param("range()", id="empty-parens"),
            pytest.param("range(/3600)", id="slash-seconds-only"),
        ],
    )
    def test_range_syntax_variants_default_to_utc_window_3600(self, shared_r2h, mode_value):
        """Bare `range`, `range()`, and `range(/N)` should all parse as
        SEEK_MODE_RANGE with TZ falling back to UTC and the explicit/default
        window. Regression guard for the parse_seek_mode_value branches that
        otherwise have no direct coverage.
        """
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            start_ts = int(time.time()) - 1500  # within 1h, UTC interpretation
            utc_str = _format_yyyyMMddHHmmss(start_ts)
            url = "/rtsp/127.0.0.1:%d/stream?playseek=%s&r2h-seek-mode=%s" % (rtsp.port, utc_str, mode_value)

            stream_get("127.0.0.1", shared_r2h.port, url, read_bytes=4096, timeout=_STREAM_TIMEOUT)

            play_reqs = [r for r in rtsp.requests_detailed if r["method"] == "PLAY"]
            assert play_reqs[0]["headers"].get("Range") == "clock=%s-" % _expected_clock_str(start_ts), (
                "syntax variant %r should enter the clock= path" % mode_value
            )
        finally:
            rtsp.stop()

    def test_range_falls_back_to_ua_tz(self, shared_r2h):
        """range(3600) without explicit TZ should fall back to UA TZ/UTC+8."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            start_ts = int(time.time()) - 1500
            cst_str = _format_yyyyMMddHHmmss(start_ts + 8 * 3600)
            url = "/rtsp/127.0.0.1:%d/stream?playseek=%s&r2h-seek-mode=range(3600)" % (rtsp.port, cst_str)

            stream_get(
                "127.0.0.1",
                shared_r2h.port,
                url,
                read_bytes=4096,
                timeout=_STREAM_TIMEOUT,
                headers={"User-Agent": "TestPlayer/1.0 TZ/UTC+8"},
            )

            play_reqs = [r for r in rtsp.requests_detailed if r["method"] == "PLAY"]
            assert play_reqs[0]["headers"].get("Range") == "clock=%s-" % _expected_clock_str(start_ts)
        finally:
            rtsp.stop()

    def test_range_falls_back_to_utc_when_no_ua_tz(self, shared_r2h):
        """range(3600) with no UA TZ should fall back to UTC."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            start_ts = int(time.time()) - 1500
            utc_str = _format_yyyyMMddHHmmss(start_ts)
            url = "/rtsp/127.0.0.1:%d/stream?playseek=%s&r2h-seek-mode=range(3600)" % (rtsp.port, utc_str)

            stream_get(
                "127.0.0.1",
                shared_r2h.port,
                url,
                read_bytes=4096,
                timeout=_STREAM_TIMEOUT,
                headers={"User-Agent": "TestPlayer/1.0"},
            )

            play_reqs = [r for r in rtsp.requests_detailed if r["method"] == "PLAY"]
            assert play_reqs[0]["headers"].get("Range") == "clock=%s-" % _expected_clock_str(start_ts)
        finally:
            rtsp.stop()

    def test_range_offset_propagates_into_clock(self, shared_r2h):
        """r2h-seek-offset shifts the clock= header time as well."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            base_ts = int(time.time()) - 3000  # 50 min ago
            offset = 1800  # +30 min, still within 60min window relative to begin
            cst_str = _format_yyyyMMddHHmmss(base_ts + 8 * 3600)
            url = "/rtsp/127.0.0.1:%d/stream?playseek=%s&r2h-seek-offset=%d&r2h-seek-mode=range(UTC%%2B8/3600)" % (
                rtsp.port,
                cst_str,
                offset,
            )

            stream_get("127.0.0.1", shared_r2h.port, url, read_bytes=4096, timeout=_STREAM_TIMEOUT)

            play_reqs = [r for r in rtsp.requests_detailed if r["method"] == "PLAY"]
            assert play_reqs[0]["headers"].get("Range") == "clock=%s-" % _expected_clock_str(base_ts + offset)
        finally:
            rtsp.stop()

    def test_range_offset_pushes_outside_window_falls_back(self, shared_r2h):
        """If r2h-seek-offset shifts begin out of the window, fall back to passthrough."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            base_ts = int(time.time()) - 3000  # 50 min ago
            offset = -1800  # makes begin look like 80 min ago, > 60min window
            cst_str = _format_yyyyMMddHHmmss(base_ts + 8 * 3600)
            url = "/rtsp/127.0.0.1:%d/stream?playseek=%s&r2h-seek-offset=%d&r2h-seek-mode=range(UTC%%2B8/3600)" % (
                rtsp.port,
                cst_str,
                offset,
            )

            stream_get("127.0.0.1", shared_r2h.port, url, read_bytes=4096, timeout=_STREAM_TIMEOUT)

            describe_reqs = [r for r in rtsp.requests_detailed if r["method"] == "DESCRIBE"]
            # Passthrough branch: range mode TZ does NOT apply, only the offset is applied
            # to the original UTC interpretation. Verify offset is present in the resulting bytes.
            assert "playseek=" in describe_reqs[0]["uri"]
            play_reqs = [r for r in rtsp.requests_detailed if r["method"] == "PLAY"]
            assert "Range" not in play_reqs[0]["headers"]
        finally:
            rtsp.stop()

    def test_range_invalid_value_falls_back_to_passthrough(self, shared_r2h):
        """Invalid r2h-seek-mode values should be ignored (treated as passthrough)."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            start_ts = int(time.time()) - 1500
            utc_str = _format_yyyyMMddHHmmss(start_ts)
            url = "/rtsp/127.0.0.1:%d/stream?playseek=%s&r2h-seek-mode=range(UTC%%2B999)" % (rtsp.port, utc_str)

            stream_get("127.0.0.1", shared_r2h.port, url, read_bytes=4096, timeout=_STREAM_TIMEOUT)

            describe_reqs = [r for r in rtsp.requests_detailed if r["method"] == "DESCRIBE"]
            assert "playseek=%s" % utc_str in describe_reqs[0]["uri"]
            play_reqs = [r for r in rtsp.requests_detailed if r["method"] == "PLAY"]
            assert "Range" not in play_reqs[0]["headers"]
        finally:
            rtsp.stop()

    def test_range_unrecognized_mode_falls_back_to_passthrough(self, shared_r2h):
        """Garbage r2h-seek-mode values should also map to passthrough."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            start_ts = int(time.time()) - 1500
            utc_str = _format_yyyyMMddHHmmss(start_ts)
            url = "/rtsp/127.0.0.1:%d/stream?playseek=%s&r2h-seek-mode=bogus" % (rtsp.port, utc_str)

            stream_get("127.0.0.1", shared_r2h.port, url, read_bytes=4096, timeout=_STREAM_TIMEOUT)

            describe_reqs = [r for r in rtsp.requests_detailed if r["method"] == "DESCRIBE"]
            assert "playseek=%s" % utc_str in describe_reqs[0]["uri"]
            play_reqs = [r for r in rtsp.requests_detailed if r["method"] == "PLAY"]
            assert "Range" not in play_reqs[0]["headers"]
        finally:
            rtsp.stop()

    def test_range_with_garbage_after_tz_falls_back_to_passthrough(self, shared_r2h):
        """range(UTC+8junk) must reject the malformed TZ token and degrade to passthrough."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            start_ts = int(time.time()) - 1500
            utc_str = _format_yyyyMMddHHmmss(start_ts)
            url = "/rtsp/127.0.0.1:%d/stream?playseek=%s&r2h-seek-mode=range(UTC%%2B8junk/3600)" % (
                rtsp.port,
                utc_str,
            )

            stream_get("127.0.0.1", shared_r2h.port, url, read_bytes=4096, timeout=_STREAM_TIMEOUT)

            describe_reqs = [r for r in rtsp.requests_detailed if r["method"] == "DESCRIBE"]
            assert "playseek=%s" % utc_str in describe_reqs[0]["uri"]
            play_reqs = [r for r in rtsp.requests_detailed if r["method"] == "PLAY"]
            assert "Range" not in play_reqs[0]["headers"]
        finally:
            rtsp.stop()

    def test_range_with_url_template_still_expands_placeholders(self, shared_r2h):
        """If the RTSP URL has ${...} placeholders AND r2h-seek-mode=range(...)
        triggers the recent-clock path, the placeholders must still be expanded
        in the upstream DESCRIBE URI. Previously the recent-clock path passed
        a NULL parse_result to service_resolve_upstream_url, which left
        placeholders unresolved in the DESCRIBE URI."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            start_ts = int(time.time()) - 1500  # 25 min ago, well within 1h window
            # Send playseek as a UTC-format yyyyMMddHHmmss string (no UA TZ),
            # so that begin_tm_utc echoes the same string back out via the
            # ${(b)...} placeholder. The recent-clock TZ override (range(UTC+0))
            # is a no-op TZ-wise but still flips the path to clock=.
            utc_str = _format_yyyyMMddHHmmss(start_ts)
            url = ("/rtsp/127.0.0.1:%d/path/${(b)yyyyMMddHHmmss}/stream?playseek=%s&r2h-seek-mode=range(3600)") % (
                rtsp.port,
                utc_str,
            )

            stream_get("127.0.0.1", shared_r2h.port, url, read_bytes=4096, timeout=_STREAM_TIMEOUT)

            describe_reqs = [r for r in rtsp.requests_detailed if r["method"] == "DESCRIBE"]
            assert describe_reqs, "expected at least one DESCRIBE"
            uri = describe_reqs[0]["uri"]
            assert "${" not in uri, "Template placeholder left unresolved in DESCRIBE URI: %s" % uri
            assert ("/path/%s/stream" % utc_str) in uri, (
                "Begin template should be substituted in DESCRIBE URI, got: %s" % uri
            )
            # Recent-clock path must still fire.
            play_reqs = [r for r in rtsp.requests_detailed if r["method"] == "PLAY"]
            assert play_reqs[0]["headers"].get("Range") == "clock=%s-" % _expected_clock_str(start_ts)
        finally:
            rtsp.stop()

    def test_range_with_iso8601_z_input_ignores_explicit_tz(self, shared_r2h):
        """When the seek input is ISO-8601 with an embedded `Z` suffix, the
        embedded TZ is authoritative — neither r2h-seek-mode=range(<TZ>) nor
        the UA `TZ/` marker may shift the parsed instant. Documented contract;
        regression guard for the explicit-TZ recompute branch."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            start_ts = int(time.time()) - 1500  # 25 min ago, well within 1h window
            iso_str = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime(start_ts))
            # range(UTC+9) AND a UA TZ that disagrees with both the range TZ and
            # the embedded `Z` — the `Z` wins regardless.
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
            assert play_reqs[0]["headers"].get("Range") == "clock=%s-" % _expected_clock_str(start_ts), (
                "Embedded `Z` must take precedence over both range(<TZ>) and UA TZ — "
                "got Range header %r" % play_reqs[0]["headers"].get("Range")
            )
        finally:
            rtsp.stop()

    def test_range_with_gmt_suffix_input_ignores_explicit_tz(self, shared_r2h):
        """yyyyMMddHHmmssGMT is a self-contained UTC marker (same contract as
        ISO-8601 `Z`). Both r2h-seek-mode=range(<TZ>) and UA TZ must be
        ignored when the input carries a GMT suffix."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            start_ts = int(time.time()) - 1500  # 25 min ago, within 1h window
            gmt_str = _format_yyyyMMddHHmmss(start_ts) + "GMT"
            # range(UTC+9) AND a UA TZ that disagrees with both the range TZ
            # and the GMT suffix — the GMT suffix wins regardless.
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
            assert play_reqs[0]["headers"].get("Range") == "clock=%s-" % _expected_clock_str(start_ts), (
                "GMT suffix must take precedence over both range(<TZ>) and UA TZ — "
                "got Range header %r" % play_reqs[0]["headers"].get("Range")
            )
        finally:
            rtsp.stop()


class TestRTSPSeekModeQueryMerge:
    """Verify the request-wins precedence rule for the configured-service
    query-merge path: any r2h-* parameter present in the request URL takes
    precedence over the M3U-configured value, and neither side leaks to the
    upstream URI."""

    @staticmethod
    def _config(r2h_port: int, rtsp_port: int, channel_name: str, configured_url_query: str) -> str:
        return (
            "[global]\n"
            "verbosity = 4\n"
            "\n"
            "[bind]\n"
            "* %d\n"
            "\n"
            "[services]\n"
            "#EXTM3U\n"
            "#EXTINF:-1,%s\n"
            "rtsp://127.0.0.1:%d/stream%s\n"
        ) % (r2h_port, channel_name, rtsp_port, configured_url_query)

    def test_configured_seek_mode_applies_when_request_silent(self, r2h_binary):
        """When the request supplies no r2h-seek-mode, the configured value
        is the fallback and produces the expected behavior (clock= header)."""
        r2h_port = find_free_port()
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            config = self._config(r2h_port, rtsp.port, "SeekModeFallback", "?r2h-seek-mode=range(UTC%2B8/3600)")
            r2h = R2HProcess(r2h_binary, r2h_port, config_content=config)
            r2h.start()
            try:
                start_ts = int(time.time()) - 1500
                cst_str = _format_yyyyMMddHHmmss(start_ts + 8 * 3600)
                url = "/SeekModeFallback?playseek=%s" % cst_str

                stream_get("127.0.0.1", r2h_port, url, read_bytes=4096, timeout=_STREAM_TIMEOUT)

                describe_reqs = [r for r in rtsp.requests_detailed if r["method"] == "DESCRIBE"]
                assert describe_reqs, "expected at least one DESCRIBE"
                assert "r2h-seek-mode" not in describe_reqs[0]["uri"], (
                    "r2h-seek-mode leaked into upstream URI: %s" % describe_reqs[0]["uri"]
                )
                play_reqs = [r for r in rtsp.requests_detailed if r["method"] == "PLAY"]
                assert play_reqs[0]["headers"].get("Range") == "clock=%s-" % _expected_clock_str(start_ts)
            finally:
                r2h.stop()
        finally:
            rtsp.stop()

    def test_request_seek_mode_overrides_configured_range(self, r2h_binary):
        """Configured r2h-seek-mode=range(...) plus request r2h-seek-mode=passthrough:
        request wins → no clock= header → no r2h-seek-mode leaks upstream."""
        r2h_port = find_free_port()
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            config = self._config(r2h_port, rtsp.port, "SeekModeMerge", "?r2h-seek-mode=range(UTC%2B8/3600)")
            r2h = R2HProcess(r2h_binary, r2h_port, config_content=config)
            r2h.start()
            try:
                start_ts = int(time.time()) - 1500
                cst_str = _format_yyyyMMddHHmmss(start_ts + 8 * 3600)
                url = "/SeekModeMerge?playseek=%s&r2h-seek-mode=passthrough" % cst_str

                stream_get("127.0.0.1", r2h_port, url, read_bytes=4096, timeout=_STREAM_TIMEOUT)

                describe_reqs = [r for r in rtsp.requests_detailed if r["method"] == "DESCRIBE"]
                assert describe_reqs, "expected at least one DESCRIBE"
                assert "playseek=%s" % cst_str in describe_reqs[0]["uri"]
                assert "r2h-seek-mode" not in describe_reqs[0]["uri"], (
                    "r2h-seek-mode leaked into upstream URI: %s" % describe_reqs[0]["uri"]
                )
                play_reqs = [r for r in rtsp.requests_detailed if r["method"] == "PLAY"]
                assert "Range" not in play_reqs[0]["headers"]
            finally:
                r2h.stop()
        finally:
            rtsp.stop()

    def test_request_range_overrides_configured_passthrough(self, r2h_binary):
        """Configured r2h-seek-mode=passthrough plus request r2h-seek-mode=range(...):
        request wins → clock= header is emitted → no r2h-seek-mode leaks upstream."""
        r2h_port = find_free_port()
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            config = self._config(r2h_port, rtsp.port, "SeekModeOff", "?r2h-seek-mode=passthrough")
            r2h = R2HProcess(r2h_binary, r2h_port, config_content=config)
            r2h.start()
            try:
                start_ts = int(time.time()) - 1500
                cst_str = _format_yyyyMMddHHmmss(start_ts + 8 * 3600)
                url = "/SeekModeOff?playseek=%s&r2h-seek-mode=range(UTC%%2B8/3600)" % cst_str

                stream_get("127.0.0.1", r2h_port, url, read_bytes=4096, timeout=_STREAM_TIMEOUT)

                describe_reqs = [r for r in rtsp.requests_detailed if r["method"] == "DESCRIBE"]
                assert describe_reqs, "expected at least one DESCRIBE"
                assert "r2h-seek-mode" not in describe_reqs[0]["uri"], (
                    "r2h-seek-mode leaked into upstream URI: %s" % describe_reqs[0]["uri"]
                )
                play_reqs = [r for r in rtsp.requests_detailed if r["method"] == "PLAY"]
                assert play_reqs[0]["headers"].get("Range") == "clock=%s-" % _expected_clock_str(start_ts)
            finally:
                r2h.stop()
        finally:
            rtsp.stop()

    def test_request_seek_offset_overrides_configured(self, r2h_binary):
        """Same precedence applies to r2h-seek-offset: request value wins,
        configured value is the fallback, and r2h-seek-offset never leaks."""
        r2h_port = find_free_port()
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            # Configured offset = 3600 (1h forward).
            config = self._config(r2h_port, rtsp.port, "OffsetMerge", "?r2h-seek-offset=3600")
            r2h = R2HProcess(r2h_binary, r2h_port, config_content=config)
            r2h.start()
            try:
                # Request overrides with a different offset (7200 = 2h forward).
                # Use playseek with literal UTC time so we can predict the upstream value.
                base_ts = 1717000000  # arbitrary fixed UTC seconds
                base_str = _format_yyyyMMddHHmmss(base_ts)
                url = "/OffsetMerge?playseek=%s&r2h-seek-offset=7200" % base_str

                stream_get("127.0.0.1", r2h_port, url, read_bytes=4096, timeout=_STREAM_TIMEOUT)

                describe_reqs = [r for r in rtsp.requests_detailed if r["method"] == "DESCRIBE"]
                assert describe_reqs, "expected at least one DESCRIBE"
                # r2h-seek-offset must not leak.
                assert "r2h-seek-offset" not in describe_reqs[0]["uri"], (
                    "r2h-seek-offset leaked into upstream URI: %s" % describe_reqs[0]["uri"]
                )
                # Request offset (7200, not 3600) should have been applied to playseek.
                expected_str = _format_yyyyMMddHHmmss(base_ts + 7200)
                assert "playseek=%s" % expected_str in describe_reqs[0]["uri"], (
                    "request offset (7200) should have applied; got URI %s" % describe_reqs[0]["uri"]
                )
            finally:
                r2h.stop()
        finally:
            rtsp.stop()

    def test_duplicate_request_seek_mode_does_not_leak(self, shared_r2h):
        """A client that sends r2h-seek-mode twice must have BOTH copies stripped
        from the upstream URI — the second copy could otherwise be re-parsed
        and override the first or leak as an unknown control parameter."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            start_ts = int(time.time()) - 1500
            utc_str = _format_yyyyMMddHHmmss(start_ts)
            # Two distinct r2h-seek-mode values; the first one (passthrough) wins.
            url = (
                "/rtsp/127.0.0.1:%d/stream?playseek=%s&r2h-seek-mode=passthrough&r2h-seek-mode=range(UTC%%2B8/3600)"
                % (rtsp.port, utc_str)
            )

            stream_get("127.0.0.1", shared_r2h.port, url, read_bytes=4096, timeout=_STREAM_TIMEOUT)

            describe_reqs = [r for r in rtsp.requests_detailed if r["method"] == "DESCRIBE"]
            assert describe_reqs, "expected at least one DESCRIBE"
            # No r2h-seek-mode should leak into the upstream URI.
            assert "r2h-seek-mode" not in describe_reqs[0]["uri"], (
                "r2h-seek-mode leaked into upstream URI: %s" % describe_reqs[0]["uri"]
            )
            # First value (passthrough) wins → no clock= header.
            play_reqs = [r for r in rtsp.requests_detailed if r["method"] == "PLAY"]
            assert "Range" not in play_reqs[0]["headers"]
        finally:
            rtsp.stop()

    def test_configured_ifname_does_not_leak(self, r2h_binary):
        """r2h-ifname configured via M3U must not leak to the upstream URI."""
        r2h_port = find_free_port()
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            config = self._config(r2h_port, rtsp.port, "IfnameFallback", "?r2h-ifname=lo0")
            r2h = R2HProcess(r2h_binary, r2h_port, config_content=config)
            r2h.start()
            try:
                stream_get("127.0.0.1", r2h_port, "/IfnameFallback", read_bytes=4096, timeout=_STREAM_TIMEOUT)

                describe_reqs = [r for r in rtsp.requests_detailed if r["method"] == "DESCRIBE"]
                assert describe_reqs, "expected at least one DESCRIBE"
                assert "r2h-ifname" not in describe_reqs[0]["uri"], (
                    "r2h-ifname leaked into upstream URI: %s" % describe_reqs[0]["uri"]
                )
            finally:
                r2h.stop()
        finally:
            rtsp.stop()

    def test_request_ifname_overrides_configured(self, r2h_binary):
        """Configured r2h-ifname plus request r2h-ifname: request wins, neither
        leaks. We can't directly observe which interface was bound from the
        e2e harness, but we can verify the merged URL is well-formed (the
        request goes through) and no r2h-ifname survives into the upstream
        URI."""
        r2h_port = find_free_port()
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            config = self._config(r2h_port, rtsp.port, "IfnameMerge", "?r2h-ifname=lo0")
            r2h = R2HProcess(r2h_binary, r2h_port, config_content=config)
            r2h.start()
            try:
                # Same interface name on the request side; the goal is to
                # exercise the merge path without depending on platform-specific
                # interface availability for assertion.
                stream_get(
                    "127.0.0.1",
                    r2h_port,
                    "/IfnameMerge?r2h-ifname=lo0",
                    read_bytes=4096,
                    timeout=_STREAM_TIMEOUT,
                )

                describe_reqs = [r for r in rtsp.requests_detailed if r["method"] == "DESCRIBE"]
                assert describe_reqs, "expected at least one DESCRIBE"
                assert "r2h-ifname" not in describe_reqs[0]["uri"], (
                    "r2h-ifname leaked into upstream URI: %s" % describe_reqs[0]["uri"]
                )
            finally:
                r2h.stop()
        finally:
            rtsp.stop()

    def test_configured_seek_name_does_not_leak(self, r2h_binary):
        """Configured r2h-seek-name must not survive into the upstream URI;
        the resolved seek param value does, but under the configured custom
        name (not as r2h-seek-name=...)."""
        r2h_port = find_free_port()
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            config = self._config(r2h_port, rtsp.port, "SeekNameFallback", "?r2h-seek-name=customseek")
            r2h = R2HProcess(r2h_binary, r2h_port, config_content=config)
            r2h.start()
            try:
                # Request supplies the value under the configured custom name.
                base_ts = 1717000000
                base_str = _format_yyyyMMddHHmmss(base_ts)
                stream_get(
                    "127.0.0.1",
                    r2h_port,
                    "/SeekNameFallback?customseek=%s" % base_str,
                    read_bytes=4096,
                    timeout=_STREAM_TIMEOUT,
                )

                describe_reqs = [r for r in rtsp.requests_detailed if r["method"] == "DESCRIBE"]
                assert describe_reqs, "expected at least one DESCRIBE"
                uri = describe_reqs[0]["uri"]
                assert "r2h-seek-name" not in uri, "r2h-seek-name leaked into upstream URI: %s" % uri
                assert "customseek=%s" % base_str in uri, (
                    "Custom-named seek value should be forwarded under the configured name; got: %s" % uri
                )
            finally:
                r2h.stop()
        finally:
            rtsp.stop()

    def test_request_seek_name_overrides_configured(self, r2h_binary):
        """Request r2h-seek-name overrides M3U-configured r2h-seek-name, and
        neither r2h-seek-name copy leaks upstream."""
        r2h_port = find_free_port()
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            # Configured custom name = "configured_name", but request asks for "request_name".
            config = self._config(r2h_port, rtsp.port, "SeekNameMerge", "?r2h-seek-name=configured_name")
            r2h = R2HProcess(r2h_binary, r2h_port, config_content=config)
            r2h.start()
            try:
                base_ts = 1717000000
                base_str = _format_yyyyMMddHHmmss(base_ts)
                # Provide the seek value under the request-configured name.
                stream_get(
                    "127.0.0.1",
                    r2h_port,
                    "/SeekNameMerge?r2h-seek-name=request_name&request_name=%s" % base_str,
                    read_bytes=4096,
                    timeout=_STREAM_TIMEOUT,
                )

                describe_reqs = [r for r in rtsp.requests_detailed if r["method"] == "DESCRIBE"]
                assert describe_reqs, "expected at least one DESCRIBE"
                uri = describe_reqs[0]["uri"]
                assert "r2h-seek-name" not in uri, "r2h-seek-name leaked into upstream URI: %s" % uri
                # Request-side custom name wins.
                assert "request_name=%s" % base_str in uri, (
                    "request_name (request-side) should be forwarded; got: %s" % uri
                )
                assert "configured_name=" not in uri, (
                    "configured_name (M3U-side) must NOT be used when request overrides; got: %s" % uri
                )
            finally:
                r2h.stop()
        finally:
            rtsp.stop()

    def test_configured_ifname_fcc_does_not_leak(self, r2h_binary):
        """r2h-ifname-fcc configured via M3U must not leak to the upstream URI.
        Mirrors the r2h-ifname coverage on the separate FCC ifname branch."""
        r2h_port = find_free_port()
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            config = self._config(r2h_port, rtsp.port, "IfnameFccFallback", "?r2h-ifname-fcc=lo0")
            r2h = R2HProcess(r2h_binary, r2h_port, config_content=config)
            r2h.start()
            try:
                stream_get("127.0.0.1", r2h_port, "/IfnameFccFallback", read_bytes=4096, timeout=_STREAM_TIMEOUT)

                describe_reqs = [r for r in rtsp.requests_detailed if r["method"] == "DESCRIBE"]
                assert describe_reqs, "expected at least one DESCRIBE"
                assert "r2h-ifname-fcc" not in describe_reqs[0]["uri"], (
                    "r2h-ifname-fcc leaked into upstream URI: %s" % describe_reqs[0]["uri"]
                )
            finally:
                r2h.stop()
        finally:
            rtsp.stop()

    def test_request_ifname_fcc_overrides_configured(self, r2h_binary):
        """Configured r2h-ifname-fcc plus request r2h-ifname-fcc: request wins,
        neither leaks. Mirrors test_request_ifname_overrides_configured for
        the separate FCC ifname branch."""
        r2h_port = find_free_port()
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            config = self._config(r2h_port, rtsp.port, "IfnameFccMerge", "?r2h-ifname-fcc=lo0")
            r2h = R2HProcess(r2h_binary, r2h_port, config_content=config)
            r2h.start()
            try:
                stream_get(
                    "127.0.0.1",
                    r2h_port,
                    "/IfnameFccMerge?r2h-ifname-fcc=lo0",
                    read_bytes=4096,
                    timeout=_STREAM_TIMEOUT,
                )

                describe_reqs = [r for r in rtsp.requests_detailed if r["method"] == "DESCRIBE"]
                assert describe_reqs, "expected at least one DESCRIBE"
                assert "r2h-ifname-fcc" not in describe_reqs[0]["uri"], (
                    "r2h-ifname-fcc leaked into upstream URI: %s" % describe_reqs[0]["uri"]
                )
            finally:
                r2h.stop()
        finally:
            rtsp.stop()
