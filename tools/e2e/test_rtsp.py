"""
E2E tests for RTSP proxy streaming.

Tests cover both TCP interleaved and UDP transport modes using mock RTSP
servers.  rtp2httpd prefers TCP interleaved but falls back to UDP when the
server only offers it.

Tests use a generous 20 s timeout via ``stream_get`` to accommodate the
RTSP state machine setup time on macOS.
"""

import pytest

from helpers import (
    MockRTSPServer,
    MockRTSPServerUDP,
    R2HProcess,
    find_free_port,
    http_request,
    stream_get,
)

pytestmark = pytest.mark.rtsp

_STREAM_TIMEOUT = 20.0


# ===================================================================
# TCP interleaved transport
# ===================================================================


class TestRTSPTCPStream:
    """RTSP with TCP interleaved (``RTP/AVP/TCP;interleaved=0-1``)."""

    def test_tcp_stream_returns_200(self, r2h_binary):
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        port = find_free_port()
        r2h = R2HProcess(r2h_binary, port, extra_args=["-v", "4", "-m", "100"])
        try:
            r2h.start()
            status, _, body = stream_get(
                "127.0.0.1", port,
                "/rtsp/127.0.0.1:%d/stream" % rtsp.port,
                read_bytes=4096, timeout=_STREAM_TIMEOUT,
            )
            assert status == 200, "Expected 200 for TCP interleaved RTSP"
            assert len(body) > 0
        finally:
            r2h.stop()
            rtsp.stop()

    def test_tcp_data_is_ts(self, r2h_binary):
        """Relayed data should be raw MPEG-TS (RTP headers stripped)."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        port = find_free_port()
        r2h = R2HProcess(r2h_binary, port, extra_args=["-v", "4", "-m", "100"])
        try:
            r2h.start()
            status, _, body = stream_get(
                "127.0.0.1", port,
                "/rtsp/127.0.0.1:%d/stream" % rtsp.port,
                read_bytes=4096, timeout=_STREAM_TIMEOUT,
            )
            assert status == 200
            assert len(body) >= 188
            assert body[0] == 0x47, "Expected TS sync byte 0x47, got 0x%02x" % body[0]
        finally:
            r2h.stop()
            rtsp.stop()

    def test_tcp_protocol_handshake(self, r2h_binary):
        """The mock should receive OPTIONS, DESCRIBE, SETUP, PLAY."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        port = find_free_port()
        r2h = R2HProcess(r2h_binary, port, extra_args=["-v", "4", "-m", "100"])
        try:
            r2h.start()
            stream_get(
                "127.0.0.1", port,
                "/rtsp/127.0.0.1:%d/test" % rtsp.port,
                read_bytes=2048, timeout=_STREAM_TIMEOUT,
            )
            methods = rtsp.requests_received
            assert "OPTIONS" in methods
            assert "DESCRIBE" in methods
            assert "SETUP" in methods
            assert "PLAY" in methods
        finally:
            r2h.stop()
            rtsp.stop()


# ===================================================================
# UDP transport
# ===================================================================


class TestRTSPUDPStream:
    """RTSP with UDP transport (``RTP/AVP;unicast;client_port=...``)."""

    def test_udp_stream_returns_200(self, r2h_binary):
        rtsp = MockRTSPServerUDP()
        rtsp.start()
        port = find_free_port()
        r2h = R2HProcess(r2h_binary, port, extra_args=["-v", "4", "-m", "100"])
        try:
            r2h.start()
            status, _, body = stream_get(
                "127.0.0.1", port,
                "/rtsp/127.0.0.1:%d/stream" % rtsp.port,
                read_bytes=4096, timeout=_STREAM_TIMEOUT,
            )
            assert status == 200, "Expected 200 for UDP RTSP"
            assert len(body) > 0
        finally:
            r2h.stop()
            rtsp.stop()

    def test_udp_data_is_ts(self, r2h_binary):
        rtsp = MockRTSPServerUDP()
        rtsp.start()
        port = find_free_port()
        r2h = R2HProcess(r2h_binary, port, extra_args=["-v", "4", "-m", "100"])
        try:
            r2h.start()
            status, _, body = stream_get(
                "127.0.0.1", port,
                "/rtsp/127.0.0.1:%d/stream" % rtsp.port,
                read_bytes=4096, timeout=_STREAM_TIMEOUT,
            )
            assert status == 200
            assert len(body) >= 188
            assert body[0] == 0x47, "Expected TS sync byte"
        finally:
            r2h.stop()
            rtsp.stop()

    def test_udp_protocol_handshake(self, r2h_binary):
        rtsp = MockRTSPServerUDP()
        rtsp.start()
        port = find_free_port()
        r2h = R2HProcess(r2h_binary, port, extra_args=["-v", "4", "-m", "100"])
        try:
            r2h.start()
            stream_get(
                "127.0.0.1", port,
                "/rtsp/127.0.0.1:%d/test" % rtsp.port,
                read_bytes=2048, timeout=_STREAM_TIMEOUT,
            )
            methods = rtsp.requests_received
            assert "OPTIONS" in methods
            assert "DESCRIBE" in methods
            assert "SETUP" in methods
            assert "PLAY" in methods
        finally:
            r2h.stop()
            rtsp.stop()


# ===================================================================
# Playseek / timeshift
# ===================================================================


class TestRTSPPlayseek:
    """Verify playseek parameter is forwarded in RTSP requests."""

    def test_playseek_tcp(self, r2h_binary):
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        port = find_free_port()
        r2h = R2HProcess(r2h_binary, port, extra_args=["-v", "4", "-m", "100"])
        try:
            r2h.start()
            status, _, body = stream_get(
                "127.0.0.1", port,
                "/rtsp/127.0.0.1:%d/stream?playseek=20240101120000-20240101130000" % rtsp.port,
                read_bytes=4096, timeout=_STREAM_TIMEOUT,
            )
            assert status == 200
            assert len(body) > 0
        finally:
            r2h.stop()
            rtsp.stop()

    def test_playseek_udp(self, r2h_binary):
        rtsp = MockRTSPServerUDP()
        rtsp.start()
        port = find_free_port()
        r2h = R2HProcess(r2h_binary, port, extra_args=["-v", "4", "-m", "100"])
        try:
            r2h.start()
            status, _, body = stream_get(
                "127.0.0.1", port,
                "/rtsp/127.0.0.1:%d/stream?playseek=20240101120000-20240101130000" % rtsp.port,
                read_bytes=4096, timeout=_STREAM_TIMEOUT,
            )
            assert status == 200
            assert len(body) > 0
        finally:
            r2h.stop()
            rtsp.stop()


# ===================================================================
# HEAD request and error handling
# ===================================================================


class TestRTSPHeadRequest:
    def test_head_rtsp(self, r2h_binary):
        port = find_free_port()
        r2h = R2HProcess(r2h_binary, port, extra_args=["-v", "4", "-m", "100"])
        try:
            r2h.start()
            status, _, body = http_request(
                "127.0.0.1", port, "HEAD",
                "/rtsp/127.0.0.1:554/test", timeout=3.0,
            )
            assert status == 200
            assert len(body) == 0
        finally:
            r2h.stop()


class TestRTSPInvalidServer:
    def test_rtsp_unreachable(self, r2h_binary):
        port = find_free_port()
        dead_port = find_free_port()
        r2h = R2HProcess(r2h_binary, port, extra_args=["-v", "4", "-m", "100"])
        try:
            r2h.start()
            status, _, _ = stream_get(
                "127.0.0.1", port,
                "/rtsp/127.0.0.1:%d/test" % dead_port,
                read_bytes=512, timeout=8.0,
            )
            assert status in (0, 500, 502, 503)
        finally:
            r2h.stop()


# ===================================================================
# Playseek forwarding verification
# ===================================================================


class TestRTSPPlayseekForwarding:
    """Verify that playseek parameters are forwarded in the RTSP URI."""

    def test_playseek_forwarded_in_describe_uri(self, r2h_binary):
        """playseek parameter should be forwarded in the DESCRIBE URI."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        time.sleep(0.1)
        port = find_free_port()
        r2h = R2HProcess(r2h_binary, port, extra_args=["-v", "4", "-m", "100"])
        try:
            r2h.start()
            status, _, body = stream_get(
                "127.0.0.1", port,
                "/rtsp/127.0.0.1:%d/stream?playseek=20240101120000-20240101130000" % rtsp.port,
                read_bytes=4096, timeout=_STREAM_TIMEOUT,
            )
            assert status == 200
            time.sleep(0.5)

            # Verify DESCRIBE URI contains the playseek parameter
            describe_reqs = [r for r in rtsp.requests_detailed if r["method"] == "DESCRIBE"]
            assert len(describe_reqs) > 0, "Expected DESCRIBE request"
            uri = describe_reqs[0]["uri"]
            assert "/stream" in uri, "DESCRIBE URI should contain the path"
            assert "playseek=" in uri, \
                "playseek should be forwarded in DESCRIBE URI, got: %s" % uri
        finally:
            r2h.stop()
            rtsp.stop()

    def test_playseek_correct_path_in_uri(self, r2h_binary):
        """The RTSP URI should contain the correct server path."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        time.sleep(0.1)
        port = find_free_port()
        r2h = R2HProcess(r2h_binary, port, extra_args=["-v", "4", "-m", "100"])
        try:
            r2h.start()
            stream_get(
                "127.0.0.1", port,
                "/rtsp/127.0.0.1:%d/live/channel1?playseek=20240101120000-20240101130000" % rtsp.port,
                read_bytes=2048, timeout=_STREAM_TIMEOUT,
            )
            time.sleep(0.5)

            # DESCRIBE URI should include the full path
            describe_reqs = [r for r in rtsp.requests_detailed if r["method"] == "DESCRIBE"]
            assert len(describe_reqs) > 0
            uri = describe_reqs[0]["uri"]
            assert "/live/channel1" in uri
        finally:
            r2h.stop()
            rtsp.stop()


# ===================================================================
# tvdr parameter (alternative to playseek)
# ===================================================================


class TestRTSPTvdr:
    """Verify tvdr parameter works as an alternative seek parameter."""

    def test_tvdr_forwarded_in_uri(self, r2h_binary):
        """tvdr parameter should be forwarded in the RTSP URI."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        time.sleep(0.1)
        port = find_free_port()
        r2h = R2HProcess(r2h_binary, port, extra_args=["-v", "4", "-m", "100"])
        try:
            r2h.start()
            status, _, body = stream_get(
                "127.0.0.1", port,
                "/rtsp/127.0.0.1:%d/stream?tvdr=20240601080000-20240601090000" % rtsp.port,
                read_bytes=4096, timeout=_STREAM_TIMEOUT,
            )
            assert status == 200
            time.sleep(0.5)

            describe_reqs = [r for r in rtsp.requests_detailed if r["method"] == "DESCRIBE"]
            assert len(describe_reqs) > 0, "Expected DESCRIBE request"
            uri = describe_reqs[0]["uri"]
            assert "tvdr=" in uri, \
                "tvdr should be forwarded in DESCRIBE URI, got: %s" % uri
        finally:
            r2h.stop()
            rtsp.stop()


# ===================================================================
# Custom seek parameter name (r2h-seek-name)
# ===================================================================


class TestRTSPCustomSeekName:
    """Verify r2h-seek-name allows specifying a custom seek parameter."""

    def test_custom_seek_forwarded_in_uri(self, r2h_binary):
        """The custom seek parameter should be forwarded in the RTSP URI."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        time.sleep(0.1)
        port = find_free_port()
        r2h = R2HProcess(r2h_binary, port, extra_args=["-v", "4", "-m", "100"])
        try:
            r2h.start()
            status, _, body = stream_get(
                "127.0.0.1", port,
                "/rtsp/127.0.0.1:%d/stream?r2h-seek-name=myseek&myseek=20240301100000-20240301110000" % rtsp.port,
                read_bytes=4096, timeout=_STREAM_TIMEOUT,
            )
            assert status == 200
            time.sleep(0.5)

            describe_reqs = [r for r in rtsp.requests_detailed if r["method"] == "DESCRIBE"]
            assert len(describe_reqs) > 0, "Expected DESCRIBE request"
            uri = describe_reqs[0]["uri"]
            # The custom seek param should be forwarded
            assert "myseek=" in uri, \
                "Custom seek param should be in DESCRIBE URI, got: %s" % uri
        finally:
            r2h.stop()
            rtsp.stop()

    def test_r2h_seek_name_stripped_from_uri(self, r2h_binary):
        """r2h-seek-name is an rtp2httpd meta-parameter and should be
        stripped from the RTSP URI, while the actual seek param stays."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        time.sleep(0.1)
        port = find_free_port()
        r2h = R2HProcess(r2h_binary, port, extra_args=["-v", "4", "-m", "100"])
        try:
            r2h.start()
            stream_get(
                "127.0.0.1", port,
                "/rtsp/127.0.0.1:%d/stream?r2h-seek-name=myseek&myseek=20240301100000-20240301110000" % rtsp.port,
                read_bytes=2048, timeout=_STREAM_TIMEOUT,
            )
            time.sleep(0.5)

            describe_reqs = [r for r in rtsp.requests_detailed if r["method"] == "DESCRIBE"]
            assert len(describe_reqs) > 0
            uri = describe_reqs[0]["uri"]
            # r2h-seek-name is internal to rtp2httpd, should not reach RTSP server
            assert "r2h-seek-name" not in uri, \
                "r2h-seek-name should be stripped from URI, got: %s" % uri
            # But the actual seek param should be present
            assert "myseek=" in uri
        finally:
            r2h.stop()
            rtsp.stop()
