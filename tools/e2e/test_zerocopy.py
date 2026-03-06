"""
E2E tests for MSG_ZEROCOPY send path (Linux only).

These tests verify that rtp2httpd streams data correctly when the
--zerocopy-on-send (-Z) flag is enabled.  MSG_ZEROCOPY uses the kernel's
MSG_ERRQUEUE for completion notifications, which arrive as EPOLLERR events.
With edge-triggered polling (EPOLLET), the handler must drain all
completions in one pass — these tests exercise that code path.

On kernels < 4.14 or non-Linux platforms, rtp2httpd silently falls back to
regular send(), so these tests validate the fallback path too.
"""

import sys
import time
import concurrent.futures

import pytest

from helpers import (
    LOOPBACK_IF,
    MCAST_ADDR,
    MockHTTPUpstream,
    MockRTSPServer,
    MockRTSPServerUDP,
    MulticastSender,
    R2HProcess,
    find_free_port,
    find_free_udp_port,
    stream_get,
)

# Skip entire module on non-Linux (MSG_ZEROCOPY is Linux-only)
pytestmark = [
    pytest.mark.skipif(sys.platform != "linux", reason="MSG_ZEROCOPY is Linux-only"),
]

_STREAM_TIMEOUT = 10.0

# Common extra args: zerocopy enabled, debug logging, 100 max-clients
_ZC_ARGS = ["-Z", "-v", "4", "-m", "100"]


# ---------------------------------------------------------------------------
# Multicast + zerocopy
# ---------------------------------------------------------------------------


class TestZerocopyMulticast:
    """Verify multicast RTP streaming works with MSG_ZEROCOPY enabled."""

    def test_multicast_stream_200(self, r2h_binary):
        """Basic multicast stream should return 200 with zerocopy."""
        mcast_port = find_free_udp_port()
        sender = MulticastSender(addr=MCAST_ADDR, port=mcast_port, pps=300)
        sender.start()
        time.sleep(0.1)

        port = find_free_port()
        r2h = R2HProcess(
            r2h_binary, port,
            extra_args=_ZC_ARGS + ["-r", LOOPBACK_IF],
        )
        try:
            r2h.start()
            status, _, body = stream_get(
                "127.0.0.1", port,
                f"/rtp/{MCAST_ADDR}:{mcast_port}",
                read_bytes=8192,
                timeout=_STREAM_TIMEOUT,
            )
            assert status == 200
            assert len(body) > 0, "Expected stream data with zerocopy"
        finally:
            r2h.stop()
            sender.stop()

    def test_multicast_ts_integrity(self, r2h_binary):
        """TS sync bytes must be intact after zerocopy transmission."""
        mcast_port = find_free_udp_port()
        sender = MulticastSender(addr=MCAST_ADDR, port=mcast_port, pps=300)
        sender.start()
        time.sleep(0.1)

        port = find_free_port()
        r2h = R2HProcess(
            r2h_binary, port,
            extra_args=_ZC_ARGS + ["-r", LOOPBACK_IF],
        )
        try:
            r2h.start()
            status, _, body = stream_get(
                "127.0.0.1", port,
                f"/rtp/{MCAST_ADDR}:{mcast_port}",
                read_bytes=8192,
                timeout=_STREAM_TIMEOUT,
            )
            assert status == 200
            assert len(body) >= 188, "Need at least one TS packet"
            assert body[0] == 0x47, f"Expected TS sync byte 0x47, got 0x{body[0]:02x}"
        finally:
            r2h.stop()
            sender.stop()

    def test_multicast_concurrent_clients(self, r2h_binary):
        """Multiple clients streaming the same multicast with zerocopy."""
        mcast_port = find_free_udp_port()
        sender = MulticastSender(addr=MCAST_ADDR, port=mcast_port, pps=300)
        sender.start()
        time.sleep(0.1)

        port = find_free_port()
        r2h = R2HProcess(
            r2h_binary, port,
            extra_args=_ZC_ARGS + ["-r", LOOPBACK_IF],
        )
        try:
            r2h.start()
            url = f"/rtp/{MCAST_ADDR}:{mcast_port}"

            with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
                futures = [
                    pool.submit(stream_get, "127.0.0.1", port, url, 4096, _STREAM_TIMEOUT)
                    for _ in range(3)
                ]
                results = [f.result() for f in futures]

            for i, (s, _, b) in enumerate(results):
                assert s == 200, f"Client {i} got status {s}"
                assert len(b) > 0, f"Client {i} got no data"
        finally:
            r2h.stop()
            sender.stop()


# ---------------------------------------------------------------------------
# RTSP + zerocopy
# ---------------------------------------------------------------------------


class TestZerocopyRTSP:
    """Verify RTSP streaming works with MSG_ZEROCOPY enabled."""

    @pytest.mark.rtsp
    def test_rtsp_tcp_stream(self, r2h_binary):
        """RTSP TCP interleaved streaming should work with zerocopy."""
        mock = MockRTSPServer(num_packets=200)
        mock.start()

        port = find_free_port()
        r2h = R2HProcess(
            r2h_binary, port,
            extra_args=_ZC_ARGS,
        )
        try:
            r2h.start()
            status, _, body = stream_get(
                "127.0.0.1", port,
                f"/rtsp/127.0.0.1:{mock.port}",
                read_bytes=4096,
                timeout=_STREAM_TIMEOUT,
            )
            assert status == 200
            assert len(body) > 0, "Expected RTSP TCP stream data with zerocopy"
        finally:
            r2h.stop()
            mock.stop()

    @pytest.mark.rtsp
    def test_rtsp_tcp_data_integrity(self, r2h_binary):
        """TS sync bytes must be intact in RTSP TCP stream with zerocopy."""
        mock = MockRTSPServer(num_packets=200)
        mock.start()

        port = find_free_port()
        r2h = R2HProcess(
            r2h_binary, port,
            extra_args=_ZC_ARGS,
        )
        try:
            r2h.start()
            status, _, body = stream_get(
                "127.0.0.1", port,
                f"/rtsp/127.0.0.1:{mock.port}",
                read_bytes=4096,
                timeout=_STREAM_TIMEOUT,
            )
            assert status == 200
            assert len(body) >= 188
            assert body[0] == 0x47, f"Expected TS sync byte 0x47, got 0x{body[0]:02x}"
        finally:
            r2h.stop()
            mock.stop()

    @pytest.mark.rtsp
    def test_rtsp_udp_stream(self, r2h_binary):
        """RTSP UDP streaming should work with zerocopy."""
        mock = MockRTSPServerUDP(num_packets=200)
        mock.start()

        port = find_free_port()
        r2h = R2HProcess(
            r2h_binary, port,
            extra_args=_ZC_ARGS,
        )
        try:
            r2h.start()
            status, _, body = stream_get(
                "127.0.0.1", port,
                f"/rtsp/127.0.0.1:{mock.port}",
                read_bytes=4096,
                timeout=_STREAM_TIMEOUT,
            )
            assert status == 200
            assert len(body) > 0, "Expected RTSP UDP stream data with zerocopy"
        finally:
            r2h.stop()
            mock.stop()


# ---------------------------------------------------------------------------
# HTTP Proxy + zerocopy
# ---------------------------------------------------------------------------


class TestZerocopyHTTPProxy:
    """Verify HTTP proxy works with MSG_ZEROCOPY enabled."""

    @pytest.mark.http_proxy
    def test_proxy_stream(self, r2h_binary):
        """HTTP proxy should forward data correctly with zerocopy."""
        body_data = b"x" * 16384  # 16KB body
        upstream = MockHTTPUpstream(routes={
            "/stream": {
                "status": 200,
                "body": body_data,
                "headers": {"Content-Type": "application/octet-stream"},
            },
        })
        upstream.start()

        port = find_free_port()
        r2h = R2HProcess(
            r2h_binary, port,
            extra_args=_ZC_ARGS,
        )
        try:
            r2h.start()
            from helpers import http_get
            status, _, body = http_get(
                "127.0.0.1", port,
                f"/http/127.0.0.1:{upstream.port}/stream",
                timeout=5.0,
            )
            assert status == 200
            assert body == body_data, "Body mismatch with zerocopy proxy"
        finally:
            r2h.stop()
            upstream.stop()

    @pytest.mark.http_proxy
    def test_proxy_large_body(self, r2h_binary):
        """HTTP proxy should handle large payloads correctly with zerocopy."""
        # 256KB body - exercises multiple sendmsg calls with MSG_ZEROCOPY
        body_data = bytes(range(256)) * 1024  # 256KB
        upstream = MockHTTPUpstream(routes={
            "/large": {
                "status": 200,
                "body": body_data,
                "headers": {"Content-Type": "application/octet-stream"},
            },
        })
        upstream.start()

        port = find_free_port()
        r2h = R2HProcess(
            r2h_binary, port,
            extra_args=_ZC_ARGS,
        )
        try:
            r2h.start()
            from helpers import http_get
            status, _, body = http_get(
                "127.0.0.1", port,
                f"/http/127.0.0.1:{upstream.port}/large",
                timeout=10.0,
            )
            assert status == 200
            assert len(body) == len(body_data), (
                f"Expected {len(body_data)} bytes, got {len(body)}"
            )
            assert body == body_data, "Body content mismatch with zerocopy proxy"
        finally:
            r2h.stop()
            upstream.stop()
