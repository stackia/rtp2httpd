"""
E2E tests for HTTP proxy seek / time processing.

Covers playseek, tvdr, custom seek name (r2h-seek-name), r2h-seek-offset,
timezone conversion (User-Agent TZ/ marker), and time format preservation
for the HTTP proxy path.
"""

import re

import pytest

from helpers import (
    MockHTTPUpstream,
    R2HProcess,
    find_free_port,
    http_get,
    stream_get,
)

pytestmark = pytest.mark.http_proxy

_TIMEOUT = 10.0


@pytest.fixture(scope="module")
def shared_r2h(r2h_binary):
    """A single rtp2httpd instance shared by all HTTP proxy seek tests."""
    port = find_free_port()
    r2h = R2HProcess(r2h_binary, port, extra_args=["-v", "4", "-m", "100"])
    r2h.start()
    yield r2h
    r2h.stop()


def _make_upstream(path="/stream"):
    """Create a MockHTTPUpstream that accepts requests on the given path."""
    return MockHTTPUpstream(routes={
        path: {"status": 200, "body": b"ok", "headers": {"Content-Type": "text/plain"}},
    })


def _get_upstream_path(upstream):
    """Return the full path (with query string) from the first recorded request."""
    assert len(upstream.requests_log) > 0, "Expected at least one request to upstream"
    return upstream.requests_log[0]["path"]


def _extract_seek_value(path, param_name):
    """Extract a seek parameter value from a URL path/query string."""
    match = re.search(r'[?&]%s=([^&]+)' % re.escape(param_name), path)
    assert match, "Expected %s= in path, got: %s" % (param_name, path)
    return match.group(1)


# ===================================================================
# Seek parameter forwarding
# ===================================================================


class TestHTTPProxySeekForwarding:
    """Verify seek parameters are forwarded to the HTTP upstream."""

    def test_playseek_forwarded(self, shared_r2h):
        """playseek parameter should be forwarded to the upstream."""
        upstream = _make_upstream()
        upstream.start()
        try:
            status, _, body = http_get(
                "127.0.0.1", shared_r2h.port,
                "/http/127.0.0.1:%d/stream?playseek=20240101120000-20240101130000" % upstream.port,
                timeout=_TIMEOUT,
            )
            assert status == 200

            path = _get_upstream_path(upstream)
            assert "playseek=" in path, \
                "playseek should be forwarded to upstream, got: %s" % path
        finally:
            upstream.stop()

    def test_tvdr_forwarded(self, shared_r2h):
        """tvdr parameter should be forwarded to the upstream."""
        upstream = _make_upstream()
        upstream.start()
        try:
            status, _, body = http_get(
                "127.0.0.1", shared_r2h.port,
                "/http/127.0.0.1:%d/stream?tvdr=20240601080000-20240601090000" % upstream.port,
                timeout=_TIMEOUT,
            )
            assert status == 200

            path = _get_upstream_path(upstream)
            assert "tvdr=" in path, \
                "tvdr should be forwarded to upstream, got: %s" % path
        finally:
            upstream.stop()

    def test_custom_seek_name_forwarded(self, shared_r2h):
        """r2h-seek-name=myseek should forward myseek to upstream."""
        upstream = _make_upstream()
        upstream.start()
        try:
            status, _, body = http_get(
                "127.0.0.1", shared_r2h.port,
                "/http/127.0.0.1:%d/stream?r2h-seek-name=myseek&myseek=20240301100000-20240301110000" % upstream.port,
                timeout=_TIMEOUT,
            )
            assert status == 200

            path = _get_upstream_path(upstream)
            assert "myseek=" in path, \
                "Custom seek param should be forwarded, got: %s" % path
        finally:
            upstream.stop()

    def test_r2h_seek_name_stripped(self, shared_r2h):
        """r2h-seek-name should be stripped from the upstream URL."""
        upstream = _make_upstream()
        upstream.start()
        try:
            http_get(
                "127.0.0.1", shared_r2h.port,
                "/http/127.0.0.1:%d/stream?r2h-seek-name=myseek&myseek=20240301100000-20240301110000" % upstream.port,
                timeout=_TIMEOUT,
            )

            path = _get_upstream_path(upstream)
            assert "r2h-seek-name" not in path, \
                "r2h-seek-name should be stripped, got: %s" % path
            assert "myseek=" in path
        finally:
            upstream.stop()


# ===================================================================
# r2h-seek-offset (additional seconds offset)
# ===================================================================


class TestHTTPProxySeekOffset:
    """Verify r2h-seek-offset applies additional seconds offset."""

    def test_positive_offset(self, shared_r2h):
        """r2h-seek-offset=3600 should add 1 hour to playseek times."""
        upstream = _make_upstream()
        upstream.start()
        try:
            http_get(
                "127.0.0.1", shared_r2h.port,
                "/http/127.0.0.1:%d/stream?playseek=20240101120000-20240101130000&r2h-seek-offset=3600" % upstream.port,
                timeout=_TIMEOUT,
            )

            path = _get_upstream_path(upstream)
            val = _extract_seek_value(path, "playseek")
            assert val == "20240101130000-20240101140000", \
                "Expected +1h offset, got: %s" % val
        finally:
            upstream.stop()

    def test_negative_offset(self, shared_r2h):
        """r2h-seek-offset=-30 should subtract 30 seconds."""
        upstream = _make_upstream()
        upstream.start()
        try:
            http_get(
                "127.0.0.1", shared_r2h.port,
                "/http/127.0.0.1:%d/stream?playseek=20240101120000-20240101130000&r2h-seek-offset=-30" % upstream.port,
                timeout=_TIMEOUT,
            )

            path = _get_upstream_path(upstream)
            val = _extract_seek_value(path, "playseek")
            assert val == "20240101115930-20240101125930", \
                "Expected -30s offset, got: %s" % val
        finally:
            upstream.stop()

    def test_offset_stripped_from_upstream(self, shared_r2h):
        """r2h-seek-offset should be stripped from the upstream URL."""
        upstream = _make_upstream()
        upstream.start()
        try:
            http_get(
                "127.0.0.1", shared_r2h.port,
                "/http/127.0.0.1:%d/stream?playseek=20240101120000-20240101130000&r2h-seek-offset=3600" % upstream.port,
                timeout=_TIMEOUT,
            )

            path = _get_upstream_path(upstream)
            assert "r2h-seek-offset" not in path, \
                "r2h-seek-offset should be stripped, got: %s" % path
        finally:
            upstream.stop()

    def test_offset_with_unix_timestamp(self, shared_r2h):
        """r2h-seek-offset should work with Unix timestamps."""
        upstream = _make_upstream()
        upstream.start()
        try:
            http_get(
                "127.0.0.1", shared_r2h.port,
                "/http/127.0.0.1:%d/stream?playseek=1704096000-1704099600&r2h-seek-offset=3600" % upstream.port,
                timeout=_TIMEOUT,
            )

            path = _get_upstream_path(upstream)
            val = _extract_seek_value(path, "playseek")
            assert val == "1704099600-1704103200", \
                "Expected +3600 on Unix timestamps, got: %s" % val
        finally:
            upstream.stop()


# ===================================================================
# Timezone conversion (User-Agent TZ/ marker)
# ===================================================================


class TestHTTPProxyTimezone:
    """Verify timezone conversion based on User-Agent TZ/ marker."""

    def test_tz_utc_plus_8_converts_yyyyMMddHHmmss(self, shared_r2h):
        """TZ/UTC+8 should subtract 8 hours from yyyyMMddHHmmss format."""
        upstream = _make_upstream()
        upstream.start()
        try:
            http_get(
                "127.0.0.1", shared_r2h.port,
                "/http/127.0.0.1:%d/stream?playseek=20240101120000-20240101130000" % upstream.port,
                timeout=_TIMEOUT,
                headers={"User-Agent": "TestPlayer/1.0 TZ/UTC+8"},
            )

            path = _get_upstream_path(upstream)
            val = _extract_seek_value(path, "playseek")
            assert val == "20240101040000-20240101050000", \
                "TZ/UTC+8: 12:00 CST should become 04:00 UTC, got: %s" % val
        finally:
            upstream.stop()

    def test_tz_utc_minus_5_converts_yyyyMMddHHmmss(self, shared_r2h):
        """TZ/UTC-5 should add 5 hours to yyyyMMddHHmmss format."""
        upstream = _make_upstream()
        upstream.start()
        try:
            http_get(
                "127.0.0.1", shared_r2h.port,
                "/http/127.0.0.1:%d/stream?playseek=20240101120000-20240101130000" % upstream.port,
                timeout=_TIMEOUT,
                headers={"User-Agent": "TestPlayer/1.0 TZ/UTC-5"},
            )

            path = _get_upstream_path(upstream)
            val = _extract_seek_value(path, "playseek")
            assert val == "20240101170000-20240101180000", \
                "TZ/UTC-5: 12:00 EST should become 17:00 UTC, got: %s" % val
        finally:
            upstream.stop()

    def test_no_tz_no_conversion(self, shared_r2h):
        """Without TZ/ in User-Agent, times should not be converted."""
        upstream = _make_upstream()
        upstream.start()
        try:
            http_get(
                "127.0.0.1", shared_r2h.port,
                "/http/127.0.0.1:%d/stream?playseek=20240101120000-20240101130000" % upstream.port,
                timeout=_TIMEOUT,
                headers={"User-Agent": "TestPlayer/1.0"},
            )

            path = _get_upstream_path(upstream)
            val = _extract_seek_value(path, "playseek")
            assert val == "20240101120000-20240101130000", \
                "No TZ: times should stay unchanged, got: %s" % val
        finally:
            upstream.stop()

    def test_unix_timestamp_skips_tz_conversion(self, shared_r2h):
        """Unix timestamps should not be affected by User-Agent timezone."""
        upstream = _make_upstream()
        upstream.start()
        try:
            http_get(
                "127.0.0.1", shared_r2h.port,
                "/http/127.0.0.1:%d/stream?playseek=1704096000-1704099600" % upstream.port,
                timeout=_TIMEOUT,
                headers={"User-Agent": "TestPlayer/1.0 TZ/UTC+8"},
            )

            path = _get_upstream_path(upstream)
            val = _extract_seek_value(path, "playseek")
            assert val == "1704096000-1704099600", \
                "Unix timestamps should not be timezone-converted, got: %s" % val
        finally:
            upstream.stop()

    def test_tz_with_offset_combined(self, shared_r2h):
        """TZ/UTC+8 combined with r2h-seek-offset should apply both."""
        upstream = _make_upstream()
        upstream.start()
        try:
            # 12:00 CST -> 04:00 UTC, then +3600 -> 05:00 UTC
            http_get(
                "127.0.0.1", shared_r2h.port,
                "/http/127.0.0.1:%d/stream?playseek=20240101120000-20240101130000&r2h-seek-offset=3600" % upstream.port,
                timeout=_TIMEOUT,
                headers={"User-Agent": "TestPlayer/1.0 TZ/UTC+8"},
            )

            path = _get_upstream_path(upstream)
            val = _extract_seek_value(path, "playseek")
            assert val == "20240101050000-20240101060000", \
                "TZ+8 then +3600s: expected 05:00-06:00 UTC, got: %s" % val
        finally:
            upstream.stop()


# ===================================================================
# Time format preservation
# ===================================================================


class TestHTTPProxyTimeFormatPreservation:
    """Verify that output format matches input format."""

    def test_gmt_suffix_preserved(self, shared_r2h):
        """yyyyMMddHHmmssGMT format should preserve the GMT suffix."""
        upstream = _make_upstream()
        upstream.start()
        try:
            http_get(
                "127.0.0.1", shared_r2h.port,
                "/http/127.0.0.1:%d/stream?playseek=20240101120000GMT-20240101130000GMT&r2h-seek-offset=3600" % upstream.port,
                timeout=_TIMEOUT,
            )

            path = _get_upstream_path(upstream)
            val = _extract_seek_value(path, "playseek")
            assert val == "20240101130000GMT-20240101140000GMT", \
                "GMT suffix should be preserved, got: %s" % val
        finally:
            upstream.stop()

    def test_unix_timestamp_format_preserved(self, shared_r2h):
        """Unix timestamp format should stay as Unix timestamp."""
        upstream = _make_upstream()
        upstream.start()
        try:
            http_get(
                "127.0.0.1", shared_r2h.port,
                "/http/127.0.0.1:%d/stream?playseek=1704096000-1704099600" % upstream.port,
                timeout=_TIMEOUT,
            )

            path = _get_upstream_path(upstream)
            val = _extract_seek_value(path, "playseek")
            assert val == "1704096000-1704099600", \
                "Unix timestamp format should be preserved, got: %s" % val
        finally:
            upstream.stop()

    def test_gmt_suffix_with_tz_conversion(self, shared_r2h):
        """yyyyMMddHHmmssGMT with TZ/UTC+8 should convert and keep GMT suffix."""
        upstream = _make_upstream()
        upstream.start()
        try:
            http_get(
                "127.0.0.1", shared_r2h.port,
                "/http/127.0.0.1:%d/stream?playseek=20240101120000GMT-20240101130000GMT" % upstream.port,
                timeout=_TIMEOUT,
                headers={"User-Agent": "TestPlayer/1.0 TZ/UTC+8"},
            )

            path = _get_upstream_path(upstream)
            val = _extract_seek_value(path, "playseek")
            assert val == "20240101040000GMT-20240101050000GMT", \
                "GMT format + TZ/UTC+8: expected 04:00-05:00 with GMT, got: %s" % val
        finally:
            upstream.stop()
