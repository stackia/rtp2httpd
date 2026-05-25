"""
E2E tests for EPG (Electronic Program Guide) serving.

Tests cover:
- Uncompressed XML EPG via http://
- Gzipped XML EPG via http://
- /epg.xml and /epg.xml.gz endpoint routing logic
- ETag caching (304 Not Modified)
- M3U x-tvg-url rewriting (points to /epg.xml or /epg.xml.gz based on source)
- r2h-token propagation in EPG URLs within M3U
- 404 when no EPG is configured or when .gz is requested but source is plain XML
- file:// EPG loading (via auth fixture)

Four module-scoped rtp2httpd instances are used (one per distinct EPG config):
- no_epg_r2h:    no x-tvg-url configured
- plain_epg_r2h: uncompressed XML loaded from HTTP upstream
- gz_epg_r2h:    gzipped XML loaded from HTTP upstream
- auth_epg_r2h:  uncompressed XML loaded from file:// with r2h-token
"""

import gzip
import os
import re
import shutil
import tempfile
import time

import pytest

from helpers import (
    MockHTTPUpstream,
    R2HProcess,
    find_free_port,
    http_get,
)

SAMPLE_EPG_XML = """\
<?xml version="1.0" encoding="UTF-8"?>
<tv generator-info-name="test">
  <channel id="CH1">
    <display-name>Channel 1</display-name>
  </channel>
  <programme start="20260101000000 +0000" stop="20260101010000 +0000" channel="CH1">
    <title>Test Programme</title>
  </programme>
</tv>
"""

SECRET = "s3cret-t0ken"


def _epg_xml(channel_id: str, display_name: str, title: str) -> str:
    return f"""\
<?xml version="1.0" encoding="UTF-8"?>
<tv generator-info-name="test">
  <channel id="{channel_id}">
    <display-name>{display_name}</display-name>
  </channel>
  <programme start="20260101000000 +0000" stop="20260101010000 +0000" channel="{channel_id}">
    <title>{title}</title>
  </programme>
</tv>
"""


def _extract_tvg_urls(playlist_text: str) -> list[str]:
    match = re.search(r'x-tvg-url="([^"]+)"', playlist_text)
    assert match, "playlist should include x-tvg-url"
    return match.group(1).split(",")


def _write_tmp(data: bytes, suffix: str = ".xml") -> str:
    """Write data to a temp file and return its path."""
    fd, path = tempfile.mkstemp(suffix=suffix, prefix="r2h_epg_")
    with os.fdopen(fd, "wb") as f:
        f.write(data)
    return path


# ---------------------------------------------------------------------------
# Module-scoped shared fixtures (4 rtp2httpd instances)
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def no_epg_r2h(r2h_binary):
    """rtp2httpd with M3U but no x-tvg-url (no EPG)."""
    port = find_free_port()
    config = f"""\
[global]
verbosity = 4

[bind]
* {port}

[services]
#EXTM3U
#EXTINF:-1,Channel
rtp://239.0.0.1:1234
"""
    r2h = R2HProcess(r2h_binary, port, config_content=config)
    r2h.start()
    yield r2h
    r2h.stop()


@pytest.fixture(scope="module")
def plain_epg_r2h(r2h_binary):
    """rtp2httpd with uncompressed EPG loaded from HTTP upstream."""
    upstream = MockHTTPUpstream(
        routes={
            "/epg.xml": {
                "status": 200,
                "body": SAMPLE_EPG_XML,
                "headers": {"Content-Type": "application/xml"},
            },
        }
    )
    upstream.start()

    port = find_free_port()
    m3u_content = (
        '#EXTM3U x-tvg-url="http://127.0.0.1:%d/epg.xml"\n#EXTINF:-1,Channel\nrtp://239.0.0.1:1234\n'
    ) % upstream.port
    upstream.routes["/m3u"] = {
        "status": 200,
        "body": m3u_content,
        "headers": {"Content-Type": "audio/x-mpegurl"},
    }
    r2h = R2HProcess(
        r2h_binary,
        port,
        extra_args=[
            "-v",
            "4",
            "-m",
            "100",
            "-M",
            "http://127.0.0.1:%d/m3u" % upstream.port,
        ],
    )
    r2h.start()
    time.sleep(1.0)  # allow async M3U + EPG fetch
    yield r2h
    r2h.stop()
    upstream.stop()


@pytest.fixture(scope="module")
def gz_epg_r2h(r2h_binary):
    """rtp2httpd with gzipped EPG loaded from HTTP upstream."""
    gz_data = gzip.compress(SAMPLE_EPG_XML.encode())
    upstream = MockHTTPUpstream(
        routes={
            "/epg.xml.gz": {
                "status": 200,
                "body": gz_data,
                "headers": {"Content-Type": "application/gzip"},
            },
        }
    )
    upstream.start()

    port = find_free_port()
    m3u_content = (
        '#EXTM3U x-tvg-url="http://127.0.0.1:%d/epg.xml.gz"\n#EXTINF:-1,Channel\nrtp://239.0.0.1:1234\n'
    ) % upstream.port
    upstream.routes["/m3u"] = {
        "status": 200,
        "body": m3u_content,
        "headers": {"Content-Type": "audio/x-mpegurl"},
    }
    r2h = R2HProcess(
        r2h_binary,
        port,
        extra_args=[
            "-v",
            "4",
            "-m",
            "100",
            "-M",
            "http://127.0.0.1:%d/m3u" % upstream.port,
        ],
    )
    r2h.start()
    time.sleep(1.0)
    yield r2h
    r2h.stop()
    upstream.stop()


@pytest.fixture(scope="module")
def auth_epg_r2h(r2h_binary):
    """rtp2httpd with uncompressed EPG from file:// and r2h-token."""
    epg_path = _write_tmp(SAMPLE_EPG_XML.encode())
    port = find_free_port()
    config = f"""\
[global]
verbosity = 4
r2h-token = {SECRET}

[bind]
* {port}

[services]
#EXTM3U x-tvg-url="file://{epg_path}"
#EXTINF:-1,Channel
rtp://239.0.0.1:1234
"""
    r2h = R2HProcess(r2h_binary, port, config_content=config)
    r2h.start()
    time.sleep(0.5)
    yield r2h
    r2h.stop()
    os.unlink(epg_path)


# ---------------------------------------------------------------------------
# No EPG configured
# ---------------------------------------------------------------------------


class TestNoEPG:
    """Without x-tvg-url, /epg.xml and /epg.xml.gz should return 404."""

    def test_epg_xml_404(self, no_epg_r2h):
        status, _, _ = http_get("127.0.0.1", no_epg_r2h.port, "/epg.xml")
        assert status == 404

    def test_epg_xml_gz_404(self, no_epg_r2h):
        status, _, _ = http_get("127.0.0.1", no_epg_r2h.port, "/epg.xml.gz")
        assert status == 404


# ---------------------------------------------------------------------------
# Uncompressed EPG
# ---------------------------------------------------------------------------


class TestUncompressedEPG:
    """EPG loaded as plain XML (via HTTP upstream)."""

    def test_epg_xml_served(self, plain_epg_r2h):
        """GET /epg.xml should return plain XML content."""
        status, hdrs, body = http_get(
            "127.0.0.1",
            plain_epg_r2h.port,
            "/epg.xml",
        )
        assert status == 200
        ct = hdrs.get("Content-Type", "")
        assert "xml" in ct.lower()
        ce = hdrs.get("Content-Encoding", "")
        assert ce == "", "Plain XML should not have Content-Encoding"
        assert b"Test Programme" in body

    def test_epg_xml_gz_returns_404(self, plain_epg_r2h):
        """GET /epg.xml.gz should return 404 when source is not gzipped."""
        status, _, _ = http_get(
            "127.0.0.1",
            plain_epg_r2h.port,
            "/epg.xml.gz",
        )
        assert status == 404

    def test_m3u_tvg_url_points_to_epg_xml(self, plain_epg_r2h):
        """M3U x-tvg-url should be rewritten to /epg.xml for plain source."""
        status, _, body = http_get(
            "127.0.0.1",
            plain_epg_r2h.port,
            "/playlist.m3u",
        )
        text = body.decode()
        assert status == 200
        assert "epg.xml" in text
        assert "epg.xml.gz" not in text


# ---------------------------------------------------------------------------
# Gzipped EPG
# ---------------------------------------------------------------------------


class TestGzippedEPG:
    """EPG loaded as gzip-compressed data (via HTTP upstream)."""

    def test_epg_xml_served_with_content_encoding(self, gz_epg_r2h):
        """GET /epg.xml should return Content-Encoding: gzip."""
        status, hdrs, body = http_get(
            "127.0.0.1",
            gz_epg_r2h.port,
            "/epg.xml",
        )
        assert status == 200
        ct = hdrs.get("Content-Type", "")
        assert "xml" in ct.lower()
        ce = hdrs.get("Content-Encoding", "")
        assert "gzip" in ce.lower(), "Gzipped source served via /epg.xml should have Content-Encoding: gzip"
        decompressed = gzip.decompress(body)
        assert b"Test Programme" in decompressed

    def test_epg_xml_gz_served(self, gz_epg_r2h):
        """GET /epg.xml.gz should return raw gzip data as application/gzip."""
        status, hdrs, body = http_get(
            "127.0.0.1",
            gz_epg_r2h.port,
            "/epg.xml.gz",
        )
        assert status == 200
        ct = hdrs.get("Content-Type", "")
        assert "gzip" in ct.lower()
        ce = hdrs.get("Content-Encoding", "")
        assert "gzip" not in ce.lower(), "/epg.xml.gz should not add Content-Encoding: gzip"
        decompressed = gzip.decompress(body)
        assert b"Test Programme" in decompressed

    def test_m3u_tvg_url_points_to_epg_xml_gz(self, gz_epg_r2h):
        """M3U x-tvg-url should be rewritten to /epg.xml.gz for gzipped source."""
        status, _, body = http_get(
            "127.0.0.1",
            gz_epg_r2h.port,
            "/playlist.m3u",
        )
        text = body.decode()
        assert status == 200
        assert "epg.xml.gz" in text


# ---------------------------------------------------------------------------
# ETag caching (shares plain_epg_r2h)
# ---------------------------------------------------------------------------


class TestEPGETag:
    """ETag-based caching on EPG endpoints."""

    def test_etag_present(self, plain_epg_r2h):
        """EPG response should include an ETag header."""
        status, hdrs, _ = http_get(
            "127.0.0.1",
            plain_epg_r2h.port,
            "/epg.xml",
        )
        assert status == 200
        etag = hdrs.get("ETag", hdrs.get("etag", ""))
        assert etag, "ETag header expected"

    def test_if_none_match_304(self, plain_epg_r2h):
        """If-None-Match with matching ETag should return 304."""
        _, hdrs1, _ = http_get(
            "127.0.0.1",
            plain_epg_r2h.port,
            "/epg.xml",
        )
        etag = hdrs1.get("ETag", hdrs1.get("etag", ""))
        assert etag

        status, _, body = http_get(
            "127.0.0.1",
            plain_epg_r2h.port,
            "/epg.xml",
            headers={"If-None-Match": etag},
        )
        assert status == 304
        assert len(body) == 0

    def test_if_none_match_mismatch(self, plain_epg_r2h):
        """If-None-Match with wrong ETag should return 200."""
        status, _, body = http_get(
            "127.0.0.1",
            plain_epg_r2h.port,
            "/epg.xml",
            headers={"If-None-Match": '"wrong-etag"'},
        )
        assert status == 200
        assert len(body) > 0

    def test_etag_consistent(self, plain_epg_r2h):
        """Two GETs should yield the same ETag."""
        _, h1, _ = http_get("127.0.0.1", plain_epg_r2h.port, "/epg.xml")
        _, h2, _ = http_get("127.0.0.1", plain_epg_r2h.port, "/epg.xml")
        e1 = h1.get("ETag", h1.get("etag", ""))
        e2 = h2.get("ETag", h2.get("etag", ""))
        assert e1 == e2 and e1 != ""


# ---------------------------------------------------------------------------
# r2h-token authentication (also tests file:// loading path)
# ---------------------------------------------------------------------------


class TestEPGAuth:
    """EPG endpoints should respect r2h-token authentication."""

    def test_epg_requires_token(self, auth_epg_r2h):
        """GET /epg.xml without token should return 401."""
        status, _, _ = http_get("127.0.0.1", auth_epg_r2h.port, "/epg.xml")
        assert status == 401

    def test_epg_with_valid_token(self, auth_epg_r2h):
        """GET /epg.xml with valid token should return 200."""
        status, _, body = http_get(
            "127.0.0.1",
            auth_epg_r2h.port,
            f"/epg.xml?r2h-token={SECRET}",
        )
        assert status == 200
        assert b"Test Programme" in body

    def test_m3u_tvg_url_includes_token(self, auth_epg_r2h):
        """M3U x-tvg-url should include r2h-token when auth is configured."""
        status, _, body = http_get(
            "127.0.0.1",
            auth_epg_r2h.port,
            f"/playlist.m3u?r2h-token={SECRET}",
        )
        assert status == 200
        text = body.decode()
        assert "x-tvg-url=" in text
        assert "r2h-token=" in text


# ---------------------------------------------------------------------------
# Multiple EPG sources
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def multi_epg_r2h(r2h_binary):
    """rtp2httpd with comma-separated HTTP and file:// EPG sources."""
    file_epg_path = _write_tmp(_epg_xml("FILE", "File Channel", "File Source Programme").encode())
    upstream = MockHTTPUpstream(
        routes={
            "/epg-one.xml": {
                "status": 200,
                "body": _epg_xml("CH1", "Channel 1", "First Source Programme"),
                "headers": {"Content-Type": "application/xml"},
            },
            "/epg-two.xml": {
                "status": 200,
                "body": _epg_xml("CH2", "Channel 2", "Second Source Programme"),
                "headers": {"Content-Type": "application/xml"},
            },
        }
    )
    upstream.start()

    port = find_free_port()
    m3u_content = (
        '#EXTM3U x-tvg-url="http://127.0.0.1:%d/epg-one.xml?labels=a,b, '
        'http://127.0.0.1:%d/epg-two.xml, file://%s"\n'
        '#EXTINF:-1 tvg-id="CH1",Channel 1\n'
        "rtp://239.0.0.1:1234\n"
    ) % (upstream.port, upstream.port, file_epg_path)
    upstream.routes["/m3u"] = {
        "status": 200,
        "body": m3u_content,
        "headers": {"Content-Type": "audio/x-mpegurl"},
    }

    r2h = R2HProcess(
        r2h_binary,
        port,
        extra_args=[
            "-v",
            "4",
            "-m",
            "100",
            "-M",
            "http://127.0.0.1:%d/m3u" % upstream.port,
        ],
    )
    r2h.start()
    time.sleep(1.5)
    yield r2h, upstream
    r2h.stop()
    upstream.stop()
    os.unlink(file_epg_path)


class TestMultipleEPGSources:
    """Comma-separated EPG sources should be fetched and exposed independently."""

    def test_epg_urls_split_only_before_supported_schemes(self, multi_epg_r2h):
        """Comma inside query should not split, but comma before http/file URL should."""
        _, upstream = multi_epg_r2h
        epg_paths = [req["path"] for req in upstream.requests_log if req["path"].startswith("/epg")]

        assert "/epg-one.xml?labels=a,b" in epg_paths
        assert "/epg-two.xml" in epg_paths
        assert not any("epg-one.xml?labels=a,b," in path for path in epg_paths)

    def test_playlist_tvg_url_lists_local_epg_sources(self, multi_epg_r2h):
        """Converted M3U should expose all cached EPG sources as ordered local URLs."""
        r2h, _ = multi_epg_r2h
        status, _, body = http_get("127.0.0.1", r2h.port, "/playlist.m3u")

        assert status == 200
        epg_urls = _extract_tvg_urls(body.decode())
        assert len(epg_urls) == 3
        assert epg_urls[0].endswith("/epg.xml")
        assert epg_urls[1].endswith("/epg/2.xml")
        assert epg_urls[2].endswith("/epg/3.xml")

    def test_epg_sources_are_served_by_index(self, multi_epg_r2h):
        """The first EPG remains on /epg.xml; later EPGs use /epg/N.xml."""
        r2h, _ = multi_epg_r2h

        status, _, body = http_get("127.0.0.1", r2h.port, "/epg.xml")
        assert status == 200
        assert b"First Source Programme" in body

        status, _, body = http_get("127.0.0.1", r2h.port, "/epg/2.xml")
        assert status == 200
        assert b"Second Source Programme" in body

        status, _, body = http_get("127.0.0.1", r2h.port, "/epg/3.xml")
        assert status == 200
        assert b"File Source Programme" in body

        status, _, _ = http_get("127.0.0.1", r2h.port, "/epg/4.xml")
        assert status == 404

    def test_multi_epg_tvg_url_includes_token_for_each_source(self, r2h_binary):
        """Each local EPG URL should receive r2h-token in protected playlists."""
        epg_one_path = _write_tmp(_epg_xml("CH1", "Channel 1", "First Token Programme").encode())
        epg_two_path = _write_tmp(_epg_xml("CH2", "Channel 2", "Second Token Programme").encode())
        port = find_free_port()
        config = f"""\
[global]
verbosity = 4
r2h-token = {SECRET}

[bind]
* {port}

[services]
#EXTM3U x-tvg-url="file://{epg_one_path}, file://{epg_two_path}"
#EXTINF:-1,Channel
rtp://239.0.0.1:1234
"""
        r2h = R2HProcess(r2h_binary, port, config_content=config)
        try:
            r2h.start()
            time.sleep(0.5)
            status, _, body = http_get("127.0.0.1", port, f"/playlist.m3u?r2h-token={SECRET}")
            assert status == 200
            epg_urls = _extract_tvg_urls(body.decode())
            assert len(epg_urls) == 2
            assert epg_urls[0].endswith(f"/epg.xml?r2h-token={SECRET}")
            assert epg_urls[1].endswith(f"/epg/2.xml?r2h-token={SECRET}")
        finally:
            r2h.stop()
            os.unlink(epg_one_path)
            os.unlink(epg_two_path)

    def test_multi_epg_tvg_url_handles_url_encoded_token_growth(self, r2h_binary):
        """Playlist generation should not fail when URL encoding expands r2h-token in every EPG URL."""
        token = "%" * 240
        encoded_token = "%25" * 240
        epg_dir = tempfile.mkdtemp(prefix="r2h_epg_", dir="/tmp")
        epg_paths = []
        for i in range(1, 33):
            epg_path = os.path.join(epg_dir, f"{i}.xml")
            with open(epg_path, "wb") as f:
                f.write(_epg_xml(f"CH{i}", f"Channel {i}", f"Encoded Token Programme {i}").encode())
            epg_paths.append(epg_path)
        port = find_free_port()
        config = f"""\
[global]
verbosity = 4
r2h-token = {token}

[bind]
* {port}

[services]
#EXTM3U x-tvg-url="{", ".join(f"file://{path}" for path in epg_paths)}"
#EXTINF:-1,Channel
rtp://239.0.0.1:1234
"""
        r2h = R2HProcess(r2h_binary, port, config_content=config)
        try:
            r2h.start()
            time.sleep(0.5)
            status, _, body = http_get(
                "127.0.0.1",
                port,
                "/playlist.m3u",
                headers={"Cookie": f"r2h-token={token}"},
            )
            assert status == 200
            epg_urls = _extract_tvg_urls(body.decode())
            assert len(epg_urls) == len(epg_paths)
            assert epg_urls[0].endswith(f"/epg.xml?r2h-token={encoded_token}")
            assert epg_urls[-1].endswith(f"/epg/{len(epg_paths)}.xml?r2h-token={encoded_token}")
        finally:
            r2h.stop()
            shutil.rmtree(epg_dir)

    def test_later_epg_source_available_when_first_source_fails(self, r2h_binary):
        """A failed EPG source should not prevent later sources from being cached."""
        upstream = MockHTTPUpstream(
            routes={
                "/ok.xml": {
                    "status": 200,
                    "body": _epg_xml("CH2", "Channel 2", "Later Source Programme"),
                    "headers": {"Content-Type": "application/xml"},
                },
            }
        )
        upstream.start()
        port = find_free_port()
        m3u_content = (
            '#EXTM3U x-tvg-url="http://127.0.0.1:%d/missing.xml,http://127.0.0.1:%d/ok.xml"\n'
            "#EXTINF:-1,Channel\n"
            "rtp://239.0.0.1:1234\n"
        ) % (upstream.port, upstream.port)
        upstream.routes["/m3u"] = {
            "status": 200,
            "body": m3u_content,
            "headers": {"Content-Type": "audio/x-mpegurl"},
        }
        r2h = R2HProcess(
            r2h_binary,
            port,
            extra_args=[
                "-v",
                "4",
                "-m",
                "100",
                "-M",
                "http://127.0.0.1:%d/m3u" % upstream.port,
            ],
        )
        try:
            r2h.start()
            time.sleep(1.5)
            status, _, _ = http_get("127.0.0.1", port, "/epg.xml")
            assert status == 404

            status, _, body = http_get("127.0.0.1", port, "/epg/2.xml")
            assert status == 200
            assert b"Later Source Programme" in body
        finally:
            r2h.stop()
            upstream.stop()

    def test_invalid_updated_m3u_header_clears_previous_epg_sources(self, r2h_binary):
        """An invalid updated M3U header should not keep serving EPG sources from the prior playlist."""
        upstream = MockHTTPUpstream(
            routes={
                "/epg.xml": {
                    "status": 200,
                    "body": _epg_xml("CH1", "Channel 1", "Initial Programme"),
                    "headers": {"Content-Type": "application/xml"},
                },
            }
        )
        upstream.start()
        port = find_free_port()
        upstream.routes["/m3u"] = {
            "status": 200,
            "body": ('#EXTM3U x-tvg-url="http://127.0.0.1:%d/epg.xml"\n#EXTINF:-1,Channel\nrtp://239.0.0.1:1234\n')
            % upstream.port,
            "headers": {"Content-Type": "audio/x-mpegurl"},
        }
        r2h = R2HProcess(
            r2h_binary,
            port,
            extra_args=[
                "-v",
                "4",
                "-m",
                "100",
                "-M",
                "http://127.0.0.1:%d/m3u" % upstream.port,
                "-I",
                "1",
            ],
        )
        try:
            r2h.start()
            deadline = time.monotonic() + 4.0
            while time.monotonic() < deadline:
                status, _, body = http_get("127.0.0.1", port, "/epg.xml")
                if status == 200 and b"Initial Programme" in body:
                    break
                time.sleep(0.2)
            else:
                pytest.fail("initial EPG was not cached")

            upstream.routes["/m3u"] = {
                "status": 200,
                "body": '#EXTM3U x-tvg-url="not-an-epg-url"\n#EXTINF:-1,Channel\nrtp://239.0.0.1:1234\n',
                "headers": {"Content-Type": "audio/x-mpegurl"},
            }

            deadline = time.monotonic() + 5.0
            while time.monotonic() < deadline:
                status, _, body = http_get("127.0.0.1", port, "/playlist.m3u")
                text = body.decode()
                if status == 200 and "x-tvg-url" not in text:
                    break
                time.sleep(0.2)
            else:
                pytest.fail("invalid M3U header still exposed previous EPG URLs")

            status, _, _ = http_get("127.0.0.1", port, "/epg.xml")
            assert status == 404
        finally:
            r2h.stop()
            upstream.stop()
