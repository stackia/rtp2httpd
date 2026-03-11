"""
E2E tests for RTP multicast streaming and FEC.

These tests verify that rtp2httpd can receive multicast RTP traffic
and relay it to HTTP clients.

The mock sender uses 7 TS packets per RTP datagram at ~200 pps,
producing roughly 2 Mbps of payload (similar to real IPTV streams).
"""

import struct

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
# Module-scoped shared rtp2httpd instance
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def multicast_r2h(r2h_binary):
    """A single rtp2httpd instance with multicast interface for streaming tests."""
    port = find_free_port()
    r2h = R2HProcess(
        r2h_binary, port,
        extra_args=["-v", "4", "-m", "100", "-r", LOOPBACK_IF],
    )
    r2h.start()
    yield r2h
    r2h.stop()


# ---------------------------------------------------------------------------
# Basic RTP multicast -> HTTP relay
# ---------------------------------------------------------------------------


class TestBasicRTPStream:
    """Verify the /rtp/ endpoint streams multicast data."""

    def test_rtp_stream_returns_200(self, multicast_r2h):
        """Requesting /rtp/<mcast>:<port> should return HTTP 200."""
        mcast_port = find_free_udp_port()
        sender = MulticastSender(addr=MCAST_ADDR, port=mcast_port, pps=200)
        sender.start()
        try:
            status, hdrs, body = stream_get(
                "127.0.0.1", multicast_r2h.port,
                f"/rtp/{MCAST_ADDR}:{mcast_port}",
                read_bytes=4096,
                timeout=_MCAST_STREAM_TIMEOUT,
            )
            assert status == 200
            assert len(body) > 0, "Expected to receive stream data"
        finally:
            sender.stop()

    def test_rtp_stream_data_is_ts(self, multicast_r2h):
        """The relayed payload should be raw MPEG-TS (starts with 0x47)."""
        mcast_port = find_free_udp_port()
        sender = MulticastSender(addr=MCAST_ADDR, port=mcast_port, pps=300)
        sender.start()
        try:
            status, _, body = stream_get(
                "127.0.0.1", multicast_r2h.port,
                f"/rtp/{MCAST_ADDR}:{mcast_port}",
                read_bytes=4096,
                timeout=_MCAST_STREAM_TIMEOUT,
            )
            assert status == 200
            assert len(body) >= 188, "Need at least one TS packet"
            assert body[0] == 0x47, f"Expected TS sync byte 0x47, got 0x{body[0]:02x}"
        finally:
            sender.stop()


# ---------------------------------------------------------------------------
# UDPxy-compatible /udp/ URL
# ---------------------------------------------------------------------------


class TestUDPxyFormat:
    """Verify /udp/ works identically to /rtp/."""

    def test_udpxy_url_returns_200(self, multicast_r2h):
        mcast_port = find_free_udp_port()
        sender = MulticastSender(addr=MCAST_ADDR, port=mcast_port, pps=200)
        sender.start()
        try:
            status, _, body = stream_get(
                "127.0.0.1", multicast_r2h.port,
                f"/udp/{MCAST_ADDR}:{mcast_port}",
                read_bytes=4096,
                timeout=_MCAST_STREAM_TIMEOUT,
            )
            assert status == 200
            assert len(body) > 0
        finally:
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

    def test_fec_param_accepted(self, multicast_r2h):
        """The server should accept ?fec=PORT and still return 200."""
        mcast_port = find_free_udp_port()
        fec_port = find_free_udp_port()
        sender = MulticastSender(addr=MCAST_ADDR, port=mcast_port, pps=200)
        sender.start()
        try:
            status, _, body = stream_get(
                "127.0.0.1", multicast_r2h.port,
                f"/rtp/{MCAST_ADDR}:{mcast_port}?fec={fec_port}",
                read_bytes=4096,
                timeout=_MCAST_STREAM_TIMEOUT,
            )
            assert status == 200
            assert len(body) > 0
        finally:
            sender.stop()


# ---------------------------------------------------------------------------
# Multiple concurrent clients
# ---------------------------------------------------------------------------


class TestMultipleConcurrentClients:
    """Verify multiple clients can stream the same multicast simultaneously."""

    def test_two_clients_same_stream(self, multicast_r2h):
        mcast_port = find_free_udp_port()
        sender = MulticastSender(addr=MCAST_ADDR, port=mcast_port, pps=300)
        sender.start()
        try:
            url = f"/rtp/{MCAST_ADDR}:{mcast_port}"

            import concurrent.futures
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                f1 = pool.submit(stream_get, "127.0.0.1", multicast_r2h.port, url, 2048, _MCAST_STREAM_TIMEOUT)
                f2 = pool.submit(stream_get, "127.0.0.1", multicast_r2h.port, url, 2048, _MCAST_STREAM_TIMEOUT)
                s1, _, b1 = f1.result()
                s2, _, b2 = f2.result()

            assert s1 == 200
            assert s2 == 200
            assert len(b1) > 0
            assert len(b2) > 0
        finally:
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


# ---------------------------------------------------------------------------
# RTP reorder
# ---------------------------------------------------------------------------


def _extract_ts_markers(body: bytes) -> list[int]:
    """Extract 2-byte big-endian markers at offset 4 from each 188-byte TS packet."""
    markers = []
    for i in range(0, len(body) - 187, 188):
        if body[i] == 0x47:
            markers.append(struct.unpack("!H", body[i + 4 : i + 6])[0])
    return markers


def _assert_ts_aligned(body: bytes) -> None:
    """Assert every 188-byte boundary starts with TS sync byte 0x47."""
    # Trim trailing incomplete packet
    usable = (len(body) // 188) * 188
    assert usable >= 188, "Need at least one complete TS packet"
    for i in range(0, usable, 188):
        assert body[i] == 0x47, f"Bad TS sync at offset {i}: 0x{body[i]:02x}"


def _assert_markers_ordered(markers: list[int]) -> None:
    """Assert markers are monotonically non-decreasing (mod 65536)."""
    assert len(markers) > 0, "Expected at least one TS marker"
    for i in range(1, len(markers)):
        diff = (markers[i] - markers[i - 1]) & 0xFFFF
        # diff==0 means same RTP packet (7 TS per RTP share a marker)
        # diff < 0x8000 means forward progress
        assert diff == 0 or diff < 0x8000, (
            f"Out-of-order marker at TS#{i}: {markers[i - 1]} -> {markers[i]}"
        )


class TestRTPReorder:
    """Verify the RTP reorder buffer corrects out-of-order delivery."""

    def test_reorder_produces_valid_ts(self, multicast_r2h):
        """Out-of-order RTP input should still yield 188-byte-aligned TS."""
        mcast_port = find_free_udp_port()
        sender = MulticastSender(
            addr=MCAST_ADDR, port=mcast_port, pps=300,
            reorder_distance=4, unique_payloads=True,
        )
        sender.start()
        try:
            status, _, body = stream_get(
                "127.0.0.1", multicast_r2h.port,
                f"/rtp/{MCAST_ADDR}:{mcast_port}",
                read_bytes=8192,
                timeout=_MCAST_STREAM_TIMEOUT,
            )
            assert status == 200
            _assert_ts_aligned(body)
        finally:
            sender.stop()

    def test_reorder_preserves_sequence_order(self, multicast_r2h):
        """Markers embedded in TS payloads must arrive in RTP sequence order."""
        mcast_port = find_free_udp_port()
        sender = MulticastSender(
            addr=MCAST_ADDR, port=mcast_port, pps=300,
            reorder_distance=4, unique_payloads=True,
        )
        sender.start()
        try:
            status, _, body = stream_get(
                "127.0.0.1", multicast_r2h.port,
                f"/rtp/{MCAST_ADDR}:{mcast_port}",
                read_bytes=16384,
                timeout=_MCAST_STREAM_TIMEOUT,
            )
            assert status == 200
            markers = _extract_ts_markers(body)
            _assert_markers_ordered(markers)
        finally:
            sender.stop()

    def test_reorder_distance_8(self, multicast_r2h):
        """Reorder distance matching the init-collect window (8 packets)."""
        mcast_port = find_free_udp_port()
        sender = MulticastSender(
            addr=MCAST_ADDR, port=mcast_port, pps=300,
            reorder_distance=8, unique_payloads=True,
        )
        sender.start()
        try:
            status, _, body = stream_get(
                "127.0.0.1", multicast_r2h.port,
                f"/rtp/{MCAST_ADDR}:{mcast_port}",
                read_bytes=16384,
                timeout=_MCAST_STREAM_TIMEOUT,
            )
            assert status == 200
            _assert_ts_aligned(body)
            markers = _extract_ts_markers(body)
            _assert_markers_ordered(markers)
        finally:
            sender.stop()

    def test_reorder_distance_16(self, multicast_r2h):
        """Larger reorder distance (16) still within the 32-slot window."""
        mcast_port = find_free_udp_port()
        sender = MulticastSender(
            addr=MCAST_ADDR, port=mcast_port, pps=300,
            reorder_distance=16, unique_payloads=True,
        )
        sender.start()
        try:
            status, _, body = stream_get(
                "127.0.0.1", multicast_r2h.port,
                f"/rtp/{MCAST_ADDR}:{mcast_port}",
                read_bytes=16384,
                timeout=_MCAST_STREAM_TIMEOUT,
            )
            assert status == 200
            _assert_ts_aligned(body)
            markers = _extract_ts_markers(body)
            _assert_markers_ordered(markers)
        finally:
            sender.stop()

    def test_duplicate_packets_handled(self, multicast_r2h):
        """Duplicate RTP packets should be silently dropped without corruption."""
        mcast_port = find_free_udp_port()
        sender = MulticastSender(
            addr=MCAST_ADDR, port=mcast_port, pps=300,
            send_duplicates=True, unique_payloads=True,
        )
        sender.start()
        try:
            status, _, body = stream_get(
                "127.0.0.1", multicast_r2h.port,
                f"/rtp/{MCAST_ADDR}:{mcast_port}",
                read_bytes=8192,
                timeout=_MCAST_STREAM_TIMEOUT,
            )
            assert status == 200
            _assert_ts_aligned(body)
            markers = _extract_ts_markers(body)
            _assert_markers_ordered(markers)
        finally:
            sender.stop()
