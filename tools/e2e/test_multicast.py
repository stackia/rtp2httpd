"""
E2E tests for RTP multicast streaming and FEC.

These tests verify that rtp2httpd can receive multicast RTP traffic
and relay it to HTTP clients.

The mock sender uses 7 TS packets per RTP datagram at ~200 pps,
producing roughly 2 Mbps of payload (similar to real IPTV streams).
"""

import time

import pytest

from helpers import (
    LOOPBACK_IF,
    MCAST_ADDR,
    MulticastSender,
    R2HProcess,
    find_free_port,
    find_free_udp_port,
    stream_get,
)

pytestmark = pytest.mark.multicast

# Timeout for multicast streaming tests.  At ~2 Mbps the 64 KB zerocopy
# batch threshold fills in < 1 s, but multicast group join on macOS may
# add a few seconds of latency.
_MCAST_STREAM_TIMEOUT = 10.0


# ---------------------------------------------------------------------------
# Basic RTP multicast -> HTTP relay
# ---------------------------------------------------------------------------


class TestBasicRTPStream:
    """Verify the /rtp/ endpoint streams multicast data."""

    def test_rtp_stream_returns_200(self, r2h_binary):
        """Requesting /rtp/<mcast>:<port> should return HTTP 200."""
        mcast_port = find_free_udp_port()
        sender = MulticastSender(addr=MCAST_ADDR, port=mcast_port, pps=200)
        sender.start()
        time.sleep(0.1)

        port = find_free_port()
        r2h = R2HProcess(
            r2h_binary, port,
            extra_args=["-v", "4", "-m", "100", "-r", LOOPBACK_IF],
        )
        try:
            r2h.start()
            status, hdrs, body = stream_get(
                "127.0.0.1", port,
                f"/rtp/{MCAST_ADDR}:{mcast_port}",
                read_bytes=4096,
                timeout=_MCAST_STREAM_TIMEOUT,
            )
            assert status == 200
            assert len(body) > 0, "Expected to receive stream data"
        finally:
            r2h.stop()
            sender.stop()

    def test_rtp_stream_data_is_ts(self, r2h_binary):
        """The relayed payload should be raw MPEG-TS (starts with 0x47)."""
        mcast_port = find_free_udp_port()
        sender = MulticastSender(addr=MCAST_ADDR, port=mcast_port, pps=300)
        sender.start()
        time.sleep(0.1)

        port = find_free_port()
        r2h = R2HProcess(
            r2h_binary, port,
            extra_args=["-v", "4", "-m", "100", "-r", LOOPBACK_IF],
        )
        try:
            r2h.start()
            status, _, body = stream_get(
                "127.0.0.1", port,
                f"/rtp/{MCAST_ADDR}:{mcast_port}",
                read_bytes=4096,
                timeout=_MCAST_STREAM_TIMEOUT,
            )
            assert status == 200
            assert len(body) >= 188, "Need at least one TS packet"
            assert body[0] == 0x47, f"Expected TS sync byte 0x47, got 0x{body[0]:02x}"
        finally:
            r2h.stop()
            sender.stop()


# ---------------------------------------------------------------------------
# UDPxy-compatible /udp/ URL
# ---------------------------------------------------------------------------


class TestUDPxyFormat:
    """Verify /udp/ works identically to /rtp/."""

    def test_udpxy_url_returns_200(self, r2h_binary):
        mcast_port = find_free_udp_port()
        sender = MulticastSender(addr=MCAST_ADDR, port=mcast_port, pps=200)
        sender.start()
        time.sleep(0.1)

        port = find_free_port()
        r2h = R2HProcess(
            r2h_binary, port,
            extra_args=["-v", "4", "-m", "100", "-r", LOOPBACK_IF],
        )
        try:
            r2h.start()
            status, _, body = stream_get(
                "127.0.0.1", port,
                f"/udp/{MCAST_ADDR}:{mcast_port}",
                read_bytes=4096,
                timeout=_MCAST_STREAM_TIMEOUT,
            )
            assert status == 200
            assert len(body) > 0
        finally:
            r2h.stop()
            sender.stop()

    def test_noudpxy_flag_disables_udp_url(self, r2h_binary):
        """-U flag should cause /udp/ URLs to return 404."""
        port = find_free_port()
        r2h = R2HProcess(
            r2h_binary, port,
            extra_args=["-v", "4", "-m", "100", "-U"],
        )
        try:
            r2h.start()
            from helpers import http_request
            status, _, _ = http_request(
                "127.0.0.1", port, "HEAD",
                "/udp/239.0.0.1:1234",
                timeout=3.0,
            )
            assert status == 404
        finally:
            r2h.stop()


# ---------------------------------------------------------------------------
# FEC parameter
# ---------------------------------------------------------------------------


class TestFEC:
    """Verify that ?fec= parameter is accepted."""

    def test_fec_param_accepted(self, r2h_binary):
        """The server should accept ?fec=PORT and still return 200."""
        mcast_port = find_free_udp_port()
        fec_port = find_free_udp_port()
        sender = MulticastSender(addr=MCAST_ADDR, port=mcast_port, pps=200)
        sender.start()
        time.sleep(0.1)

        port = find_free_port()
        r2h = R2HProcess(
            r2h_binary, port,
            extra_args=["-v", "4", "-m", "100", "-r", LOOPBACK_IF],
        )
        try:
            r2h.start()
            status, _, body = stream_get(
                "127.0.0.1", port,
                f"/rtp/{MCAST_ADDR}:{mcast_port}?fec={fec_port}",
                read_bytes=4096,
                timeout=_MCAST_STREAM_TIMEOUT,
            )
            assert status == 200
            assert len(body) > 0
        finally:
            r2h.stop()
            sender.stop()


# ---------------------------------------------------------------------------
# Multiple concurrent clients
# ---------------------------------------------------------------------------


class TestMultipleConcurrentClients:
    """Verify multiple clients can stream the same multicast simultaneously."""

    def test_two_clients_same_stream(self, r2h_binary):
        mcast_port = find_free_udp_port()
        sender = MulticastSender(addr=MCAST_ADDR, port=mcast_port, pps=300)
        sender.start()
        time.sleep(0.1)

        port = find_free_port()
        r2h = R2HProcess(
            r2h_binary, port,
            extra_args=["-v", "4", "-m", "100", "-r", LOOPBACK_IF],
        )
        try:
            r2h.start()
            url = f"/rtp/{MCAST_ADDR}:{mcast_port}"

            import concurrent.futures
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                f1 = pool.submit(stream_get, "127.0.0.1", port, url, 2048, _MCAST_STREAM_TIMEOUT)
                f2 = pool.submit(stream_get, "127.0.0.1", port, url, 2048, _MCAST_STREAM_TIMEOUT)
                s1, _, b1 = f1.result()
                s2, _, b2 = f2.result()

            assert s1 == 200
            assert s2 == 200
            assert len(b1) > 0
            assert len(b2) > 0
        finally:
            r2h.stop()
            sender.stop()


# ---------------------------------------------------------------------------
# HEAD request (does NOT require actual multicast data)
# ---------------------------------------------------------------------------


class TestHeadRequest:
    """HEAD on /rtp/ should return 200 without opening the stream."""

    def test_head_rtp(self, r2h_binary):
        port = find_free_port()
        mcast_port = find_free_udp_port()
        r2h = R2HProcess(
            r2h_binary, port,
            extra_args=["-v", "4", "-m", "100"],
        )
        try:
            r2h.start()
            from helpers import http_request
            status, hdrs, body = http_request(
                "127.0.0.1", port, "HEAD",
                f"/rtp/{MCAST_ADDR}:{mcast_port}",
                timeout=3.0,
            )
            assert status == 200
            assert len(body) == 0  # HEAD should have empty body
        finally:
            r2h.stop()
