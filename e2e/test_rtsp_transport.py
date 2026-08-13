"""
E2E tests for RTSP proxy streaming – TCP interleaved and UDP transport.

Tests verify basic connectivity, TS payload correctness, and the RTSP
handshake sequence for both transport modes.
"""

import pytest
from helpers import (
    MockRTSPServer,
    MockRTSPServerSilent,
    MockRTSPServerUDP,
    R2HProcess,
    find_free_port,
    get_header,
    http_request,
    raw_http_request,
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
                f"/rtsp/127.0.0.1:{rtsp.port}/stream",
                read_bytes=4096,
                timeout=_STREAM_TIMEOUT,
            )
            assert status == 200, "Expected 200 for TCP interleaved RTSP"
            assert len(body) > 0
        finally:
            rtsp.stop()

    def test_tcp_stream_metadata_headers(self, shared_r2h):
        sdp = (
            "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=T\r\n"
            "t=0 0\r\nm=video 0 RTP/AVP 33\r\n"
            "a=range:npt=10.25-40.5\r\na=control:*\r\n"
        )
        rtsp = MockRTSPServer(
            num_packets=500,
            custom_sdp=sdp,
            play_response_headers=[("sCaLe", "1.500000"), ("rAnGe", "npt=10.25-40.5")],
        )
        rtsp.start()
        try:
            status, headers, body = stream_get(
                "127.0.0.1",
                shared_r2h.port,
                f"/rtsp/127.0.0.1:{rtsp.port}/stream",
                read_bytes=4096,
                timeout=_STREAM_TIMEOUT,
            )
            assert status == 200
            assert body
            assert headers["r2h-upstream-protocol"] == "rtsp"
            assert headers["r2h-upstream-transport"] == "tcp-interleaved"
            assert headers["r2h-upstream-payload"] == "mp2t-rtp"
            assert headers["r2h-playback-scale"] == "1.5"
            assert headers["r2h-playback-range"] == "npt=10.25-40.5"
            assert headers["r2h-media-duration"] == "30.25"
            assert "r2h-metadata-version" not in headers
            assert not any(name.startswith("r2h-fec-") for name in headers)
            assert "session" not in headers
            assert "content-base" not in headers
        finally:
            rtsp.stop()

    def test_head_stops_after_describe(self, shared_r2h):
        sdp = (
            "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=T\r\n"
            "t=0 0\r\nm=video 0 RTP/AVP 33\r\n"
            "a=range:npt=2-12.125\r\na=control:*\r\n"
        )
        rtsp = MockRTSPServer(custom_sdp=sdp)
        rtsp.start()
        try:
            status, headers, body = http_request(
                "127.0.0.1",
                shared_r2h.port,
                "HEAD",
                f"/rtsp/127.0.0.1:{rtsp.port}/stream",
                timeout=10.0,
            )
            assert status == 200
            assert body == b""
            assert get_header(headers, "R2H-Upstream-Protocol") == "rtsp"
            assert get_header(headers, "R2H-Upstream-Payload") == "mp2t-rtp"
            assert get_header(headers, "R2H-Media-Duration") == "10.125"
            assert get_header(headers, "R2H-Upstream-Transport") == ""
            assert get_header(headers, "R2H-Playback-Scale") == ""
            assert get_header(headers, "R2H-Playback-Range") == ""
            assert rtsp.requests_received == ["OPTIONS", "DESCRIBE"]
        finally:
            rtsp.stop()

    def test_head_parses_clock_form_npt_duration(self, shared_r2h):
        sdp = (
            "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=T\r\n"
            "t=0 0\r\nm=video 0 RTP/AVP 33\r\n"
            "a=range:npt=00:00:10.25-01:30:40.75\r\na=control:*\r\n"
        )
        rtsp = MockRTSPServer(custom_sdp=sdp)
        rtsp.start()
        try:
            status, headers, body = http_request(
                "127.0.0.1",
                shared_r2h.port,
                "HEAD",
                f"/rtsp/127.0.0.1:{rtsp.port}/stream",
                timeout=10.0,
            )
            assert status == 200
            assert body == b""
            assert get_header(headers, "R2H-Media-Duration") == "5430.5"
            assert rtsp.requests_received == ["OPTIONS", "DESCRIBE"]
        finally:
            rtsp.stop()

    def test_head_metadata_takes_precedence_over_duration_query(self, shared_r2h):
        sdp = (
            "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=T\r\n"
            "t=0 0\r\nm=video 0 RTP/AVP 33\r\n"
            "a=range:npt=2-12.125\r\na=control:*\r\n"
        )
        rtsp = MockRTSPServer(custom_sdp=sdp)
        rtsp.start()
        try:
            status, headers, body = http_request(
                "127.0.0.1",
                shared_r2h.port,
                "HEAD",
                f"/rtsp/127.0.0.1:{rtsp.port}/stream?r2h-duration=1",
                timeout=10.0,
            )
            assert status == 200
            assert body == b""
            assert get_header(headers, "Content-Type") == "video/mp2t"
            assert get_header(headers, "R2H-Upstream-Protocol") == "rtsp"
            assert get_header(headers, "R2H-Upstream-Payload") == "mp2t-rtp"
            assert get_header(headers, "R2H-Media-Duration") == "10.125"
            assert rtsp.requests_received == ["OPTIONS", "DESCRIBE"]
        finally:
            rtsp.stop()

    def test_head_survives_upstream_close_after_describe(self, shared_r2h):
        rtsp = MockRTSPServer(close_after_describe=True)
        rtsp.start()
        try:
            status, headers, body = http_request(
                "127.0.0.1",
                shared_r2h.port,
                "HEAD",
                f"/rtsp/127.0.0.1:{rtsp.port}/stream",
                timeout=10.0,
            )
            assert status == 200
            assert body == b""
            assert get_header(headers, "R2H-Upstream-Protocol") == "rtsp"
            assert get_header(headers, "R2H-Upstream-Payload") == "mp2t-rtp"
            assert rtsp.requests_received == ["OPTIONS", "DESCRIBE"]
        finally:
            rtsp.stop()

    def test_head_survives_upstream_reset_after_describe(self, shared_r2h):
        rtsp = MockRTSPServer(reset_after_describe=True)
        rtsp.start()
        try:
            status, headers, body = http_request(
                "127.0.0.1",
                shared_r2h.port,
                "HEAD",
                f"/rtsp/127.0.0.1:{rtsp.port}/stream",
                timeout=10.0,
            )
            assert status == 200
            assert body == b""
            assert get_header(headers, "R2H-Upstream-Protocol") == "rtsp"
            assert get_header(headers, "R2H-Upstream-Payload") == "mp2t-rtp"
            assert rtsp.requests_received == ["OPTIONS", "DESCRIBE"]
        finally:
            rtsp.stop()

    def test_head_probe_timeout_returns_503(self, shared_r2h):
        rtsp = MockRTSPServerSilent()
        rtsp.start()
        try:
            # raw_http_request, not http_request: http.client discards a HEAD
            # body, which would hide a spec violation here.
            status, _, body = raw_http_request(
                "127.0.0.1",
                shared_r2h.port,
                "HEAD",
                f"/rtsp/127.0.0.1:{rtsp.port}/stream",
                timeout=8.0,
            )
            assert status == 503
            assert body == b"", "a HEAD response must not carry content"
        finally:
            rtsp.stop()

    def test_head_unreachable_upstream_sends_no_body(self, shared_r2h):
        dead_port = find_free_port()
        status, _, body = raw_http_request(
            "127.0.0.1",
            shared_r2h.port,
            "HEAD",
            f"/rtsp/127.0.0.1:{dead_port}/stream",
            timeout=8.0,
        )
        assert status == 503
        assert body == b"", "a HEAD response must not carry content"

    def test_get_error_still_sends_body(self, shared_r2h):
        """The HEAD carve-out must not strip bodies from ordinary GET errors."""
        dead_port = find_free_port()
        status, _, body = raw_http_request(
            "127.0.0.1",
            shared_r2h.port,
            "GET",
            f"/rtsp/127.0.0.1:{dead_port}/stream",
            timeout=8.0,
        )
        assert status == 503
        assert b"503" in body

    def test_head_omits_unrepresentable_duration(self, shared_r2h):
        """A duration we cannot render exactly is dropped, never approximated."""
        sdp = (
            "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=T\r\n"
            "t=0 0\r\nm=video 0 RTP/AVP 33\r\n"
            "a=range:npt=0-1e300\r\na=control:*\r\n"
        )
        rtsp = MockRTSPServer(custom_sdp=sdp)
        rtsp.start()
        try:
            status, headers, _ = http_request(
                "127.0.0.1",
                shared_r2h.port,
                "HEAD",
                f"/rtsp/127.0.0.1:{rtsp.port}/stream",
                timeout=10.0,
            )
            assert status == 200
            assert get_header(headers, "R2H-Upstream-Protocol") == "rtsp"
            assert get_header(headers, "R2H-Media-Duration") == ""
        finally:
            rtsp.stop()

    def test_head_omits_open_ended_npt_range(self, shared_r2h):
        """Live streams advertise `npt=now-`, which has no finite duration."""
        sdp = (
            "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=T\r\n"
            "t=0 0\r\nm=video 0 RTP/AVP 33\r\n"
            "a=range:npt=now-\r\na=control:*\r\n"
        )
        rtsp = MockRTSPServer(custom_sdp=sdp)
        rtsp.start()
        try:
            status, headers, _ = http_request(
                "127.0.0.1",
                shared_r2h.port,
                "HEAD",
                f"/rtsp/127.0.0.1:{rtsp.port}/stream",
                timeout=10.0,
            )
            assert status == 200
            assert get_header(headers, "R2H-Media-Duration") == ""
        finally:
            rtsp.stop()

    def test_head_after_auth_challenge_reports_retry_metadata(self, shared_r2h):
        """A 401 clears the DESCRIBE stage; the retry must refill it."""
        sdp = (
            "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=T\r\n"
            "t=0 0\r\nm=video 0 RTP/AVP 33\r\n"
            "a=range:npt=0-42.5\r\na=control:*\r\n"
        )
        rtsp = MockRTSPServer(custom_sdp=sdp, challenge_describe_once=True)
        rtsp.start()
        try:
            status, headers, body = http_request(
                "127.0.0.1",
                shared_r2h.port,
                "HEAD",
                f"/rtsp/user:pass@127.0.0.1:{rtsp.port}/stream",
                timeout=10.0,
            )
            assert status == 200
            assert body == b""
            assert get_header(headers, "R2H-Upstream-Payload") == "mp2t-rtp"
            assert get_header(headers, "R2H-Media-Duration") == "42.5"
            assert rtsp.requests_received == ["OPTIONS", "DESCRIBE", "DESCRIBE"]
        finally:
            rtsp.stop()

    def test_head_redirect_reports_only_final_server_metadata(self, shared_r2h):
        """Metadata learned before a redirect must not leak into the response."""
        target_sdp = (
            "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=T\r\n"
            "t=0 0\r\nm=video 0 MP2T/AVP 33\r\n"
            "a=range:npt=0-7.5\r\na=control:*\r\n"
        )
        target = MockRTSPServer(custom_sdp=target_sdp)
        target.start()
        # The first server advertises RTP-encapsulated TS and a 900s range;
        # neither may survive the 302 to a server that advertises neither.
        source_sdp = (
            "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=T\r\n"
            "t=0 0\r\nm=video 0 RTP/AVP 33\r\n"
            "a=range:npt=0-900\r\na=control:*\r\n"
        )
        redirect = MockRTSPServer(
            custom_sdp=source_sdp,
            redirect_describe_to=f"rtsp://127.0.0.1:{target.port}/stream",
        )
        redirect.start()
        try:
            status, headers, body = http_request(
                "127.0.0.1",
                shared_r2h.port,
                "HEAD",
                f"/rtsp/127.0.0.1:{redirect.port}/stream",
                timeout=10.0,
            )
            assert status == 200
            assert body == b""
            assert get_header(headers, "R2H-Upstream-Protocol") == "rtsp"
            assert get_header(headers, "R2H-Media-Duration") == "7.5"
            # MP2T/AVP is not RTP-encapsulated, and a HEAD sees no media, so the
            # payload must be absent rather than the pre-redirect mp2t-rtp.
            assert get_header(headers, "R2H-Upstream-Payload") == ""
            assert target.requests_received == ["OPTIONS", "DESCRIBE"]
        finally:
            redirect.stop()
            target.stop()

    def test_stream_ignores_invalid_play_metadata(self, shared_r2h):
        """Unparsable Scale / control-character Range are dropped, not echoed."""
        rtsp = MockRTSPServer(
            num_packets=500,
            play_response_headers=[("Scale", "fast"), ("Range", "npt=0-\x0130")],
        )
        rtsp.start()
        try:
            status, headers, body = stream_get(
                "127.0.0.1",
                shared_r2h.port,
                f"/rtsp/127.0.0.1:{rtsp.port}/stream",
                read_bytes=4096,
                timeout=_STREAM_TIMEOUT,
            )
            assert status == 200
            assert body
            assert headers["r2h-upstream-transport"] == "tcp-interleaved"
            assert "r2h-playback-scale" not in headers
            assert "r2h-playback-range" not in headers
        finally:
            rtsp.stop()

    def test_stream_reports_direct_ts_payload(self, shared_r2h):
        """An MP2T/TCP upstream sends bare TS in the interleaved frames."""
        sdp = "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=T\r\nt=0 0\r\nm=video 0 MP2T/AVP 33\r\na=control:*\r\n"
        rtsp = MockRTSPServer(
            num_packets=500,
            custom_sdp=sdp,
            encapsulate_rtp=False,
            setup_transport="MP2T/TCP;unicast;interleaved=0-1",
        )
        rtsp.start()
        try:
            status, headers, body = stream_get(
                "127.0.0.1",
                shared_r2h.port,
                f"/rtsp/127.0.0.1:{rtsp.port}/stream",
                read_bytes=4096,
                timeout=_STREAM_TIMEOUT,
            )
            assert status == 200
            assert body
            assert body[0] == 0x47, "expected raw MPEG-TS to be relayed unchanged"
            assert headers["r2h-upstream-protocol"] == "rtsp"
            assert headers["r2h-upstream-transport"] == "tcp-interleaved"
            assert headers["r2h-upstream-payload"] == "mp2t-direct"
            assert "access-control-expose-headers" not in headers
        finally:
            rtsp.stop()

    def test_stream_sdp_alone_does_not_decide_payload(self, shared_r2h):
        """A non-RTP SDP must not veto mp2t-rtp when the media is RTP after all."""
        sdp = "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=T\r\nt=0 0\r\nm=video 0 MP2T/AVP 33\r\na=control:*\r\n"
        rtsp = MockRTSPServer(num_packets=500, custom_sdp=sdp)
        rtsp.start()
        try:
            status, headers, body = stream_get(
                "127.0.0.1",
                shared_r2h.port,
                f"/rtsp/127.0.0.1:{rtsp.port}/stream",
                read_bytes=4096,
                timeout=_STREAM_TIMEOUT,
            )
            assert status == 200
            assert body
            assert headers["r2h-upstream-payload"] == "mp2t-rtp"
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
                f"/rtsp/127.0.0.1:{rtsp.port}/stream",
                read_bytes=4096,
                timeout=_STREAM_TIMEOUT,
            )
            assert status == 200
            assert len(body) >= 188
            assert body[0] == 0x47, f"Expected TS sync byte 0x47, got 0x{body[0]:02x}"
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
                f"/rtsp/127.0.0.1:{rtsp.port}/test",
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

    def test_requests_echo_options_session(self, shared_r2h):
        """HMS-style servers return Session in OPTIONS; all subsequent
        requests (DESCRIBE, SETUP, PLAY) must echo it."""
        session_id = "2728486233"
        rtsp = MockRTSPServer(num_packets=200, options_session_id=session_id)
        rtsp.start()
        try:
            status, _, body = stream_get(
                "127.0.0.1",
                shared_r2h.port,
                f"/rtsp/127.0.0.1:{rtsp.port}/stream",
                read_bytes=4096,
                timeout=_STREAM_TIMEOUT,
            )
            assert status == 200, "Expected stream to succeed when requests carry Session"
            assert len(body) > 0

            assert rtsp.requests_received.index("OPTIONS") < rtsp.requests_received.index("DESCRIBE")
            for method in ("DESCRIBE", "SETUP", "PLAY"):
                req = next(r for r in rtsp.requests_detailed if r["method"] == method)
                assert req["headers"].get("Session") == session_id, f"{method} must echo the OPTIONS Session"
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
            status, headers, body = stream_get(
                "127.0.0.1",
                shared_r2h.port,
                f"/rtsp/127.0.0.1:{rtsp.port}/stream",
                read_bytes=4096,
                timeout=_STREAM_TIMEOUT,
            )
            assert status == 200, "Expected 200 for UDP RTSP"
            assert len(body) > 0
            assert headers["r2h-upstream-protocol"] == "rtsp"
            assert headers["r2h-upstream-transport"] == "udp"
            assert headers["r2h-upstream-payload"] == "mp2t-rtp"
        finally:
            rtsp.stop()

    def test_udp_data_is_ts(self, shared_r2h):
        rtsp = MockRTSPServerUDP()
        rtsp.start()
        try:
            status, _, body = stream_get(
                "127.0.0.1",
                shared_r2h.port,
                f"/rtsp/127.0.0.1:{rtsp.port}/stream",
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
                f"/rtsp/127.0.0.1:{rtsp.port}/test",
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
