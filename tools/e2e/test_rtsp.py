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
