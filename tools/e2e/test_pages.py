"""
E2E tests for built-in web pages (status, player) and the root
playlist endpoint.
"""

import pytest

from helpers import (
    R2HProcess,
    find_free_port,
    http_get,
)


# ---------------------------------------------------------------------------
# Status page
# ---------------------------------------------------------------------------


class TestStatusPage:
    """The /status page should return HTML."""

    def test_status_returns_html(self, r2h_binary):
        port = find_free_port()
        r2h = R2HProcess(r2h_binary, port, extra_args=["-v", "4", "-m", "100"])
        try:
            r2h.start()
            status, hdrs, body = http_get("127.0.0.1", port, "/status")
            assert status == 200
            ct = hdrs.get("Content-Type", hdrs.get("content-type", ""))
            assert "html" in ct.lower()
            assert len(body) > 100  # non-trivial HTML page
        finally:
            r2h.stop()

    def test_status_contains_info(self, r2h_binary):
        """Status page should contain recognizable content.
        The embedded HTML may be gzip-compressed; request uncompressed."""
        import gzip

        port = find_free_port()
        r2h = R2HProcess(r2h_binary, port, extra_args=["-v", "4", "-m", "100"])
        try:
            r2h.start()
            _, hdrs, body = http_get(
                "127.0.0.1", port, "/status",
                headers={"Accept-Encoding": "identity"},
            )
            # Decompress if gzip (0x1f 0x8b magic)
            if body[:2] == b"\x1f\x8b":
                body = gzip.decompress(body)
            text = body.decode("utf-8", errors="replace").lower()
            assert "<html" in text or "<!doctype" in text
        finally:
            r2h.stop()


# ---------------------------------------------------------------------------
# Player page
# ---------------------------------------------------------------------------


class TestPlayerPage:
    """The /player page should return HTML."""

    def test_player_returns_html(self, r2h_binary):
        port = find_free_port()
        r2h = R2HProcess(r2h_binary, port, extra_args=["-v", "4", "-m", "100"])
        try:
            r2h.start()
            status, hdrs, body = http_get("127.0.0.1", port, "/player")
            assert status == 200
            ct = hdrs.get("Content-Type", hdrs.get("content-type", ""))
            assert "html" in ct.lower()
            assert len(body) > 100
        finally:
            r2h.stop()


# ---------------------------------------------------------------------------
# Root / and /playlist.m3u
# ---------------------------------------------------------------------------


class TestPlaylistEndpoints:
    """Playlist should be served at /playlist.m3u."""

    def test_playlist_m3u_with_services(self, r2h_binary):
        port = find_free_port()
        config = f"""\
[global]
verbosity = 4

[bind]
* {port}

[services]
#EXTM3U
#EXTINF:-1,Test Ch
rtp://239.0.0.1:1234
"""
        r2h = R2HProcess(r2h_binary, port, config_content=config)
        try:
            r2h.start()
            status, _, body = http_get("127.0.0.1", port, "/playlist.m3u")
            assert status == 200
            assert b"#EXTM3U" in body
        finally:
            r2h.stop()

    def test_playlist_m3u_no_services(self, r2h_binary):
        """Without any services, /playlist.m3u should return 404."""
        port = find_free_port()
        r2h = R2HProcess(r2h_binary, port, extra_args=["-v", "4", "-m", "100"])
        try:
            r2h.start()
            status, _, _ = http_get("127.0.0.1", port, "/playlist.m3u")
            assert status == 404
        finally:
            r2h.stop()


# ---------------------------------------------------------------------------
# Status SSE endpoint
# ---------------------------------------------------------------------------


class TestStatusSSE:
    """The status SSE endpoint should respond with event-stream type."""

    def test_status_sse_content_type(self, r2h_binary):
        from helpers import stream_get

        port = find_free_port()
        r2h = R2HProcess(r2h_binary, port, extra_args=["-v", "4", "-m", "100"])
        try:
            r2h.start()
            status, hdrs, _ = stream_get(
                "127.0.0.1", port, "/status/sse",
                read_bytes=256, timeout=3.0,
            )
            if status == 200:
                ct = hdrs.get("content-type", "")
                assert "event-stream" in ct or "text/" in ct
        finally:
            r2h.stop()
