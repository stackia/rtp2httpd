"""End-to-end coverage for the always-on ZTE RTSP NAT traversal behaviour."""

import socket
import struct

import pytest

from helpers import (
    LOOPBACK_IF,
    MockRTSPServer,
    MockRTSPServerZTE,
    MockSTUNServer,
    R2HProcess,
    find_free_port,
    ipv6_loopback_available,
    stream_get,
)

pytestmark = pytest.mark.rtsp


def _request(server, method):
    return next(request for request in server.requests_detailed if request["method"] == method)


class TestZTEProtocol:
    def test_headers_endpoint_invariants_and_probe_bytes(self, r2h_binary):
        rtsp = MockRTSPServerZTE(num_packets=500)
        rtsp.start()
        r2h_port = find_free_port()
        r2h = R2HProcess(r2h_binary, r2h_port, extra_args=["-v", "4", "-m", "100"], capture_log=True)
        r2h.start()
        try:
            status, _, body = stream_get(
                "127.0.0.1",
                r2h_port,
                "/rtsp/127.0.0.1:%d/stream" % rtsp.port,
                read_bytes=4096,
                timeout=20.0,
            )
            assert status == 200
            assert len(body) >= 188
            assert rtsp.valid_probe_received

            assert rtsp.control_peer is not None
            tcp_source_ip, tcp_source_port = rtsp.control_peer[:2]
            expected_x_nat = "%s:%d" % (tcp_source_ip, tcp_source_port)
            describe = _request(rtsp, "DESCRIBE")
            setup = _request(rtsp, "SETUP")
            assert describe["headers"]["x-NAT"] == expected_x_nat
            assert setup["headers"]["x-NAT"] == expected_x_nat

            # The full candidate list is always offered so a UDP-incapable server
            # can fall back to TCP interleaved; the ZTE-specific
            # client_address/mode parameters ride on the UDP alternatives only.
            transport = setup["headers"]["Transport"]
            assert transport == ",".join(
                [
                    "MP2T/RTP/TCP;unicast;interleaved=0-1",
                    "MP2T/TCP;unicast;interleaved=0-1",
                    "RTP/AVP/TCP;unicast;interleaved=0-1",
                ]
                + [
                    "%s;unicast;client_address=%s;client_port=%d-%d;mode=PLAY"
                    % (profile, tcp_source_ip, rtsp._client_rtp_port, rtsp._client_rtp_port + 1)
                    for profile in ("MP2T/RTP/UDP", "MP2T/UDP", "RTP/AVP")
                ]
            )

            # Probes are sent three times per attempt (UDP has no delivery
            # guarantee); every one of them must be a well-formed punch packet.
            assert len(rtsp.udp_datagrams) >= 3
            for payload, udp_source in rtsp.udp_datagrams:
                assert len(payload) == 84
                assert payload[:8] == b"ZXV10STB"
                assert payload[8:12] == b"\x7f\xff\xff\xff"
                assert payload[12:16] == socket.inet_aton(tcp_source_ip)
                assert struct.unpack("!H", payload[16:18])[0] == rtsp._client_rtp_port
                assert struct.unpack("!H", payload[18:20])[0] == tcp_source_port
                assert payload[20:] == bytes(64)
                assert udp_source[0] == tcp_source_ip
                assert udp_source[1] == rtsp._client_rtp_port

            # TCP control requests and UDP probes are consumed by separate mock
            # threads, so their server-side observation order is inherently
            # racy. The probe target port is disclosed only by the SETUP
            # response, and MockRTSPServerZTE withholds media until this exact
            # packet validates, which covers the protocol dependency without a
            # cross-protocol scheduling assertion.
            assert "RTSP: Upstream interface route-selected, local endpoint %s:" % tcp_source_ip in r2h.read_log()
        finally:
            r2h.stop()
            rtsp.stop()

    @pytest.mark.parametrize("interface_source", ["global", "request"])
    def test_interface_selection_keeps_tcp_and_udp_source_aligned(self, r2h_binary, interface_source):
        rtsp = MockRTSPServerZTE(num_packets=200)
        rtsp.start()
        r2h_port = find_free_port()
        extra_args = []
        path = "/rtsp/127.0.0.1:%d/stream" % rtsp.port
        if interface_source == "global":
            extra_args.extend(["--upstream-interface-rtsp", LOOPBACK_IF])
        else:
            path += "?r2h-ifname=%s" % LOOPBACK_IF
        r2h = R2HProcess(r2h_binary, r2h_port, extra_args=extra_args)
        r2h.start()
        try:
            status, _, body = stream_get("127.0.0.1", r2h_port, path, read_bytes=188, timeout=20.0)
            assert status == 200
            assert body
            assert rtsp.valid_probe_received
            assert rtsp.control_peer is not None
            assert rtsp.udp_datagrams[0][1][0] == rtsp.control_peer[0]
        finally:
            r2h.stop()
            rtsp.stop()

    def test_tcp_only_server_falls_back_to_interleaved_without_probe(self, r2h_binary):
        """The server picks the transport; UDP is never forced."""
        rtsp = MockRTSPServer(num_packets=300)
        rtsp.start()
        r2h_port = find_free_port()
        r2h = R2HProcess(r2h_binary, r2h_port, extra_args=["-v", "4"], capture_log=True)
        r2h.start()
        try:
            status, _, body = stream_get(
                "127.0.0.1",
                r2h_port,
                "/rtsp/127.0.0.1:%d/stream" % rtsp.port,
                read_bytes=188,
                timeout=20.0,
            )
            assert status == 200
            assert body

            setup = _request(rtsp, "SETUP")
            transport = setup["headers"]["Transport"]
            # Both families are offered; x-NAT still rides along for ZTE servers
            assert "interleaved=0-1" in transport
            assert "MP2T/RTP/UDP;unicast;client_address=" in transport
            assert "x-NAT" in setup["headers"]

            log = r2h.read_log()
            assert "Using TCP interleaved transport" in log
            assert "NAT probe" not in log
        finally:
            r2h.stop()
            rtsp.stop()

    def test_ipv6_upstream_falls_back_to_ordinary_rtsp(self, r2h_binary):
        if not ipv6_loopback_available():
            pytest.skip("IPv6 loopback is unavailable")
        rtsp = MockRTSPServer(num_packets=300, host="::1")
        rtsp.start()
        r2h_port = find_free_port()
        r2h = R2HProcess(r2h_binary, r2h_port, extra_args=["-v", "4"], capture_log=True)
        r2h.start()
        try:
            status, _, body = stream_get(
                "127.0.0.1",
                r2h_port,
                "/rtsp/[::1]:%d/stream" % rtsp.port,
                read_bytes=188,
                timeout=20.0,
            )
            assert status == 200
            assert body
            assert "x-NAT" not in _request(rtsp, "DESCRIBE")["headers"]
            assert "client_address=" not in _request(rtsp, "SETUP")["headers"]["Transport"]
            assert "IPv6 control connection, skipping ZTE NAT traversal" in r2h.read_log()
        finally:
            r2h.stop()
            rtsp.stop()

    def test_redirect_recaptures_control_endpoint(self, r2h_binary):
        target = MockRTSPServerZTE(num_packets=300)
        target.start()
        redirect = MockRTSPServer(redirect_describe_to="rtsp://127.0.0.1:%d/stream" % target.port)
        redirect.start()
        r2h_port = find_free_port()
        r2h = R2HProcess(r2h_binary, r2h_port)
        r2h.start()
        try:
            status, _, body = stream_get(
                "127.0.0.1",
                r2h_port,
                "/rtsp/127.0.0.1:%d/stream" % redirect.port,
                read_bytes=188,
                timeout=20.0,
            )
            assert status == 200
            assert body
            assert target.valid_probe_received
            assert target.control_peer is not None
            expected_x_nat = "%s:%d" % target.control_peer[:2]
            assert _request(target, "DESCRIBE")["headers"]["x-NAT"] == expected_x_nat
        finally:
            r2h.stop()
            redirect.stop()
            target.stop()


class TestSTUNInteraction:
    def test_stun_mapping_is_advertised_in_x_nat_and_client_address(self, r2h_binary):
        """With STUN configured, the discovered public mapping wins everywhere."""
        mapped_ip = "203.0.113.7"
        mapped_port = 50006
        stun = MockSTUNServer(mapped_ip=mapped_ip, mapped_port=mapped_port)
        # The punch packet now carries the STUN mapping, and the UDP source port
        # is the real local port rather than the advertised one.
        rtsp = MockRTSPServerZTE(
            num_packets=300,
            expected_ip=mapped_ip,
            expected_control_port=mapped_port,
            check_source_port=False,
        )
        stun.start()
        rtsp.start()
        r2h_port = find_free_port()
        r2h = R2HProcess(
            r2h_binary,
            r2h_port,
            extra_args=["-v", "4", "--rtsp-stun-server", "127.0.0.1:%d" % stun.port],
            capture_log=True,
        )
        r2h.start()
        try:
            status, _, body = stream_get(
                "127.0.0.1",
                r2h_port,
                "/rtsp/127.0.0.1:%d/stream" % rtsp.port,
                read_bytes=188,
                timeout=20.0,
            )
            assert status == 200
            assert body
            assert stun.requests_received >= 1
            assert rtsp.valid_probe_received

            expected_x_nat = "%s:%d" % (mapped_ip, mapped_port)
            # DESCRIBE is held back until STUN settles, so it already carries
            # the public mapping rather than the private endpoint.
            assert _request(rtsp, "DESCRIBE")["headers"]["x-NAT"] == expected_x_nat
            setup = _request(rtsp, "SETUP")
            assert setup["headers"]["x-NAT"] == expected_x_nat
            transport = setup["headers"]["Transport"]
            assert "client_address=%s;client_port=%d-%d" % (mapped_ip, mapped_port, mapped_port + 1) in transport
        finally:
            r2h.stop()
            rtsp.stop()
            stun.stop()

    def test_silent_stun_falls_back_to_local_endpoint(self, r2h_binary):
        """A dead STUN server must not stall the handshake past its own budget."""
        stun = MockSTUNServer(silent=True)
        rtsp = MockRTSPServerZTE(num_packets=300)
        stun.start()
        rtsp.start()
        r2h_port = find_free_port()
        r2h = R2HProcess(
            r2h_binary,
            r2h_port,
            extra_args=["-v", "4", "--rtsp-stun-server", "127.0.0.1:%d" % stun.port],
            capture_log=True,
        )
        r2h.start()
        try:
            status, _, body = stream_get(
                "127.0.0.1",
                r2h_port,
                "/rtsp/127.0.0.1:%d/stream" % rtsp.port,
                read_bytes=188,
                timeout=30.0,
            )
            assert status == 200
            assert body
            assert rtsp.valid_probe_received
            assert rtsp.control_peer is not None
            assert _request(rtsp, "DESCRIBE")["headers"]["x-NAT"] == "%s:%d" % rtsp.control_peer[:2]

            log = r2h.read_log()
            # DESCRIBE really was parked, and STUN's ~3s retry budget did not
            # trip the 3s handshake timeout.
            assert "Waiting for STUN response before sending DESCRIBE" in log
            assert "STUN: Timeout after 3 attempts" in log
            # Parking must not pipeline DESCRIBE behind an unanswered OPTIONS.
            assert rtsp.requests_received[:4] == ["OPTIONS", "DESCRIBE", "SETUP", "PLAY"]
        finally:
            r2h.stop()
            rtsp.stop()
            stun.stop()
