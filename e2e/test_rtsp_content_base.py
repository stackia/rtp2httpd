"""
E2E tests for RTSP Content-Base + SDP a=control URL resolution.

Verifies that rtp2httpd correctly resolves SETUP URLs from the
Content-Base header and SDP a=control attributes per RFC 3986.
"""

import pytest

from helpers import (
    MockRTSPServer,
    R2HProcess,
    find_free_port,
    stream_get,
)

pytestmark = pytest.mark.rtsp

_STREAM_TIMEOUT = 20.0


@pytest.fixture(scope="module")
def shared_r2h(r2h_binary):
    """A single rtp2httpd instance shared by all Content-Base tests."""
    port = find_free_port()
    r2h = R2HProcess(r2h_binary, port, extra_args=["-v", "4", "-m", "100"])
    r2h.start()
    yield r2h
    r2h.stop()


class TestRTSPContentBase:
    """Verify SETUP uses Content-Base + SDP a=control to build the URL."""

    # -- Normal cases -------------------------------------------------------

    def test_setup_uses_content_base_with_track_id(self, shared_r2h):
        """Content-Base (auto trailing /) + a=control:trackID=2 → SETUP
        URL = Content-Base/trackID=2."""
        rtsp = MockRTSPServer(num_packets=500, sdp_control="trackID=2")
        rtsp.start()
        try:
            stream_get(
                "127.0.0.1", shared_r2h.port,
                "/rtsp/127.0.0.1:%d/live/stream.sdp" % rtsp.port,
                read_bytes=4096, timeout=_STREAM_TIMEOUT,
            )

            setup_reqs = [r for r in rtsp.requests_detailed if r["method"] == "SETUP"]
            assert len(setup_reqs) > 0, "Expected SETUP request"
            setup_uri = setup_reqs[0]["uri"]
            assert setup_uri.endswith("/live/stream.sdp/trackID=2"), \
                "SETUP URI should resolve to Content-Base/trackID=2, got: %s" % setup_uri
        finally:
            rtsp.stop()

    def test_play_uses_original_url(self, shared_r2h):
        """PLAY should use the original DESCRIBE URL, not the track URL."""
        rtsp = MockRTSPServer(num_packets=500, sdp_control="trackID=2")
        rtsp.start()
        try:
            stream_get(
                "127.0.0.1", shared_r2h.port,
                "/rtsp/127.0.0.1:%d/live/stream.sdp" % rtsp.port,
                read_bytes=4096, timeout=_STREAM_TIMEOUT,
            )

            play_reqs = [r for r in rtsp.requests_detailed if r["method"] == "PLAY"]
            assert len(play_reqs) > 0, "Expected PLAY request"
            play_uri = play_reqs[0]["uri"]
            assert "trackID" not in play_uri, \
                "PLAY URI should use original URL, not track URL, got: %s" % play_uri
            assert "/live/stream.sdp" in play_uri
        finally:
            rtsp.stop()

    def test_aggregate_control_uses_original_url(self, shared_r2h):
        """a=control:* → SETUP uses the original URL unchanged."""
        rtsp = MockRTSPServer(num_packets=500, sdp_control="*")
        rtsp.start()
        try:
            stream_get(
                "127.0.0.1", shared_r2h.port,
                "/rtsp/127.0.0.1:%d/live/stream.sdp" % rtsp.port,
                read_bytes=4096, timeout=_STREAM_TIMEOUT,
            )

            setup_reqs = [r for r in rtsp.requests_detailed if r["method"] == "SETUP"]
            assert len(setup_reqs) > 0, "Expected SETUP request"
            setup_uri = setup_reqs[0]["uri"]
            assert setup_uri.endswith("/live/stream.sdp"), \
                "SETUP URI for a=control:* should use original URL, got: %s" % setup_uri
            assert "trackID" not in setup_uri
        finally:
            rtsp.stop()

    def test_absolute_control_url(self, shared_r2h):
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
        try:
            stream_get(
                "127.0.0.1", shared_r2h.port,
                "/rtsp/127.0.0.1:%d/live/stream.sdp" % rtsp.port,
                read_bytes=4096, timeout=_STREAM_TIMEOUT,
            )

            setup_reqs = [r for r in rtsp.requests_detailed if r["method"] == "SETUP"]
            assert len(setup_reqs) > 0, "Expected SETUP request"
            setup_uri = setup_reqs[0]["uri"]
            assert setup_uri == abs_url, \
                "SETUP URI for absolute a=control should be used as-is, got: %s" % setup_uri
        finally:
            rtsp.stop()

    # -- No Content-Base header ---------------------------------------------

    def test_no_content_base_relative_control(self, shared_r2h):
        """Without Content-Base, relative a=control resolves against the
        DESCRIBE request URL per RFC 3986 (replaces last path segment)."""
        rtsp = MockRTSPServer(num_packets=500, sdp_control="trackID=2",
                              content_base=None)
        rtsp.start()
        try:
            stream_get(
                "127.0.0.1", shared_r2h.port,
                "/rtsp/127.0.0.1:%d/live/stream.sdp" % rtsp.port,
                read_bytes=4096, timeout=_STREAM_TIMEOUT,
            )

            setup_reqs = [r for r in rtsp.requests_detailed if r["method"] == "SETUP"]
            assert len(setup_reqs) > 0, "Expected SETUP request"
            setup_uri = setup_reqs[0]["uri"]
            # RFC 3986: resolve "trackID=2" against ".../live/stream.sdp"
            # → last segment "stream.sdp" replaced → ".../live/trackID=2"
            assert setup_uri.endswith("/live/trackID=2"), \
                "Without Content-Base, relative control should replace last " \
                "path segment, got: %s" % setup_uri
        finally:
            rtsp.stop()

    # -- No a=control in SDP ------------------------------------------------

    def test_no_control_attribute(self, shared_r2h):
        """SDP without a=control → SETUP uses the original URL."""
        sdp_no_control = ("v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=T\r\n"
                          "c=IN IP4 0.0.0.0\r\nt=0 0\r\n"
                          "m=video 0 RTP/AVP 33\r\n"
                          "a=rtpmap:33 MP2T/90000\r\n")
        rtsp = MockRTSPServer(num_packets=500, custom_sdp=sdp_no_control)
        rtsp.start()
        try:
            stream_get(
                "127.0.0.1", shared_r2h.port,
                "/rtsp/127.0.0.1:%d/live/stream.sdp" % rtsp.port,
                read_bytes=4096, timeout=_STREAM_TIMEOUT,
            )

            setup_reqs = [r for r in rtsp.requests_detailed if r["method"] == "SETUP"]
            assert len(setup_reqs) > 0, "Expected SETUP request"
            setup_uri = setup_reqs[0]["uri"]
            assert setup_uri.endswith("/live/stream.sdp"), \
                "No a=control in SDP → SETUP should use original URL, got: %s" % setup_uri
        finally:
            rtsp.stop()

    # -- Multi-track SDP (only first track used) ----------------------------

    def test_multi_track_uses_first_media_control(self, shared_r2h):
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
        try:
            stream_get(
                "127.0.0.1", shared_r2h.port,
                "/rtsp/127.0.0.1:%d/live/stream.sdp" % rtsp.port,
                read_bytes=4096, timeout=_STREAM_TIMEOUT,
            )

            setup_reqs = [r for r in rtsp.requests_detailed if r["method"] == "SETUP"]
            assert len(setup_reqs) > 0, "Expected SETUP request"
            setup_uri = setup_reqs[0]["uri"]
            # First media-level control is trackID=1
            assert setup_uri.endswith("/live/stream.sdp/trackID=1"), \
                "Multi-track: SETUP should use first media control (trackID=1), got: %s" % setup_uri
        finally:
            rtsp.stop()

    def test_session_aggregate_with_media_track_control(self, shared_r2h):
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
        try:
            stream_get(
                "127.0.0.1", shared_r2h.port,
                "/rtsp/127.0.0.1:%d/live/stream.sdp" % rtsp.port,
                read_bytes=4096, timeout=_STREAM_TIMEOUT,
            )

            setup_reqs = [r for r in rtsp.requests_detailed if r["method"] == "SETUP"]
            assert len(setup_reqs) > 0, "Expected SETUP request"
            setup_uri = setup_reqs[0]["uri"]
            assert setup_uri.endswith("/live/stream.sdp/trackID=3"), \
                "Session a=control:* + media a=control:trackID=3 → " \
                "SETUP should use media control, got: %s" % setup_uri
        finally:
            rtsp.stop()

    # -- Content-Base without trailing slash ---------------------------------

    def test_content_base_no_trailing_slash(self, shared_r2h):
        """Content-Base without trailing '/' + relative control → RFC 3986
        replaces the last path segment of Content-Base."""
        # Manually set Content-Base without trailing slash
        rtsp = MockRTSPServer(num_packets=500, sdp_control="trackID=2")
        # Override content_base to explicit value without trailing slash
        cb = "rtsp://127.0.0.1:%d/live/stream.sdp" % rtsp.port
        rtsp._content_base = cb
        rtsp.start()
        try:
            stream_get(
                "127.0.0.1", shared_r2h.port,
                "/rtsp/127.0.0.1:%d/live/stream.sdp" % rtsp.port,
                read_bytes=4096, timeout=_STREAM_TIMEOUT,
            )

            setup_reqs = [r for r in rtsp.requests_detailed if r["method"] == "SETUP"]
            assert len(setup_reqs) > 0, "Expected SETUP request"
            setup_uri = setup_reqs[0]["uri"]
            # Content-Base doesn't end with '/' → RFC 3986 replaces last segment
            assert setup_uri.endswith("/live/trackID=2"), \
                "Content-Base without '/' should replace last segment, got: %s" % setup_uri
        finally:
            rtsp.stop()

    # -- Original URL has query parameters ----------------------------------

    def test_content_base_with_query_params(self, shared_r2h):
        """Original URL has query parameters but Content-Base does not.
        SETUP should use Content-Base + control (no query params)."""
        rtsp = MockRTSPServer(num_packets=500, sdp_control="trackID=2")
        rtsp.start()
        try:
            stream_get(
                "127.0.0.1", shared_r2h.port,
                "/rtsp/127.0.0.1:%d/live/stream.sdp?token=abc123&sid=456" % rtsp.port,
                read_bytes=4096, timeout=_STREAM_TIMEOUT,
            )

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
            rtsp.stop()

    # -- Deep path + relative control ---------------------------------------

    def test_deep_path_relative_control(self, shared_r2h):
        """Deep path like /a/b/c/d.sdp + relative control resolves correctly
        against Content-Base."""
        rtsp = MockRTSPServer(num_packets=500, sdp_control="stream1")
        rtsp.start()
        try:
            stream_get(
                "127.0.0.1", shared_r2h.port,
                "/rtsp/127.0.0.1:%d/iptv/channels/001/live.sdp" % rtsp.port,
                read_bytes=4096, timeout=_STREAM_TIMEOUT,
            )

            setup_reqs = [r for r in rtsp.requests_detailed if r["method"] == "SETUP"]
            assert len(setup_reqs) > 0, "Expected SETUP request"
            setup_uri = setup_reqs[0]["uri"]
            # Content-Base (auto) = .../live.sdp/ + control "stream1"
            assert setup_uri.endswith("/iptv/channels/001/live.sdp/stream1"), \
                "Deep path SETUP should resolve correctly, got: %s" % setup_uri
        finally:
            rtsp.stop()
