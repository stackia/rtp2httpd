"""
E2E tests for built-in web pages (status, player) and the root
playlist endpoint.
"""

import gzip
import json
import os
import signal
import struct
import time
from urllib.parse import quote

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


def _parse_manifest(body: bytes) -> dict:
    return json.loads(body.decode("utf-8"))


def _png_dimensions(body: bytes, content_encoding: str) -> tuple[int, int]:
    if content_encoding == "gzip":
        body = gzip.decompress(body)
    assert body.startswith(b"\x89PNG\r\n\x1a\n")
    return struct.unpack(">II", body[16:24])


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

    def test_status_contains_install_metadata(self, basic_r2h):
        _, _, body = http_get("127.0.0.1", basic_r2h.port, "/status", headers={"Accept-Encoding": "identity"})
        text = body.decode("utf-8")
        assert 'rel="manifest" href="./status.webmanifest" crossorigin="use-credentials"' in text
        assert 'rel="icon" type="image/png" sizes="192x192" href="./assets/icon-192.png"' in text
        assert 'rel="apple-touch-icon" sizes="192x192" href="./assets/icon-192.png"' in text
        assert 'name="apple-mobile-web-app-title" content="R2H 面板"' in text


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

    def test_player_contains_install_metadata(self, basic_r2h):
        _, _, body = http_get("127.0.0.1", basic_r2h.port, "/player", headers={"Accept-Encoding": "identity"})
        text = body.decode("utf-8")
        assert 'rel="manifest" href="./player.webmanifest" crossorigin="use-credentials"' in text
        assert 'rel="icon" type="image/png" sizes="192x192" href="./assets/icon-192.png"' in text
        assert 'rel="apple-touch-icon" sizes="192x192" href="./assets/icon-192.png"' in text
        assert 'name="apple-mobile-web-app-title" content="R2H 播放器"' in text


# ---------------------------------------------------------------------------
# Web App Manifests
# ---------------------------------------------------------------------------


class TestWebAppManifests:
    @pytest.mark.parametrize(
        ("manifest_path", "name", "short_name", "english_name", "english_short_name", "start_url"),
        [
            ("/status.webmanifest", "rtp2httpd 面板", "R2H 面板", "rtp2httpd Status", "R2H Status", "/status"),
            (
                "/player.webmanifest",
                "rtp2httpd 播放器",
                "R2H 播放器",
                "rtp2httpd Player",
                "R2H Player",
                "/player",
            ),
        ],
    )
    def test_default_manifest(
        self,
        basic_r2h,
        manifest_path,
        name,
        short_name,
        english_name,
        english_short_name,
        start_url,
    ):
        status, hdrs, body = http_get("127.0.0.1", basic_r2h.port, manifest_path)
        assert status == 200
        assert "application/manifest+json" in get_header(hdrs, "Content-Type")
        assert get_header(hdrs, "Cache-Control") == "no-cache"

        manifest = _parse_manifest(body)
        assert manifest["lang"] == "zh-Hans"
        assert manifest["dir"] == "ltr"
        assert manifest["name"] == name
        assert manifest["short_name"] == short_name
        assert manifest["name_localized"] == {"zh-Hans": name, "zh-Hant": name, "en": english_name}
        assert manifest["short_name_localized"] == {
            "zh-Hans": short_name,
            "zh-Hant": short_name,
            "en": english_short_name,
        }
        assert manifest["id"] == start_url
        assert manifest["scope"] == start_url
        assert manifest["start_url"] == start_url
        assert manifest["display"] == "standalone"
        expected_dark_color = "#090b1a" if manifest_path == "/status.webmanifest" else "#050b18"
        assert manifest["theme_color"] == expected_dark_color
        assert manifest["background_color"] == expected_dark_color
        assert manifest["icons"] == [
            {"src": "/assets/icon-192.png", "sizes": "192x192", "type": "image/png"},
            {"src": "/assets/icon-512.png", "sizes": "512x512", "type": "image/png"},
        ]

    @pytest.mark.parametrize(("path", "expected_size"), [("/assets/icon-192.png", 192), ("/assets/icon-512.png", 512)])
    def test_manifest_icon_dimensions(self, basic_r2h, path, expected_size):
        status, hdrs, body = http_get("127.0.0.1", basic_r2h.port, path)
        assert status == 200
        assert get_header(hdrs, "Content-Type") == "image/png"
        assert _png_dimensions(body, get_header(hdrs, "Content-Encoding")) == (expected_size, expected_size)

    def test_root_page_path_manifest(self, r2h_binary):
        port = find_free_port()
        config = f"""\
[global]
status-page-path = ////
player-page-path = //watch///
app-path-prefix = ///app///

[bind]
* {port}
"""
        r2h = R2HProcess(r2h_binary, port, config_content=config)
        try:
            r2h.start()
            status, _, body = http_get("127.0.0.1", port, "/app/status.webmanifest")
            assert status == 200
            manifest = _parse_manifest(body)
            assert manifest["id"] == "/app/"
            assert manifest["scope"] == "/app/"
            assert manifest["start_url"] == "/app/"

            status, _, body = http_get("127.0.0.1", port, "/app/player.webmanifest")
            assert status == 200
            manifest = _parse_manifest(body)
            assert manifest["id"] == "/app/watch"
            assert manifest["scope"] == "/app/watch"
            assert manifest["start_url"] == "/app/watch"
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

    @pytest.mark.parametrize(
        ("manifest_path", "start_url"),
        [
            (f"{APP_PREFIX}/status.webmanifest", f"{APP_PREFIX}/status"),
            (f"{APP_PREFIX}/player.webmanifest", f"{APP_PREFIX}/player"),
        ],
    )
    def test_prefixed_manifest_paths(self, prefixed_r2h, manifest_path, start_url):
        status, _, body = http_get("127.0.0.1", prefixed_r2h.port, manifest_path)
        assert status == 200
        manifest = _parse_manifest(body)
        assert manifest["id"] == start_url
        assert manifest["scope"] == start_url
        assert manifest["start_url"] == start_url
        assert manifest["icons"][0]["src"] == f"{APP_PREFIX}/assets/icon-192.png"
        assert manifest["icons"][1]["src"] == f"{APP_PREFIX}/assets/icon-512.png"

    def test_prefixed_static_asset(self, prefixed_r2h):
        status, hdrs, body = http_get("127.0.0.1", prefixed_r2h.port, f"{APP_PREFIX}/assets/icon-192.png")
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
            "/assets/icon-192.png",
            "/playlist.m3u",
            "/app/rtp2httpd2/status",
        ],
    )
    def test_unprefixed_or_boundary_mismatch_routes_404(self, prefixed_r2h, path):
        status, _, _ = http_get("127.0.0.1", prefixed_r2h.port, path)
        assert status == 404

    def test_token_cookie_path_uses_app_prefix(self, r2h_binary):
        port = find_free_port()
        token = "secret token;&$"
        encoded_token = quote(token, safe="/")
        config = f"""\
[global]
verbosity = 4
app-path-prefix = {APP_PREFIX}
r2h-token = {token}

[bind]
* {port}
"""
        r2h = R2HProcess(r2h_binary, port, config_content=config)
        try:
            r2h.start()
            status, _, _ = http_get("127.0.0.1", port, f"{APP_PREFIX}/status.webmanifest")
            assert status == 401

            status, hdrs, _ = http_get("127.0.0.1", port, f"{APP_PREFIX}/status?r2h-token={encoded_token}")
            assert status == 200
            set_cookie = get_header(hdrs, "Set-Cookie")
            assert f"r2h-token={encoded_token}" in set_cookie
            assert f"Path={APP_PREFIX}" in set_cookie

            cookie = f"r2h-token={encoded_token}"
            status, _, body = http_get(
                "127.0.0.1",
                port,
                f"{APP_PREFIX}/status.webmanifest",
                headers={"Cookie": cookie},
            )
            assert status == 200
            manifest = _parse_manifest(body)
            assert manifest["id"] == f"{APP_PREFIX}/status"
            assert manifest["scope"] == f"{APP_PREFIX}/status"
            assert manifest["start_url"] == f"{APP_PREFIX}/status?r2h-token={encoded_token}"

            status, hdrs, _ = http_get("127.0.0.1", port, manifest["start_url"])
            assert status == 200
            assert f"r2h-token={encoded_token}" in get_header(hdrs, "Set-Cookie")
        finally:
            r2h.stop()

    def test_manifest_updates_after_config_reload(self, r2h_binary):
        port = find_free_port()
        old_config = f"""\
[global]
workers = 1
app-path-prefix = /old
status-page-path = /old-status
r2h-token = old-token

[bind]
* {port}
"""
        new_config = f"""\
[global]
workers = 1
app-path-prefix = /new
status-page-path = /new-status
r2h-token = new-token

[bind]
* {port}
"""
        r2h = R2HProcess(r2h_binary, port, config_content=old_config)
        try:
            r2h.start()
            status, _, body = http_get(
                "127.0.0.1",
                port,
                "/old/status.webmanifest?r2h-token=old-token",
            )
            assert status == 200
            assert _parse_manifest(body)["start_url"] == "/old/old-status?r2h-token=old-token"

            assert r2h._config_path is not None
            with open(r2h._config_path, "w") as config_file:
                config_file.write(new_config)
            assert r2h.process is not None
            os.kill(r2h.process.pid, signal.SIGHUP)

            deadline = time.monotonic() + 5
            while True:
                status, _, body = http_get(
                    "127.0.0.1",
                    port,
                    "/new/status.webmanifest?r2h-token=new-token",
                )
                if status == 200:
                    break
                if time.monotonic() >= deadline:
                    raise AssertionError(f"reloaded manifest did not become available; last status was {status}")
                time.sleep(0.05)

            manifest = _parse_manifest(body)
            assert manifest["id"] == "/new/new-status"
            assert manifest["scope"] == "/new/new-status"
            assert manifest["start_url"] == "/new/new-status?r2h-token=new-token"
        finally:
            r2h.stop()
