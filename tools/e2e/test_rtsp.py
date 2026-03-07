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
    http_get,
    http_request,
    stream_get,
)

pytestmark = pytest.mark.rtsp

_STREAM_TIMEOUT = 20.0


# ---------------------------------------------------------------------------
# Module-scoped shared rtp2httpd instance
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def shared_r2h(r2h_binary):
    """A single rtp2httpd instance shared by all RTSP tests."""
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
                "127.0.0.1", shared_r2h.port,
                "/rtsp/127.0.0.1:%d/stream" % rtsp.port,
                read_bytes=4096, timeout=_STREAM_TIMEOUT,
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
                "127.0.0.1", shared_r2h.port,
                "/rtsp/127.0.0.1:%d/stream" % rtsp.port,
                read_bytes=4096, timeout=_STREAM_TIMEOUT,
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
                "127.0.0.1", shared_r2h.port,
                "/rtsp/127.0.0.1:%d/test" % rtsp.port,
                read_bytes=2048, timeout=_STREAM_TIMEOUT,
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
                "127.0.0.1", shared_r2h.port,
                "/rtsp/127.0.0.1:%d/stream" % rtsp.port,
                read_bytes=4096, timeout=_STREAM_TIMEOUT,
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
                "127.0.0.1", shared_r2h.port,
                "/rtsp/127.0.0.1:%d/stream" % rtsp.port,
                read_bytes=4096, timeout=_STREAM_TIMEOUT,
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
                "127.0.0.1", shared_r2h.port,
                "/rtsp/127.0.0.1:%d/test" % rtsp.port,
                read_bytes=2048, timeout=_STREAM_TIMEOUT,
            )
            methods = rtsp.requests_received
            assert "OPTIONS" in methods
            assert "DESCRIBE" in methods
            assert "SETUP" in methods
            assert "PLAY" in methods
        finally:
            rtsp.stop()


# ===================================================================
# Playseek / timeshift
# ===================================================================


class TestRTSPPlayseek:
    """Verify playseek parameter is forwarded in RTSP requests."""

    def test_playseek_tcp(self, shared_r2h):
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            status, _, body = stream_get(
                "127.0.0.1", shared_r2h.port,
                "/rtsp/127.0.0.1:%d/stream?playseek=20240101120000-20240101130000" % rtsp.port,
                read_bytes=4096, timeout=_STREAM_TIMEOUT,
            )
            assert status == 200
            assert len(body) > 0
        finally:
            rtsp.stop()

    def test_playseek_udp(self, shared_r2h):
        rtsp = MockRTSPServerUDP()
        rtsp.start()
        try:
            status, _, body = stream_get(
                "127.0.0.1", shared_r2h.port,
                "/rtsp/127.0.0.1:%d/stream?playseek=20240101120000-20240101130000" % rtsp.port,
                read_bytes=4096, timeout=_STREAM_TIMEOUT,
            )
            assert status == 200
            assert len(body) > 0
        finally:
            rtsp.stop()


# ===================================================================
# HEAD request and error handling
# ===================================================================


class TestRTSPHeadRequest:
    def test_head_rtsp(self, shared_r2h):
        status, _, body = http_request(
            "127.0.0.1", shared_r2h.port, "HEAD",
            "/rtsp/127.0.0.1:554/test", timeout=3.0,
        )
        assert status == 200
        assert len(body) == 0


class TestRTSPInvalidServer:
    def test_rtsp_unreachable(self, shared_r2h):
        dead_port = find_free_port()
        status, _, _ = stream_get(
            "127.0.0.1", shared_r2h.port,
            "/rtsp/127.0.0.1:%d/test" % dead_port,
            read_bytes=512, timeout=8.0,
        )
        assert status in (0, 500, 502, 503)


# ===================================================================
# Playseek forwarding verification
# ===================================================================


class TestRTSPPlayseekForwarding:
    """Verify that playseek parameters are forwarded in the RTSP URI."""

    def test_playseek_forwarded_in_describe_uri(self, shared_r2h):
        """playseek parameter should be forwarded in the DESCRIBE URI."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            status, _, body = stream_get(
                "127.0.0.1", shared_r2h.port,
                "/rtsp/127.0.0.1:%d/stream?playseek=20240101120000-20240101130000" % rtsp.port,
                read_bytes=4096, timeout=_STREAM_TIMEOUT,
            )
            assert status == 200

            # Verify DESCRIBE URI contains the playseek parameter
            describe_reqs = [r for r in rtsp.requests_detailed if r["method"] == "DESCRIBE"]
            assert len(describe_reqs) > 0, "Expected DESCRIBE request"
            uri = describe_reqs[0]["uri"]
            assert "/stream" in uri, "DESCRIBE URI should contain the path"
            assert "playseek=" in uri, \
                "playseek should be forwarded in DESCRIBE URI, got: %s" % uri
        finally:
            rtsp.stop()

    def test_playseek_correct_path_in_uri(self, shared_r2h):
        """The RTSP URI should contain the correct server path."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            stream_get(
                "127.0.0.1", shared_r2h.port,
                "/rtsp/127.0.0.1:%d/live/channel1?playseek=20240101120000-20240101130000" % rtsp.port,
                read_bytes=2048, timeout=_STREAM_TIMEOUT,
            )

            # DESCRIBE URI should include the full path
            describe_reqs = [r for r in rtsp.requests_detailed if r["method"] == "DESCRIBE"]
            assert len(describe_reqs) > 0
            uri = describe_reqs[0]["uri"]
            assert "/live/channel1" in uri
        finally:
            rtsp.stop()


# ===================================================================
# tvdr parameter (alternative to playseek)
# ===================================================================


class TestRTSPTvdr:
    """Verify tvdr parameter works as an alternative seek parameter."""

    def test_tvdr_forwarded_in_uri(self, shared_r2h):
        """tvdr parameter should be forwarded in the RTSP URI."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            status, _, body = stream_get(
                "127.0.0.1", shared_r2h.port,
                "/rtsp/127.0.0.1:%d/stream?tvdr=20240601080000-20240601090000" % rtsp.port,
                read_bytes=4096, timeout=_STREAM_TIMEOUT,
            )
            assert status == 200

            describe_reqs = [r for r in rtsp.requests_detailed if r["method"] == "DESCRIBE"]
            assert len(describe_reqs) > 0, "Expected DESCRIBE request"
            uri = describe_reqs[0]["uri"]
            assert "tvdr=" in uri, \
                "tvdr should be forwarded in DESCRIBE URI, got: %s" % uri
        finally:
            rtsp.stop()


# ===================================================================
# Custom seek parameter name (r2h-seek-name)
# ===================================================================


class TestRTSPCustomSeekName:
    """Verify r2h-seek-name allows specifying a custom seek parameter."""

    def test_custom_seek_forwarded_in_uri(self, shared_r2h):
        """The custom seek parameter should be forwarded in the RTSP URI."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            status, _, body = stream_get(
                "127.0.0.1", shared_r2h.port,
                "/rtsp/127.0.0.1:%d/stream?r2h-seek-name=myseek&myseek=20240301100000-20240301110000" % rtsp.port,
                read_bytes=4096, timeout=_STREAM_TIMEOUT,
            )
            assert status == 200

            describe_reqs = [r for r in rtsp.requests_detailed if r["method"] == "DESCRIBE"]
            assert len(describe_reqs) > 0, "Expected DESCRIBE request"
            uri = describe_reqs[0]["uri"]
            # The custom seek param should be forwarded
            assert "myseek=" in uri, \
                "Custom seek param should be in DESCRIBE URI, got: %s" % uri
        finally:
            rtsp.stop()

    def test_r2h_seek_name_stripped_from_uri(self, shared_r2h):
        """r2h-seek-name is an rtp2httpd meta-parameter and should be
        stripped from the RTSP URI, while the actual seek param stays."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            stream_get(
                "127.0.0.1", shared_r2h.port,
                "/rtsp/127.0.0.1:%d/stream?r2h-seek-name=myseek&myseek=20240301100000-20240301110000" % rtsp.port,
                read_bytes=2048, timeout=_STREAM_TIMEOUT,
            )

            describe_reqs = [r for r in rtsp.requests_detailed if r["method"] == "DESCRIBE"]
            assert len(describe_reqs) > 0
            uri = describe_reqs[0]["uri"]
            # r2h-seek-name is internal to rtp2httpd, should not reach RTSP server
            assert "r2h-seek-name" not in uri, \
                "r2h-seek-name should be stripped from URI, got: %s" % uri
            # But the actual seek param should be present
            assert "myseek=" in uri
        finally:
            rtsp.stop()


# ===================================================================
# Content-Base + SDP a=control URL resolution
# ===================================================================


class TestRTSPContentBase:
    """Verify SETUP uses Content-Base + SDP a=control to build the URL."""

    # -- Normal cases -------------------------------------------------------

    def test_setup_uses_content_base_with_track_id(self, r2h_binary):
        """Content-Base (auto trailing /) + a=control:trackID=2 → SETUP
        URL = Content-Base/trackID=2."""
        rtsp = MockRTSPServer(num_packets=500, sdp_control="trackID=2")
        rtsp.start()
        time.sleep(0.1)
        port = find_free_port()
        r2h = R2HProcess(r2h_binary, port, extra_args=["-v", "4", "-m", "100"])
        try:
            r2h.start()
            stream_get(
                "127.0.0.1", port,
                "/rtsp/127.0.0.1:%d/live/stream.sdp" % rtsp.port,
                read_bytes=4096, timeout=_STREAM_TIMEOUT,
            )
            time.sleep(0.5)

            setup_reqs = [r for r in rtsp.requests_detailed if r["method"] == "SETUP"]
            assert len(setup_reqs) > 0, "Expected SETUP request"
            setup_uri = setup_reqs[0]["uri"]
            assert setup_uri.endswith("/live/stream.sdp/trackID=2"), \
                "SETUP URI should resolve to Content-Base/trackID=2, got: %s" % setup_uri
        finally:
            r2h.stop()
            rtsp.stop()

    def test_play_uses_original_url(self, r2h_binary):
        """PLAY should use the original DESCRIBE URL, not the track URL."""
        rtsp = MockRTSPServer(num_packets=500, sdp_control="trackID=2")
        rtsp.start()
        time.sleep(0.1)
        port = find_free_port()
        r2h = R2HProcess(r2h_binary, port, extra_args=["-v", "4", "-m", "100"])
        try:
            r2h.start()
            stream_get(
                "127.0.0.1", port,
                "/rtsp/127.0.0.1:%d/live/stream.sdp" % rtsp.port,
                read_bytes=4096, timeout=_STREAM_TIMEOUT,
            )
            time.sleep(0.5)

            play_reqs = [r for r in rtsp.requests_detailed if r["method"] == "PLAY"]
            assert len(play_reqs) > 0, "Expected PLAY request"
            play_uri = play_reqs[0]["uri"]
            assert "trackID" not in play_uri, \
                "PLAY URI should use original URL, not track URL, got: %s" % play_uri
            assert "/live/stream.sdp" in play_uri
        finally:
            r2h.stop()
            rtsp.stop()

    def test_aggregate_control_uses_original_url(self, r2h_binary):
        """a=control:* → SETUP uses the original URL unchanged."""
        rtsp = MockRTSPServer(num_packets=500, sdp_control="*")
        rtsp.start()
        time.sleep(0.1)
        port = find_free_port()
        r2h = R2HProcess(r2h_binary, port, extra_args=["-v", "4", "-m", "100"])
        try:
            r2h.start()
            stream_get(
                "127.0.0.1", port,
                "/rtsp/127.0.0.1:%d/live/stream.sdp" % rtsp.port,
                read_bytes=4096, timeout=_STREAM_TIMEOUT,
            )
            time.sleep(0.5)

            setup_reqs = [r for r in rtsp.requests_detailed if r["method"] == "SETUP"]
            assert len(setup_reqs) > 0, "Expected SETUP request"
            setup_uri = setup_reqs[0]["uri"]
            assert setup_uri.endswith("/live/stream.sdp"), \
                "SETUP URI for a=control:* should use original URL, got: %s" % setup_uri
            assert "trackID" not in setup_uri
        finally:
            r2h.stop()
            rtsp.stop()

    def test_absolute_control_url(self, r2h_binary):
        """a=control with absolute rtsp:// URL → SETUP uses that URL
        directly, ignoring Content-Base."""
        abs_control = "rtsp://127.0.0.1:%d/alt/path/track1"
        # We need to know the mock port before constructing the control URL;
        # use the same host so SETUP succeeds against the same mock server.
        rtsp = MockRTSPServer(num_packets=500)
        # Set control after port is assigned
        abs_url = abs_control % rtsp.port
        rtsp._sdp_control = abs_url
        rtsp.start()
        time.sleep(0.1)
        port = find_free_port()
        r2h = R2HProcess(r2h_binary, port, extra_args=["-v", "4", "-m", "100"])
        try:
            r2h.start()
            stream_get(
                "127.0.0.1", port,
                "/rtsp/127.0.0.1:%d/live/stream.sdp" % rtsp.port,
                read_bytes=4096, timeout=_STREAM_TIMEOUT,
            )
            time.sleep(0.5)

            setup_reqs = [r for r in rtsp.requests_detailed if r["method"] == "SETUP"]
            assert len(setup_reqs) > 0, "Expected SETUP request"
            setup_uri = setup_reqs[0]["uri"]
            assert setup_uri == abs_url, \
                "SETUP URI for absolute a=control should be used as-is, got: %s" % setup_uri
        finally:
            r2h.stop()
            rtsp.stop()

    # -- No Content-Base header ---------------------------------------------

    def test_no_content_base_relative_control(self, r2h_binary):
        """Without Content-Base, relative a=control resolves against the
        DESCRIBE request URL per RFC 3986 (replaces last path segment)."""
        rtsp = MockRTSPServer(num_packets=500, sdp_control="trackID=2",
                              content_base=None)
        rtsp.start()
        time.sleep(0.1)
        port = find_free_port()
        r2h = R2HProcess(r2h_binary, port, extra_args=["-v", "4", "-m", "100"])
        try:
            r2h.start()
            stream_get(
                "127.0.0.1", port,
                "/rtsp/127.0.0.1:%d/live/stream.sdp" % rtsp.port,
                read_bytes=4096, timeout=_STREAM_TIMEOUT,
            )
            time.sleep(0.5)

            setup_reqs = [r for r in rtsp.requests_detailed if r["method"] == "SETUP"]
            assert len(setup_reqs) > 0, "Expected SETUP request"
            setup_uri = setup_reqs[0]["uri"]
            # RFC 3986: resolve "trackID=2" against ".../live/stream.sdp"
            # → last segment "stream.sdp" replaced → ".../live/trackID=2"
            assert setup_uri.endswith("/live/trackID=2"), \
                "Without Content-Base, relative control should replace last " \
                "path segment, got: %s" % setup_uri
        finally:
            r2h.stop()
            rtsp.stop()

    # -- No a=control in SDP ------------------------------------------------

    def test_no_control_attribute(self, r2h_binary):
        """SDP without a=control → SETUP uses the original URL."""
        sdp_no_control = ("v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=T\r\n"
                          "c=IN IP4 0.0.0.0\r\nt=0 0\r\n"
                          "m=video 0 RTP/AVP 33\r\n"
                          "a=rtpmap:33 MP2T/90000\r\n")
        rtsp = MockRTSPServer(num_packets=500, custom_sdp=sdp_no_control)
        rtsp.start()
        time.sleep(0.1)
        port = find_free_port()
        r2h = R2HProcess(r2h_binary, port, extra_args=["-v", "4", "-m", "100"])
        try:
            r2h.start()
            stream_get(
                "127.0.0.1", port,
                "/rtsp/127.0.0.1:%d/live/stream.sdp" % rtsp.port,
                read_bytes=4096, timeout=_STREAM_TIMEOUT,
            )
            time.sleep(0.5)

            setup_reqs = [r for r in rtsp.requests_detailed if r["method"] == "SETUP"]
            assert len(setup_reqs) > 0, "Expected SETUP request"
            setup_uri = setup_reqs[0]["uri"]
            assert setup_uri.endswith("/live/stream.sdp"), \
                "No a=control in SDP → SETUP should use original URL, got: %s" % setup_uri
        finally:
            r2h.stop()
            rtsp.stop()

    # -- Multi-track SDP (only first track used) ----------------------------

    def test_multi_track_uses_first_media_control(self, r2h_binary):
        """SDP with two m= sections: only the first media-level a=control
        should be used for SETUP (rtp2httpd sets up one track)."""
        sdp_multi = ("v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=T\r\n"
                     "c=IN IP4 0.0.0.0\r\nt=0 0\r\n"
                     "m=video 0 RTP/AVP 33\r\n"
                     "a=rtpmap:33 MP2T/90000\r\n"
                     "a=control:trackID=1\r\n"
                     "m=audio 0 RTP/AVP 97\r\n"
                     "a=rtpmap:97 MPEG4-GENERIC/48000\r\n"
                     "a=control:trackID=2\r\n")
        # sdp_control="trackID=1" ensures auto Content-Base adds trailing /
        rtsp = MockRTSPServer(num_packets=500, custom_sdp=sdp_multi,
                              sdp_control="trackID=1")
        rtsp.start()
        time.sleep(0.1)
        port = find_free_port()
        r2h = R2HProcess(r2h_binary, port, extra_args=["-v", "4", "-m", "100"])
        try:
            r2h.start()
            stream_get(
                "127.0.0.1", port,
                "/rtsp/127.0.0.1:%d/live/stream.sdp" % rtsp.port,
                read_bytes=4096, timeout=_STREAM_TIMEOUT,
            )
            time.sleep(0.5)

            setup_reqs = [r for r in rtsp.requests_detailed if r["method"] == "SETUP"]
            assert len(setup_reqs) > 0, "Expected SETUP request"
            setup_uri = setup_reqs[0]["uri"]
            # First media-level control is trackID=1
            assert setup_uri.endswith("/live/stream.sdp/trackID=1"), \
                "Multi-track: SETUP should use first media control (trackID=1), got: %s" % setup_uri
        finally:
            r2h.stop()
            rtsp.stop()

    def test_session_aggregate_with_media_track_control(self, r2h_binary):
        """Session-level a=control:* + media-level a=control:trackID=3
        → SETUP should use the media-level control, not the session one."""
        sdp_session_and_media = (
            "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=T\r\n"
            "c=IN IP4 0.0.0.0\r\nt=0 0\r\n"
            "a=control:*\r\n"
            "m=video 0 RTP/AVP 33\r\n"
            "a=rtpmap:33 MP2T/90000\r\n"
            "a=control:trackID=3\r\n")
        # sdp_control="trackID=3" ensures auto Content-Base adds trailing /
        rtsp = MockRTSPServer(num_packets=500, custom_sdp=sdp_session_and_media,
                              sdp_control="trackID=3")
        rtsp.start()
        time.sleep(0.1)
        port = find_free_port()
        r2h = R2HProcess(r2h_binary, port, extra_args=["-v", "4", "-m", "100"])
        try:
            r2h.start()
            stream_get(
                "127.0.0.1", port,
                "/rtsp/127.0.0.1:%d/live/stream.sdp" % rtsp.port,
                read_bytes=4096, timeout=_STREAM_TIMEOUT,
            )
            time.sleep(0.5)

            setup_reqs = [r for r in rtsp.requests_detailed if r["method"] == "SETUP"]
            assert len(setup_reqs) > 0, "Expected SETUP request"
            setup_uri = setup_reqs[0]["uri"]
            assert setup_uri.endswith("/live/stream.sdp/trackID=3"), \
                "Session a=control:* + media a=control:trackID=3 → " \
                "SETUP should use media control, got: %s" % setup_uri
        finally:
            r2h.stop()
            rtsp.stop()

    # -- Content-Base without trailing slash ---------------------------------

    def test_content_base_no_trailing_slash(self, r2h_binary):
        """Content-Base without trailing '/' + relative control → RFC 3986
        replaces the last path segment of Content-Base."""
        # Manually set Content-Base without trailing slash
        rtsp = MockRTSPServer(num_packets=500, sdp_control="trackID=2")
        rtsp.start()
        time.sleep(0.1)
        # Override content_base to explicit value without trailing slash
        cb = "rtsp://127.0.0.1:%d/live/stream.sdp" % rtsp.port
        rtsp._content_base = cb
        port = find_free_port()
        r2h = R2HProcess(r2h_binary, port, extra_args=["-v", "4", "-m", "100"])
        try:
            r2h.start()
            stream_get(
                "127.0.0.1", port,
                "/rtsp/127.0.0.1:%d/live/stream.sdp" % rtsp.port,
                read_bytes=4096, timeout=_STREAM_TIMEOUT,
            )
            time.sleep(0.5)

            setup_reqs = [r for r in rtsp.requests_detailed if r["method"] == "SETUP"]
            assert len(setup_reqs) > 0, "Expected SETUP request"
            setup_uri = setup_reqs[0]["uri"]
            # Content-Base doesn't end with '/' → RFC 3986 replaces last segment
            assert setup_uri.endswith("/live/trackID=2"), \
                "Content-Base without '/' should replace last segment, got: %s" % setup_uri
        finally:
            r2h.stop()
            rtsp.stop()

    # -- Original URL has query parameters ----------------------------------

    def test_content_base_with_query_params(self, r2h_binary):
        """Original URL has query parameters but Content-Base does not.
        SETUP should use Content-Base + control (no query params)."""
        rtsp = MockRTSPServer(num_packets=500, sdp_control="trackID=2")
        rtsp.start()
        time.sleep(0.1)
        port = find_free_port()
        r2h = R2HProcess(r2h_binary, port, extra_args=["-v", "4", "-m", "100"])
        try:
            r2h.start()
            stream_get(
                "127.0.0.1", port,
                "/rtsp/127.0.0.1:%d/live/stream.sdp?token=abc123&sid=456" % rtsp.port,
                read_bytes=4096, timeout=_STREAM_TIMEOUT,
            )
            time.sleep(0.5)

            setup_reqs = [r for r in rtsp.requests_detailed if r["method"] == "SETUP"]
            assert len(setup_reqs) > 0, "Expected SETUP request"
            setup_uri = setup_reqs[0]["uri"]
            # Content-Base (auto-derived from URI with query) + trackID=2
            # The Content-Base includes the query params from the original URI
            # but the key point is trackID=2 is appended
            assert "trackID=2" in setup_uri, \
                "SETUP URI should contain trackID=2, got: %s" % setup_uri

            # PLAY should use the original URL with query params
            play_reqs = [r for r in rtsp.requests_detailed if r["method"] == "PLAY"]
            assert len(play_reqs) > 0, "Expected PLAY request"
            play_uri = play_reqs[0]["uri"]
            assert "trackID" not in play_uri, \
                "PLAY should not contain trackID, got: %s" % play_uri
        finally:
            r2h.stop()
            rtsp.stop()

    # -- Deep path + relative control ---------------------------------------

    def test_deep_path_relative_control(self, r2h_binary):
        """Deep path like /a/b/c/d.sdp + relative control resolves correctly
        against Content-Base."""
        rtsp = MockRTSPServer(num_packets=500, sdp_control="stream1")
        rtsp.start()
        time.sleep(0.1)
        port = find_free_port()
        r2h = R2HProcess(r2h_binary, port, extra_args=["-v", "4", "-m", "100"])
        try:
            r2h.start()
            stream_get(
                "127.0.0.1", port,
                "/rtsp/127.0.0.1:%d/iptv/channels/001/live.sdp" % rtsp.port,
                read_bytes=4096, timeout=_STREAM_TIMEOUT,
            )
            time.sleep(0.5)

            setup_reqs = [r for r in rtsp.requests_detailed if r["method"] == "SETUP"]
            assert len(setup_reqs) > 0, "Expected SETUP request"
            setup_uri = setup_reqs[0]["uri"]
            # Content-Base (auto) = .../live.sdp/ + control "stream1"
            assert setup_uri.endswith("/iptv/channels/001/live.sdp/stream1"), \
                "Deep path SETUP should resolve correctly, got: %s" % setup_uri
        finally:
            r2h.stop()
            rtsp.stop()


# ===================================================================
# r2h-duration (stream duration query)
# ===================================================================


class TestRTSPDurationQuery:
    """r2h-duration=1 queries stream duration via DESCRIBE without playing."""

    def test_duration_returns_json(self, r2h_binary):
        """r2h-duration=1 should return JSON with duration from SDP
        a=range:npt= without sending SETUP or PLAY."""
        sdp_with_range = ("v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=T\r\n"
                          "c=IN IP4 0.0.0.0\r\nt=0 0\r\n"
                          "a=range:npt=0.000-3600.500\r\n"
                          "m=video 0 RTP/AVP 33\r\na=control:*\r\n")
        rtsp = MockRTSPServer(num_packets=500, custom_sdp=sdp_with_range)
        rtsp.start()
        time.sleep(0.1)
        port = find_free_port()
        r2h = R2HProcess(r2h_binary, port, extra_args=["-v", "4", "-m", "100"])
        try:
            r2h.start()
            status, hdrs, body = http_get(
                "127.0.0.1", port,
                "/rtsp/127.0.0.1:%d/stream?r2h-duration=1" % rtsp.port,
                timeout=_STREAM_TIMEOUT,
            )
            assert status == 200, "Expected 200 for r2h-duration, got %d" % status
            body_str = body.decode(errors="replace")
            assert '"duration"' in body_str, \
                "Response should contain duration JSON, got: %s" % body_str
            assert "3600.500" in body_str, \
                "Duration should be 3600.500, got: %s" % body_str
        finally:
            r2h.stop()
            rtsp.stop()

    def test_duration_no_setup_or_play(self, r2h_binary):
        """r2h-duration should only do OPTIONS + DESCRIBE, no SETUP/PLAY."""
        sdp_with_range = ("v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=T\r\n"
                          "c=IN IP4 0.0.0.0\r\nt=0 0\r\n"
                          "a=range:npt=0.000-1800.000\r\n"
                          "m=video 0 RTP/AVP 33\r\na=control:*\r\n")
        rtsp = MockRTSPServer(num_packets=500, custom_sdp=sdp_with_range)
        rtsp.start()
        time.sleep(0.1)
        port = find_free_port()
        r2h = R2HProcess(r2h_binary, port, extra_args=["-v", "4", "-m", "100"])
        try:
            r2h.start()
            http_get(
                "127.0.0.1", port,
                "/rtsp/127.0.0.1:%d/stream?r2h-duration=1" % rtsp.port,
                timeout=_STREAM_TIMEOUT,
            )
            time.sleep(0.5)

            methods = rtsp.requests_received
            assert "OPTIONS" in methods, "Expected OPTIONS"
            assert "DESCRIBE" in methods, "Expected DESCRIBE"
            assert "SETUP" not in methods, \
                "r2h-duration should NOT send SETUP, got: %s" % methods
            assert "PLAY" not in methods, \
                "r2h-duration should NOT send PLAY, got: %s" % methods
        finally:
            r2h.stop()
            rtsp.stop()

    def test_duration_stripped_from_rtsp_uri(self, r2h_binary):
        """r2h-duration is an rtp2httpd meta-parameter and should be
        stripped from the RTSP URI sent to the server."""
        sdp_with_range = ("v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=T\r\n"
                          "c=IN IP4 0.0.0.0\r\nt=0 0\r\n"
                          "a=range:npt=0.000-7200.000\r\n"
                          "m=video 0 RTP/AVP 33\r\na=control:*\r\n")
        rtsp = MockRTSPServer(num_packets=500, custom_sdp=sdp_with_range)
        rtsp.start()
        time.sleep(0.1)
        port = find_free_port()
        r2h = R2HProcess(r2h_binary, port, extra_args=["-v", "4", "-m", "100"])
        try:
            r2h.start()
            http_get(
                "127.0.0.1", port,
                "/rtsp/127.0.0.1:%d/stream?r2h-duration=1" % rtsp.port,
                timeout=_STREAM_TIMEOUT,
            )
            time.sleep(0.5)

            describe_reqs = [r for r in rtsp.requests_detailed
                             if r["method"] == "DESCRIBE"]
            assert len(describe_reqs) > 0, "Expected DESCRIBE"
            uri = describe_reqs[0]["uri"]
            assert "r2h-duration" not in uri, \
                "r2h-duration should be stripped from RTSP URI, got: %s" % uri
        finally:
            r2h.stop()
            rtsp.stop()


# ===================================================================
# r2h-start (seek / Range header)
# ===================================================================


class TestRTSPStartSeek:
    """r2h-start=<npt> adds Range header to PLAY for seeking."""

    def test_start_adds_range_header(self, r2h_binary):
        """r2h-start should be forwarded as Range: npt=<value>- in PLAY."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        time.sleep(0.1)
        port = find_free_port()
        r2h = R2HProcess(r2h_binary, port, extra_args=["-v", "4", "-m", "100"])
        try:
            r2h.start()
            stream_get(
                "127.0.0.1", port,
                "/rtsp/127.0.0.1:%d/stream?r2h-start=120.5" % rtsp.port,
                read_bytes=4096, timeout=_STREAM_TIMEOUT,
            )
            time.sleep(0.5)

            play_reqs = [r for r in rtsp.requests_detailed
                         if r["method"] == "PLAY"]
            assert len(play_reqs) > 0, "Expected PLAY request"
            play_headers = play_reqs[0]["headers"]
            assert "Range" in play_headers, \
                "PLAY should have Range header, headers: %s" % play_headers
            assert "120.5" in play_headers["Range"], \
                "Range should contain npt start value, got: %s" % play_headers["Range"]
        finally:
            r2h.stop()
            rtsp.stop()

    def test_start_stripped_from_rtsp_uri(self, r2h_binary):
        """r2h-start is an rtp2httpd meta-parameter and should be stripped
        from the RTSP URI sent to the server."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        time.sleep(0.1)
        port = find_free_port()
        r2h = R2HProcess(r2h_binary, port, extra_args=["-v", "4", "-m", "100"])
        try:
            r2h.start()
            stream_get(
                "127.0.0.1", port,
                "/rtsp/127.0.0.1:%d/stream?r2h-start=60" % rtsp.port,
                read_bytes=4096, timeout=_STREAM_TIMEOUT,
            )
            time.sleep(0.5)

            describe_reqs = [r for r in rtsp.requests_detailed
                             if r["method"] == "DESCRIBE"]
            assert len(describe_reqs) > 0, "Expected DESCRIBE"
            uri = describe_reqs[0]["uri"]
            assert "r2h-start" not in uri, \
                "r2h-start should be stripped from RTSP URI, got: %s" % uri
        finally:
            r2h.stop()
            rtsp.stop()

    def test_start_with_other_params(self, r2h_binary):
        """r2h-start should be stripped but other query params preserved."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        time.sleep(0.1)
        port = find_free_port()
        r2h = R2HProcess(r2h_binary, port, extra_args=["-v", "4", "-m", "100"])
        try:
            r2h.start()
            stream_get(
                "127.0.0.1", port,
                "/rtsp/127.0.0.1:%d/stream?token=abc&r2h-start=30&sid=123" % rtsp.port,
                read_bytes=4096, timeout=_STREAM_TIMEOUT,
            )
            time.sleep(0.5)

            describe_reqs = [r for r in rtsp.requests_detailed
                             if r["method"] == "DESCRIBE"]
            assert len(describe_reqs) > 0, "Expected DESCRIBE"
            uri = describe_reqs[0]["uri"]
            assert "r2h-start" not in uri, \
                "r2h-start should be stripped, got: %s" % uri
            assert "token=abc" in uri, \
                "Other params should be preserved, got: %s" % uri
            assert "sid=123" in uri, \
                "Other params should be preserved, got: %s" % uri
        finally:
            r2h.stop()
            rtsp.stop()

    def test_no_range_header_without_start(self, r2h_binary):
        """Without r2h-start, PLAY should not have a Range header."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        time.sleep(0.1)
        port = find_free_port()
        r2h = R2HProcess(r2h_binary, port, extra_args=["-v", "4", "-m", "100"])
        try:
            r2h.start()
            stream_get(
                "127.0.0.1", port,
                "/rtsp/127.0.0.1:%d/stream" % rtsp.port,
                read_bytes=4096, timeout=_STREAM_TIMEOUT,
            )
            time.sleep(0.5)

            play_reqs = [r for r in rtsp.requests_detailed
                         if r["method"] == "PLAY"]
            assert len(play_reqs) > 0, "Expected PLAY request"
            play_headers = play_reqs[0]["headers"]
            assert "Range" not in play_headers, \
                "PLAY without r2h-start should not have Range, got: %s" % play_headers
        finally:
            r2h.stop()
            rtsp.stop()
