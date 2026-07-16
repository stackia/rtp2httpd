"""
E2E tests for M3U content rewriting through the HTTP reverse proxy.

When rtp2httpd proxies an M3U/HLS playlist, it rewrites URLs inside the
playlist body so that segment / sub-playlist fetches also go through the
proxy.  These tests verify the rewriting logic end-to-end.
"""

import socket
import struct
import threading

import pytest

from helpers import (
    MockHTTPUpstream,
    R2HProcess,
    find_free_port,
    get_header,
    http_get,
    stream_get,
)

pytestmark = pytest.mark.http_proxy

_TIMEOUT = 5.0
_HEADER_PARSE_READ_SIZE = 8191  # HTTP_PROXY_RESPONSE_BUFFER_SIZE - 1
APP_PREFIX = "/app/rtp2httpd"


# ---------------------------------------------------------------------------
# Module-scoped shared rtp2httpd instance
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def shared_r2h(r2h_binary):
    """A single rtp2httpd instance shared by all M3U rewrite tests."""
    port = find_free_port()
    r2h = R2HProcess(r2h_binary, port, extra_args=["-v", "4", "-m", "100"])
    r2h.start()
    yield r2h
    r2h.stop()


@pytest.fixture(scope="module")
def prefixed_r2h(r2h_binary):
    """A shared rtp2httpd instance mounted under app-path-prefix."""
    port = find_free_port()
    config = f"""\
[global]
verbosity = 4
maxclients = 100
app-path-prefix = {APP_PREFIX}

[bind]
* {port}
"""
    r2h = R2HProcess(r2h_binary, port, config_content=config)
    r2h.start()
    yield r2h
    r2h.stop()


@pytest.fixture(scope="module")
def relative_path_prefixed_r2h(r2h_binary):
    """A shared rtp2httpd instance with app-path-prefix and relative M3U URLs."""
    port = find_free_port()
    config = f"""\
[global]
verbosity = 4
maxclients = 100
app-path-prefix = {APP_PREFIX}
use-relative-path-in-m3u = yes

[bind]
* {port}
"""
    r2h = R2HProcess(r2h_binary, port, config_content=config)
    r2h.start()
    yield r2h
    r2h.stop()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _m3u_get(shared_r2h, upstream_port, path, content_type="application/vnd.apple.mpegurl", path_prefix=""):
    """Convenience: GET an M3U path through the proxy and return decoded text."""
    status, hdrs, body = http_get(
        "127.0.0.1",
        shared_r2h.port,
        f"{path_prefix}/http/127.0.0.1:{upstream_port}{path}",
        timeout=_TIMEOUT,
    )
    return status, hdrs, body.decode("utf-8", errors="replace")


def _make_m3u_upstream(path, body, content_type="application/vnd.apple.mpegurl"):
    """Create and start a MockHTTPUpstream serving an M3U playlist."""
    upstream = MockHTTPUpstream(
        routes={
            path: {
                "status": 200,
                "body": body,
                "headers": {"Content-Type": content_type},
            },
        }
    )
    upstream.start()
    return upstream


class _RawHTTPResponseUpstream:
    """Serve a prebuilt raw HTTP response and keep the connection open."""

    def __init__(self, response, *, part_delay=0.0, keep_open=True, reset_after_send=False):
        self.port = find_free_port()
        self.response_parts = [response] if isinstance(response, bytes) else list(response)
        self.part_delay = part_delay
        self.keep_open = keep_open
        self.reset_after_send = reset_after_send
        self._server_sock = None
        self._thread = None
        self._stop = threading.Event()
        self._client_threads = []

    def start(self):
        self._server_sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._server_sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._server_sock.bind(("127.0.0.1", self.port))
        self._server_sock.listen(5)
        self._server_sock.settimeout(0.5)
        self._thread = threading.Thread(target=self._accept, daemon=True)
        self._thread.start()

    def stop(self):
        self._stop.set()
        if self._server_sock:
            self._server_sock.close()
        for thread in self._client_threads:
            thread.join(timeout=1)
        if self._thread:
            self._thread.join(timeout=3)

    def _accept(self):
        assert self._server_sock is not None
        while not self._stop.is_set():
            try:
                conn, _ = self._server_sock.accept()
            except socket.timeout:
                continue
            except OSError:
                break
            thread = threading.Thread(target=self._handle, args=(conn,), daemon=True)
            self._client_threads.append(thread)
            thread.start()

    def _handle(self, conn):
        try:
            conn.settimeout(1.0)
            request = b""
            while b"\r\n\r\n" not in request:
                chunk = conn.recv(1024)
                if not chunk:
                    return
                request += chunk
            for part in self.response_parts:
                conn.sendall(part)
                if self.part_delay > 0 and self._stop.wait(self.part_delay):
                    return
            if self.keep_open:
                self._stop.wait(_TIMEOUT * 2)
        except OSError:
            pass
        finally:
            if self.reset_after_send:
                try:
                    conn.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))
                except OSError:
                    pass
            conn.close()


def _make_padded_header_m3u_upstream(body, content_type="application/vnd.apple.mpegurl"):
    """Create an upstream whose first proxy header read contains no body bytes."""
    if isinstance(body, str):
        body = body.encode()
    prefix = (f"HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {len(body)}\r\nX-Pad: ").encode()
    suffix = b"\r\n\r\n"
    pad_len = _HEADER_PARSE_READ_SIZE - len(prefix) - len(suffix)
    assert pad_len > 0
    headers = prefix + (b"a" * pad_len) + suffix
    assert len(headers) == _HEADER_PARSE_READ_SIZE
    response = headers + body
    upstream = _RawHTTPResponseUpstream(response)
    upstream.start()
    return upstream


def _raw_chunked_headers(content_type="text/plain", transfer_encoding="chunked", trailer=None, content_length=None):
    headers = (
        "HTTP/1.1 200 OK\r\n"
        f"Content-Type: {content_type}\r\n"
        f"Transfer-Encoding: {transfer_encoding}\r\n"
        "Connection: keep-alive\r\n"
    )
    if trailer:
        headers += f"Trailer: {trailer}\r\n"
    if content_length is not None:
        headers += f"Content-Length: {content_length}\r\n"
    return (headers + "\r\n").encode()


# ---------------------------------------------------------------------------
# Basic absolute http:// URL rewriting
# ---------------------------------------------------------------------------


class TestM3URewriteAbsoluteHTTP:
    """Absolute http:// URLs in M3U segments should be rewritten."""

    def test_segment_urls_rewritten(self, shared_r2h):
        """http:// segment URLs should be rewritten to proxy format."""
        m3u = (
            "#EXTM3U\n"
            "#EXT-X-VERSION:3\n"
            "#EXT-X-TARGETDURATION:10\n"
            "#EXTINF:10,\n"
            "http://10.0.0.1:8080/seg1.ts\n"
            "#EXTINF:10,\n"
            "http://10.0.0.1:8080/seg2.ts\n"
        )
        upstream = _make_m3u_upstream("/live/playlist.m3u8", m3u)
        try:
            status, _, text = _m3u_get(shared_r2h, upstream.port, "/live/playlist.m3u8")
            assert status == 200
            assert "#EXTM3U" in text
            # Original http:// URLs should be replaced with proxy URLs
            assert "http://10.0.0.1:8080/seg1.ts" not in text
            assert "http://10.0.0.1:8080/seg2.ts" not in text
            assert "/http/10.0.0.1:8080/seg1.ts" in text
            assert "/http/10.0.0.1:8080/seg2.ts" in text
        finally:
            upstream.stop()

    def test_segment_urls_rewritten_with_app_path_prefix(self, prefixed_r2h):
        """Rewritten segment URLs should include app-path-prefix."""
        m3u = "#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\nhttp://10.0.0.1:8080/seg1.ts\n"
        upstream = _make_m3u_upstream("/live/playlist.m3u8", m3u)
        try:
            status, _, text = _m3u_get(
                prefixed_r2h,
                upstream.port,
                "/live/playlist.m3u8",
                path_prefix=APP_PREFIX,
            )
            assert status == 200
            assert "http://10.0.0.1:8080/seg1.ts" not in text
            assert f"{APP_PREFIX}/http/10.0.0.1:8080/seg1.ts" in text
        finally:
            upstream.stop()

    def test_segment_urls_rewritten_as_relative_with_app_path_prefix(self, relative_path_prefixed_r2h):
        """Relative M3U mode should omit scheme/host and keep app-path-prefix."""
        m3u = "#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\nhttp://10.0.0.1:8080/seg1.ts\n"
        upstream = _make_m3u_upstream("/live/playlist.m3u8", m3u)
        try:
            status, _, text = _m3u_get(
                relative_path_prefixed_r2h,
                upstream.port,
                "/live/playlist.m3u8",
                path_prefix=APP_PREFIX,
            )
            urls = [line for line in text.splitlines() if "seg1.ts" in line]

            assert status == 200
            assert urls == [f"{APP_PREFIX}/http/10.0.0.1:8080/seg1.ts"]
            assert "http://" not in text
        finally:
            upstream.stop()

    def test_variant_playlist_urls_rewritten(self, shared_r2h):
        """http:// URLs in a master/variant playlist should be rewritten."""
        m3u = (
            "#EXTM3U\n"
            "#EXT-X-STREAM-INF:BANDWIDTH=800000\n"
            "http://10.0.0.1:8080/low/index.m3u8\n"
            "#EXT-X-STREAM-INF:BANDWIDTH=2000000\n"
            "http://10.0.0.1:8080/high/index.m3u8\n"
        )
        upstream = _make_m3u_upstream("/master.m3u8", m3u)
        try:
            status, _, text = _m3u_get(shared_r2h, upstream.port, "/master.m3u8")
            assert status == 200
            assert "http://10.0.0.1:8080/low/index.m3u8" not in text
            assert "http://10.0.0.1:8080/high/index.m3u8" not in text
            assert "/http/10.0.0.1:8080/low/index.m3u8" in text
            assert "/http/10.0.0.1:8080/high/index.m3u8" in text
        finally:
            upstream.stop()

    def test_url_with_query_params_rewritten(self, shared_r2h):
        """Query parameters on segment URLs should be preserved after rewrite."""
        m3u = "#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\nhttp://10.0.0.1:8080/seg.ts?token=abc&t=123\n"
        upstream = _make_m3u_upstream("/playlist.m3u8", m3u)
        try:
            status, _, text = _m3u_get(shared_r2h, upstream.port, "/playlist.m3u8")
            assert status == 200
            assert "http://10.0.0.1:8080/" not in text
            assert "/http/10.0.0.1:8080/seg.ts?" in text
            assert "token=abc" in text
            assert "t=123" in text
        finally:
            upstream.stop()

    def test_port_80_url_rewritten(self, shared_r2h):
        """http:// URLs with default port 80 (no explicit port) should be rewritten."""
        m3u = "#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\nhttp://cdn.example.com/seg.ts\n"
        upstream = _make_m3u_upstream("/playlist.m3u8", m3u)
        try:
            status, _, text = _m3u_get(shared_r2h, upstream.port, "/playlist.m3u8")
            assert status == 200
            assert "http://cdn.example.com/seg.ts" not in text
            assert "/http/cdn.example.com/seg.ts" in text
        finally:
            upstream.stop()


# ---------------------------------------------------------------------------
# Relative URL rewriting
# ---------------------------------------------------------------------------


class TestM3URewriteRelativeURL:
    """Relative URLs in M3U should be resolved against the upstream and rewritten."""

    def test_bare_filename_resolved(self, shared_r2h):
        """A bare filename like 'segment.ts' should be resolved to upstream dir."""
        m3u = "#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\nsegment0.ts\n#EXTINF:10,\nsegment1.ts\n"
        upstream = _make_m3u_upstream("/live/stream/playlist.m3u8", m3u)
        try:
            status, _, text = _m3u_get(shared_r2h, upstream.port, "/live/stream/playlist.m3u8")
            assert status == 200
            # Should be resolved: /live/stream/ + segment0.ts
            lines = [line for line in text.splitlines() if "segment0.ts" in line]
            assert len(lines) == 1
            assert f"/http/127.0.0.1:{upstream.port}/live/stream/segment0.ts" in lines[0]
            lines1 = [line for line in text.splitlines() if "segment1.ts" in line]
            assert len(lines1) == 1
            assert f"/http/127.0.0.1:{upstream.port}/live/stream/segment1.ts" in lines1[0]
        finally:
            upstream.stop()

    def test_absolute_path_resolved(self, shared_r2h):
        """An absolute path like '/segments/seg.ts' should use upstream host."""
        m3u = "#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\n/segments/seg0.ts\n"
        upstream = _make_m3u_upstream("/live/playlist.m3u8", m3u)
        try:
            status, _, text = _m3u_get(shared_r2h, upstream.port, "/live/playlist.m3u8")
            assert status == 200
            lines = [line for line in text.splitlines() if "seg0.ts" in line]
            assert len(lines) == 1
            assert f"/http/127.0.0.1:{upstream.port}/segments/seg0.ts" in lines[0]
        finally:
            upstream.stop()

    def test_relative_subdir_resolved(self, shared_r2h):
        """A relative path like 'subdir/seg.ts' should be resolved to upstream dir."""
        m3u = "#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\nhd/seg0.ts\n"
        upstream = _make_m3u_upstream("/live/playlist.m3u8", m3u)
        try:
            status, _, text = _m3u_get(shared_r2h, upstream.port, "/live/playlist.m3u8")
            assert status == 200
            lines = [line for line in text.splitlines() if "seg0.ts" in line]
            assert len(lines) == 1
            assert f"/http/127.0.0.1:{upstream.port}/live/hd/seg0.ts" in lines[0]
        finally:
            upstream.stop()


# ---------------------------------------------------------------------------
# https:// URLs should NOT be rewritten
# ---------------------------------------------------------------------------


class TestM3URewriteHTTPS:
    """https:// URLs should be passed through unchanged."""

    def test_https_segment_not_rewritten(self, shared_r2h):
        """https:// segment URLs should remain unchanged in the output."""
        m3u = "#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\nhttps://secure.example.com/seg.ts\n"
        upstream = _make_m3u_upstream("/playlist.m3u8", m3u)
        try:
            status, _, text = _m3u_get(shared_r2h, upstream.port, "/playlist.m3u8")
            assert status == 200
            assert "https://secure.example.com/seg.ts" in text
        finally:
            upstream.stop()

    def test_mixed_http_https(self, shared_r2h):
        """http:// should be rewritten, https:// should be preserved."""
        m3u = (
            "#EXTM3U\n"
            "#EXT-X-TARGETDURATION:10\n"
            "#EXTINF:10,\n"
            "http://10.0.0.1:8080/seg1.ts\n"
            "#EXTINF:10,\n"
            "https://secure.cdn.com/seg2.ts\n"
        )
        upstream = _make_m3u_upstream("/playlist.m3u8", m3u)
        try:
            status, _, text = _m3u_get(shared_r2h, upstream.port, "/playlist.m3u8")
            assert status == 200
            assert "http://10.0.0.1:8080/seg1.ts" not in text
            assert "/http/10.0.0.1:8080/seg1.ts" in text
            assert "https://secure.cdn.com/seg2.ts" in text
        finally:
            upstream.stop()


# ---------------------------------------------------------------------------
# URI= attribute rewriting in HLS tags
# ---------------------------------------------------------------------------


class TestM3URewriteURIAttribute:
    """URI= attributes in HLS tags (#EXT-X-KEY, #EXT-X-MAP, etc.) should be rewritten."""

    def test_ext_x_key_uri_rewritten(self, shared_r2h):
        """#EXT-X-KEY URI attribute should be rewritten."""
        m3u = (
            "#EXTM3U\n"
            "#EXT-X-VERSION:3\n"
            "#EXT-X-TARGETDURATION:10\n"
            '#EXT-X-KEY:METHOD=AES-128,URI="http://10.0.0.1:8080/key.bin"\n'
            "#EXTINF:10,\n"
            "http://10.0.0.1:8080/seg1.ts\n"
        )
        upstream = _make_m3u_upstream("/playlist.m3u8", m3u)
        try:
            status, _, text = _m3u_get(shared_r2h, upstream.port, "/playlist.m3u8")
            assert status == 200
            assert "http://10.0.0.1:8080/key.bin" not in text
            assert "/http/10.0.0.1:8080/key.bin" in text
            # Should still have the EXT-X-KEY tag structure
            assert "#EXT-X-KEY:" in text
            assert "METHOD=AES-128" in text
        finally:
            upstream.stop()

    def test_ext_x_map_uri_rewritten(self, shared_r2h):
        """#EXT-X-MAP URI attribute should be rewritten."""
        m3u = (
            "#EXTM3U\n"
            "#EXT-X-VERSION:7\n"
            "#EXT-X-TARGETDURATION:6\n"
            '#EXT-X-MAP:URI="http://10.0.0.1:8080/init.mp4"\n'
            "#EXTINF:6,\n"
            "http://10.0.0.1:8080/seg1.m4s\n"
        )
        upstream = _make_m3u_upstream("/playlist.m3u8", m3u)
        try:
            status, _, text = _m3u_get(shared_r2h, upstream.port, "/playlist.m3u8")
            assert status == 200
            assert "http://10.0.0.1:8080/init.mp4" not in text
            assert "/http/10.0.0.1:8080/init.mp4" in text
            assert "#EXT-X-MAP:" in text
        finally:
            upstream.stop()

    def test_uri_attribute_https_not_rewritten(self, shared_r2h):
        """https:// URI attribute should NOT be rewritten."""
        m3u = (
            "#EXTM3U\n"
            "#EXT-X-TARGETDURATION:10\n"
            '#EXT-X-KEY:METHOD=AES-128,URI="https://drm.example.com/key"\n'
            "#EXTINF:10,\n"
            "http://10.0.0.1:8080/seg1.ts\n"
        )
        upstream = _make_m3u_upstream("/playlist.m3u8", m3u)
        try:
            status, _, text = _m3u_get(shared_r2h, upstream.port, "/playlist.m3u8")
            assert status == 200
            assert "https://drm.example.com/key" in text
            # But the http:// segment should still be rewritten
            assert "/http/10.0.0.1:8080/seg1.ts" in text
        finally:
            upstream.stop()

    def test_uri_with_additional_attributes(self, shared_r2h):
        """URI= with other attributes on the same tag should be rewritten correctly."""
        m3u = (
            "#EXTM3U\n"
            "#EXT-X-TARGETDURATION:10\n"
            '#EXT-X-KEY:METHOD=AES-128,URI="http://10.0.0.1:8080/key",IV=0x1234\n'
            "#EXTINF:10,\n"
            "http://10.0.0.1:8080/seg.ts\n"
        )
        upstream = _make_m3u_upstream("/playlist.m3u8", m3u)
        try:
            status, _, text = _m3u_get(shared_r2h, upstream.port, "/playlist.m3u8")
            assert status == 200
            assert "/http/10.0.0.1:8080/key" in text
            assert "IV=0x1234" in text
            assert "METHOD=AES-128" in text
        finally:
            upstream.stop()


# ---------------------------------------------------------------------------
# Comment lines and metadata pass-through
# ---------------------------------------------------------------------------


class TestM3URewritePassthrough:
    """Non-URL lines (comments, HLS tags without URI) should pass through unchanged."""

    def test_hls_tags_preserved(self, shared_r2h):
        """HLS tags like #EXT-X-VERSION, #EXT-X-TARGETDURATION should be preserved."""
        m3u = (
            "#EXTM3U\n"
            "#EXT-X-VERSION:3\n"
            "#EXT-X-TARGETDURATION:10\n"
            "#EXT-X-MEDIA-SEQUENCE:42\n"
            "#EXTINF:9.009,\n"
            "http://10.0.0.1:8080/seg.ts\n"
            "#EXT-X-ENDLIST\n"
        )
        upstream = _make_m3u_upstream("/playlist.m3u8", m3u)
        try:
            status, _, text = _m3u_get(shared_r2h, upstream.port, "/playlist.m3u8")
            assert status == 200
            assert "#EXTM3U" in text
            assert "#EXT-X-VERSION:3" in text
            assert "#EXT-X-TARGETDURATION:10" in text
            assert "#EXT-X-MEDIA-SEQUENCE:42" in text
            assert "#EXTINF:9.009," in text
            assert "#EXT-X-ENDLIST" in text
        finally:
            upstream.stop()

    def test_empty_lines_preserved(self, shared_r2h):
        """Empty lines in the playlist should not cause issues."""
        m3u = "#EXTM3U\n\n#EXT-X-TARGETDURATION:10\n\n#EXTINF:10,\nhttp://10.0.0.1:8080/seg.ts\n\n"
        upstream = _make_m3u_upstream("/playlist.m3u8", m3u)
        try:
            status, _, text = _m3u_get(shared_r2h, upstream.port, "/playlist.m3u8")
            assert status == 200
            assert "#EXTM3U" in text
            assert "/http/10.0.0.1:8080/seg.ts" in text
        finally:
            upstream.stop()


# ---------------------------------------------------------------------------
# Content-Type detection
# ---------------------------------------------------------------------------


class TestM3URewriteContentType:
    """M3U URLs take priority, with Content-Type used as a fallback."""

    @pytest.mark.parametrize(
        ("route_path", "request_path"),
        [
            ("/playlist.m3u8", "/playlist.m3u8"),
            ("/playlist.m3u", "/playlist.m3u"),
            ("/playlist.M3U8", "/playlist.M3U8"),
            ("/playlist.m3u8", "/playlist.m3u8?token=test"),
        ],
    )
    def test_m3u_url_extension_overrides_content_type(self, shared_r2h, route_path, request_path):
        """M3U path extensions should trigger rewriting regardless of Content-Type."""
        m3u = "#EXTM3U\n#EXTINF:10,\nhttp://10.0.0.1:8080/seg.ts\n"
        upstream = _make_m3u_upstream(route_path, m3u, content_type="text/plain")
        try:
            status, _, text = _m3u_get(shared_r2h, upstream.port, request_path)
            assert status == 200
            assert "http://10.0.0.1:8080/seg.ts" not in text
            assert "/http/10.0.0.1:8080/seg.ts" in text
        finally:
            upstream.stop()

    def test_application_vnd_apple_mpegurl(self, shared_r2h):
        """application/vnd.apple.mpegurl should trigger rewriting."""
        m3u = "#EXTM3U\n#EXTINF:10,\nhttp://10.0.0.1:8080/seg.ts\n"
        upstream = _make_m3u_upstream(
            "/playlist.m3u8",
            m3u,
            content_type="application/vnd.apple.mpegurl",
        )
        try:
            status, _, text = _m3u_get(shared_r2h, upstream.port, "/playlist.m3u8")
            assert status == 200
            assert "http://10.0.0.1:8080/seg.ts" not in text
            assert "/http/10.0.0.1:8080/seg.ts" in text
        finally:
            upstream.stop()

    def test_application_x_mpegurl(self, shared_r2h):
        """application/x-mpegurl should trigger rewriting."""
        m3u = "#EXTM3U\n#EXTINF:10,\nhttp://10.0.0.1:8080/seg.ts\n"
        upstream = _make_m3u_upstream(
            "/playlist.m3u8",
            m3u,
            content_type="application/x-mpegurl",
        )
        try:
            status, _, text = _m3u_get(shared_r2h, upstream.port, "/playlist.m3u8")
            assert status == 200
            assert "http://10.0.0.1:8080/seg.ts" not in text
        finally:
            upstream.stop()

    def test_audio_x_mpegurl(self, shared_r2h):
        """audio/x-mpegurl should trigger rewriting."""
        m3u = "#EXTM3U\n#EXTINF:10,\nhttp://10.0.0.1:8080/seg.ts\n"
        upstream = _make_m3u_upstream(
            "/playlist.m3u8",
            m3u,
            content_type="audio/x-mpegurl",
        )
        try:
            status, _, text = _m3u_get(shared_r2h, upstream.port, "/playlist.m3u8")
            assert status == 200
            assert "http://10.0.0.1:8080/seg.ts" not in text
        finally:
            upstream.stop()

    def test_audio_mpegurl(self, shared_r2h):
        """audio/mpegurl should trigger rewriting."""
        m3u = "#EXTM3U\n#EXTINF:10,\nhttp://10.0.0.1:8080/seg.ts\n"
        upstream = _make_m3u_upstream(
            "/playlist.m3u8",
            m3u,
            content_type="audio/mpegurl",
        )
        try:
            status, _, text = _m3u_get(shared_r2h, upstream.port, "/playlist.m3u8")
            assert status == 200
            assert "http://10.0.0.1:8080/seg.ts" not in text
        finally:
            upstream.stop()

    def test_non_m3u_content_not_rewritten(self, shared_r2h):
        """text/plain content should NOT have URLs rewritten."""
        body = "http://10.0.0.1:8080/seg.ts\n"
        upstream = MockHTTPUpstream(
            routes={
                "/data.txt": {
                    "status": 200,
                    "body": body,
                    "headers": {"Content-Type": "text/plain"},
                },
            }
        )
        upstream.start()
        try:
            status, _, raw = http_get(
                "127.0.0.1",
                shared_r2h.port,
                f"/http/127.0.0.1:{upstream.port}/data.txt",
                timeout=_TIMEOUT,
            )
            text = raw.decode("utf-8", errors="replace")
            assert status == 200
            # URL should be passed through unchanged
            assert "http://10.0.0.1:8080/seg.ts" in text
        finally:
            upstream.stop()

    def test_content_type_with_charset(self, shared_r2h):
        """Content-Type with charset parameter should still trigger rewrite."""
        m3u = "#EXTM3U\n#EXTINF:10,\nhttp://10.0.0.1:8080/seg.ts\n"
        upstream = _make_m3u_upstream(
            "/playlist.m3u8",
            m3u,
            content_type="application/vnd.apple.mpegurl; charset=utf-8",
        )
        try:
            status, _, text = _m3u_get(shared_r2h, upstream.port, "/playlist.m3u8")
            assert status == 200
            assert "http://10.0.0.1:8080/seg.ts" not in text
            assert "/http/10.0.0.1:8080/seg.ts" in text
        finally:
            upstream.stop()

    def test_m3u_url_redirect_keeps_http_redirect_semantics(self, shared_r2h):
        """A redirect from an M3U URL should rewrite Location, not its HTML body."""
        redirect_body = b"<html>redirecting</html>\n"
        upstream = MockHTTPUpstream(
            routes={
                "/archive/index.m3u8": {
                    "status": 302,
                    "body": redirect_body,
                    "headers": {
                        "Content-Type": "text/html",
                        "Location": "http://10.0.0.1:8080/final/index.m3u8",
                    },
                },
            }
        )
        upstream.start()
        try:
            status, hdrs, body = http_get(
                "127.0.0.1",
                shared_r2h.port,
                f"/http/127.0.0.1:{upstream.port}/archive/index.m3u8",
                timeout=_TIMEOUT,
            )

            assert status == 302
            assert get_header(hdrs, "Location") == "/http/10.0.0.1:8080/final/index.m3u8"
            assert body == redirect_body
        finally:
            upstream.stop()


# ---------------------------------------------------------------------------
# Complex / realistic playlists
# ---------------------------------------------------------------------------


class TestM3URewriteRealistic:
    """More realistic playlist scenarios."""

    def test_full_hls_media_playlist(self, shared_r2h):
        """A complete HLS media playlist with multiple segments."""
        m3u = (
            "#EXTM3U\n"
            "#EXT-X-VERSION:3\n"
            "#EXT-X-TARGETDURATION:10\n"
            "#EXT-X-MEDIA-SEQUENCE:100\n"
            '#EXT-X-KEY:METHOD=AES-128,URI="http://10.0.0.1:8080/keys/key100.bin",IV=0x00000064\n'
            "#EXTINF:9.009,\n"
            "http://10.0.0.1:8080/segments/seg100.ts\n"
            "#EXTINF:10.010,\n"
            "http://10.0.0.1:8080/segments/seg101.ts\n"
            "#EXTINF:8.008,\n"
            "http://10.0.0.1:8080/segments/seg102.ts\n"
            "#EXT-X-ENDLIST\n"
        )
        upstream = _make_m3u_upstream("/live/index.m3u8", m3u)
        try:
            status, _, text = _m3u_get(shared_r2h, upstream.port, "/live/index.m3u8")
            assert status == 200
            # All three segments should be rewritten
            for i in range(100, 103):
                assert f"http://10.0.0.1:8080/segments/seg{i}.ts" not in text
                assert f"/http/10.0.0.1:8080/segments/seg{i}.ts" in text
            # Key URI should be rewritten
            assert "http://10.0.0.1:8080/keys/key100.bin" not in text
            assert "/http/10.0.0.1:8080/keys/key100.bin" in text
            # Tags and attributes preserved
            assert "#EXT-X-MEDIA-SEQUENCE:100" in text
            assert "IV=0x00000064" in text
        finally:
            upstream.stop()


# ---------------------------------------------------------------------------
# Chunked transfer decoding
# ---------------------------------------------------------------------------


class TestM3URewriteChunked:
    """Chunk framing should be removed only for M3U rewrite responses."""

    def test_chunked_text_plain_m3u_is_decoded_and_rewritten(self, shared_r2h):
        """Regression: chunk sizes and the zero chunk must not become playlist URLs."""
        first = b"#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:8\n"
        second = b"#EXTINF:8.000,\n321124334400000.jpeg\n"
        headers = _raw_chunked_headers(trailer="X-Playlist-Checksum", content_length=1)
        response_parts = [
            headers,
            f"{len(first):X};source=test\r".encode(),
            b"\n",
            first[:7],
            first[7:],
            b"\r",
            b"\n",
            f"{len(second):x}\r\n".encode(),
            second[:-1],
            second[-1:],
            b"\r\n0\r",
            b"\nX-Playlist-Checksum: ok\r\n",
            b"\r",
            b"\n",
        ]
        upstream = _RawHTTPResponseUpstream(response_parts, part_delay=0.005)
        upstream.start()
        try:
            status, hdrs, body = http_get(
                "127.0.0.1",
                shared_r2h.port,
                f"/http/127.0.0.1:{upstream.port}/video/index.m3u8",
                timeout=2.0,
            )
            text = body.decode()
            assert status == 200
            assert text.startswith("#EXTM3U\n")
            assert f"/http/127.0.0.1:{upstream.port}/video/321124334400000.jpeg" in text
            assert not any(line.endswith("/0") for line in text.splitlines())
            assert get_header(hdrs, "Transfer-Encoding") == ""
            assert get_header(hdrs, "Trailer") == ""
            assert int(get_header(hdrs, "Content-Length")) == len(body)
        finally:
            upstream.stop()

    def test_empty_chunked_m3u_returns_empty_content_length_body(self, shared_r2h):
        upstream = _RawHTTPResponseUpstream(_raw_chunked_headers() + b"0\r\n\r\n")
        upstream.start()
        try:
            status, hdrs, body = http_get(
                "127.0.0.1",
                shared_r2h.port,
                f"/http/127.0.0.1:{upstream.port}/empty.m3u8",
                timeout=2.0,
            )
            assert status == 200
            assert body == b""
            assert get_header(hdrs, "Content-Length") == "0"
            assert get_header(hdrs, "Transfer-Encoding") == ""
        finally:
            upstream.stop()

    def test_complete_chunked_m3u_survives_immediate_upstream_reset(self, shared_r2h):
        playlist = b"#EXTM3U\n#EXTINF:8.000,\nsegment.ts\n"
        response = _raw_chunked_headers() + f"{len(playlist):x}\r\n".encode() + playlist + b"\r\n0\r\n\r\n"
        upstream = _RawHTTPResponseUpstream(response, keep_open=False, reset_after_send=True)
        upstream.start()
        try:
            status, hdrs, body = http_get(
                "127.0.0.1",
                shared_r2h.port,
                f"/http/127.0.0.1:{upstream.port}/reset.m3u8",
                timeout=2.0,
            )
            assert status == 200
            assert f"/http/127.0.0.1:{upstream.port}/segment.ts".encode() in body
            assert int(get_header(hdrs, "Content-Length")) == len(body)
        finally:
            upstream.stop()

    def test_non_m3u_chunked_response_remains_passthrough(self, shared_r2h):
        response = _raw_chunked_headers(content_type="application/octet-stream") + b"5\r\nhello\r\n0\r\n\r\n"
        upstream = _RawHTTPResponseUpstream(response)
        upstream.start()
        try:
            status, hdrs, body = http_get(
                "127.0.0.1",
                shared_r2h.port,
                f"/http/127.0.0.1:{upstream.port}/data.bin",
                timeout=2.0,
            )
            assert status == 200
            assert get_header(hdrs, "Transfer-Encoding").lower() == "chunked"
            assert body == b"hello"
        finally:
            upstream.stop()

    @pytest.mark.parametrize(
        ("chunked_body", "keep_open"),
        [
            (b"Z\r\n", True),
            (b"10000000000000000\r\n", True),
            (b"1;" + b"a" * 4095 + b"\r\nx\r\n0\r\n\r\n", True),
            (b"3\r\nabcX\n0\r\n\r\n", True),
            (b"0\r\nX: " + b"a" * 8192 + b"\r\n\r\n", True),
            (b"0\r\nX: invalid\n\r\n", True),
            (b"5\r\nhello\r\n", False),
        ],
        ids=[
            "invalid-size",
            "size-overflow",
            "oversized-size-line",
            "invalid-data-crlf",
            "oversized-trailer",
            "invalid-trailer-crlf",
            "missing-zero-chunk",
        ],
    )
    def test_malformed_chunked_m3u_returns_503(self, shared_r2h, chunked_body, keep_open):
        upstream = _RawHTTPResponseUpstream(_raw_chunked_headers() + chunked_body, keep_open=keep_open)
        upstream.start()
        try:
            status, _, body = http_get(
                "127.0.0.1",
                shared_r2h.port,
                f"/http/127.0.0.1:{upstream.port}/invalid.m3u8",
                timeout=2.0,
            )
            assert status == 503
            assert b"Service Unavailable" in body
        finally:
            upstream.stop()

    def test_unsupported_transfer_coding_returns_503(self, shared_r2h):
        response = _raw_chunked_headers(transfer_encoding="gzip, chunked") + b"0\r\n\r\n"
        upstream = _RawHTTPResponseUpstream(response)
        upstream.start()
        try:
            status, _, _ = http_get(
                "127.0.0.1",
                shared_r2h.port,
                f"/http/127.0.0.1:{upstream.port}/encoded.m3u8",
                timeout=2.0,
            )
            assert status == 503
        finally:
            upstream.stop()


class TestM3URewritePlaylistVariants:
    """Master, mixed-source, and large playlist scenarios."""

    def test_master_playlist_with_audio(self, shared_r2h):
        """A master playlist with #EXT-X-MEDIA and URI for audio renditions."""
        m3u = (
            "#EXTM3U\n"
            '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="English",URI="http://10.0.0.1:8080/audio/en.m3u8"\n'
            '#EXT-X-STREAM-INF:BANDWIDTH=2000000,AUDIO="aac"\n'
            "http://10.0.0.1:8080/video/high.m3u8\n"
        )
        upstream = _make_m3u_upstream("/master.m3u8", m3u)
        try:
            status, _, text = _m3u_get(shared_r2h, upstream.port, "/master.m3u8")
            assert status == 200
            # Audio URI should be rewritten
            assert "http://10.0.0.1:8080/audio/en.m3u8" not in text
            assert "/http/10.0.0.1:8080/audio/en.m3u8" in text
            # Video stream URL should be rewritten
            assert "http://10.0.0.1:8080/video/high.m3u8" not in text
            assert "/http/10.0.0.1:8080/video/high.m3u8" in text
        finally:
            upstream.stop()

    def test_mixed_absolute_and_relative(self, shared_r2h):
        """Playlist with a mix of absolute and relative URLs."""
        m3u = (
            "#EXTM3U\n"
            "#EXT-X-TARGETDURATION:10\n"
            "#EXTINF:10,\n"
            "http://10.0.0.1:8080/cdn/seg1.ts\n"
            "#EXTINF:10,\n"
            "seg2.ts\n"
            "#EXTINF:10,\n"
            "/absolute/seg3.ts\n"
        )
        upstream = _make_m3u_upstream("/live/stream/playlist.m3u8", m3u)
        try:
            status, _, text = _m3u_get(shared_r2h, upstream.port, "/live/stream/playlist.m3u8")
            assert status == 200
            # Absolute http:// rewritten
            assert "/http/10.0.0.1:8080/cdn/seg1.ts" in text
            # Relative resolved to upstream dir + rewritten
            assert f"/http/127.0.0.1:{upstream.port}/live/stream/seg2.ts" in text
            # Absolute path resolved to upstream host + rewritten
            assert f"/http/127.0.0.1:{upstream.port}/absolute/seg3.ts" in text
        finally:
            upstream.stop()

    @pytest.mark.parametrize("upstream_mode", ["normal_headers", "padded_header_only"], ids=["normal", "header-only"])
    def test_large_playlist_body_is_fully_buffered(self, shared_r2h, upstream_mode):
        """A large M3U body should be fully read after header parsing."""
        segment_count = 4096
        segments = "".join("#EXTINF:10,\nsegment-%04d.ts?token=abcdef0123456789\n" % i for i in range(segment_count))
        m3u = "#EXTM3U\n#EXT-X-TARGETDURATION:10\n" + segments + "#EXT-X-ENDLIST\n"
        if upstream_mode == "normal_headers":
            upstream = _make_m3u_upstream("/lookback/long.m3u8", m3u)
        else:
            upstream = _make_padded_header_m3u_upstream(m3u)
        try:
            status, hdrs, body = stream_get(
                "127.0.0.1",
                shared_r2h.port,
                f"/http/127.0.0.1:{upstream.port}/lookback/long.m3u8",
                read_bytes=512 * 1024,
                timeout=_TIMEOUT,
            )
            text = body.decode("utf-8", errors="replace")
            assert status == 200
            assert f"/http/127.0.0.1:{upstream.port}/lookback/segment-0000.ts?token=abcdef0123456789" in text
            assert (
                f"/http/127.0.0.1:{upstream.port}/lookback/segment-{segment_count - 1:04d}.ts?token=abcdef0123456789"
                in text
            )
            cl = hdrs.get("content-length")
            assert cl is not None
            assert int(cl) == len(body)
        finally:
            upstream.stop()


# ---------------------------------------------------------------------------
# Edge cases
# ---------------------------------------------------------------------------


class TestM3URewriteEdgeCases:
    """Edge cases for M3U rewriting."""

    def test_empty_m3u_body(self, shared_r2h):
        """An empty M3U body should be returned without error."""
        upstream = _make_m3u_upstream("/empty.m3u8", "")
        try:
            status, _, text = _m3u_get(shared_r2h, upstream.port, "/empty.m3u8")
            assert status == 200
            assert text == ""
        finally:
            upstream.stop()

    def test_m3u_header_only(self, shared_r2h):
        """An M3U with only #EXTM3U and no segments should pass through."""
        m3u = "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXT-X-ENDLIST\n"
        upstream = _make_m3u_upstream("/empty-pl.m3u8", m3u)
        try:
            status, _, text = _m3u_get(shared_r2h, upstream.port, "/empty-pl.m3u8")
            assert status == 200
            assert "#EXTM3U" in text
            assert "#EXT-X-ENDLIST" in text
        finally:
            upstream.stop()

    def test_url_with_uri_in_path(self, shared_r2h):
        """A URL containing 'URI=' as part of the path should not confuse the parser."""
        m3u = "#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\nhttp://10.0.0.1:8080/path/with/URI=value/seg.ts\n"
        upstream = _make_m3u_upstream("/playlist.m3u8", m3u)
        try:
            status, _, text = _m3u_get(shared_r2h, upstream.port, "/playlist.m3u8")
            assert status == 200
            # The URL line should be rewritten as a whole URL, not parsed for URI=
            assert "/http/10.0.0.1:8080/" in text
            assert "seg.ts" in text
        finally:
            upstream.stop()

    def test_windows_line_endings(self, shared_r2h):
        """M3U with \\r\\n line endings should be handled correctly."""
        m3u = "#EXTM3U\r\n#EXT-X-TARGETDURATION:10\r\n#EXTINF:10,\r\nhttp://10.0.0.1:8080/seg.ts\r\n"
        upstream = _make_m3u_upstream("/playlist.m3u8", m3u)
        try:
            status, _, text = _m3u_get(shared_r2h, upstream.port, "/playlist.m3u8")
            assert status == 200
            assert "#EXTM3U" in text
            assert "/http/10.0.0.1:8080/seg.ts" in text
        finally:
            upstream.stop()

    def test_no_trailing_newline(self, shared_r2h):
        """M3U without a trailing newline should still work."""
        m3u = (
            "#EXTM3U\n"
            "#EXT-X-TARGETDURATION:10\n"
            "#EXTINF:10,\n"
            "http://10.0.0.1:8080/seg.ts"  # no trailing \n
        )
        upstream = _make_m3u_upstream("/playlist.m3u8", m3u)
        try:
            status, _, text = _m3u_get(shared_r2h, upstream.port, "/playlist.m3u8")
            assert status == 200
            assert "/http/10.0.0.1:8080/seg.ts" in text
        finally:
            upstream.stop()

    def test_multiple_different_hosts(self, shared_r2h):
        """Segments from different hosts should each be rewritten correctly."""
        m3u = (
            "#EXTM3U\n"
            "#EXT-X-TARGETDURATION:10\n"
            "#EXTINF:10,\n"
            "http://cdn1.example.com:8080/seg1.ts\n"
            "#EXTINF:10,\n"
            "http://cdn2.example.com:9090/seg2.ts\n"
        )
        upstream = _make_m3u_upstream("/playlist.m3u8", m3u)
        try:
            status, _, text = _m3u_get(shared_r2h, upstream.port, "/playlist.m3u8")
            assert status == 200
            assert "/http/cdn1.example.com:8080/seg1.ts" in text
            assert "/http/cdn2.example.com:9090/seg2.ts" in text
        finally:
            upstream.stop()

    def test_content_length_updated(self, shared_r2h):
        """After rewriting, the Content-Length should match the actual body size."""
        m3u = "#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\nhttp://10.0.0.1:8080/seg.ts\n"
        upstream = _make_m3u_upstream("/playlist.m3u8", m3u)
        try:
            status, hdrs, text = _m3u_get(shared_r2h, upstream.port, "/playlist.m3u8")
            assert status == 200
            cl = hdrs.get("Content-Length", hdrs.get("content-length"))
            if cl is not None:
                assert int(cl) == len(text.encode("utf-8"))
        finally:
            upstream.stop()
