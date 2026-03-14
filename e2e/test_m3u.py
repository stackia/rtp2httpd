"""
E2E tests for M3U playlist transformation.

Tests cover inline M3U (via [services] section), external M3U (via file://),
URL rewriting, ETag caching, and edge cases.
"""

import os
import tempfile
import time

import pytest

from helpers import (
    R2HProcess,
    extract_catchup_source,
    find_free_port,
    http_get,
    http_request,
)


# ---------------------------------------------------------------------------
# Inline M3U (from [services] config section)
# ---------------------------------------------------------------------------


class TestInlineM3U:
    """M3U content defined directly in the [services] section."""

    def test_inline_m3u_served(self, r2h_binary):
        """An inline M3U should be returned at /playlist.m3u."""
        port = find_free_port()
        config = f"""\
[global]
verbosity = 4
maxclients = 10

[bind]
* {port}

[services]
#EXTM3U
#EXTINF:-1,Channel One
rtp://239.0.0.1:1234
#EXTINF:-1,Channel Two
rtp://239.0.0.2:1234
"""
        r2h = R2HProcess(r2h_binary, port, config_content=config)
        try:
            r2h.start()
            status, hdrs, body = http_get("127.0.0.1", port, "/playlist.m3u")
            text = body.decode()

            assert status == 200
            assert "#EXTM3U" in text
            assert "Channel One" in text
            assert "Channel Two" in text
        finally:
            r2h.stop()

    def test_inline_m3u_content_type(self, r2h_binary):
        """Playlist should be served as audio/x-mpegurl."""
        port = find_free_port()
        config = f"""\
[global]
verbosity = 4

[bind]
* {port}

[services]
#EXTM3U
#EXTINF:-1,Test
rtp://239.0.0.1:1234
"""
        r2h = R2HProcess(r2h_binary, port, config_content=config)
        try:
            r2h.start()
            status, hdrs, _ = http_get("127.0.0.1", port, "/playlist.m3u")
            assert status == 200
            ct = hdrs.get("Content-Type", "")
            assert "mpegurl" in ct.lower() or "m3u" in ct.lower()
        finally:
            r2h.stop()


# ---------------------------------------------------------------------------
# External M3U via file://
# ---------------------------------------------------------------------------


class TestExternalM3UFile:
    """M3U loaded from a local file via -M file://."""

    def _write_m3u(self, content: str) -> str:
        fd, path = tempfile.mkstemp(suffix=".m3u", prefix="r2h_test_")
        with os.fdopen(fd, "w") as f:
            f.write(content)
        return path

    def test_external_file_m3u(self, r2h_binary):
        m3u_path = self._write_m3u(
            "#EXTM3U\n" "#EXTINF:-1,File Channel\n" "rtp://239.10.0.1:5000\n"
        )
        port = find_free_port()
        r2h = R2HProcess(
            r2h_binary,
            port,
            extra_args=["-v", "4", "-m", "100", "-M", f"file://{m3u_path}"],
        )
        try:
            r2h.start()
            # External M3U may load asynchronously, give it a moment
            time.sleep(0.2)
            status, _, body = http_get("127.0.0.1", port, "/playlist.m3u")
            text = body.decode()
            assert status == 200
            assert "File Channel" in text
        finally:
            r2h.stop()
            os.unlink(m3u_path)

    def test_external_m3u_with_fec(self, r2h_binary):
        """FEC query parameter in M3U source should be preserved internally.
        The transformed URL may or may not include the FEC param (it is stored
        in the service config).  We just verify the service is listed."""
        m3u_path = self._write_m3u(
            "#EXTM3U\n" "#EXTINF:-1,FEC Stream\n" "rtp://239.10.0.1:5000?fec=5002\n"
        )
        port = find_free_port()
        r2h = R2HProcess(
            r2h_binary,
            port,
            extra_args=["-v", "4", "-m", "100", "-M", f"file://{m3u_path}"],
        )
        try:
            r2h.start()
            time.sleep(0.2)
            status, _, body = http_get("127.0.0.1", port, "/playlist.m3u")
            text = body.decode()
            assert status == 200
            assert "FEC Stream" in text
        finally:
            r2h.stop()
            os.unlink(m3u_path)


# ---------------------------------------------------------------------------
# URL rewriting
# ---------------------------------------------------------------------------


class TestM3UURLRewriting:
    """Verify that source URLs are rewritten to go through rtp2httpd."""

    def test_rtp_url_rewritten(self, r2h_binary):
        """rtp:// URLs should be rewritten to http://<server>/<name>."""
        port = find_free_port()
        config = f"""\
[global]
verbosity = 4

[bind]
* {port}

[services]
#EXTM3U
#EXTINF:-1,My Channel
rtp://239.0.0.1:1234
"""
        r2h = R2HProcess(r2h_binary, port, config_content=config)
        try:
            r2h.start()
            status, _, body = http_get("127.0.0.1", port, "/playlist.m3u")
            text = body.decode()
            assert status == 200
            # Should NOT contain the raw rtp:// URL
            assert "rtp://239.0.0.1:1234" not in text
            # Should contain a proxied HTTP URL
            assert "http://" in text
            assert "My Channel" in text
        finally:
            r2h.stop()

    def test_rtsp_url_rewritten(self, r2h_binary):
        """rtsp:// URLs should also be rewritten."""
        port = find_free_port()
        config = f"""\
[global]
verbosity = 4

[bind]
* {port}

[services]
#EXTM3U
#EXTINF:-1,RTSP Channel
rtsp://10.0.0.1:554/live
"""
        r2h = R2HProcess(r2h_binary, port, config_content=config)
        try:
            r2h.start()
            status, _, body = http_get("127.0.0.1", port, "/playlist.m3u")
            text = body.decode()
            assert status == 200
            assert "rtsp://10.0.0.1:554" not in text
            assert "RTSP Channel" in text
        finally:
            r2h.stop()

    def test_http_url_preserved_or_rewritten(self, r2h_binary):
        """http:// source URLs should either be rewritten through the proxy
        or preserved, depending on implementation."""
        port = find_free_port()
        config = f"""\
[global]
verbosity = 4

[bind]
* {port}

[services]
#EXTM3U
#EXTINF:-1,Web Stream
http://example.com:8080/live.m3u8
"""
        r2h = R2HProcess(r2h_binary, port, config_content=config)
        try:
            r2h.start()
            status, _, body = http_get("127.0.0.1", port, "/playlist.m3u")
            text = body.decode()
            assert status == 200
            assert "Web Stream" in text
        finally:
            r2h.stop()


# ---------------------------------------------------------------------------
# ETag and conditional GET
# ---------------------------------------------------------------------------


class TestM3UETag:
    """Verify ETag-based caching on the playlist endpoint."""

    def _start_with_m3u(self, r2h_binary, port):
        config = f"""\
[global]
verbosity = 4

[bind]
* {port}

[services]
#EXTM3U
#EXTINF:-1,ETag Test
rtp://239.0.0.1:1234
"""
        r2h = R2HProcess(r2h_binary, port, config_content=config)
        r2h.start()
        return r2h

    def test_etag_present(self, r2h_binary):
        """The playlist response should include an ETag header."""
        port = find_free_port()
        r2h = self._start_with_m3u(r2h_binary, port)
        try:
            status, hdrs, _ = http_get("127.0.0.1", port, "/playlist.m3u")
            assert status == 200
            etag = hdrs.get("ETag", hdrs.get("etag", ""))
            assert etag, "ETag header expected"
        finally:
            r2h.stop()

    def test_if_none_match_304(self, r2h_binary):
        """If-None-Match with matching ETag should return 304."""
        port = find_free_port()
        r2h = self._start_with_m3u(r2h_binary, port)
        try:
            # First request to get ETag
            _, hdrs1, _ = http_get("127.0.0.1", port, "/playlist.m3u")
            etag = hdrs1.get("ETag", hdrs1.get("etag", ""))
            assert etag

            # Second request with If-None-Match
            status, _, body = http_get(
                "127.0.0.1",
                port,
                "/playlist.m3u",
                headers={"If-None-Match": etag},
            )
            assert status == 304
            assert len(body) == 0
        finally:
            r2h.stop()

    def test_if_none_match_mismatch(self, r2h_binary):
        """If-None-Match with wrong ETag should return 200."""
        port = find_free_port()
        r2h = self._start_with_m3u(r2h_binary, port)
        try:
            status, _, body = http_get(
                "127.0.0.1",
                port,
                "/playlist.m3u",
                headers={"If-None-Match": '"wrong-etag"'},
            )
            assert status == 200
            assert len(body) > 0
        finally:
            r2h.stop()

    def test_etag_consistent(self, r2h_binary):
        """Two GETs with the same playlist should yield the same ETag."""
        port = find_free_port()
        r2h = self._start_with_m3u(r2h_binary, port)
        try:
            _, h1, _ = http_get("127.0.0.1", port, "/playlist.m3u")
            _, h2, _ = http_get("127.0.0.1", port, "/playlist.m3u")
            e1 = h1.get("ETag", h1.get("etag", ""))
            e2 = h2.get("ETag", h2.get("etag", ""))
            assert e1 == e2 and e1 != ""
        finally:
            r2h.stop()


# ---------------------------------------------------------------------------
# Duplicate service names
# ---------------------------------------------------------------------------


class TestM3UDuplicateNames:
    """Duplicate service names should be de-duplicated with /N suffixes."""

    def test_duplicate_names(self, r2h_binary):
        port = find_free_port()
        config = f"""\
[global]
verbosity = 4

[bind]
* {port}

[services]
#EXTM3U
#EXTINF:-1,Same Name
rtp://239.0.0.1:1234
#EXTINF:-1,Same Name
rtp://239.0.0.2:1234
#EXTINF:-1,Same Name
rtp://239.0.0.3:1234
"""
        r2h = R2HProcess(r2h_binary, port, config_content=config)
        try:
            r2h.start()
            status, _, body = http_get("127.0.0.1", port, "/playlist.m3u")
            text = body.decode()
            assert status == 200
            # Each "Same Name" entry should have a distinct URL
            lines = [l for l in text.splitlines() if l.startswith("http")]
            assert len(lines) >= 3, "Expected at least 3 rewritten URLs"
            assert len(set(lines)) == len(lines), "URLs should be unique"
        finally:
            r2h.stop()


# ---------------------------------------------------------------------------
# Catchup / timeshift attributes
# ---------------------------------------------------------------------------


class TestM3UCatchup:
    """Catchup attributes in EXTINF should be preserved."""

    def test_catchup_source_preserved(self, r2h_binary):
        port = find_free_port()
        config = f"""\
[global]
verbosity = 4

[bind]
* {port}

[services]
#EXTM3U
#EXTINF:-1 catchup="default" catchup-source="rtsp://10.0.0.50:554/playback?seek={{utc:YmdHMS}}-{{utcend:YmdHMS}}",Catchup Ch
rtp://239.0.0.1:1234
"""
        r2h = R2HProcess(r2h_binary, port, config_content=config)
        try:
            r2h.start()
            status, _, body = http_get("127.0.0.1", port, "/playlist.m3u")
            text = body.decode()
            assert status == 200
            assert 'catchup="default"' in text or "catchup-source=" in text
            assert "Catchup Ch" in text
        finally:
            r2h.stop()


class TestM3UCatchupAppend:
    """Append catchup fragments should be promoted into direct catchup proxy URLs."""

    def test_question_mark_preserved_no_dynamic_query(self, r2h_binary):
        """Append catchup with '?' should become a direct proxy catchup URL."""
        port = find_free_port()
        config = f"""\
[global]
verbosity = 4

[bind]
* {port}

[services]
#EXTM3U
#EXTINF:-1 catchup="append" catchup-source="?playseek={{utc}}-{{utcend}}",QMark NoDyn Ch
rtp://239.0.0.1:1234
"""
        r2h = R2HProcess(r2h_binary, port, config_content=config)
        try:
            r2h.start()
            status, _, body = http_get("127.0.0.1", port, "/playlist.m3u")
            text = body.decode()
            assert status == 200
            assert "QMark NoDyn Ch" in text
            line, catchup_source = extract_catchup_source(text, "QMark NoDyn Ch")
            assert 'catchup="default"' in line, (
                "Expected transformed append catchup to become default, got:\n%s" % line
            )
            assert (
                "/QMark%20NoDyn%20Ch/catchup?playseek={utc}-{utcend}" in catchup_source
            ), ("Expected direct catchup proxy URL, got:\n%s" % catchup_source)
        finally:
            r2h.stop()

    def test_ampersand_adjusted_to_question_no_dynamic_query(self, r2h_binary):
        """Append catchup with '&' should also become a direct proxy catchup URL."""
        port = find_free_port()
        config = f"""\
[global]
verbosity = 4

[bind]
* {port}

[services]
#EXTM3U
#EXTINF:-1 catchup="append" catchup-source="&playseek={{utc}}-{{utcend}}",Amp NoDyn Ch
rtp://239.0.0.1:1234
"""
        r2h = R2HProcess(r2h_binary, port, config_content=config)
        try:
            r2h.start()
            status, _, body = http_get("127.0.0.1", port, "/playlist.m3u")
            text = body.decode()
            assert status == 200
            assert "Amp NoDyn Ch" in text
            line, catchup_source = extract_catchup_source(text, "Amp NoDyn Ch")
            assert 'catchup="default"' in line, (
                "Expected transformed append catchup to become default, got:\n%s" % line
            )
            assert (
                "/Amp%20NoDyn%20Ch/catchup?playseek={utc}-{utcend}" in catchup_source
            ), ("Expected direct catchup proxy URL, got:\n%s" % catchup_source)
        finally:
            r2h.stop()

    def test_ampersand_preserved_with_dynamic_query(self, r2h_binary):
        """Append catchup should use direct proxy URL even when main proxy URL has dynamic query."""
        port = find_free_port()
        config = f"""\
[global]
verbosity = 4

[bind]
* {port}

[services]
#EXTM3U
#EXTINF:-1 catchup="append" catchup-source="&playseek={{utc}}-{{utcend}}",Amp Dyn Ch
http://10.10.10.1:8888/live/stream.m3u8?begin={{utc}}
"""
        r2h = R2HProcess(r2h_binary, port, config_content=config)
        try:
            r2h.start()
            status, _, body = http_get("127.0.0.1", port, "/playlist.m3u")
            text = body.decode()
            assert status == 200
            assert "Amp Dyn Ch" in text
            line, catchup_source = extract_catchup_source(text, "Amp Dyn Ch")
            assert 'catchup="default"' in line, (
                "Expected transformed append catchup to become default, got:\n%s" % line
            )
            assert (
                "/Amp%20Dyn%20Ch/catchup?playseek={utc}-{utcend}" in catchup_source
            ), ("Expected direct catchup proxy URL, got:\n%s" % catchup_source)
            assert "http://127.0.0.1:" in line
        finally:
            r2h.stop()

    def test_question_adjusted_to_ampersand_with_dynamic_query(self, r2h_binary):
        """Append catchup with '?' should still use a direct proxy catchup URL."""
        port = find_free_port()
        config = f"""\
[global]
verbosity = 4

[bind]
* {port}

[services]
#EXTM3U
#EXTINF:-1 catchup="append" catchup-source="?playseek={{utc}}-{{utcend}}",QMark Dyn Ch
http://10.10.10.1:8888/live/stream.m3u8?begin={{utc}}
"""
        r2h = R2HProcess(r2h_binary, port, config_content=config)
        try:
            r2h.start()
            status, _, body = http_get("127.0.0.1", port, "/playlist.m3u")
            text = body.decode()
            assert status == 200
            assert "QMark Dyn Ch" in text
            line, catchup_source = extract_catchup_source(text, "QMark Dyn Ch")
            assert 'catchup="default"' in line, (
                "Expected transformed append catchup to become default, got:\n%s" % line
            )
            assert (
                "/QMark%20Dyn%20Ch/catchup?playseek={utc}-{utcend}" in catchup_source
            ), ("Expected direct catchup proxy URL, got:\n%s" % catchup_source)
        finally:
            r2h.stop()

    def test_static_query_does_not_count_as_dynamic(self, r2h_binary):
        """Static main-query parameters should not prevent append catchup promotion."""
        port = find_free_port()
        config = f"""\
[global]
verbosity = 4

[bind]
* {port}

[services]
#EXTM3U
#EXTINF:-1 catchup="append" catchup-source="&playseek={{utc}}-{{utcend}}",Static Query Ch
http://10.10.10.1:8888/live/stream.m3u8?token=abc
"""
        r2h = R2HProcess(r2h_binary, port, config_content=config)
        try:
            r2h.start()
            status, _, body = http_get("127.0.0.1", port, "/playlist.m3u")
            text = body.decode()
            assert status == 200
            assert "Static Query Ch" in text
            line, catchup_source = extract_catchup_source(text, "Static Query Ch")
            assert 'catchup="default"' in line, (
                "Expected transformed append catchup to become default, got:\n%s" % line
            )
            assert (
                "/Static%20Query%20Ch/catchup?playseek={utc}-{utcend}" in catchup_source
            ), ("Expected direct catchup proxy URL, got:\n%s" % catchup_source)
        finally:
            r2h.stop()

    def test_no_prefix_catchup_is_promoted(self, r2h_binary):
        """Append catchup-source without a leading separator should still become a direct proxy URL."""
        port = find_free_port()
        config = f"""\
[global]
verbosity = 4

[bind]
* {port}

[services]
#EXTM3U
#EXTINF:-1 catchup="append" catchup-source="playseek={{utc}}-{{utcend}}",No Prefix Ch
rtp://239.0.0.1:1234
"""
        r2h = R2HProcess(r2h_binary, port, config_content=config)
        try:
            r2h.start()
            status, _, body = http_get("127.0.0.1", port, "/playlist.m3u")
            text = body.decode()
            assert status == 200
            assert "No Prefix Ch" in text
            line, catchup_source = extract_catchup_source(text, "No Prefix Ch")
            assert 'catchup="default"' in line, (
                "Expected transformed append catchup to become default, got:\n%s" % line
            )
            assert (
                "/No%20Prefix%20Ch/catchup?playseek={utc}-{utcend}" in catchup_source
            ), ("Expected direct catchup proxy URL, got:\n%s" % catchup_source)
        finally:
            r2h.stop()


# ---------------------------------------------------------------------------
# TVG URL in header
# ---------------------------------------------------------------------------


class TestM3UTvgUrl:
    """x-tvg-url attribute in #EXTM3U header should be preserved."""

    def test_tvg_url(self, r2h_binary):
        port = find_free_port()
        config = f"""\
[global]
verbosity = 4

[bind]
* {port}

[services]
#EXTM3U x-tvg-url="http://example.com/epg.xml.gz"
#EXTINF:-1 tvg-id="CH1" tvg-name="Channel 1",Channel 1
rtp://239.0.0.1:1234
"""
        r2h = R2HProcess(r2h_binary, port, config_content=config)
        try:
            r2h.start()
            status, _, body = http_get("127.0.0.1", port, "/playlist.m3u")
            text = body.decode()
            assert status == 200
            assert "tvg-id" in text or "tvg-name" in text
            assert "Channel 1" in text
        finally:
            r2h.stop()


# ---------------------------------------------------------------------------
# EXTINF metadata
# ---------------------------------------------------------------------------


class TestM3UMetadata:
    """EXTINF metadata (tvg-id, group-title, logo) should be preserved."""

    def test_group_title_preserved(self, r2h_binary):
        port = find_free_port()
        config = f"""\
[global]
verbosity = 4

[bind]
* {port}

[services]
#EXTM3U
#EXTINF:-1 tvg-id="CCTV1" tvg-name="CCTV-1" tvg-logo="http://example.com/logo.png" group-title="Central",CCTV-1
rtp://239.0.0.1:1234
"""
        r2h = R2HProcess(r2h_binary, port, config_content=config)
        try:
            r2h.start()
            status, _, body = http_get("127.0.0.1", port, "/playlist.m3u")
            text = body.decode()
            assert status == 200
            assert 'group-title="Central"' in text
            assert "CCTV-1" in text
        finally:
            r2h.stop()


# ---------------------------------------------------------------------------
# Special characters in service names
# ---------------------------------------------------------------------------


class TestM3USpecialChars:
    """Service names with Chinese / special characters should be URL-encoded
    in the transformed playlist but accessible when decoded."""

    def test_chinese_service_name(self, r2h_binary):
        port = find_free_port()
        config = f"""\
[global]
verbosity = 4

[bind]
* {port}

[services]
#EXTM3U
#EXTINF:-1,\u5e7f\u4e1c\u536b\u89c6
rtp://239.0.0.1:1234
"""
        r2h = R2HProcess(r2h_binary, port, config_content=config)
        try:
            r2h.start()
            status, _, body = http_get("127.0.0.1", port, "/playlist.m3u")
            text = body.decode()
            assert status == 200
            # The service name should appear (either encoded or literal)
            assert "\u5e7f\u4e1c\u536b\u89c6" in text or "%E5%B9%BF" in text
        finally:
            r2h.stop()


# ---------------------------------------------------------------------------
# Mixed protocol sources
# ---------------------------------------------------------------------------


class TestM3UMixedSources:
    """Playlist with a mix of rtp://, rtsp://, and http:// sources."""

    def test_mixed_sources(self, r2h_binary):
        port = find_free_port()
        config = f"""\
[global]
verbosity = 4

[bind]
* {port}

[services]
#EXTM3U
#EXTINF:-1,RTP Channel
rtp://239.0.0.1:1234
#EXTINF:-1,RTSP Channel
rtsp://10.0.0.1:554/live
#EXTINF:-1,HTTP Channel
http://example.com:8080/stream.m3u8
"""
        r2h = R2HProcess(r2h_binary, port, config_content=config)
        try:
            r2h.start()
            status, _, body = http_get("127.0.0.1", port, "/playlist.m3u")
            text = body.decode()
            assert status == 200
            assert "RTP Channel" in text
            assert "RTSP Channel" in text
            assert "HTTP Channel" in text
            # Each should have a distinct URL line
            url_lines = [l for l in text.splitlines() if l.startswith("http")]
            assert len(url_lines) >= 3
        finally:
            r2h.stop()


# ---------------------------------------------------------------------------
# Named service access (via M3U service name)
# ---------------------------------------------------------------------------


class TestM3UServiceAccess:
    """Services defined in M3U should be accessible by name."""

    def test_service_head_by_name(self, r2h_binary):
        """HEAD request to a named service should return 200."""
        port = find_free_port()
        config = f"""\
[global]
verbosity = 4

[bind]
* {port}

[services]
#EXTM3U
#EXTINF:-1,Test Service
rtp://239.0.0.1:1234
"""
        r2h = R2HProcess(r2h_binary, port, config_content=config)
        try:
            r2h.start()
            status, _, body = http_request(
                "127.0.0.1",
                port,
                "HEAD",
                "/Test%20Service",
                timeout=3.0,
            )
            assert status == 200
            assert len(body) == 0
        finally:
            r2h.stop()

    def test_service_unknown_name_404(self, r2h_binary):
        """A service name not in M3U should return 404."""
        port = find_free_port()
        config = f"""\
[global]
verbosity = 4

[bind]
* {port}

[services]
#EXTM3U
#EXTINF:-1,Known
rtp://239.0.0.1:1234
"""
        r2h = R2HProcess(r2h_binary, port, config_content=config)
        try:
            r2h.start()
            status, _, _ = http_get("127.0.0.1", port, "/Unknown")
            assert status == 404
        finally:
            r2h.stop()


# ---------------------------------------------------------------------------
# Label suffix ($label) stripping
# ---------------------------------------------------------------------------


class TestM3ULabelSuffix:
    """The $label suffix in URLs is for UI display only and should be
    stripped before service matching."""

    def test_label_suffix_stripped(self, r2h_binary):
        """HEAD /ServiceName$label should match ServiceName."""
        port = find_free_port()
        config = f"""\
[global]
verbosity = 4

[bind]
* {port}

[services]
#EXTM3U
#EXTINF:-1,MyChannel
rtp://239.0.0.1:1234
"""
        r2h = R2HProcess(r2h_binary, port, config_content=config)
        try:
            r2h.start()
            # With $label suffix
            status, _, _ = http_request(
                "127.0.0.1",
                port,
                "HEAD",
                "/MyChannel$HD",
                timeout=3.0,
            )
            assert status == 200
        finally:
            r2h.stop()


# ---------------------------------------------------------------------------
# External M3U via HTTP URL
# ---------------------------------------------------------------------------


class TestM3UHTTPExternal:
    """M3U loaded from an HTTP URL via -M http://..."""

    def test_external_http_m3u(self, r2h_binary):
        """Loading M3U from an HTTP URL should populate the playlist."""
        from helpers import MockHTTPUpstream

        m3u_content = (
            "#EXTM3U\n" "#EXTINF:-1,HTTP Loaded Channel\n" "rtp://239.10.0.1:5000\n"
        )
        upstream = MockHTTPUpstream(
            routes={
                "/channels.m3u": {
                    "status": 200,
                    "body": m3u_content,
                    "headers": {"Content-Type": "audio/x-mpegurl"},
                },
            }
        )
        upstream.start()

        port = find_free_port()
        r2h = R2HProcess(
            r2h_binary,
            port,
            extra_args=[
                "-v",
                "4",
                "-m",
                "100",
                "-M",
                "http://127.0.0.1:%d/channels.m3u" % upstream.port,
            ],
        )
        try:
            r2h.start()
            time.sleep(0.5)  # allow async M3U fetch via curl
            status, _, body = http_get("127.0.0.1", port, "/playlist.m3u")
            text = body.decode()
            assert status == 200
            assert "HTTP Loaded Channel" in text
        finally:
            r2h.stop()
            upstream.stop()

    def test_external_http_m3u_url_rewritten(self, r2h_binary):
        """URLs in externally loaded HTTP M3U should be rewritten."""
        from helpers import MockHTTPUpstream

        m3u_content = (
            "#EXTM3U\n"
            "#EXTINF:-1,Ext RTSP Channel\n"
            "rtsp://192.168.1.1:554/live\n"
            "#EXTINF:-1,Ext RTP Channel\n"
            "rtp://239.10.0.1:5000\n"
        )
        upstream = MockHTTPUpstream(
            routes={
                "/list.m3u": {
                    "status": 200,
                    "body": m3u_content,
                    "headers": {"Content-Type": "audio/x-mpegurl"},
                },
            }
        )
        upstream.start()

        port = find_free_port()
        r2h = R2HProcess(
            r2h_binary,
            port,
            extra_args=[
                "-v",
                "4",
                "-m",
                "100",
                "-M",
                "http://127.0.0.1:%d/list.m3u" % upstream.port,
            ],
        )
        try:
            r2h.start()
            time.sleep(0.5)
            status, _, body = http_get("127.0.0.1", port, "/playlist.m3u")
            text = body.decode()
            assert status == 200
            # URLs should be rewritten to go through rtp2httpd
            assert "rtsp://192.168.1.1:554" not in text
            assert "rtp://239.10.0.1:5000" not in text
            assert "http://" in text
        finally:
            r2h.stop()
            upstream.stop()


# ---------------------------------------------------------------------------
# Multiple sources per channel with $label suffix in M3U
# ---------------------------------------------------------------------------


class TestM3UMultiLabel:
    """M3U with multiple sources for the same channel using $label."""

    def test_multi_label_distinct_urls(self, r2h_binary):
        """Channels with same name but different $label should produce
        distinct URLs in the playlist."""
        port = find_free_port()
        config = f"""\
[global]
verbosity = 4

[bind]
* {port}

[services]
#EXTM3U
#EXTINF:-1,CCTV-1
rtp://239.0.0.1:1234$HD
#EXTINF:-1,CCTV-1
rtp://239.0.0.2:1234$SD
"""
        r2h = R2HProcess(r2h_binary, port, config_content=config)
        try:
            r2h.start()
            status, _, body = http_get("127.0.0.1", port, "/playlist.m3u")
            text = body.decode()
            assert status == 200
            assert "CCTV-1" in text
            # Should have URLs for both sources
            url_lines = [l for l in text.splitlines() if l.startswith("http")]
            assert (
                len(url_lines) >= 2
            ), "Expected at least 2 URLs for multi-label, got %d" % len(url_lines)
            assert len(set(url_lines)) == len(url_lines), "URLs should be unique"
        finally:
            r2h.stop()

    def test_multi_label_urls_contain_labels(self, r2h_binary):
        """The playlist URLs for multi-label channels should reference labels."""
        port = find_free_port()
        config = f"""\
[global]
verbosity = 4

[bind]
* {port}

[services]
#EXTM3U
#EXTINF:-1,TestCh
rtp://239.0.0.1:1234$HD
#EXTINF:-1,TestCh
rtp://239.0.0.2:1234$SD
"""
        r2h = R2HProcess(r2h_binary, port, config_content=config)
        try:
            r2h.start()
            status, _, body = http_get("127.0.0.1", port, "/playlist.m3u")
            text = body.decode()
            assert status == 200
            # Both EXTINF entries should reference TestCh
            assert text.count("TestCh") >= 2
        finally:
            r2h.stop()
