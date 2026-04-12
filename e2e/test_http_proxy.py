"""
E2E tests for HTTP reverse proxy.

These tests start a mock HTTP upstream, point rtp2httpd at it via
/http/127.0.0.1:<port>/..., and verify responses are correctly proxied.
"""

import time

import pytest

from helpers import (
    MockHTTPUpstream,
    MockHTTPUpstreamSilent,
    R2HProcess,
    find_free_port,
    http_get,
    stream_get,
)

pytestmark = pytest.mark.http_proxy


# ---------------------------------------------------------------------------
# Module-scoped shared rtp2httpd instance
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def shared_r2h(r2h_binary):
    """A single rtp2httpd instance shared by all HTTP proxy tests."""
    port = find_free_port()
    r2h = R2HProcess(r2h_binary, port, extra_args=["-v", "4", "-m", "100"])
    r2h.start()
    yield r2h
    r2h.stop()


# ---------------------------------------------------------------------------
# Basic proxy functionality
# ---------------------------------------------------------------------------


class TestBasicProxy:
    """Verify that rtp2httpd can proxy simple HTTP requests."""

    def test_proxy_200(self, shared_r2h):
        """A proxied path returning 200 should be relayed to the client."""
        upstream = MockHTTPUpstream(
            routes={
                "/hello": {"status": 200, "body": b"world", "headers": {"Content-Type": "text/plain"}},
            }
        )
        upstream.start()
        try:
            status, hdrs, body = http_get(
                "127.0.0.1",
                shared_r2h.port,
                f"/http/127.0.0.1:{upstream.port}/hello",
                timeout=5.0,
            )
            assert status == 200
            assert body == b"world"
        finally:
            upstream.stop()

    def test_proxy_404_passthrough(self, shared_r2h):
        """A proxied 404 from the upstream should be forwarded to the client."""
        upstream = MockHTTPUpstream(routes={})  # no routes -> all 404
        upstream.start()
        try:
            status, _, _ = http_get(
                "127.0.0.1",
                shared_r2h.port,
                f"/http/127.0.0.1:{upstream.port}/missing",
                timeout=5.0,
            )
            assert status == 404
        finally:
            upstream.stop()


# ---------------------------------------------------------------------------
# Content types
# ---------------------------------------------------------------------------


class TestProxyContentType:
    """Verify Content-Type from upstream is preserved."""

    def test_json_content_type(self, shared_r2h):
        upstream = MockHTTPUpstream(
            routes={
                "/api/data": {
                    "status": 200,
                    "body": b'{"key":"value"}',
                    "headers": {"Content-Type": "application/json"},
                },
            }
        )
        upstream.start()
        try:
            status, hdrs, body = http_get(
                "127.0.0.1",
                shared_r2h.port,
                f"/http/127.0.0.1:{upstream.port}/api/data",
                timeout=5.0,
            )
            assert status == 200
            assert body == b'{"key":"value"}'
        finally:
            upstream.stop()


# ---------------------------------------------------------------------------
# Large response
# ---------------------------------------------------------------------------


class TestProxyLargeBody:
    """Verify a larger payload is proxied completely."""

    @pytest.mark.slow
    def test_large_payload(self, shared_r2h):
        """Verify a 64 KB payload is proxied completely."""
        big_body = b"X" * (64 * 1024)
        upstream = MockHTTPUpstream(
            routes={
                "/big": {"status": 200, "body": big_body, "headers": {"Content-Type": "application/octet-stream"}},
            }
        )
        upstream.start()
        try:
            status, _, body = http_get(
                "127.0.0.1",
                shared_r2h.port,
                "/http/127.0.0.1:%d/big" % upstream.port,
                timeout=10.0,
            )
            assert status == 200
            assert len(body) == len(big_body)
        finally:
            upstream.stop()


# ---------------------------------------------------------------------------
# Query parameter forwarding
# ---------------------------------------------------------------------------


class TestProxyQueryParams:
    """Query parameters should be forwarded to the upstream."""

    def test_query_forwarded(self, shared_r2h):
        # The mock doesn't inspect query params, but rtp2httpd should
        # proxy the full URL. We just verify a 200 comes back.
        upstream = MockHTTPUpstream(
            routes={
                "/search": {"status": 200, "body": b"found"},
            }
        )
        upstream.start()
        try:
            status, _, body = http_get(
                "127.0.0.1",
                shared_r2h.port,
                f"/http/127.0.0.1:{upstream.port}/search?q=test&page=1",
                timeout=5.0,
            )
            assert status == 200
        finally:
            upstream.stop()


# ---------------------------------------------------------------------------
# Upstream unreachable
# ---------------------------------------------------------------------------


class TestProxyUnreachable:
    """When the upstream is unreachable, rtp2httpd should fail gracefully."""

    def test_upstream_down(self, shared_r2h):
        dead_port = find_free_port()
        status, _, _ = stream_get(
            "127.0.0.1",
            shared_r2h.port,
            "/http/127.0.0.1:%d/whatever" % dead_port,
            read_bytes=512,
            timeout=6.0,
        )
        # Should be an error or a closed connection
        assert status in (0, 500, 502, 503)


# ---------------------------------------------------------------------------
# Upstream timeout (accepts connection but never responds)
# ---------------------------------------------------------------------------

# Timeout constant matching C code (3s)
_HTTP_PROXY_TIMEOUT = 3
_TIMEOUT_MIN_FACTOR = 0.8
_TIMEOUT_MAX_FACTOR = 3.0


class TestProxyUpstreamTimeout:
    """When the HTTP upstream accepts but never responds, should time out."""

    @pytest.mark.slow
    def test_http_proxy_response_timeout(self, r2h_binary):
        """MockHTTPUpstreamSilent doesn't respond — should get 503 within timeout."""
        r2h_port = find_free_port()
        r2h = R2HProcess(r2h_binary, r2h_port, extra_args=["-v", "4", "-m", "100"])
        r2h.start()
        try:
            upstream = MockHTTPUpstreamSilent()
            upstream.start()
            try:
                t0 = time.monotonic()
                status, _, _ = stream_get(
                    "127.0.0.1",
                    r2h_port,
                    "/http/127.0.0.1:%d/test" % upstream.port,
                    read_bytes=256,
                    timeout=_HTTP_PROXY_TIMEOUT * _TIMEOUT_MAX_FACTOR + 5,
                )
                elapsed = time.monotonic() - t0

                assert status == 503, f"Expected 503, got {status}"
                assert elapsed >= _HTTP_PROXY_TIMEOUT * _TIMEOUT_MIN_FACTOR, f"Timed out too quickly: {elapsed:.1f}s"
                assert elapsed <= _HTTP_PROXY_TIMEOUT * _TIMEOUT_MAX_FACTOR + 2, f"Timed out too slowly: {elapsed:.1f}s"
            finally:
                upstream.stop()
        finally:
            r2h.stop()


# ---------------------------------------------------------------------------
# HTTP proxy with different status codes
# ---------------------------------------------------------------------------


class TestProxyStatusCodes:
    """Verify various upstream HTTP status codes are forwarded."""

    def test_proxy_500(self, shared_r2h):
        upstream = MockHTTPUpstream(
            routes={
                "/err": {"status": 500, "body": b"Internal Error"},
            }
        )
        upstream.start()
        try:
            status, _, body = http_get(
                "127.0.0.1",
                shared_r2h.port,
                "/http/127.0.0.1:%d/err" % upstream.port,
                timeout=5.0,
            )
            assert status == 500
        finally:
            upstream.stop()

    def test_proxy_302_body(self, shared_r2h):
        """rtp2httpd should forward redirects from upstream."""
        upstream = MockHTTPUpstream(
            routes={
                "/redirect": {
                    "status": 302,
                    "body": b"",
                    "headers": {"Location": "http://example.com/new"},
                },
            }
        )
        upstream.start()
        try:
            status, hdrs, _ = http_get(
                "127.0.0.1",
                shared_r2h.port,
                "/http/127.0.0.1:%d/redirect" % upstream.port,
                timeout=5.0,
            )
            assert status == 302
        finally:
            upstream.stop()


# ---------------------------------------------------------------------------
# Redirect Location rewriting
# ---------------------------------------------------------------------------


def _get_location(hdrs):
    """Extract Location header value (case-insensitive lookup)."""
    for k, v in hdrs.items():
        if k.lower() == "location":
            return v
    return None


class TestProxyRedirectLocationRewrite:
    """30x redirect responses should have their Location header rewritten
    so the URL points back through the rtp2httpd proxy."""

    def test_302_location_rewritten(self, shared_r2h):
        """302 Location with http:// URL should be rewritten to /http/... path."""
        upstream = MockHTTPUpstream(
            routes={
                "/old": {
                    "status": 302,
                    "body": b"",
                    "headers": {"Location": "http://10.0.0.1:8080/new/page"},
                },
            }
        )
        upstream.start()
        try:
            status, hdrs, _ = http_get(
                "127.0.0.1",
                shared_r2h.port,
                "/http/127.0.0.1:%d/old" % upstream.port,
                timeout=5.0,
            )
            assert status == 302
            location = _get_location(hdrs)
            assert location is not None, "Location header missing"
            assert location == "/http/10.0.0.1:8080/new/page"
        finally:
            upstream.stop()

    def test_301_location_rewritten(self, shared_r2h):
        """301 permanent redirect should also rewrite Location."""
        upstream = MockHTTPUpstream(
            routes={
                "/moved": {
                    "status": 301,
                    "body": b"",
                    "headers": {"Location": "http://10.0.0.1:8080/moved-here"},
                },
            }
        )
        upstream.start()
        try:
            status, hdrs, _ = http_get(
                "127.0.0.1",
                shared_r2h.port,
                "/http/127.0.0.1:%d/moved" % upstream.port,
                timeout=5.0,
            )
            assert status == 301
            location = _get_location(hdrs)
            assert location is not None, "Location header missing"
            assert location == "/http/10.0.0.1:8080/moved-here"
        finally:
            upstream.stop()

    def test_307_location_rewritten(self, shared_r2h):
        """307 temporary redirect should rewrite Location."""
        upstream = MockHTTPUpstream(
            routes={
                "/temp": {
                    "status": 307,
                    "body": b"",
                    "headers": {"Location": "http://10.0.0.1:8080/temp-dest"},
                },
            }
        )
        upstream.start()
        try:
            status, hdrs, _ = http_get(
                "127.0.0.1",
                shared_r2h.port,
                "/http/127.0.0.1:%d/temp" % upstream.port,
                timeout=5.0,
            )
            assert status == 307
            location = _get_location(hdrs)
            assert location is not None, "Location header missing"
            assert location == "/http/10.0.0.1:8080/temp-dest"
        finally:
            upstream.stop()

    def test_redirect_location_preserves_query_string(self, shared_r2h):
        """Query parameters in Location URL should be preserved after rewrite."""
        upstream = MockHTTPUpstream(
            routes={
                "/redir-qs": {
                    "status": 302,
                    "body": b"",
                    "headers": {"Location": "http://10.0.0.1:8080/target?foo=bar&baz=1"},
                },
            }
        )
        upstream.start()
        try:
            status, hdrs, _ = http_get(
                "127.0.0.1",
                shared_r2h.port,
                "/http/127.0.0.1:%d/redir-qs" % upstream.port,
                timeout=5.0,
            )
            assert status == 302
            location = _get_location(hdrs)
            assert location is not None, "Location header missing"
            assert "/http/10.0.0.1:8080/target?" in location
            assert "foo=bar" in location
            assert "baz=1" in location
        finally:
            upstream.stop()

    def test_redirect_https_location_not_rewritten(self, shared_r2h):
        """https:// Location should NOT be rewritten (only http:// is supported)."""
        upstream = MockHTTPUpstream(
            routes={
                "/secure-redir": {
                    "status": 302,
                    "body": b"",
                    "headers": {"Location": "https://example.com/secure"},
                },
            }
        )
        upstream.start()
        try:
            status, hdrs, _ = http_get(
                "127.0.0.1",
                shared_r2h.port,
                "/http/127.0.0.1:%d/secure-redir" % upstream.port,
                timeout=5.0,
            )
            assert status == 302
            location = _get_location(hdrs)
            assert location is not None, "Location header missing"
            assert location == "https://example.com/secure"
        finally:
            upstream.stop()

    def test_non_redirect_location_not_rewritten(self, shared_r2h):
        """A 200 response with a Location header should NOT rewrite it."""
        upstream = MockHTTPUpstream(
            routes={
                "/ok-with-loc": {
                    "status": 200,
                    "body": b"ok",
                    "headers": {
                        "Location": "http://10.0.0.1:8080/other",
                        "Content-Type": "text/plain",
                    },
                },
            }
        )
        upstream.start()
        try:
            status, hdrs, _ = http_get(
                "127.0.0.1",
                shared_r2h.port,
                "/http/127.0.0.1:%d/ok-with-loc" % upstream.port,
                timeout=5.0,
            )
            assert status == 200
            location = _get_location(hdrs)
            if location is not None:
                assert location == "http://10.0.0.1:8080/other"
        finally:
            upstream.stop()


# ---------------------------------------------------------------------------
# HTTP proxy with empty response body
# ---------------------------------------------------------------------------


class TestProxyEmptyBody:
    """An upstream 200 with empty body should be forwarded."""

    def test_empty_200(self, shared_r2h):
        upstream = MockHTTPUpstream(
            routes={
                "/empty": {"status": 200, "body": b""},
            }
        )
        upstream.start()
        try:
            status, _, body = http_get(
                "127.0.0.1",
                shared_r2h.port,
                "/http/127.0.0.1:%d/empty" % upstream.port,
                timeout=5.0,
            )
            assert status == 200
            assert body == b""
        finally:
            upstream.stop()


# ---------------------------------------------------------------------------
# Connection: close header enforcement
# ---------------------------------------------------------------------------


class TestProxyConnectionClose:
    """Verify that rtp2httpd always sends Connection: close to clients."""

    def test_connection_close_in_response(self, shared_r2h):
        """HTTP proxy responses must include Connection: close header."""
        upstream = MockHTTPUpstream(
            routes={
                "/test": {"status": 200, "body": b"test content", "headers": {"Content-Type": "text/plain"}},
            }
        )
        upstream.start()
        try:
            status, hdrs, body = http_get(
                "127.0.0.1",
                shared_r2h.port,
                "/http/127.0.0.1:%d/test" % upstream.port,
                timeout=5.0,
            )
            assert status == 200
            assert body == b"test content"
            # Verify Connection: close is present (case-insensitive)
            connection_header = None
            for k, v in hdrs.items():
                if k.lower() == "connection":
                    connection_header = v.lower()
                    break
            assert connection_header is not None, "Connection header is missing"
            assert "close" in connection_header, f"Expected 'close' in Connection header, got '{connection_header}'"
        finally:
            upstream.stop()

    def test_connection_close_with_redirect(self, shared_r2h):
        """HTTP proxy redirect responses must include Connection: close."""
        upstream = MockHTTPUpstream(
            routes={
                "/redirect": {
                    "status": 302,
                    "body": b"",
                    "headers": {"Location": "http://10.0.0.1:8080/new"},
                },
            }
        )
        upstream.start()
        try:
            status, hdrs, _ = http_get(
                "127.0.0.1",
                shared_r2h.port,
                "/http/127.0.0.1:%d/redirect" % upstream.port,
                timeout=5.0,
            )
            assert status == 302
            # Verify Connection: close is present
            connection_header = None
            for k, v in hdrs.items():
                if k.lower() == "connection":
                    connection_header = v.lower()
                    break
            assert connection_header is not None, "Connection header is missing"
            assert "close" in connection_header, f"Expected 'close' in Connection header, got '{connection_header}'"
        finally:
            upstream.stop()

    def test_connection_close_with_upstream_keepalive(self, shared_r2h):
        """Even if upstream sends keep-alive, rtp2httpd must send close."""
        upstream = MockHTTPUpstream(
            routes={
                "/keepalive": {
                    "status": 200,
                    "body": b"content",
                    "headers": {"Content-Type": "text/plain", "Connection": "keep-alive"},
                },
            }
        )
        upstream.start()
        try:
            status, hdrs, body = http_get(
                "127.0.0.1",
                shared_r2h.port,
                "/http/127.0.0.1:%d/keepalive" % upstream.port,
                timeout=5.0,
            )
            assert status == 200
            assert body == b"content"
            # Verify rtp2httpd overrides upstream's keep-alive with close
            connection_header = None
            for k, v in hdrs.items():
                if k.lower() == "connection":
                    connection_header = v.lower()
                    break
            assert connection_header is not None, "Connection header is missing"
            assert "close" in connection_header, f"Expected 'close' in Connection header, got '{connection_header}'"
        finally:
            upstream.stop()
