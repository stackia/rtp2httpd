"""
E2E tests for RTSP STUN (NAT traversal) support.

Tests verify that rtp2httpd correctly:
- Sends a STUN Binding Request to the configured server
- Uses the STUN-mapped port in the SETUP Transport client_port
- Falls back to local port when STUN times out
- Retries STUN requests on timeout

Note: TCP interleaved transport is used so that data flows reliably on
localhost (no real NAT).  The SETUP Transport header still contains UDP
``client_port`` offers, which we inspect to verify STUN behaviour.
"""

import time

import pytest

from helpers import (
    MockRTSPServer,
    R2HProcess,
    find_free_port,
    stream_get,
)
from helpers.mock_stun import MockSTUNServer

pytestmark = pytest.mark.rtsp

_STREAM_TIMEOUT = 20.0


class TestSTUNMappedPort:
    """When STUN succeeds, the mapped port should appear in SETUP."""

    def test_setup_uses_stun_mapped_port(self, r2h_binary):
        """SETUP Transport client_port should be the STUN-mapped port."""
        mapped_port = 50000
        stun = MockSTUNServer(mapped_port=mapped_port)
        stun.start()
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        r2h_port = find_free_port()
        r2h = R2HProcess(
            r2h_binary,
            r2h_port,
            extra_args=["-v", "4", "-m", "100", "-N", "127.0.0.1:%d" % stun.port],
        )
        r2h.start()
        try:
            status, _, body = stream_get(
                "127.0.0.1",
                r2h_port,
                "/rtsp/127.0.0.1:%d/stream" % rtsp.port,
                read_bytes=4096,
                timeout=_STREAM_TIMEOUT,
            )
            assert status == 200
            assert len(body) > 0

            # STUN server should have received at least one Binding Request
            assert stun.requests_received >= 1, "Expected STUN Binding Request, got %d" % stun.requests_received

            # Verify the SETUP Transport header uses the mapped port
            setup_reqs = [r for r in rtsp.requests_detailed if r["method"] == "SETUP"]
            assert len(setup_reqs) >= 1, "No SETUP request received"
            transport = setup_reqs[0]["headers"].get("Transport", "")
            assert "client_port=%d-%d" % (mapped_port, mapped_port + 1) in transport, (
                "Expected mapped port %d in Transport, got: %s" % (mapped_port, transport)
            )
        finally:
            r2h.stop()
            rtsp.stop()
            stun.stop()

    def test_stream_data_is_ts_with_stun(self, r2h_binary):
        """Streaming should still produce valid TS data when STUN is active."""
        stun = MockSTUNServer(mapped_port=50002)
        stun.start()
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        r2h_port = find_free_port()
        r2h = R2HProcess(
            r2h_binary,
            r2h_port,
            extra_args=["-v", "4", "-m", "100", "-N", "127.0.0.1:%d" % stun.port],
        )
        r2h.start()
        try:
            status, _, body = stream_get(
                "127.0.0.1",
                r2h_port,
                "/rtsp/127.0.0.1:%d/stream" % rtsp.port,
                read_bytes=4096,
                timeout=_STREAM_TIMEOUT,
            )
            assert status == 200
            assert len(body) >= 188
            assert body[0] == 0x47, "Expected TS sync byte 0x47, got 0x%02x" % body[0]
        finally:
            r2h.stop()
            rtsp.stop()
            stun.stop()


class TestSTUNTimeout:
    """When STUN times out, rtp2httpd should fall back to local port."""

    def test_fallback_to_local_port_on_timeout(self, r2h_binary):
        """With a silent STUN server, the stream should still work using
        local ports."""
        stun = MockSTUNServer(silent=True)
        stun.start()
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        r2h_port = find_free_port()
        r2h = R2HProcess(
            r2h_binary,
            r2h_port,
            extra_args=["-v", "4", "-m", "100", "-N", "127.0.0.1:%d" % stun.port],
        )
        r2h.start()
        try:
            status, _, body = stream_get(
                "127.0.0.1",
                r2h_port,
                "/rtsp/127.0.0.1:%d/stream" % rtsp.port,
                read_bytes=4096,
                timeout=_STREAM_TIMEOUT,
            )
            assert status == 200
            assert len(body) > 0

            # STUN requests should have been sent (initial + retries)
            assert stun.requests_received >= 1, "Expected STUN requests even in silent mode"

            # The SETUP client_port should NOT be the default mapped port
            # (50000) since STUN was silent — it should be the local port.
            setup_reqs = [r for r in rtsp.requests_detailed if r["method"] == "SETUP"]
            assert len(setup_reqs) >= 1
            transport = setup_reqs[0]["headers"].get("Transport", "")
            assert "client_port=50000" not in transport, "Should not use default mapped port after timeout"
        finally:
            r2h.stop()
            rtsp.stop()
            stun.stop()

    def test_stun_retries_on_timeout(self, r2h_binary):
        """Silent STUN should trigger retry attempts (max 2 retries = 3
        total requests)."""
        stun = MockSTUNServer(silent=True)
        stun.start()
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        r2h_port = find_free_port()
        r2h = R2HProcess(
            r2h_binary,
            r2h_port,
            extra_args=["-v", "4", "-m", "100", "-N", "127.0.0.1:%d" % stun.port],
        )
        r2h.start()
        try:
            stream_get(
                "127.0.0.1",
                r2h_port,
                "/rtsp/127.0.0.1:%d/stream" % rtsp.port,
                read_bytes=4096,
                timeout=_STREAM_TIMEOUT,
            )
            # Allow a moment for retries to complete
            time.sleep(0.5)

            # Should have received initial + up to 2 retries = 3
            assert stun.requests_received >= 2, (
                "Expected at least 2 STUN requests (initial + retry), got %d" % stun.requests_received
            )
        finally:
            r2h.stop()
            rtsp.stop()
            stun.stop()
