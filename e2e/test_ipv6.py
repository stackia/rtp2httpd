"""
E2E tests for IPv6 support.

Covers:
- HTTP proxy with IPv6-only upstream (`/http/[::1]:port/...`), including the
  bracketed Host header, M3U rewrite, and redirect Location rewrite.
- RTSP proxy over TCP interleaved with IPv6 upstream (`/rtsp/[::1]:port/...`).
- HTTP server listening on the IPv6 loopback, hostname validation with
  `[::1]:port` Host headers, and playlist base URL generation.
- FCC graceful fallback when the FCC server address is IPv6.
"""

import time

import pytest

from helpers import (
    MockHTTPUpstream,
    MockRTSPServer,
    R2HProcess,
    find_free_port,
    http_get,
    ipv6_loopback_available,
    stream_get,
    wait_for_port,
)

pytestmark = pytest.mark.skipif(
    not ipv6_loopback_available(),
    reason="IPv6 loopback (::1) not available on this host",
)

_TIMEOUT = 5.0
_STREAM_TIMEOUT = 20.0


# ---------------------------------------------------------------------------
# Module-scoped shared rtp2httpd instance (dual-stack listen)
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def shared_r2h(r2h_binary):
    """A single rtp2httpd instance shared by IPv6 proxy tests."""
    port = find_free_port()
    r2h = R2HProcess(r2h_binary, port, extra_args=["-v", "4", "-m", "100"])
    r2h.start()
    yield r2h
    r2h.stop()


# ---------------------------------------------------------------------------
# HTTP proxy with IPv6 upstream
# ---------------------------------------------------------------------------


@pytest.mark.http_proxy
class TestHTTPProxyIPv6Upstream:
    """`/http/[::1]:port/...` should proxy to an IPv6-only upstream."""

    def test_proxy_200_via_ipv6(self, shared_r2h):
        upstream = MockHTTPUpstream(
            host="::1",
            routes={"/ok": {"status": 200, "body": b"v6-world", "headers": {"Content-Type": "text/plain"}}},
        )
        upstream.start()
        try:
            status, _, body = http_get(
                "127.0.0.1",
                shared_r2h.port,
                f"/http/[::1]:{upstream.port}/ok",
                timeout=_TIMEOUT,
            )
            assert status == 200
            assert body == b"v6-world"
        finally:
            upstream.stop()

    def test_host_header_is_bracketed(self, shared_r2h):
        """The upstream must receive `Host: [::1]:port` (bracketed IPv6)."""
        upstream = MockHTTPUpstream(
            host="::1",
            routes={"/ok": {"status": 200, "body": b"x"}},
        )
        upstream.start()
        try:
            status, _, _ = http_get(
                "127.0.0.1",
                shared_r2h.port,
                f"/http/[::1]:{upstream.port}/ok",
                timeout=_TIMEOUT,
            )
            assert status == 200
            assert len(upstream.requests_log) == 1
            host_hdr = upstream.requests_log[0]["headers"].get("Host")
            assert host_hdr == f"[::1]:{upstream.port}"
        finally:
            upstream.stop()

    def test_m3u_relative_rewrite_ipv6_authority(self, shared_r2h):
        """Relative M3U URLs from an IPv6 upstream should be rewritten with a
        bracketed `[::1]:port` authority in the proxy URL."""
        m3u = "#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\nseg0.ts\n#EXTINF:10,\n/abs/seg1.ts\n"
        upstream = MockHTTPUpstream(
            host="::1",
            routes={
                "/live/playlist.m3u8": {
                    "status": 200,
                    "body": m3u,
                    "headers": {"Content-Type": "application/vnd.apple.mpegurl"},
                },
            },
        )
        upstream.start()
        try:
            status, _, body = http_get(
                "127.0.0.1",
                shared_r2h.port,
                f"/http/[::1]:{upstream.port}/live/playlist.m3u8",
                timeout=_TIMEOUT,
            )
            text = body.decode("utf-8", errors="replace")
            assert status == 200
            assert f"/http/[::1]:{upstream.port}/live/seg0.ts" in text
            assert f"/http/[::1]:{upstream.port}/abs/seg1.ts" in text
        finally:
            upstream.stop()

    def test_redirect_location_ipv6_rewritten(self, shared_r2h):
        """A redirect to an IPv6 upstream URL should be rewritten to /http/[::1]:..."""
        upstream = MockHTTPUpstream(
            host="::1",
            routes={
                "/old": {
                    "status": 302,
                    "body": b"",
                    "headers": {"Location": "http://[::1]:8080/new/page"},
                },
            },
        )
        upstream.start()
        try:
            status, hdrs, _ = http_get(
                "127.0.0.1",
                shared_r2h.port,
                f"/http/[::1]:{upstream.port}/old",
                timeout=_TIMEOUT,
            )
            assert status == 302
            location = next((v for k, v in hdrs.items() if k.lower() == "location"), None)
            assert location == "/http/[::1]:8080/new/page"
        finally:
            upstream.stop()


# ---------------------------------------------------------------------------
# RTSP proxy (TCP interleaved) with IPv6 upstream
# ---------------------------------------------------------------------------


@pytest.mark.rtsp
class TestRTSPIPv6Upstream:
    """`/rtsp/[::1]:port/...` should play over TCP interleaved transport."""

    def test_rtsp_tcp_stream_via_ipv6(self, shared_r2h):
        rtsp = MockRTSPServer(num_packets=500, host="::1")
        rtsp.start()
        try:
            status, _, body = stream_get(
                "127.0.0.1",
                shared_r2h.port,
                f"/rtsp/[::1]:{rtsp.port}/stream",
                read_bytes=4096,
                timeout=_STREAM_TIMEOUT,
            )
            assert status == 200
            assert len(body) >= 188
            assert body[0] == 0x47, "Expected TS sync byte 0x47, got 0x%02x" % body[0]
        finally:
            rtsp.stop()

    def test_rtsp_handshake_uses_bracketed_url(self, shared_r2h):
        """RTSP requests must carry rtsp://[::1]:port/... URIs (brackets kept)."""
        rtsp = MockRTSPServer(num_packets=500, host="::1")
        rtsp.start()
        try:
            stream_get(
                "127.0.0.1",
                shared_r2h.port,
                f"/rtsp/[::1]:{rtsp.port}/stream",
                read_bytes=2048,
                timeout=_STREAM_TIMEOUT,
            )
            methods = rtsp.requests_received
            assert "OPTIONS" in methods
            assert "DESCRIBE" in methods
            assert "SETUP" in methods
            assert "PLAY" in methods
            describe = next(r for r in rtsp.requests_detailed if r["method"] == "DESCRIBE")
            assert describe["uri"].startswith(f"rtsp://[::1]:{rtsp.port}/")
        finally:
            rtsp.stop()


# ---------------------------------------------------------------------------
# HTTP server on IPv6 loopback
# ---------------------------------------------------------------------------


class TestHTTPServerIPv6Listen:
    """rtp2httpd bound to ::1 should serve requests and validate IPv6 Hosts."""

    @pytest.fixture(scope="class")
    @classmethod
    def v6_r2h(cls, r2h_binary):
        port = find_free_port("::1")
        config = f"""\
[global]
verbosity = 4
hostname = ::1

[bind]
::1 {port}

[services]
#EXTM3U
#EXTINF:-1,Channel One
rtp://239.0.0.1:1234
"""
        r2h = R2HProcess(r2h_binary, port, config_content=config)
        r2h.start(wait=False)
        assert wait_for_port(port, host="::1", timeout=6.0), "rtp2httpd did not listen on [::1]"
        yield r2h
        r2h.stop()

    def test_request_with_bracketed_host_accepted(self, v6_r2h):
        """A request with `Host: [::1]:port` must pass hostname validation."""
        status, _, body = http_get("::1", v6_r2h.port, "/playlist.m3u", timeout=_TIMEOUT)
        assert status == 200
        assert b"#EXTM3U" in body

    def test_request_with_wrong_host_rejected(self, v6_r2h):
        status, _, _ = http_get(
            "::1", v6_r2h.port, "/playlist.m3u", timeout=_TIMEOUT, headers={"Host": "evil.example.com"}
        )
        assert status == 400

    def test_playlist_base_url_bracketed(self, v6_r2h):
        """Playlist URLs must use a valid bracketed IPv6 authority."""
        status, _, body = http_get("::1", v6_r2h.port, "/playlist.m3u", timeout=_TIMEOUT)
        text = body.decode("utf-8", errors="replace")
        assert status == 200
        assert "http://[::1]" in text
        # A bare (unbracketed) IPv6 authority like http://::1 is invalid
        assert "http://::1" not in text


# ---------------------------------------------------------------------------
# FCC with IPv6 address: graceful fallback
# ---------------------------------------------------------------------------


@pytest.mark.fcc
class TestFCCIPv6Fallback:
    """`fcc=[::1]:port` must not crash; FCC is disabled with a warning and the
    stream falls back to plain multicast."""

    def test_fcc_ipv6_disabled_with_warning(self, r2h_binary):
        port = find_free_port()
        r2h = R2HProcess(
            r2h_binary,
            port,
            extra_args=["-v", "4", "-m", "100"],
            capture_log=True,
        )
        try:
            r2h.start()
            # No multicast data flows; just verify the server survives the
            # request and logs the IPv4-only fallback.
            stream_get(
                "127.0.0.1",
                port,
                "/rtp/239.0.0.1:5140?fcc=[::1]:9999",
                read_bytes=128,
                timeout=2.0,
            )
            time.sleep(0.2)
            assert r2h.process is not None and r2h.process.poll() is None, "rtp2httpd crashed"
            log = r2h.read_log()
            assert "FCC is IPv4-only" in log
        finally:
            r2h.stop()
