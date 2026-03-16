"""
E2E tests for RTSP proxy streaming – TCP interleaved and UDP transport.

Tests verify basic connectivity, TS payload correctness, and the RTSP
handshake sequence for both transport modes.
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
    """A single rtp2httpd instance shared by all transport tests."""
    port = find_free_port()
    r2h = R2HProcess(r2h_binary, port, extra_args=["-v", "4", "-m", "100"])
    r2h.start()
    yield r2h
    r2h.stop()


# ===================================================================
# TCP interleaved transport
# ===================================================================


class TestRTSPTCPStream:
    """RTSP with TCP interleaved (``RTP/AVP/TCP;interleaved=0-1``)."""

    def test_tcp_stream_returns_200(self, shared_r2h):
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            status, _, body = stream_get(
                "127.0.0.1",
                shared_r2h.port,
                "/rtsp/127.0.0.1:%d/stream" % rtsp.port,
                read_bytes=4096,
                timeout=_STREAM_TIMEOUT,
            )
            assert status == 200, "Expected 200 for TCP interleaved RTSP"
            assert len(body) > 0
        finally:
            rtsp.stop()

    def test_tcp_data_is_ts(self, shared_r2h):
        """Relayed data should be raw MPEG-TS (RTP headers stripped)."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            status, _, body = stream_get(
                "127.0.0.1",
                shared_r2h.port,
                "/rtsp/127.0.0.1:%d/stream" % rtsp.port,
                read_bytes=4096,
                timeout=_STREAM_TIMEOUT,
            )
            assert status == 200
            assert len(body) >= 188
            assert body[0] == 0x47, "Expected TS sync byte 0x47, got 0x%02x" % body[0]
        finally:
            rtsp.stop()

    def test_tcp_protocol_handshake(self, shared_r2h):
        """The mock should receive OPTIONS, DESCRIBE, SETUP, PLAY."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            stream_get(
                "127.0.0.1",
                shared_r2h.port,
                "/rtsp/127.0.0.1:%d/test" % rtsp.port,
                read_bytes=2048,
                timeout=_STREAM_TIMEOUT,
            )
            methods = rtsp.requests_received
            assert "OPTIONS" in methods
            assert "DESCRIBE" in methods
            assert "SETUP" in methods
            assert "PLAY" in methods
        finally:
            rtsp.stop()


# ===================================================================
# UDP transport
# ===================================================================


class TestRTSPUDPStream:
    """RTSP with UDP transport (``RTP/AVP;unicast;client_port=...``)."""

    def test_udp_stream_returns_200(self, shared_r2h):
        rtsp = MockRTSPServerUDP()
        rtsp.start()
        try:
            status, _, body = stream_get(
                "127.0.0.1",
                shared_r2h.port,
                "/rtsp/127.0.0.1:%d/stream" % rtsp.port,
                read_bytes=4096,
                timeout=_STREAM_TIMEOUT,
            )
            assert status == 200, "Expected 200 for UDP RTSP"
            assert len(body) > 0
        finally:
            rtsp.stop()

    def test_udp_data_is_ts(self, shared_r2h):
        rtsp = MockRTSPServerUDP()
        rtsp.start()
        try:
            status, _, body = stream_get(
                "127.0.0.1",
                shared_r2h.port,
                "/rtsp/127.0.0.1:%d/stream" % rtsp.port,
                read_bytes=4096,
                timeout=_STREAM_TIMEOUT,
            )
            assert status == 200
            assert len(body) >= 188
            assert body[0] == 0x47, "Expected TS sync byte"
        finally:
            rtsp.stop()

    def test_udp_protocol_handshake(self, shared_r2h):
        rtsp = MockRTSPServerUDP()
        rtsp.start()
        try:
            stream_get(
                "127.0.0.1",
                shared_r2h.port,
                "/rtsp/127.0.0.1:%d/test" % rtsp.port,
                read_bytes=2048,
                timeout=_STREAM_TIMEOUT,
            )
            methods = rtsp.requests_received
            assert "OPTIONS" in methods
            assert "DESCRIBE" in methods
            assert "SETUP" in methods
            assert "PLAY" in methods
        finally:
            rtsp.stop()
