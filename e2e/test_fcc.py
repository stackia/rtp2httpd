"""
E2E tests for FCC (Fast Channel Change) functionality.

Tests both Telecom and Huawei FCC protocols by mocking an FCC server
that accepts requests and streams unicast RTP data before transitioning
to multicast.
"""

import time

import pytest

from helpers import (
    LOOPBACK_IF,
    MCAST_ADDR,
    MockFCCServer,
    MulticastSender,
    R2HProcess,
    find_free_port,
    find_free_udp_port,
    find_free_udp_port_pair,
    stream_get,
)

pytestmark = [pytest.mark.fcc, pytest.mark.multicast]

_FCC_STREAM_TIMEOUT = 10.0


@pytest.fixture(scope="module")
def shared_r2h(r2h_binary):
    """A single rtp2httpd instance shared by all FCC tests."""
    port = find_free_port()
    r2h = R2HProcess(
        r2h_binary,
        port,
        extra_args=["-v", "4", "-m", "100", "-r", LOOPBACK_IF],
    )
    r2h.start()
    yield r2h
    r2h.stop()


# ---------------------------------------------------------------------------
# Telecom FCC protocol
# ---------------------------------------------------------------------------


class TestTelecomFCC:
    """Tests for Telecom/ZTE/Fiberhome FCC protocol (default)."""

    def test_fcc_unicast_stream(self, shared_r2h):
        """FCC server sends unicast data; HTTP client receives TS payload."""
        mcast_port = find_free_udp_port()
        fcc = MockFCCServer(
            mcast_addr=MCAST_ADDR,
            protocol="telecom",
            unicast_pps=300,
            sync_after=0,
        )
        fcc.start()
        try:
            status, _, body = stream_get(
                "127.0.0.1",
                shared_r2h.port,
                f"/rtp/{MCAST_ADDR}:{mcast_port}?fcc=127.0.0.1:{fcc.port}",
                read_bytes=4096,
                timeout=_FCC_STREAM_TIMEOUT,
            )
            assert status == 200
            assert len(body) > 0, "Expected to receive unicast stream data"
            assert body[0] == 0x47, f"Expected TS sync byte 0x47, got 0x{body[0]:02x}"
            assert fcc.requests_received >= 1
        finally:
            fcc.stop()

    def test_fcc_single_socket_keeps_media_when_signal_port_changes(self, shared_r2h):
        """Telecom single socket should not filter RTP by the control port."""
        mcast_port = find_free_udp_port()
        fcc = MockFCCServer(
            mcast_addr=MCAST_ADDR,
            protocol="telecom",
            unicast_pps=300,
            sync_after=0,
            telecom_signal_port=find_free_udp_port(),
            telecom_fcc_ip="127.0.0.1",
        )
        fcc.start()
        try:
            status, _, body = stream_get(
                "127.0.0.1",
                shared_r2h.port,
                f"/rtp/{MCAST_ADDR}:{mcast_port}?fcc=127.0.0.1:{fcc.port}",
                read_bytes=4096,
                timeout=_FCC_STREAM_TIMEOUT,
            )
            assert status == 200
            assert len(body) > 0, "Expected to receive unicast stream data"
            assert body[0] == 0x47, f"Expected TS sync byte 0x47, got 0x{body[0]:02x}"
            assert fcc.requests_received >= 1
        finally:
            fcc.stop()

    def test_fcc_redirect_to_unicast_stream(self, shared_r2h):
        """Telecom duplicate redirect responses should not consume redirect budget."""
        mcast_port = find_free_udp_port()
        target = MockFCCServer(
            mcast_addr=MCAST_ADDR,
            protocol="telecom",
            unicast_pps=300,
            sync_after=0,
        )
        redirect = MockFCCServer(
            mcast_addr=MCAST_ADDR,
            protocol="telecom",
            redirect_to=("127.0.0.1", target.port),
        )
        target.start()
        redirect.start()
        try:
            status, _, body = stream_get(
                "127.0.0.1",
                shared_r2h.port,
                f"/rtp/{MCAST_ADDR}:{mcast_port}?fcc=127.0.0.1:{redirect.port}",
                read_bytes=4096,
                timeout=_FCC_STREAM_TIMEOUT,
            )
            assert status == 200
            assert len(body) > 0, "Expected to receive redirected unicast stream data"
            assert body[0] == 0x47, f"Expected TS sync byte 0x47, got 0x{body[0]:02x}"
            assert redirect.requests_received >= 1
            assert target.requests_received >= 1
        finally:
            redirect.stop()
            target.stop()

    def test_fcc_with_multicast_transition(self, shared_r2h):
        """FCC unicast followed by sync notification triggers multicast join."""
        mcast_port = find_free_udp_port()
        sender = MulticastSender(addr=MCAST_ADDR, port=mcast_port, pps=200)
        sender.start()

        fcc = MockFCCServer(
            mcast_addr=MCAST_ADDR,
            protocol="telecom",
            unicast_pps=300,
            sync_after=50,
        )
        fcc.start()
        try:
            status, _, body = stream_get(
                "127.0.0.1",
                shared_r2h.port,
                f"/rtp/{MCAST_ADDR}:{mcast_port}?fcc=127.0.0.1:{fcc.port}",
                read_bytes=8192,
                timeout=_FCC_STREAM_TIMEOUT,
            )
            assert status == 200
            assert len(body) > 0
            assert fcc.requests_received >= 1
        finally:
            fcc.stop()
            sender.stop()

    def test_fcc_server_receives_termination(self, shared_r2h):
        """After sync and multicast join, rtp2httpd sends termination to FCC server."""
        mcast_port = find_free_udp_port()
        sender = MulticastSender(addr=MCAST_ADDR, port=mcast_port, pps=200)
        sender.start()

        fcc = MockFCCServer(
            mcast_addr=MCAST_ADDR,
            protocol="telecom",
            unicast_pps=300,
            sync_after=30,
        )
        fcc.start()
        try:
            status, _, body = stream_get(
                "127.0.0.1",
                shared_r2h.port,
                f"/rtp/{MCAST_ADDR}:{mcast_port}?fcc=127.0.0.1:{fcc.port}",
                read_bytes=16384,
                timeout=_FCC_STREAM_TIMEOUT,
            )
            assert status == 200
            assert len(body) > 0
            # Allow time for the termination packet to arrive
            time.sleep(0.3)
        finally:
            fcc.stop()
            sender.stop()

        assert fcc.terminations_received >= 1, "Expected at least one FCC termination packet"


# ---------------------------------------------------------------------------
# Huawei FCC protocol
# ---------------------------------------------------------------------------


class TestHuaweiFCC:
    """Tests for Huawei FCC protocol."""

    def test_huawei_fcc_unicast_stream(self, shared_r2h):
        """Huawei FCC server sends unicast data; HTTP client receives TS payload."""
        mcast_port = find_free_udp_port()
        fcc = MockFCCServer(
            mcast_addr=MCAST_ADDR,
            protocol="huawei",
            unicast_pps=300,
            sync_after=0,
        )
        fcc.start()
        try:
            url = f"/rtp/{MCAST_ADDR}:{mcast_port}?fcc=127.0.0.1:{fcc.port}&fcc-type=huawei"
            status, _, body = stream_get(
                "127.0.0.1",
                shared_r2h.port,
                url,
                read_bytes=4096,
                timeout=_FCC_STREAM_TIMEOUT,
            )
            assert status == 200
            assert len(body) > 0, "Expected to receive unicast stream data"
            assert body[0] == 0x47, f"Expected TS sync byte 0x47, got 0x{body[0]:02x}"
            assert fcc.requests_received >= 1
        finally:
            fcc.stop()

    def test_huawei_fcc_short_response_unicast_stream(self, shared_r2h):
        """Huawei short non-NAT response sends RTP to the media socket."""
        mcast_port = find_free_udp_port()
        fcc = MockFCCServer(
            mcast_addr=MCAST_ADDR,
            protocol="huawei",
            unicast_pps=300,
            sync_after=0,
            huawei_response_format="short",
            first_unicast_seq=0xD3AD,
        )
        fcc.start()
        try:
            url = f"/rtp/{MCAST_ADDR}:{mcast_port}?fcc=127.0.0.1:{fcc.port}&fcc-type=huawei"
            status, _, body = stream_get(
                "127.0.0.1",
                shared_r2h.port,
                url,
                read_bytes=4096,
                timeout=_FCC_STREAM_TIMEOUT,
            )
            assert status == 200
            assert len(body) > 0, "Expected to receive Huawei short-response unicast data"
            assert body[0] == 0x47, f"Expected TS sync byte 0x47, got 0x{body[0]:02x}"
            assert fcc.requests_received >= 1
        finally:
            fcc.stop()

    def test_huawei_fcc_socket_pair_stays_inside_listen_range(self, r2h_binary):
        """Huawei double sockets use N/N+1 within fcc-listen-port-range."""
        mcast_port = find_free_udp_port()
        media_port, signal_port = find_free_udp_port_pair()
        r2h_port = find_free_port()
        r2h = R2HProcess(
            r2h_binary,
            r2h_port,
            extra_args=[
                "-v",
                "4",
                "-m",
                "100",
                "-r",
                LOOPBACK_IF,
                "-P",
                f"{media_port}-{signal_port}",
            ],
        )
        fcc = MockFCCServer(
            mcast_addr=MCAST_ADDR,
            protocol="huawei",
            unicast_pps=300,
            sync_after=0,
            huawei_response_format="short",
        )
        r2h.start()
        fcc.start()
        try:
            url = f"/rtp/{MCAST_ADDR}:{mcast_port}?fcc=127.0.0.1:{fcc.port}&fcc-type=huawei"
            status, _, body = stream_get(
                "127.0.0.1",
                r2h.port,
                url,
                read_bytes=4096,
                timeout=_FCC_STREAM_TIMEOUT,
            )
            assert status == 200
            assert len(body) > 0, "Expected to receive Huawei range-bound unicast data"
            assert body[0] == 0x47, f"Expected TS sync byte 0x47, got 0x{body[0]:02x}"
            assert fcc.request_client_addrs
            assert fcc.request_client_addrs[0][1] == signal_port
        finally:
            fcc.stop()
            r2h.stop()

    def test_huawei_fcc_redirect_to_short_response(self, shared_r2h):
        """Huawei redirect followed by short non-NAT response should receive unicast."""
        mcast_port = find_free_udp_port()
        target = MockFCCServer(
            mcast_addr=MCAST_ADDR,
            protocol="huawei",
            unicast_pps=300,
            sync_after=0,
            huawei_response_format="short",
            first_unicast_seq=0x4319,
        )
        redirect = MockFCCServer(
            mcast_addr=MCAST_ADDR,
            protocol="huawei",
            redirect_to=("127.0.0.1", target.port),
        )
        target.start()
        redirect.start()
        try:
            url = f"/rtp/{MCAST_ADDR}:{mcast_port}?fcc=127.0.0.1:{redirect.port}&fcc-type=huawei"
            status, _, body = stream_get(
                "127.0.0.1",
                shared_r2h.port,
                url,
                read_bytes=4096,
                timeout=_FCC_STREAM_TIMEOUT,
            )
            assert status == 200
            assert len(body) > 0, "Expected redirected Huawei short-response unicast data"
            assert body[0] == 0x47, f"Expected TS sync byte 0x47, got 0x{body[0]:02x}"
            assert redirect.requests_received >= 1
            assert target.requests_received >= 1
        finally:
            redirect.stop()
            target.stop()

    def test_huawei_fcc_with_multicast_transition(self, shared_r2h):
        """Huawei FCC unicast followed by sync triggers multicast join."""
        mcast_port = find_free_udp_port()
        sender = MulticastSender(addr=MCAST_ADDR, port=mcast_port, pps=200)
        sender.start()

        fcc = MockFCCServer(
            mcast_addr=MCAST_ADDR,
            protocol="huawei",
            unicast_pps=300,
            sync_after=50,
        )
        fcc.start()
        try:
            url = f"/rtp/{MCAST_ADDR}:{mcast_port}?fcc=127.0.0.1:{fcc.port}&fcc-type=huawei"
            status, _, body = stream_get(
                "127.0.0.1",
                shared_r2h.port,
                url,
                read_bytes=8192,
                timeout=_FCC_STREAM_TIMEOUT,
            )
            assert status == 200
            assert len(body) > 0
            assert fcc.requests_received >= 1
        finally:
            fcc.stop()
            sender.stop()

    def test_huawei_fcc_server_receives_termination(self, shared_r2h):
        """Huawei FCC: rtp2httpd sends FMT 9 termination after sync."""
        mcast_port = find_free_udp_port()
        sender = MulticastSender(addr=MCAST_ADDR, port=mcast_port, pps=200)
        sender.start()

        fcc = MockFCCServer(
            mcast_addr=MCAST_ADDR,
            protocol="huawei",
            unicast_pps=300,
            sync_after=30,
        )
        fcc.start()
        try:
            url = f"/rtp/{MCAST_ADDR}:{mcast_port}?fcc=127.0.0.1:{fcc.port}&fcc-type=huawei"
            status, _, body = stream_get(
                "127.0.0.1",
                shared_r2h.port,
                url,
                read_bytes=16384,
                timeout=_FCC_STREAM_TIMEOUT,
            )
            assert status == 200
            assert len(body) > 0
            time.sleep(0.3)
        finally:
            fcc.stop()
            sender.stop()

        assert fcc.terminations_received >= 1, "Expected at least one Huawei FCC termination packet (FMT 9)"


# ---------------------------------------------------------------------------
# FCC error / fallback scenarios
# ---------------------------------------------------------------------------


class TestFCCFallback:
    """Tests for FCC error handling and multicast fallback."""

    def test_fcc_timeout_falls_back_to_multicast(self, shared_r2h):
        """If FCC server doesn't respond, rtp2httpd should fall back to multicast."""
        mcast_port = find_free_udp_port()
        sender = MulticastSender(addr=MCAST_ADDR, port=mcast_port, pps=200)
        sender.start()

        # Use a port where no FCC server is listening
        dead_fcc_port = find_free_udp_port()
        try:
            status, _, body = stream_get(
                "127.0.0.1",
                shared_r2h.port,
                f"/rtp/{MCAST_ADDR}:{mcast_port}?fcc=127.0.0.1:{dead_fcc_port}",
                read_bytes=4096,
                timeout=_FCC_STREAM_TIMEOUT,
            )
            assert status == 200
            assert len(body) > 0, "Expected multicast fallback to deliver data"
        finally:
            sender.stop()
