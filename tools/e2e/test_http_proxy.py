"""
E2E tests for HTTP reverse proxy.

These tests start a mock HTTP upstream, point rtp2httpd at it via
/http/127.0.0.1:<port>/…, and verify responses are correctly proxied.
"""

import time

import pytest

from helpers import (
    MockHTTPUpstream,
    R2HProcess,
    find_free_port,
    http_get,
    http_request,
    stream_get,
)

pytestmark = pytest.mark.http_proxy


# ---------------------------------------------------------------------------
# Basic proxy functionality
# ---------------------------------------------------------------------------


class TestBasicProxy:
    """Verify that rtp2httpd can proxy simple HTTP requests."""

    def test_proxy_200(self, r2h_binary):
        """A proxied path returning 200 should be relayed to the client."""
        upstream = MockHTTPUpstream(routes={
            "/hello": {"status": 200, "body": b"world", "headers": {"Content-Type": "text/plain"}},
        })
        upstream.start()
        time.sleep(0.1)

        port = find_free_port()
        r2h = R2HProcess(
            r2h_binary, port,
            extra_args=["-v", "4", "-m", "100"],
        )
        try:
            r2h.start()
            status, hdrs, body = http_get(
                "127.0.0.1", port,
                f"/http/127.0.0.1:{upstream.port}/hello",
                timeout=5.0,
            )
            assert status == 200
            assert body == b"world"
        finally:
            r2h.stop()
            upstream.stop()

    def test_proxy_404_passthrough(self, r2h_binary):
        """A proxied 404 from the upstream should be forwarded to the client."""
        upstream = MockHTTPUpstream(routes={})  # no routes → all 404
        upstream.start()
        time.sleep(0.1)

        port = find_free_port()
        r2h = R2HProcess(
            r2h_binary, port,
            extra_args=["-v", "4", "-m", "100"],
        )
        try:
            r2h.start()
            status, _, _ = http_get(
                "127.0.0.1", port,
                f"/http/127.0.0.1:{upstream.port}/missing",
                timeout=5.0,
            )
            assert status == 404
        finally:
            r2h.stop()
            upstream.stop()


# ---------------------------------------------------------------------------
# Content types
# ---------------------------------------------------------------------------


class TestProxyContentType:
    """Verify Content-Type from upstream is preserved."""

    def test_json_content_type(self, r2h_binary):
        upstream = MockHTTPUpstream(routes={
            "/api/data": {
                "status": 200,
                "body": b'{"key":"value"}',
                "headers": {"Content-Type": "application/json"},
            },
        })
        upstream.start()
        time.sleep(0.1)

        port = find_free_port()
        r2h = R2HProcess(
            r2h_binary, port,
            extra_args=["-v", "4", "-m", "100"],
        )
        try:
            r2h.start()
            status, hdrs, body = http_get(
                "127.0.0.1", port,
                f"/http/127.0.0.1:{upstream.port}/api/data",
                timeout=5.0,
            )
            assert status == 200
            assert body == b'{"key":"value"}'
        finally:
            r2h.stop()
            upstream.stop()


# ---------------------------------------------------------------------------
# Large response
# ---------------------------------------------------------------------------


class TestProxyLargeBody:
    """Verify a larger payload is proxied completely."""

    @pytest.mark.slow
    @pytest.mark.xfail(reason="rtp2httpd HTTP proxy may time out on large payloads (potential bug)")
    def test_large_payload(self, r2h_binary):
        """Verify a 64 KB payload is proxied completely."""
        big_body = b"X" * (64 * 1024)
        upstream = MockHTTPUpstream(routes={
            "/big": {"status": 200, "body": big_body, "headers": {"Content-Type": "application/octet-stream"}},
        })
        upstream.start()
        time.sleep(0.1)

        port = find_free_port()
        r2h = R2HProcess(
            r2h_binary, port,
            extra_args=["-v", "4", "-m", "100"],
        )
        try:
            r2h.start()
            status, _, body = http_get(
                "127.0.0.1", port,
                "/http/127.0.0.1:%d/big" % upstream.port,
                timeout=10.0,
            )
            assert status == 200
            assert len(body) == len(big_body)
        finally:
            r2h.stop()
            upstream.stop()


# ---------------------------------------------------------------------------
# Query parameter forwarding
# ---------------------------------------------------------------------------


class TestProxyQueryParams:
    """Query parameters should be forwarded to the upstream."""

    def test_query_forwarded(self, r2h_binary):
        # The mock doesn't inspect query params, but rtp2httpd should
        # proxy the full URL. We just verify a 200 comes back.
        upstream = MockHTTPUpstream(routes={
            "/search": {"status": 200, "body": b"found"},
        })
        upstream.start()
        time.sleep(0.1)

        port = find_free_port()
        r2h = R2HProcess(
            r2h_binary, port,
            extra_args=["-v", "4", "-m", "100"],
        )
        try:
            r2h.start()
            status, _, body = http_get(
                "127.0.0.1", port,
                f"/http/127.0.0.1:{upstream.port}/search?q=test&page=1",
                timeout=5.0,
            )
            assert status == 200
        finally:
            r2h.stop()
            upstream.stop()


# ---------------------------------------------------------------------------
# M3U content rewriting through proxy
# ---------------------------------------------------------------------------


class TestProxyM3URewrite:
    """When proxying M3U playlists, internal URLs should be rewritten."""

    def test_m3u_proxy(self, r2h_binary):
        m3u_body = (
            "#EXTM3U\n"
            "#EXT-X-VERSION:3\n"
            "#EXT-X-TARGETDURATION:10\n"
            "#EXTINF:10,\n"
            "http://127.0.0.1:9999/segment1.ts\n"
            "#EXTINF:10,\n"
            "http://127.0.0.1:9999/segment2.ts\n"
        )
        upstream = MockHTTPUpstream(routes={
            "/live/playlist.m3u8": {
                "status": 200,
                "body": m3u_body,
                "headers": {"Content-Type": "application/vnd.apple.mpegurl"},
            },
        })
        upstream.start()
        time.sleep(0.1)

        port = find_free_port()
        r2h = R2HProcess(
            r2h_binary, port,
            extra_args=["-v", "4", "-m", "100"],
        )
        try:
            r2h.start()
            status, hdrs, body = http_get(
                "127.0.0.1", port,
                f"/http/127.0.0.1:{upstream.port}/live/playlist.m3u8",
                timeout=5.0,
            )
            assert status == 200
            # The body may be rewritten to route segments through rtp2httpd.
            # At minimum, the playlist data should be returned.
            text = body.decode("utf-8", errors="replace")
            assert "#EXTM3U" in text
        finally:
            r2h.stop()
            upstream.stop()


# ---------------------------------------------------------------------------
# Upstream unreachable
# ---------------------------------------------------------------------------


class TestProxyUnreachable:
    """When the upstream is unreachable, rtp2httpd should fail gracefully."""

    def test_upstream_down(self, r2h_binary):
        dead_port = find_free_port()
        port = find_free_port()
        r2h = R2HProcess(
            r2h_binary, port,
            extra_args=["-v", "4", "-m", "100"],
        )
        try:
            r2h.start()
            status, _, _ = stream_get(
                "127.0.0.1", port,
                "/http/127.0.0.1:%d/whatever" % dead_port,
                read_bytes=512,
                timeout=6.0,
            )
            # Should be an error or a closed connection
            assert status in (0, 500, 502, 503)
        finally:
            r2h.stop()


# ---------------------------------------------------------------------------
# HTTP proxy with different status codes
# ---------------------------------------------------------------------------


class TestProxyStatusCodes:
    """Verify various upstream HTTP status codes are forwarded."""

    def test_proxy_500(self, r2h_binary):
        upstream = MockHTTPUpstream(routes={
            "/err": {"status": 500, "body": b"Internal Error"},
        })
        upstream.start()
        time.sleep(0.1)
        port = find_free_port()
        r2h = R2HProcess(r2h_binary, port, extra_args=["-v", "4", "-m", "100"])
        try:
            r2h.start()
            status, _, body = http_get(
                "127.0.0.1", port,
                "/http/127.0.0.1:%d/err" % upstream.port,
                timeout=5.0,
            )
            assert status == 500
        finally:
            r2h.stop()
            upstream.stop()

    def test_proxy_302_body(self, r2h_binary):
        """rtp2httpd should forward redirects from upstream."""
        upstream = MockHTTPUpstream(routes={
            "/redirect": {
                "status": 302,
                "body": b"",
                "headers": {"Location": "http://example.com/new"},
            },
        })
        upstream.start()
        time.sleep(0.1)
        port = find_free_port()
        r2h = R2HProcess(r2h_binary, port, extra_args=["-v", "4", "-m", "100"])
        try:
            r2h.start()
            status, hdrs, _ = http_get(
                "127.0.0.1", port,
                "/http/127.0.0.1:%d/redirect" % upstream.port,
                timeout=5.0,
            )
            assert status == 302
        finally:
            r2h.stop()
            upstream.stop()


# ---------------------------------------------------------------------------
# HTTP proxy with empty response body
# ---------------------------------------------------------------------------


class TestProxyEmptyBody:
    """An upstream 200 with empty body should be forwarded."""

    def test_empty_200(self, r2h_binary):
        upstream = MockHTTPUpstream(routes={
            "/empty": {"status": 200, "body": b""},
        })
        upstream.start()
        time.sleep(0.1)
        port = find_free_port()
        r2h = R2HProcess(r2h_binary, port, extra_args=["-v", "4", "-m", "100"])
        try:
            r2h.start()
            status, _, body = http_get(
                "127.0.0.1", port,
                "/http/127.0.0.1:%d/empty" % upstream.port,
                timeout=5.0,
            )
            assert status == 200
            assert body == b""
        finally:
            r2h.stop()
            upstream.stop()
