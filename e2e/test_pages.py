"""
E2E tests for built-in web pages (status, player) and the root
playlist endpoint.
"""

import os
import time

import pytest

from helpers import (
    R2HProcess,
    find_free_port,
    get_header,
    http_get,
    stream_get,
    write_temp_file,
)


APP_PREFIX = "/app/rtp2httpd"
SAMPLE_EPG_XML = """\
<?xml version="1.0" encoding="UTF-8"?>
<tv>
  <channel id="CH1"><display-name>Channel 1</display-name></channel>
  <programme start="20260101000000 +0000" stop="20260101010000 +0000" channel="CH1">
    <title>Prefixed Programme</title>
  </programme>
</tv>
"""


def _wait_for_http_status(port: int, path: str, expected: int = 200, timeout: float = 3.0) -> None:
    deadline = time.monotonic() + timeout
    last_status = None

    while time.monotonic() < deadline:
        status, _, _ = http_get("127.0.0.1", port, path, timeout=1.0)
        last_status = status
        if status == expected:
            return
        time.sleep(0.05)

    raise AssertionError(f"{path} did not return {expected} before timeout; last status was {last_status}")


# ---------------------------------------------------------------------------
# Module-scoped shared rtp2httpd instance
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def basic_r2h(r2h_binary):
    """A single rtp2httpd instance shared by tests using default config."""
    port = find_free_port()
    r2h = R2HProcess(r2h_binary, port, extra_args=["-v", "4", "-m", "100"])
    r2h.start()
    yield r2h
    r2h.stop()


@pytest.fixture(scope="module")
def prefixed_r2h(r2h_binary):
    """A shared rtp2httpd instance mounted under app-path-prefix."""
    port = find_free_port()
    epg_path = write_temp_file(SAMPLE_EPG_XML.encode(), suffix=".xml", prefix="r2h_pages_epg_")
    config = f"""\
[global]
verbosity = 4
app-path-prefix = {APP_PREFIX}

[bind]
* {port}

[services]
#EXTM3U x-tvg-url="file://{epg_path}"
#EXTINF:-1,Prefixed Ch
rtp://239.0.0.1:1234
"""
    r2h = R2HProcess(r2h_binary, port, config_content=config)
    try:
        r2h.start()
        _wait_for_http_status(port, f"{APP_PREFIX}/epg.xml")
        yield r2h
    finally:
        r2h.stop()
        os.unlink(epg_path)


# ---------------------------------------------------------------------------
# Status page
# ---------------------------------------------------------------------------


class TestStatusPage:
    """The /status page should return HTML."""

    def test_status_returns_html(self, basic_r2h):
        status, hdrs, body = http_get("127.0.0.1", basic_r2h.port, "/status")
        assert status == 200
        ct = get_header(hdrs, "Content-Type")
        assert "html" in ct.lower()
        assert len(body) > 100  # non-trivial HTML page

    def test_status_contains_info(self, basic_r2h):
        """Status page should contain recognizable content.
        The embedded HTML may be gzip-compressed; request uncompressed."""
        import gzip

        _, hdrs, body = http_get(
            "127.0.0.1",
            basic_r2h.port,
            "/status",
            headers={"Accept-Encoding": "identity"},
        )
        # Decompress if gzip (0x1f 0x8b magic)
        if body[:2] == b"\x1f\x8b":
            body = gzip.decompress(body)
        text = body.decode("utf-8", errors="replace").lower()
        assert "<html" in text or "<!doctype" in text


# ---------------------------------------------------------------------------
# Player page
# ---------------------------------------------------------------------------


class TestPlayerPage:
    """The /player page should return HTML."""

    def test_player_returns_html(self, basic_r2h):
        status, hdrs, body = http_get("127.0.0.1", basic_r2h.port, "/player")
        assert status == 200
        ct = get_header(hdrs, "Content-Type")
        assert "html" in ct.lower()
        assert len(body) > 100


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

    def test_playlist_m3u_no_services(self, basic_r2h):
        """Without any services, /playlist.m3u should return 404."""
        status, _, _ = http_get("127.0.0.1", basic_r2h.port, "/playlist.m3u")
        assert status == 404


# ---------------------------------------------------------------------------
# Status SSE endpoint
# ---------------------------------------------------------------------------


class TestStatusSSE:
    """The status SSE endpoint should respond with event-stream type."""

    def test_status_sse_content_type(self, basic_r2h):
        status, hdrs, _ = stream_get(
            "127.0.0.1",
            basic_r2h.port,
            "/status/sse",
            read_bytes=256,
            timeout=3.0,
        )
        if status == 200:
            ct = hdrs.get("content-type", "")
            assert "event-stream" in ct or "text/" in ct


# ---------------------------------------------------------------------------
# app-path-prefix
# ---------------------------------------------------------------------------


class TestAppPathPrefix:
    """All public resources should move under app-path-prefix when configured."""

    def test_prefixed_status_html_injects_runtime_paths(self, prefixed_r2h):
        status, hdrs, body = http_get("127.0.0.1", prefixed_r2h.port, f"{APP_PREFIX}/status")
        assert status == 200
        assert "html" in get_header(hdrs, "Content-Type").lower()
        assert get_header(hdrs, "Content-Encoding") == ""
        text = body.decode("utf-8", errors="replace")
        assert f'<base href="{APP_PREFIX}/">' in text
        assert f'"appPathPrefix":"{APP_PREFIX}"' in text
        assert '"logLevel":4' in text

    def test_prefixed_player_html(self, prefixed_r2h):
        status, hdrs, body = http_get("127.0.0.1", prefixed_r2h.port, f"{APP_PREFIX}/player")
        assert status == 200
        assert "html" in get_header(hdrs, "Content-Type").lower()
        assert len(body) > 100

    def test_prefixed_static_asset(self, prefixed_r2h):
        status, hdrs, body = http_get("127.0.0.1", prefixed_r2h.port, f"{APP_PREFIX}/assets/icon.png")
        assert status == 200
        assert "image/png" in get_header(hdrs, "Content-Type").lower()
        assert len(body) > 0

    def test_prefixed_playlist_contains_prefixed_urls(self, prefixed_r2h):
        status, _, body = http_get("127.0.0.1", prefixed_r2h.port, f"{APP_PREFIX}/playlist.m3u")
        assert status == 200
        text = body.decode("utf-8", errors="replace")
        assert "#EXTM3U" in text
        assert f"{APP_PREFIX}/" in text
        assert f"{APP_PREFIX}/epg.xml" in text

    def test_prefixed_epg_endpoint(self, prefixed_r2h):
        status, hdrs, body = http_get("127.0.0.1", prefixed_r2h.port, f"{APP_PREFIX}/epg.xml")
        assert status == 200
        assert "xml" in get_header(hdrs, "Content-Type").lower()
        assert b"Prefixed Programme" in body

    def test_prefixed_status_sse(self, prefixed_r2h):
        status, hdrs, _ = stream_get(
            "127.0.0.1",
            prefixed_r2h.port,
            f"{APP_PREFIX}/status/sse",
            read_bytes=256,
            timeout=3.0,
        )
        if status == 200:
            assert "event-stream" in hdrs.get("content-type", "")

    @pytest.mark.parametrize(
        "path",
        [
            "/status",
            "/player",
            "/assets/icon.png",
            "/playlist.m3u",
            "/app/rtp2httpd2/status",
        ],
    )
    def test_unprefixed_or_boundary_mismatch_routes_404(self, prefixed_r2h, path):
        status, _, _ = http_get("127.0.0.1", prefixed_r2h.port, path)
        assert status == 404

    def test_token_cookie_path_uses_app_prefix(self, r2h_binary):
        port = find_free_port()
        config = f"""\
[global]
verbosity = 4
app-path-prefix = {APP_PREFIX}
r2h-token = secret-token

[bind]
* {port}
"""
        r2h = R2HProcess(r2h_binary, port, config_content=config)
        try:
            r2h.start()
            status, hdrs, _ = http_get("127.0.0.1", port, f"{APP_PREFIX}/status?r2h-token=secret-token")
            assert status == 200
            set_cookie = get_header(hdrs, "Set-Cookie")
            assert "r2h-token=secret-token" in set_cookie
            assert f"Path={APP_PREFIX}" in set_cookie

            status, _, _ = http_get(
                "127.0.0.1",
                port,
                f"{APP_PREFIX}/status",
                headers={"Cookie": "r2h-token=secret-token"},
            )
            assert status == 200
        finally:
            r2h.stop()
