"""
E2E tests for M3U content rewriting through the HTTP reverse proxy.

When rtp2httpd proxies an M3U/HLS playlist, it rewrites URLs inside the
playlist body so that segment / sub-playlist fetches also go through the
proxy.  These tests verify the rewriting logic end-to-end.
"""

import pytest

from helpers import (
    MockHTTPUpstream,
    R2HProcess,
    find_free_port,
    http_get,
)

pytestmark = pytest.mark.http_proxy

_TIMEOUT = 5.0


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


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _m3u_get(shared_r2h, upstream_port, path, content_type="application/vnd.apple.mpegurl"):
    """Convenience: GET an M3U path through the proxy and return decoded text."""
    status, hdrs, body = http_get(
        "127.0.0.1", shared_r2h.port,
        f"/http/127.0.0.1:{upstream_port}{path}",
        timeout=_TIMEOUT,
    )
    return status, hdrs, body.decode("utf-8", errors="replace")


def _make_m3u_upstream(path, body, content_type="application/vnd.apple.mpegurl"):
    """Create and start a MockHTTPUpstream serving an M3U playlist."""
    upstream = MockHTTPUpstream(routes={
        path: {
            "status": 200,
            "body": body,
            "headers": {"Content-Type": content_type},
        },
    })
    upstream.start()
    return upstream


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
        m3u = (
            "#EXTM3U\n"
            "#EXT-X-TARGETDURATION:10\n"
            "#EXTINF:10,\n"
            "http://10.0.0.1:8080/seg.ts?token=abc&t=123\n"
        )
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
        m3u = (
            "#EXTM3U\n"
            "#EXT-X-TARGETDURATION:10\n"
            "#EXTINF:10,\n"
            "http://cdn.example.com/seg.ts\n"
        )
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
        m3u = (
            "#EXTM3U\n"
            "#EXT-X-TARGETDURATION:10\n"
            "#EXTINF:10,\n"
            "segment0.ts\n"
            "#EXTINF:10,\n"
            "segment1.ts\n"
        )
        upstream = _make_m3u_upstream("/live/stream/playlist.m3u8", m3u)
        try:
            status, _, text = _m3u_get(shared_r2h, upstream.port, "/live/stream/playlist.m3u8")
            assert status == 200
            # Should be resolved: /live/stream/ + segment0.ts
            lines = [l for l in text.splitlines() if "segment0.ts" in l]
            assert len(lines) == 1
            assert f"/http/127.0.0.1:{upstream.port}/live/stream/segment0.ts" in lines[0]
            lines1 = [l for l in text.splitlines() if "segment1.ts" in l]
            assert len(lines1) == 1
            assert f"/http/127.0.0.1:{upstream.port}/live/stream/segment1.ts" in lines1[0]
        finally:
            upstream.stop()

    def test_absolute_path_resolved(self, shared_r2h):
        """An absolute path like '/segments/seg.ts' should use upstream host."""
        m3u = (
            "#EXTM3U\n"
            "#EXT-X-TARGETDURATION:10\n"
            "#EXTINF:10,\n"
            "/segments/seg0.ts\n"
        )
        upstream = _make_m3u_upstream("/live/playlist.m3u8", m3u)
        try:
            status, _, text = _m3u_get(shared_r2h, upstream.port, "/live/playlist.m3u8")
            assert status == 200
            lines = [l for l in text.splitlines() if "seg0.ts" in l]
            assert len(lines) == 1
            assert f"/http/127.0.0.1:{upstream.port}/segments/seg0.ts" in lines[0]
        finally:
            upstream.stop()

    def test_relative_subdir_resolved(self, shared_r2h):
        """A relative path like 'subdir/seg.ts' should be resolved to upstream dir."""
        m3u = (
            "#EXTM3U\n"
            "#EXT-X-TARGETDURATION:10\n"
            "#EXTINF:10,\n"
            "hd/seg0.ts\n"
        )
        upstream = _make_m3u_upstream("/live/playlist.m3u8", m3u)
        try:
            status, _, text = _m3u_get(shared_r2h, upstream.port, "/live/playlist.m3u8")
            assert status == 200
            lines = [l for l in text.splitlines() if "seg0.ts" in l]
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
        m3u = (
            "#EXTM3U\n"
            "#EXT-X-TARGETDURATION:10\n"
            "#EXTINF:10,\n"
            "https://secure.example.com/seg.ts\n"
        )
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
        m3u = (
            "#EXTM3U\n"
            "\n"
            "#EXT-X-TARGETDURATION:10\n"
            "\n"
            "#EXTINF:10,\n"
            "http://10.0.0.1:8080/seg.ts\n"
            "\n"
        )
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
    """Only M3U content types should trigger rewriting."""

    def test_application_vnd_apple_mpegurl(self, shared_r2h):
        """application/vnd.apple.mpegurl should trigger rewriting."""
        m3u = "#EXTM3U\n#EXTINF:10,\nhttp://10.0.0.1:8080/seg.ts\n"
        upstream = _make_m3u_upstream(
            "/playlist.m3u8", m3u,
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
            "/playlist.m3u8", m3u,
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
            "/playlist.m3u8", m3u,
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
            "/playlist.m3u8", m3u,
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
        upstream = MockHTTPUpstream(routes={
            "/data.txt": {
                "status": 200,
                "body": body,
                "headers": {"Content-Type": "text/plain"},
            },
        })
        upstream.start()
        try:
            status, _, raw = http_get(
                "127.0.0.1", shared_r2h.port,
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
            "/playlist.m3u8", m3u,
            content_type="application/vnd.apple.mpegurl; charset=utf-8",
        )
        try:
            status, _, text = _m3u_get(shared_r2h, upstream.port, "/playlist.m3u8")
            assert status == 200
            assert "http://10.0.0.1:8080/seg.ts" not in text
            assert "/http/10.0.0.1:8080/seg.ts" in text
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

    def test_master_playlist_with_audio(self, shared_r2h):
        """A master playlist with #EXT-X-MEDIA and URI for audio renditions."""
        m3u = (
            "#EXTM3U\n"
            '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="English",URI="http://10.0.0.1:8080/audio/en.m3u8"\n'
            "#EXT-X-STREAM-INF:BANDWIDTH=2000000,AUDIO=\"aac\"\n"
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
        m3u = (
            "#EXTM3U\n"
            "#EXT-X-TARGETDURATION:10\n"
            "#EXTINF:10,\n"
            "http://10.0.0.1:8080/path/with/URI=value/seg.ts\n"
        )
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
        m3u = (
            "#EXTM3U\r\n"
            "#EXT-X-TARGETDURATION:10\r\n"
            "#EXTINF:10,\r\n"
            "http://10.0.0.1:8080/seg.ts\r\n"
        )
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
        m3u = (
            "#EXTM3U\n"
            "#EXT-X-TARGETDURATION:10\n"
            "#EXTINF:10,\n"
            "http://10.0.0.1:8080/seg.ts\n"
        )
        upstream = _make_m3u_upstream("/playlist.m3u8", m3u)
        try:
            status, hdrs, text = _m3u_get(shared_r2h, upstream.port, "/playlist.m3u8")
            assert status == 200
            cl = hdrs.get("Content-Length", hdrs.get("content-length"))
            if cl is not None:
                assert int(cl) == len(text.encode("utf-8"))
        finally:
            upstream.stop()
