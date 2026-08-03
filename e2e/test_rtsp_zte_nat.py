"""End-to-end coverage for the ZTE RTSP NAT traversal mode."""

import os
import signal
import socket
import struct
import time

import pytest

from helpers import (
    LOOPBACK_IF,
    MockRTSPServer,
    MockRTSPServerZTE,
    MockSTUNServer,
    R2HProcess,
    build_config,
    find_free_port,
    ipv6_loopback_available,
    stream_get,
)

pytestmark = pytest.mark.rtsp


def _request(server, method):
    return next(request for request in server.requests_detailed if request["method"] == method)


class TestZTEProtocol:
    def test_zte_headers_endpoint_invariants_and_probe_bytes(self, r2h_binary):
        stun = MockSTUNServer()
        rtsp = MockRTSPServerZTE(num_packets=500)
        stun.start()
        rtsp.start()
        r2h_port = find_free_port()
        r2h = R2HProcess(
            r2h_binary,
            r2h_port,
            extra_args=[
                "-v",
                "4",
                "-m",
                "100",
                "--rtsp-nat-mode",
                "zte",
                "--rtsp-stun-server",
                "127.0.0.1:%d" % stun.port,
            ],
            capture_log=True,
        )
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
            assert stun.requests_received == 0

            assert rtsp.control_peer is not None
            tcp_source_ip, tcp_source_port = rtsp.control_peer[:2]
            expected_x_nat = "%s:%d" % (tcp_source_ip, tcp_source_port)
            describe = _request(rtsp, "DESCRIBE")
            setup = _request(rtsp, "SETUP")
            assert describe["headers"]["x-NAT"] == expected_x_nat
            assert setup["headers"]["x-NAT"] == expected_x_nat

            transport = setup["headers"]["Transport"]
            assert transport == (
                "MP2T/RTP/UDP;unicast;client_address=%s;client_port=%d-%d;mode=PLAY"
                % (tcp_source_ip, rtsp._client_rtp_port, rtsp._client_rtp_port + 1)
            )

            assert len(rtsp.udp_datagrams) == 1
            payload, udp_source = rtsp.udp_datagrams[0]
            assert len(payload) == 84
            assert payload[:8] == b"ZXV10STB"
            assert payload[8:12] == b"\x7f\xff\xff\xff"
            assert payload[12:16] == socket.inet_aton(tcp_source_ip)
            assert struct.unpack("!H", payload[16:18])[0] == rtsp._client_rtp_port
            assert struct.unpack("!H", payload[18:20])[0] == tcp_source_port
            assert payload[20:] == bytes(64)
            assert udp_source[0] == tcp_source_ip
            assert udp_source[1] == rtsp._client_rtp_port
            assert rtsp.events.index("setup_response_sent") < rtsp.events.index("zte_probe_received")
            assert rtsp.events.index("zte_probe_received") < rtsp.events.index("play_received")

            log = r2h.read_log()
            assert "RTSP STUN server ignored because rtsp-nat-mode=zte" in log
            assert "RTSP: Upstream interface route-selected, local endpoint %s:" % tcp_source_ip in log
        finally:
            r2h.stop()
            rtsp.stop()
            stun.stop()

    @pytest.mark.parametrize("interface_source", ["global", "request"])
    def test_interface_selection_keeps_tcp_and_udp_source_aligned(self, r2h_binary, interface_source):
        rtsp = MockRTSPServerZTE(num_packets=200)
        rtsp.start()
        r2h_port = find_free_port()
        extra_args = ["--rtsp-nat-mode", "zte"]
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

    def test_ipv6_upstream_falls_back_to_ordinary_rtsp(self, r2h_binary):
        if not ipv6_loopback_available():
            pytest.skip("IPv6 loopback is unavailable")
        rtsp = MockRTSPServer(num_packets=300, host="::1")
        rtsp.start()
        r2h_port = find_free_port()
        r2h = R2HProcess(
            r2h_binary,
            r2h_port,
            extra_args=["-v", "4", "--rtsp-nat-mode", "zte"],
            capture_log=True,
        )
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
            assert "ZTE NAT traversal only supports IPv4" in r2h.read_log()
        finally:
            r2h.stop()
            rtsp.stop()

    def test_redirect_recaptures_control_endpoint(self, r2h_binary):
        target = MockRTSPServerZTE(num_packets=300)
        target.start()
        redirect = MockRTSPServer(redirect_describe_to="rtsp://127.0.0.1:%d/stream" % target.port)
        redirect.start()
        r2h_port = find_free_port()
        r2h = R2HProcess(r2h_binary, r2h_port, extra_args=["--rtsp-nat-mode", "zte"])
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


class TestNATModeCompatibility:
    def test_config_file_enables_zte(self, r2h_binary):
        rtsp = MockRTSPServerZTE(num_packets=200)
        rtsp.start()
        r2h_port = find_free_port()
        r2h = R2HProcess(
            r2h_binary,
            r2h_port,
            config_content=build_config(r2h_port, global_lines=["rtsp-nat-mode = zte"]),
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
            assert rtsp.valid_probe_received
        finally:
            r2h.stop()
            rtsp.stop()

    def test_explicit_none_disables_legacy_stun_inference(self, r2h_binary):
        stun = MockSTUNServer()
        rtsp = MockRTSPServer(num_packets=500)
        stun.start()
        rtsp.start()
        r2h_port = find_free_port()
        r2h = R2HProcess(
            r2h_binary,
            r2h_port,
            extra_args=[
                "--rtsp-nat-mode",
                "none",
                "--rtsp-stun-server",
                "127.0.0.1:%d" % stun.port,
            ],
        )
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
            assert body
            time.sleep(0.1)
            assert stun.requests_received == 0
            assert "x-NAT" not in _request(rtsp, "DESCRIBE")["headers"]
        finally:
            r2h.stop()
            rtsp.stop()
            stun.stop()

    def test_explicit_stun_requires_server(self, r2h_binary):
        r2h = R2HProcess(
            r2h_binary,
            find_free_port(),
            extra_args=["--rtsp-nat-mode", "stun"],
            capture_log=True,
        )
        r2h.start(wait=False)
        try:
            assert r2h.process is not None
            assert r2h.process.wait(timeout=5) != 0
            assert "rtsp-nat-mode=stun requires rtsp-stun-server" in r2h.read_log()
        finally:
            r2h.stop()

    def test_cli_mode_override_survives_reload(self, r2h_binary):
        rtsp = MockRTSPServer(num_packets=300)
        rtsp.start()
        r2h_port = find_free_port()
        r2h = R2HProcess(
            r2h_binary,
            r2h_port,
            config_content=build_config(r2h_port, global_lines=["rtsp-nat-mode = zte"]),
            extra_args=["--rtsp-nat-mode", "none"],
            capture_log=True,
        )
        r2h.start()
        try:
            path = "/rtsp/127.0.0.1:%d/stream" % rtsp.port
            status, _, body = stream_get("127.0.0.1", r2h_port, path, read_bytes=188, timeout=20.0)
            assert status == 200
            assert body

            assert r2h.process is not None
            os.kill(r2h.process.pid, signal.SIGHUP)
            deadline = time.time() + 5.0
            while "Configuration reloaded successfully" not in r2h.read_log() and time.time() < deadline:
                time.sleep(0.05)

            status, _, body = stream_get("127.0.0.1", r2h_port, path, read_bytes=188, timeout=20.0)
            assert status == 200
            assert body
            describe_requests = [request for request in rtsp.requests_detailed if request["method"] == "DESCRIBE"]
            assert len(describe_requests) >= 2
            assert all("x-NAT" not in request["headers"] for request in describe_requests)
        finally:
            r2h.stop()
            rtsp.stop()
