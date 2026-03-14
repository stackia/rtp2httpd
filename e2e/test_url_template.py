"""
E2E tests for time and seek processing.

Covers two distinct layers:
1. Resolver-layer URL handling for direct HTTP/RTSP requests.
2. M3U catchup-source rewrite and closed-loop consumption from /playlist.m3u.
"""

import re

import pytest

from helpers import (
    MockHTTPUpstream,
    MockRTSPServer,
    MockRTSPServerUDP,
    R2HProcess,
    find_free_port,
    http_get,
    stream_get,
)

_TIMEOUT = 10.0
_STREAM_TIMEOUT = 20.0

# Known epoch values for test assertions (UTC):
# 2024-01-01 12:00:00 UTC = 1704110400
# 2024-01-01 13:00:00 UTC = 1704114000
_BEGIN_EPOCH = 1704110400
_END_EPOCH = 1704114000
_DURATION = _END_EPOCH - _BEGIN_EPOCH  # 3600


@pytest.fixture(scope="module")
def shared_r2h(r2h_binary):
    """A single rtp2httpd instance shared by all URL template tests."""
    port = find_free_port()
    r2h = R2HProcess(r2h_binary, port, extra_args=["-v", "4", "-m", "100"])
    r2h.start()
    yield r2h
    r2h.stop()


def _make_upstream(*paths):
    """Create a MockHTTPUpstream that accepts requests on the given paths."""
    routes = {}
    for p in paths:
        routes[p] = {
            "status": 200,
            "body": b"ok",
            "headers": {"Content-Type": "text/plain"},
        }
    return MockHTTPUpstream(routes=routes)


def _get_upstream_path(upstream):
    """Return the full path (with query string) from the first recorded request."""
    assert len(upstream.requests_log) > 0, "Expected at least one request to upstream"
    return upstream.requests_log[0]["path"]


def _extract_query_param(path, param_name):
    """Extract a query parameter value from a path or URI."""
    match = re.search(r"[?&]%s=([^&]+)" % re.escape(param_name), path)
    assert match, "Expected %s= in path, got: %s" % (param_name, path)
    return match.group(1)


def _get_describe_uri(rtsp):
    """Extract the URI from the first DESCRIBE request."""
    describe_reqs = [r for r in rtsp.requests_detailed if r["method"] == "DESCRIBE"]
    assert len(describe_reqs) > 0, "Expected DESCRIBE request"
    return describe_reqs[0]["uri"]


def _extract_catchup_source(playlist_text, channel_name):
    """Extract catchup-source URL from the EXTINF line for a channel."""
    for line in playlist_text.splitlines():
        if channel_name in line and "catchup-source=" in line:
            match = re.search(r'catchup-source="([^"]+)"', line)
            assert match, "Expected catchup-source in line: %s" % line
            return match.group(1)
    raise AssertionError("Expected catchup-source line for channel: %s" % channel_name)


def _absolute_url_to_path(url):
    """Convert an absolute proxy URL back into an HTTP path for local requests."""
    match = re.match(r"https?://[^/]+(/.*)$", url)
    assert match, "Expected absolute HTTP URL, got: %s" % url
    return match.group(1)


# ===================================================================
# Resolver-layer HTTP proxy with path-level templates
# ===================================================================


@pytest.mark.http_proxy
class TestHTTPTemplateResolver:
    """Verify resolver-layer template substitution in HTTP proxy paths."""

    def test_begin_end_yyyyMMddHHmmss(self, shared_r2h):
        """${(b)yyyyMMddHHmmss} and ${(e)yyyyMMddHHmmss} should be substituted."""
        expected_path = "/path/20240101120000/20240101130000/file.m3u8"
        upstream = _make_upstream(expected_path)
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d"
                "/path/${(b)yyyyMMddHHmmss}/${(e)yyyyMMddHHmmss}/file.m3u8"
                "?playseek=20240101120000-20240101130000"
            ) % upstream.port
            status, _, _ = http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            assert status == 200

            path = _get_upstream_path(upstream)
            assert path == expected_path
        finally:
            upstream.stop()

    def test_utc_placeholder(self, shared_r2h):
        """{utc} should be replaced with begin time as ISO8601."""
        expected_path = "/stream/2024-01-01T12:00:00.000Z/data"
        upstream = _make_upstream(expected_path)
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d/stream/{utc}/data"
                "?playseek=20240101120000-20240101130000"
            ) % upstream.port
            status, _, _ = http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            assert status == 200

            path = _get_upstream_path(upstream)
            assert path == expected_path
        finally:
            upstream.stop()

    def test_start_placeholder_alias(self, shared_r2h):
        """{start} should behave identically to {utc} (ISO8601)."""
        expected_path = "/stream/2024-01-01T12:00:00.000Z"
        upstream = _make_upstream(expected_path)
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d/stream/{start}"
                "?playseek=20240101120000-20240101130000"
            ) % upstream.port
            status, _, _ = http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            assert status == 200

            path = _get_upstream_path(upstream)
            assert path == expected_path
        finally:
            upstream.stop()

    def test_end_placeholder(self, shared_r2h):
        """{end} should be replaced with end time as ISO8601."""
        expected_path = "/stream/2024-01-01T13:00:00.000Z"
        upstream = _make_upstream(expected_path)
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d/stream/{end}"
                "?playseek=20240101120000-20240101130000"
            ) % upstream.port
            status, _, _ = http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            assert status == 200

            path = _get_upstream_path(upstream)
            assert path == expected_path
        finally:
            upstream.stop()

    def test_duration_placeholder(self, shared_r2h):
        """{duration} should be replaced with end - begin in seconds."""
        expected_path = "/stream/%d" % _DURATION
        upstream = _make_upstream(expected_path)
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d/stream/{duration}"
                "?playseek=20240101120000-20240101130000"
            ) % upstream.port
            status, _, _ = http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            assert status == 200

            path = _get_upstream_path(upstream)
            assert path == expected_path
        finally:
            upstream.stop()

    def test_component_Y(self, shared_r2h):
        """{Y} should be replaced with 4-digit year."""
        expected_path = "/stream/2024"
        upstream = _make_upstream(expected_path)
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d/stream/{Y}"
                "?playseek=20240101120000-20240101130000"
            ) % upstream.port
            status, _, _ = http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            assert status == 200
            assert _get_upstream_path(upstream) == expected_path
        finally:
            upstream.stop()

    def test_component_m(self, shared_r2h):
        """{m} should be replaced with 2-digit month."""
        expected_path = "/stream/01"
        upstream = _make_upstream(expected_path)
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d/stream/{m}"
                "?playseek=20240101120000-20240101130000"
            ) % upstream.port
            status, _, _ = http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            assert status == 200
            assert _get_upstream_path(upstream) == expected_path
        finally:
            upstream.stop()

    def test_component_d(self, shared_r2h):
        """{d} should be replaced with 2-digit day."""
        expected_path = "/stream/01"
        upstream = _make_upstream(expected_path)
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d/stream/{d}"
                "?playseek=20240101120000-20240101130000"
            ) % upstream.port
            status, _, _ = http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            assert status == 200
            assert _get_upstream_path(upstream) == expected_path
        finally:
            upstream.stop()

    def test_component_H(self, shared_r2h):
        """{H} should be replaced with 2-digit hour."""
        expected_path = "/stream/12"
        upstream = _make_upstream(expected_path)
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d/stream/{H}"
                "?playseek=20240101120000-20240101130000"
            ) % upstream.port
            status, _, _ = http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            assert status == 200
            assert _get_upstream_path(upstream) == expected_path
        finally:
            upstream.stop()

    def test_component_M_minute(self, shared_r2h):
        """{M} should be replaced with 2-digit minute."""
        # Use non-zero minute to distinguish from month
        expected_path = "/stream/30"
        upstream = _make_upstream(expected_path)
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d/stream/{M}"
                "?playseek=20240101123000-20240101133000"
            ) % upstream.port
            status, _, _ = http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            assert status == 200
            assert _get_upstream_path(upstream) == expected_path
        finally:
            upstream.stop()

    def test_component_S_second(self, shared_r2h):
        """{S} should be replaced with 2-digit second."""
        expected_path = "/stream/45"
        upstream = _make_upstream(expected_path)
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d/stream/{S}"
                "?playseek=20240101120045-20240101130045"
            ) % upstream.port
            status, _, _ = http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            assert status == 200
            assert _get_upstream_path(upstream) == expected_path
        finally:
            upstream.stop()

    def test_all_components_together(self, shared_r2h):
        """{Y}/{m}/{d}/{H}/{M}/{S} all in one URL."""
        expected_path = "/stream/2024/01/01/12/00/00"
        upstream = _make_upstream(expected_path)
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d/stream/{Y}/{m}/{d}/{H}/{M}/{S}"
                "?playseek=20240101120000-20240101130000"
            ) % upstream.port
            status, _, _ = http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            assert status == 200
            assert _get_upstream_path(upstream) == expected_path
        finally:
            upstream.stop()

    def test_custom_format_with_literal_dash(self, shared_r2h):
        """Format pattern yyyyMMdd-HHmmss should emit literal dash."""
        expected_path = "/path/20240101-120000/20240101-130000/file.m3u8"
        upstream = _make_upstream(expected_path)
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d"
                "/path/${(b)yyyyMMdd-HHmmss}/${(e)yyyyMMdd-HHmmss}/file.m3u8"
                "?playseek=20240101120000-20240101130000"
            ) % upstream.port
            status, _, _ = http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            assert status == 200
            assert _get_upstream_path(upstream) == expected_path
        finally:
            upstream.stop()

    def test_no_seek_value_passthrough(self, shared_r2h):
        """Template URL without playseek should pass through with placeholders intact."""
        upstream = _make_upstream()
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d"
                "/path/${(b)yyyyMMddHHmmss}/${(e)yyyyMMddHHmmss}/file.m3u8"
            ) % upstream.port
            # No playseek parameter - URL should be forwarded as-is
            http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)

            path = _get_upstream_path(upstream)
            assert "${(b)yyyyMMddHHmmss}" in path, (
                "Without seek value, template should be passed through, got: %s" % path
            )
        finally:
            upstream.stop()

    def test_mixed_path_and_query_templates(self, shared_r2h):
        """Templates in both URL path and query string should all be substituted."""
        expected_path = "/path/20240101120000/data"
        upstream = _make_upstream(expected_path)
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d"
                "/path/${(b)yyyyMMddHHmmss}/data"
                "?ts={utc}&playseek=20240101120000-20240101130000"
            ) % upstream.port
            status, _, _ = http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            assert status == 200

            full_path = _get_upstream_path(upstream)
            # Path substituted
            assert full_path.startswith("/path/20240101120000/data")
            # Query template also substituted (ISO8601)
            assert "ts=2024-01-01T12" in full_path, (
                "Query template {utc} should be substituted as ISO8601, got: %s"
                % full_path
            )
        finally:
            upstream.stop()

    def test_multiple_begin_templates(self, shared_r2h):
        """Multiple ${(b)...} placeholders with different formats in the same URL."""
        expected_path = "/path/20240101/120000/file"
        upstream = _make_upstream(expected_path)
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d"
                "/path/${(b)yyyyMMdd}/${(b)HHmmss}/file"
                "?playseek=20240101120000-20240101130000"
            ) % upstream.port
            status, _, _ = http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            assert status == 200
            assert _get_upstream_path(upstream) == expected_path
        finally:
            upstream.stop()

    def test_begin_only_no_end_in_seek(self, shared_r2h):
        """Seek value with begin only (no dash, no end) should still substitute begin templates."""
        expected_path = "/path/20240101120000/file"
        upstream = _make_upstream(expected_path)
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d"
                "/path/${(b)yyyyMMddHHmmss}/file"
                "?playseek=20240101120000"
            ) % upstream.port
            status, _, _ = http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            assert status == 200
            assert _get_upstream_path(upstream) == expected_path
        finally:
            upstream.stop()

    def test_unix_timestamp_as_seek_value(self, shared_r2h):
        """Seek value as Unix timestamps should work with templates."""
        # 1704110400 = 2024-01-01 12:00:00 UTC
        # 1704114000 = 2024-01-01 13:00:00 UTC
        expected_path = "/path/20240101120000/20240101130000/file"
        upstream = _make_upstream(expected_path)
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d"
                "/path/${(b)yyyyMMddHHmmss}/${(e)yyyyMMddHHmmss}/file"
                "?playseek=%d-%d"
            ) % (upstream.port, _BEGIN_EPOCH, _END_EPOCH)
            status, _, _ = http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            assert status == 200
            assert _get_upstream_path(upstream) == expected_path
        finally:
            upstream.stop()

    def test_offset_placeholder_replaced(self, shared_r2h):
        """{offset} should be replaced with a numeric value (time(NULL) - begin_utc)."""
        upstream = _make_upstream()
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d/stream/{offset}"
                "?playseek=20240101120000-20240101130000"
            ) % upstream.port
            http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)

            path = _get_upstream_path(upstream)
            # {offset} should be replaced with a large positive number
            # (current time - 2024-01-01 12:00:00 UTC)
            match = re.match(r"/stream/(\d+)", path)
            assert match, "Expected /stream/<number>, got: %s" % path
            offset_val = int(match.group(1))
            # The offset should be at least a few million seconds (we're past 2024)
            assert offset_val > 1000000, (
                "Offset should be large (time since 2024-01-01), got: %d" % offset_val
            )
        finally:
            upstream.stop()

    def test_utc_and_begin_format_in_same_url(self, shared_r2h):
        """Both {utc} (ISO8601) and ${(b)yyyyMMddHHmmss} in the same URL should both substitute."""
        expected_path = "/path/2024-01-01T12:00:00.000Z/20240101120000/file"
        upstream = _make_upstream(expected_path)
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d"
                "/path/{utc}/${(b)yyyyMMddHHmmss}/file"
                "?playseek=20240101120000-20240101130000"
            ) % upstream.port
            status, _, _ = http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            assert status == 200
            assert _get_upstream_path(upstream) == expected_path
        finally:
            upstream.stop()


# ===================================================================
# Template with timezone and seek offset
# ===================================================================


@pytest.mark.http_proxy
class TestHTTPPathTemplateTimezone:
    """Verify timezone and offset interaction with path-level templates."""

    def test_tz_utc_plus_8(self, shared_r2h):
        """TZ/UTC+8: ${(b)FORMAT} uses local time, so 12:00 local stays 12:00."""
        expected_path = "/path/20240101120000/20240101130000/file.m3u8"
        upstream = _make_upstream(expected_path)
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d"
                "/path/${(b)yyyyMMddHHmmss}/${(e)yyyyMMddHHmmss}/file.m3u8"
                "?playseek=20240101120000-20240101130000"
            ) % upstream.port
            status, _, _ = http_get(
                "127.0.0.1",
                shared_r2h.port,
                url,
                timeout=_TIMEOUT,
                headers={"User-Agent": "TestPlayer/1.0 TZ/UTC+8"},
            )
            assert status == 200
            assert _get_upstream_path(upstream) == expected_path
        finally:
            upstream.stop()

    def test_seek_offset_applied(self, shared_r2h):
        """r2h-seek-offset=3600 should shift template times by +1 hour."""
        # 12:00 + 1h = 13:00, 13:00 + 1h = 14:00
        expected_path = "/path/20240101130000/20240101140000/file.m3u8"
        upstream = _make_upstream(expected_path)
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d"
                "/path/${(b)yyyyMMddHHmmss}/${(e)yyyyMMddHHmmss}/file.m3u8"
                "?playseek=20240101120000-20240101130000&r2h-seek-offset=3600"
            ) % upstream.port
            status, _, _ = http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            assert status == 200
            assert _get_upstream_path(upstream) == expected_path
        finally:
            upstream.stop()

    def test_tz_and_offset_combined(self, shared_r2h):
        """TZ/UTC+8 + r2h-seek-offset=3600: 12:00 CST+1h=13:00 CST, end 14:00 CST (local time)."""
        expected_path = "/path/20240101130000/20240101140000/file.m3u8"
        upstream = _make_upstream(expected_path)
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d"
                "/path/${(b)yyyyMMddHHmmss}/${(e)yyyyMMddHHmmss}/file.m3u8"
                "?playseek=20240101120000-20240101130000&r2h-seek-offset=3600"
            ) % upstream.port
            status, _, _ = http_get(
                "127.0.0.1",
                shared_r2h.port,
                url,
                timeout=_TIMEOUT,
                headers={"User-Agent": "TestPlayer/1.0 TZ/UTC+8"},
            )
            assert status == 200
            assert _get_upstream_path(upstream) == expected_path
        finally:
            upstream.stop()

    def test_lutc_with_timezone(self, shared_r2h):
        """{lutc} should return current time as ISO8601 UTC."""
        upstream = _make_upstream()
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d/stream/{lutc}"
                "?playseek=20240101120000-20240101130000"
            ) % upstream.port
            http_get(
                "127.0.0.1",
                shared_r2h.port,
                url,
                timeout=_TIMEOUT,
                headers={"User-Agent": "TestPlayer/1.0 TZ/UTC+8"},
            )

            path = _get_upstream_path(upstream)
            # {lutc} outputs current time as ISO8601 - verify format
            match = re.match(
                r"/stream/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z)", path
            )
            assert match, "Expected ISO8601 format for {lutc}, got: %s" % path
        finally:
            upstream.stop()

    def test_utc_with_timezone(self, shared_r2h):
        """{utc} with TZ/UTC+8 should give begin time as ISO8601 UTC."""
        # With TZ/UTC+8: begin 12:00 local → 04:00 UTC → ISO8601
        expected_path = "/stream/2024-01-01T04:00:00.000Z"
        upstream = _make_upstream(expected_path)
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d/stream/{utc}"
                "?playseek=20240101120000-20240101130000"
            ) % upstream.port
            status, _, _ = http_get(
                "127.0.0.1",
                shared_r2h.port,
                url,
                timeout=_TIMEOUT,
                headers={"User-Agent": "TestPlayer/1.0 TZ/UTC+8"},
            )
            assert status == 200
            assert _get_upstream_path(upstream) == expected_path
        finally:
            upstream.stop()

    def test_duration_unaffected_by_timezone(self, shared_r2h):
        """{duration} should be the same regardless of timezone."""
        expected_path = "/stream/3600"
        upstream = _make_upstream(expected_path)
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d/stream/{duration}"
                "?playseek=20240101120000-20240101130000"
            ) % upstream.port
            status, _, _ = http_get(
                "127.0.0.1",
                shared_r2h.port,
                url,
                timeout=_TIMEOUT,
                headers={"User-Agent": "TestPlayer/1.0 TZ/UTC+8"},
            )
            assert status == 200
            assert _get_upstream_path(upstream) == expected_path
        finally:
            upstream.stop()

    def test_negative_seek_offset(self, shared_r2h):
        """Negative r2h-seek-offset should shift template times backward."""
        # 12:00 - 30s = 11:59:30, 13:00 - 30s = 12:59:30
        expected_path = "/path/20240101115930/20240101125930/file"
        upstream = _make_upstream(expected_path)
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d"
                "/path/${(b)yyyyMMddHHmmss}/${(e)yyyyMMddHHmmss}/file"
                "?playseek=20240101120000-20240101130000&r2h-seek-offset=-30"
            ) % upstream.port
            status, _, _ = http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            assert status == 200
            assert _get_upstream_path(upstream) == expected_path
        finally:
            upstream.stop()


# ===================================================================
# Edge cases
# ===================================================================


@pytest.mark.http_proxy
class TestHTTPPathTemplateEdgeCases:
    """Edge cases for URL template substitution."""

    def test_template_adjacent_to_slash(self, shared_r2h):
        """Template placeholder right after slash should work."""
        expected_path = "/2024-01-01T12:00:00.000Z/"
        upstream = _make_upstream(expected_path)
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d/{utc}/" "?playseek=20240101120000-20240101130000"
            ) % upstream.port
            status, _, _ = http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            assert status == 200
            assert _get_upstream_path(upstream) == expected_path
        finally:
            upstream.stop()

    def test_url_with_port_and_template(self, shared_r2h):
        """URL with explicit port in host and template in path."""
        expected_path = "/cctv/20240101120000/data.ts"
        upstream = _make_upstream(expected_path)
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d/cctv/${(b)yyyyMMddHHmmss}/data.ts"
                "?playseek=20240101120000-20240101130000"
            ) % upstream.port
            status, _, _ = http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            assert status == 200
            assert _get_upstream_path(upstream) == expected_path
        finally:
            upstream.stop()

    def test_short_format_yyyyMMdd(self, shared_r2h):
        """Format pattern with only date part (yyyyMMdd)."""
        expected_path = "/path/20240101/file"
        upstream = _make_upstream(expected_path)
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d/path/${(b)yyyyMMdd}/file"
                "?playseek=20240101120000-20240101130000"
            ) % upstream.port
            status, _, _ = http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            assert status == 200
            assert _get_upstream_path(upstream) == expected_path
        finally:
            upstream.stop()

    def test_short_format_HHmmss(self, shared_r2h):
        """Format pattern with only time part (HHmmss)."""
        expected_path = "/path/120000/file"
        upstream = _make_upstream(expected_path)
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d/path/${(b)HHmmss}/file"
                "?playseek=20240101120000-20240101130000"
            ) % upstream.port
            status, _, _ = http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            assert status == 200
            assert _get_upstream_path(upstream) == expected_path
        finally:
            upstream.stop()

    def test_unrecognized_placeholder_passthrough(self, shared_r2h):
        """Unknown {foo} placeholders should pass through unchanged."""
        upstream = _make_upstream()
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d/stream/{foo}/{utc}"
                "?playseek=20240101120000-20240101130000"
            ) % upstream.port
            http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)

            path = _get_upstream_path(upstream)
            assert "{foo}" in path, (
                "Unknown placeholder should pass through, got: %s" % path
            )
            assert (
                "2024-01-01T12:00:00.000Z" in path
            ), "Known placeholder {utc} should still be substituted as ISO8601"
        finally:
            upstream.stop()

    def test_format_with_literal_underscore(self, shared_r2h):
        """Format with literal underscore: yyyyMMdd_HHmmss."""
        expected_path = "/path/20240101_120000/file"
        upstream = _make_upstream(expected_path)
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d/path/${(b)yyyyMMdd_HHmmss}/file"
                "?playseek=20240101120000-20240101130000"
            ) % upstream.port
            status, _, _ = http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            assert status == 200
            assert _get_upstream_path(upstream) == expected_path
        finally:
            upstream.stop()

    def test_template_date_boundary_midnight(self, shared_r2h):
        """Template substitution near midnight boundary (23:00 + 2h offset)."""
        # 23:00 UTC + 2h seek offset = 01:00 next day (2024-01-02)
        expected_path = "/path/20240102010000/file"
        upstream = _make_upstream(expected_path)
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d/path/${(b)yyyyMMddHHmmss}/file"
                "?playseek=20240101230000-20240102000000&r2h-seek-offset=7200"
            ) % upstream.port
            status, _, _ = http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            assert status == 200
            assert _get_upstream_path(upstream) == expected_path
        finally:
            upstream.stop()

    def test_custom_seek_name_with_template(self, shared_r2h):
        """r2h-seek-name should work with template URLs."""
        expected_path = "/path/20240101120000/20240101130000/file"
        upstream = _make_upstream(expected_path)
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d"
                "/path/${(b)yyyyMMddHHmmss}/${(e)yyyyMMddHHmmss}/file"
                "?r2h-seek-name=myseek&myseek=20240101120000-20240101130000"
            ) % upstream.port
            status, _, _ = http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            assert status == 200
            assert _get_upstream_path(upstream) == expected_path
        finally:
            upstream.stop()

    def test_open_ended_seek_range(self, shared_r2h):
        """Seek value with trailing dash (open-ended range) should substitute begin."""
        expected_path = "/path/20240101120000/file"
        upstream = _make_upstream(expected_path)
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d/path/${(b)yyyyMMddHHmmss}/file"
                "?playseek=20240101120000-"
            ) % upstream.port
            status, _, _ = http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            assert status == 200
            assert _get_upstream_path(upstream) == expected_path
        finally:
            upstream.stop()

    def test_template_with_existing_static_query_params(self, shared_r2h):
        """Static query params in template URL should be preserved after substitution."""
        expected_path = "/path/20240101120000/file"
        upstream = _make_upstream(expected_path)
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d/path/${(b)yyyyMMddHHmmss}/file"
                "?quality=hd&playseek=20240101120000-20240101130000"
            ) % upstream.port
            status, _, _ = http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            assert status == 200

            full_path = _get_upstream_path(upstream)
            assert full_path.startswith("/path/20240101120000/file")
            assert "quality=hd" in full_path, (
                "Static query params should be preserved, got: %s" % full_path
            )
        finally:
            upstream.stop()


# ===================================================================
# RTSP with path-level templates
# ===================================================================


@pytest.mark.rtsp
class TestRTSPPathTemplate:
    """Verify template substitution in RTSP URIs."""

    def test_begin_end_in_describe_uri(self, shared_r2h):
        """${(b)...}/${(e)...} in RTSP URL should be substituted in DESCRIBE URI."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            url = (
                "/rtsp/127.0.0.1:%d"
                "/path/${(b)yyyyMMddHHmmss}/${(e)yyyyMMddHHmmss}/stream"
                "?playseek=20240101120000-20240101130000"
            ) % rtsp.port
            status, _, body = stream_get(
                "127.0.0.1",
                shared_r2h.port,
                url,
                read_bytes=4096,
                timeout=_STREAM_TIMEOUT,
            )
            assert status == 200

            describe_reqs = [
                r for r in rtsp.requests_detailed if r["method"] == "DESCRIBE"
            ]
            assert len(describe_reqs) > 0, "Expected DESCRIBE request"
            uri = describe_reqs[0]["uri"]
            assert "20240101120000" in uri, (
                "Begin template should be substituted in DESCRIBE URI, got: %s" % uri
            )
            assert "20240101130000" in uri, (
                "End template should be substituted in DESCRIBE URI, got: %s" % uri
            )
            assert "${" not in uri, (
                "No unresolved templates should remain in URI, got: %s" % uri
            )
        finally:
            rtsp.stop()

    def test_utc_in_rtsp_uri(self, shared_r2h):
        """{utc} in RTSP URL should be substituted with ISO8601."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            url = (
                "/rtsp/127.0.0.1:%d/stream/{utc}"
                "?playseek=20240101120000-20240101130000"
            ) % rtsp.port
            status, _, body = stream_get(
                "127.0.0.1",
                shared_r2h.port,
                url,
                read_bytes=4096,
                timeout=_STREAM_TIMEOUT,
            )
            assert status == 200

            describe_reqs = [
                r for r in rtsp.requests_detailed if r["method"] == "DESCRIBE"
            ]
            assert len(describe_reqs) > 0
            uri = describe_reqs[0]["uri"]
            assert "2024-01-01T12:00:00.000Z" in uri, (
                "Expected ISO8601 in URI, got: %s" % uri
            )
        finally:
            rtsp.stop()


# ===================================================================
# Query-append mode (non-template URLs)
# ===================================================================


@pytest.mark.http_proxy
class TestQueryAppendMode:
    """Verify that non-template URLs append seek params as query parameters."""

    def test_playseek_appended(self, shared_r2h):
        """Non-template URL should append playseek as query parameter."""
        upstream = _make_upstream("/stream")
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d/stream" "?playseek=20240101120000-20240101130000"
            ) % upstream.port
            status, _, _ = http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            assert status == 200

            path = _get_upstream_path(upstream)
            assert "playseek=" in path, (
                "Query-append mode should append playseek, got: %s" % path
            )
            assert path.startswith("/stream?") or path.startswith("/stream&"), (
                "Path should be /stream with query, got: %s" % path
            )
        finally:
            upstream.stop()


@pytest.mark.http_proxy
class TestHTTPQueryAppendMetaParams:
    """Meta-parameter handling for HTTP query-append seek flows."""

    def test_custom_seek_name_forwarded(self, shared_r2h):
        """r2h-seek-name=myseek should forward myseek to the upstream."""
        upstream = _make_upstream("/stream")
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d/stream"
                "?r2h-seek-name=myseek&myseek=20240301100000-20240301110000"
            ) % upstream.port
            status, _, _ = http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            assert status == 200

            path = _get_upstream_path(upstream)
            assert "myseek=" in path, (
                "Custom seek param should be forwarded, got: %s" % path
            )
        finally:
            upstream.stop()

    def test_r2h_seek_name_stripped(self, shared_r2h):
        """r2h-seek-name should be stripped from the upstream URL."""
        upstream = _make_upstream("/stream")
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d/stream"
                "?r2h-seek-name=myseek&myseek=20240301100000-20240301110000"
            ) % upstream.port
            http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)

            path = _get_upstream_path(upstream)
            assert "r2h-seek-name" not in path, (
                "r2h-seek-name should be stripped, got: %s" % path
            )
            assert "myseek=" in path
        finally:
            upstream.stop()


@pytest.mark.http_proxy
class TestHTTPQueryAppendOffset:
    """Offset handling for HTTP query-append seek flows."""

    def test_positive_offset(self, shared_r2h):
        """r2h-seek-offset=3600 should add 1 hour to playseek times."""
        upstream = _make_upstream("/stream")
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d/stream"
                "?playseek=20240101120000-20240101130000&r2h-seek-offset=3600"
            ) % upstream.port
            http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)

            path = _get_upstream_path(upstream)
            assert (
                _extract_query_param(path, "playseek")
                == "20240101130000-20240101140000"
            )
        finally:
            upstream.stop()

    def test_negative_offset(self, shared_r2h):
        """r2h-seek-offset=-30 should subtract 30 seconds."""
        upstream = _make_upstream("/stream")
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d/stream"
                "?playseek=20240101120000-20240101130000&r2h-seek-offset=-30"
            ) % upstream.port
            http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)

            path = _get_upstream_path(upstream)
            assert (
                _extract_query_param(path, "playseek")
                == "20240101115930-20240101125930"
            )
        finally:
            upstream.stop()

    def test_offset_stripped_from_upstream(self, shared_r2h):
        """r2h-seek-offset should be stripped from the upstream URL."""
        upstream = _make_upstream("/stream")
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d/stream"
                "?playseek=20240101120000-20240101130000&r2h-seek-offset=3600"
            ) % upstream.port
            http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)

            path = _get_upstream_path(upstream)
            assert "r2h-seek-offset" not in path, (
                "r2h-seek-offset should be stripped, got: %s" % path
            )
        finally:
            upstream.stop()

    def test_offset_with_unix_timestamp(self, shared_r2h):
        """r2h-seek-offset should work with Unix timestamps."""
        upstream = _make_upstream("/stream")
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d/stream"
                "?playseek=1704096000-1704099600&r2h-seek-offset=3600"
            ) % upstream.port
            http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)

            path = _get_upstream_path(upstream)
            assert _extract_query_param(path, "playseek") == "1704099600-1704103200"
        finally:
            upstream.stop()


@pytest.mark.http_proxy
class TestHTTPQueryAppendTimezoneAndFormat:
    """Timezone conversion and output format preservation for HTTP query-append."""

    def test_tz_utc_minus_5_converts_yyyyMMddHHmmss(self, shared_r2h):
        """TZ/UTC-5 should add 5 hours to yyyyMMddHHmmss format."""
        upstream = _make_upstream("/stream")
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d/stream" "?playseek=20240101120000-20240101130000"
            ) % upstream.port
            http_get(
                "127.0.0.1",
                shared_r2h.port,
                url,
                timeout=_TIMEOUT,
                headers={"User-Agent": "TestPlayer/1.0 TZ/UTC-5"},
            )

            path = _get_upstream_path(upstream)
            assert (
                _extract_query_param(path, "playseek")
                == "20240101170000-20240101180000"
            )
        finally:
            upstream.stop()

    def test_no_tz_no_conversion(self, shared_r2h):
        """Without TZ/ in User-Agent, times should not be converted."""
        upstream = _make_upstream("/stream")
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d/stream" "?playseek=20240101120000-20240101130000"
            ) % upstream.port
            http_get(
                "127.0.0.1",
                shared_r2h.port,
                url,
                timeout=_TIMEOUT,
                headers={"User-Agent": "TestPlayer/1.0"},
            )

            path = _get_upstream_path(upstream)
            assert (
                _extract_query_param(path, "playseek")
                == "20240101120000-20240101130000"
            )
        finally:
            upstream.stop()

    def test_unix_timestamp_skips_tz_conversion(self, shared_r2h):
        """Unix timestamps should not be affected by User-Agent timezone."""
        upstream = _make_upstream("/stream")
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d/stream" "?playseek=1704096000-1704099600"
            ) % upstream.port
            http_get(
                "127.0.0.1",
                shared_r2h.port,
                url,
                timeout=_TIMEOUT,
                headers={"User-Agent": "TestPlayer/1.0 TZ/UTC+8"},
            )

            path = _get_upstream_path(upstream)
            assert _extract_query_param(path, "playseek") == "1704096000-1704099600"
        finally:
            upstream.stop()

    def test_tz_with_offset_combined(self, shared_r2h):
        """TZ/UTC+8 combined with r2h-seek-offset should apply both."""
        upstream = _make_upstream("/stream")
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d/stream"
                "?playseek=20240101120000-20240101130000&r2h-seek-offset=3600"
            ) % upstream.port
            http_get(
                "127.0.0.1",
                shared_r2h.port,
                url,
                timeout=_TIMEOUT,
                headers={"User-Agent": "TestPlayer/1.0 TZ/UTC+8"},
            )

            path = _get_upstream_path(upstream)
            assert (
                _extract_query_param(path, "playseek")
                == "20240101050000-20240101060000"
            )
        finally:
            upstream.stop()

    def test_gmt_suffix_preserved(self, shared_r2h):
        """yyyyMMddHHmmssGMT format should preserve the GMT suffix."""
        upstream = _make_upstream("/stream")
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d/stream"
                "?playseek=20240101120000GMT-20240101130000GMT&r2h-seek-offset=3600"
            ) % upstream.port
            http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)

            path = _get_upstream_path(upstream)
            assert (
                _extract_query_param(path, "playseek")
                == "20240101130000GMT-20240101140000GMT"
            )
        finally:
            upstream.stop()

    def test_unix_timestamp_format_preserved(self, shared_r2h):
        """Unix timestamp format should stay as Unix timestamp."""
        upstream = _make_upstream("/stream")
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d/stream" "?playseek=1704096000-1704099600"
            ) % upstream.port
            http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)

            path = _get_upstream_path(upstream)
            assert _extract_query_param(path, "playseek") == "1704096000-1704099600"
        finally:
            upstream.stop()

    def test_gmt_suffix_with_tz_conversion(self, shared_r2h):
        """yyyyMMddHHmmssGMT with TZ/UTC+8 should convert and keep GMT suffix."""
        upstream = _make_upstream("/stream")
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d/stream"
                "?playseek=20240101120000GMT-20240101130000GMT"
            ) % upstream.port
            http_get(
                "127.0.0.1",
                shared_r2h.port,
                url,
                timeout=_TIMEOUT,
                headers={"User-Agent": "TestPlayer/1.0 TZ/UTC+8"},
            )

            path = _get_upstream_path(upstream)
            assert (
                _extract_query_param(path, "playseek")
                == "20240101040000GMT-20240101050000GMT"
            )
        finally:
            upstream.stop()

    def test_tvdr_appended(self, shared_r2h):
        """Non-template URL with tvdr should append as query parameter."""
        upstream = _make_upstream("/stream")
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d/stream" "?tvdr=20240601080000-20240601090000"
            ) % upstream.port
            status, _, _ = http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            assert status == 200

            path = _get_upstream_path(upstream)
            assert "tvdr=" in path, "tvdr should be appended, got: %s" % path
        finally:
            upstream.stop()

    def test_no_template_no_seek(self, shared_r2h):
        """Non-template URL without seek should be passed through unchanged."""
        upstream = _make_upstream("/stream")
        upstream.start()
        try:
            url = "/http/127.0.0.1:%d/stream" % upstream.port
            status, _, _ = http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            assert status == 200

            path = _get_upstream_path(upstream)
            assert path == "/stream", (
                "URL without seek should be unchanged, got: %s" % path
            )
        finally:
            upstream.stop()

    def test_append_with_existing_query(self, shared_r2h):
        """Non-template URL with existing query params + seek should append with &."""
        upstream = _make_upstream("/stream")
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d/stream"
                "?token=abc&playseek=20240101120000-20240101130000"
            ) % upstream.port
            status, _, _ = http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            assert status == 200

            path = _get_upstream_path(upstream)
            assert "token=abc" in path, "Existing query params should be preserved"
            assert "playseek=" in path, "Seek should be appended"
            assert "&playseek=" in path, (
                "Seek should be appended with & separator, got: %s" % path
            )
        finally:
            upstream.stop()

    def test_tz_conversion_in_query_append(self, shared_r2h):
        """TZ conversion should work in query-append mode."""
        upstream = _make_upstream("/stream")
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d/stream" "?playseek=20240101120000-20240101130000"
            ) % upstream.port
            status, _, _ = http_get(
                "127.0.0.1",
                shared_r2h.port,
                url,
                timeout=_TIMEOUT,
                headers={"User-Agent": "TestPlayer/1.0 TZ/UTC+8"},
            )
            assert status == 200

            path = _get_upstream_path(upstream)
            match = re.search(r"playseek=([^&]+)", path)
            assert match, "Expected playseek in path"
            val = match.group(1)
            assert val == "20240101040000-20240101050000", (
                "TZ conversion should work in query-append mode, got: %s" % val
            )
        finally:
            upstream.stop()

    def test_iso8601_seek_range_in_query_append(self, shared_r2h):
        """ISO8601 seek ranges should not be split on date hyphens in query-append mode."""
        upstream = _make_upstream("/stream")
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d/stream"
                "?playseek=2024-01-01T12:00:00.000Z-2024-01-01T13:00:00.000Z"
            ) % upstream.port
            status, _, _ = http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            assert status == 200

            path = _get_upstream_path(upstream)
            match = re.search(r"playseek=([^&]+)", path)
            assert match, "Expected playseek in path"
            assert (
                match.group(1) == "2024-01-01T12:00:00.000Z-2024-01-01T13:00:00.000Z"
            ), (
                "ISO8601 seek range should remain intact after splitting, got: %s"
                % match.group(1)
            )
        finally:
            upstream.stop()


# ===================================================================
# M3U catchup-source rewrite layer
# ===================================================================


class TestM3UCatchupRewrite:
    """Verify /playlist.m3u rewrite output for catchup-source templates."""

    def test_path_template_gets_playseek_injected(self, r2h_binary):
        """Catchup-source with path templates should preserve original placeholders in playseek."""
        port = find_free_port()
        config = f"""\
[global]
verbosity = 4
maxclients = 10

[bind]
* {port}

[services]
#EXTM3U
#EXTINF:-1 catchup="default" catchup-source="http://10.10.10.1:8888/path/${{(b)yyyyMMddHHmmss}}/${{(e)yyyyMMddHHmmss}}/1.m3u8",Template Channel
rtp://239.0.0.1:1234
"""
        r2h = R2HProcess(r2h_binary, port, config_content=config)
        try:
            r2h.start()
            status, _, body = http_get("127.0.0.1", port, "/playlist.m3u")
            text = body.decode()

            assert status == 200
            assert "Template Channel" in text

            assert "playseek=${(b)yyyyMMddHHmmss}-${(e)yyyyMMddHHmmss}" in text, (
                "Path template catchup-source should keep original placeholder format, got:\n%s"
                % text
            )
        finally:
            r2h.stop()


# ===================================================================
# M3U catchup-source closed-loop consumption
# ===================================================================


@pytest.mark.http_proxy
class TestM3UCatchupConsumption:
    """Verify playlist-emitted catchup links can be consumed end-to-end."""

    def test_path_template_link_resolves_to_upstream_path(self, r2h_binary):
        """A catchup-source from /playlist.m3u should work after simulated player substitution."""
        expected_path = "/path/20240101120000/20240101130000/1.m3u8"
        upstream = _make_upstream(expected_path)
        upstream.start()
        port = find_free_port()
        config = f"""\
[global]
verbosity = 4
maxclients = 10

[bind]
* {port}

[services]
#EXTM3U
#EXTINF:-1 catchup="default" catchup-source="http://127.0.0.1:{upstream.port}/path/${{(b)yyyyMMddHHmmss}}/${{(e)yyyyMMddHHmmss}}/1.m3u8",Template Loop Channel
rtp://239.0.0.1:1234
"""
        r2h = R2HProcess(r2h_binary, port, config_content=config)
        try:
            r2h.start()
            status, _, body = http_get("127.0.0.1", port, "/playlist.m3u")
            assert status == 200

            catchup_source = _extract_catchup_source(
                body.decode(), "Template Loop Channel"
            )
            resolved_url = catchup_source.replace(
                "${(b)yyyyMMddHHmmss}", "20240101120000"
            )
            resolved_url = resolved_url.replace(
                "${(e)yyyyMMddHHmmss}", "20240101130000"
            )

            status, _, _ = http_get(
                "127.0.0.1",
                port,
                _absolute_url_to_path(resolved_url),
                timeout=_TIMEOUT,
            )
            assert status == 200
            assert _get_upstream_path(upstream) == expected_path
        finally:
            r2h.stop()
            upstream.stop()

    def test_mixed_template_link_preserves_dynamic_query_end_to_end(self, r2h_binary):
        """A catchup-source with path and query templates should resolve both after player substitution."""
        expected_path = "/path/20240101120000/1.m3u8"
        upstream = _make_upstream(expected_path)
        upstream.start()
        port = find_free_port()
        config = f"""\
[global]
verbosity = 4
maxclients = 10

[bind]
* {port}

[services]
#EXTM3U
#EXTINF:-1 catchup="default" catchup-source="http://127.0.0.1:{upstream.port}/path/${{(b)yyyyMMddHHmmss}}/1.m3u8?token=1&begin={{utc}}",Mixed Loop Channel
rtp://239.0.0.1:1234
"""
        r2h = R2HProcess(r2h_binary, port, config_content=config)
        try:
            r2h.start()
            status, _, body = http_get("127.0.0.1", port, "/playlist.m3u")
            assert status == 200

            catchup_source = _extract_catchup_source(
                body.decode(), "Mixed Loop Channel"
            )
            resolved_url = catchup_source.replace(
                "${(b)yyyyMMddHHmmss}", "20240101120000"
            )
            resolved_url = resolved_url.replace("{utc}", "2024-01-01T12:00:00.000Z")

            status, _, _ = http_get(
                "127.0.0.1",
                port,
                _absolute_url_to_path(resolved_url),
                timeout=_TIMEOUT,
            )
            assert status == 200

            full_path = _get_upstream_path(upstream)
            assert full_path.startswith(expected_path)
            assert "token=1" in full_path
            assert "begin=2024-01-01T12:00:00.000Z" in full_path
        finally:
            r2h.stop()
            upstream.stop()


# ===================================================================
# M3U catchup-source rewrite edge cases
# ===================================================================


class TestM3UCatchupRewriteMore:
    """Additional rewrite-only checks for catchup-source transformation."""

    def test_query_only_templates_unchanged(self, r2h_binary):
        """Catchup-source with query-only templates should NOT inject extra playseek."""
        port = find_free_port()
        config = f"""\
[global]
verbosity = 4
maxclients = 10

[bind]
* {port}

[services]
#EXTM3U
#EXTINF:-1 catchup="default" catchup-source="rtsp://10.0.0.50:554/playback?seek={{utc:YmdHMS}}-{{utcend:YmdHMS}}",Query Template Ch
rtp://239.0.0.1:1234
"""
        r2h = R2HProcess(r2h_binary, port, config_content=config)
        try:
            r2h.start()
            status, _, body = http_get("127.0.0.1", port, "/playlist.m3u")
            text = body.decode()

            assert status == 200
            assert "Query Template Ch" in text

            # The query-only templates should be extracted by extract_dynamic_params
            # and NOT have a duplicate playseek={utc}-{end} injected
            lines = text.split("\n")
            catchup_lines = [l for l in lines if "catchup-source=" in l]
            assert len(catchup_lines) > 0, "Should have catchup-source line"

            # Count occurrences of "playseek=" - should NOT appear
            # (the original dynamic params are {utc:YmdHMS}-{utcend:YmdHMS})
            catchup_line = catchup_lines[0]
            playseek_count = catchup_line.count("playseek=")
            # The original URL uses "seek=" not "playseek=", so playseek should not be injected
            assert playseek_count == 0, (
                "Query-only templates should not inject extra playseek, got:\n%s"
                % catchup_line
            )
        finally:
            r2h.stop()

    def test_no_template_no_injection(self, r2h_binary):
        """Catchup-source without any templates should not get playseek injected."""
        port = find_free_port()
        config = f"""\
[global]
verbosity = 4
maxclients = 10

[bind]
* {port}

[services]
#EXTM3U
#EXTINF:-1 catchup="default" catchup-source="http://10.10.10.1:8888/playback/cctv-1/stream.m3u8",Plain Channel
rtp://239.0.0.1:1234
"""
        r2h = R2HProcess(r2h_binary, port, config_content=config)
        try:
            r2h.start()
            status, _, body = http_get("127.0.0.1", port, "/playlist.m3u")
            text = body.decode()

            assert status == 200
            assert "Plain Channel" in text

            lines = text.split("\n")
            catchup_lines = [l for l in lines if "catchup-source=" in l]
            if len(catchup_lines) > 0:
                catchup_line = catchup_lines[0]
                assert (
                    "playseek={utc}" not in catchup_line
                ), "No-template catchup should not get playseek injected"
        finally:
            r2h.stop()

    def test_path_template_with_dollar_brace(self, r2h_binary):
        """Catchup-source with ${(b)...} in path should trigger injection."""
        port = find_free_port()
        config = f"""\
[global]
verbosity = 4
maxclients = 10

[bind]
* {port}

[services]
#EXTM3U
#EXTINF:-1 catchup="default" catchup-source="http://10.10.10.1:8888/cctv/${{(b)yyyyMMdd}}/${{(e)HHmmss}}/stream.ts",Dollar Brace Ch
rtp://239.0.0.1:1234
"""
        r2h = R2HProcess(r2h_binary, port, config_content=config)
        try:
            r2h.start()
            status, _, body = http_get("127.0.0.1", port, "/playlist.m3u")
            text = body.decode()

            assert status == 200
            assert "Dollar Brace Ch" in text
            assert (
                "playseek=" in text
            ), "Path template with ${(b)...} should inject playseek"
        finally:
            r2h.stop()

    def test_path_template_uses_original_playseek_format(self, r2h_binary):
        """Multi-part path templates should keep the original placeholder fragments in playseek."""
        port = find_free_port()
        config = f"""\
[global]
verbosity = 4
maxclients = 10

[bind]
* {port}

[services]
#EXTM3U
#EXTINF:-1 catchup="default" catchup-source="http://10.10.10.1:8888/path/${{(b)yyyyMMdd}}/${{(b)HHmmss}}/${{(e)yyyyMMdd}}/${{(e)HHmmss}}/1.m3u8",Canonical Channel
rtp://239.0.0.1:1234
"""
        r2h = R2HProcess(r2h_binary, port, config_content=config)
        try:
            r2h.start()
            status, _, body = http_get("127.0.0.1", port, "/playlist.m3u")
            text = body.decode()

            assert status == 200
            assert "Canonical Channel" in text
            assert (
                "playseek=${(b)yyyyMMdd}${(b)HHmmss}-${(e)yyyyMMdd}${(e)HHmmss}" in text
            ), ("Expected original placeholder fragments in playseek, got:\n%s" % text)
        finally:
            r2h.stop()

    def test_path_and_query_templates_are_both_preserved(self, r2h_binary):
        """Path-template catchup should keep dynamic query params and preserve path placeholders in playseek."""
        port = find_free_port()
        config = f"""\
[global]
verbosity = 4
maxclients = 10

[bind]
* {port}

[services]
#EXTM3U
#EXTINF:-1 catchup="default" catchup-source="http://10.10.10.1:8888/path/${{(b)yyyyMMddHHmmss}}/1.m3u8?token=1&begin={{utc}}",Mixed Channel
rtp://239.0.0.1:1234
"""
        r2h = R2HProcess(r2h_binary, port, config_content=config)
        try:
            r2h.start()
            status, _, body = http_get("127.0.0.1", port, "/playlist.m3u")
            text = body.decode()

            assert status == 200
            assert "Mixed Channel" in text
            assert "playseek=${(b)yyyyMMddHHmmss}" in text, (
                "Expected original begin placeholder in playseek, got:\n%s" % text
            )
            assert "begin={utc}" in text, (
                "Expected original dynamic query params to be preserved, got:\n%s"
                % text
            )
        finally:
            r2h.stop()


# ===================================================================
# Additional normal / edge case coverage
# ===================================================================


@pytest.mark.http_proxy
class TestHTTPPathTemplateMoreCases:
    """Additional normal and edge case coverage for URL template substitution."""

    def test_iso8601_seek_range_in_template_mode(self, shared_r2h):
        """ISO8601 seek ranges should not be split on date hyphens in template mode."""
        expected_path = "/archive/20240101120000/20240101130000/video.ts"
        upstream = _make_upstream(expected_path)
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d/archive/${(b)yyyyMMddHHmmss}/${(e)yyyyMMddHHmmss}/video.ts"
                "?playseek=2024-01-01T12:00:00.000Z-2024-01-01T13:00:00.000Z"
            ) % upstream.port
            status, _, _ = http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            assert status == 200
            assert _get_upstream_path(upstream) == expected_path
        finally:
            upstream.stop()

    def test_end_template_only(self, shared_r2h):
        """URL with only ${(e)...} and no ${(b)...} should still substitute end."""
        expected_path = "/archive/20240101130000/video.ts"
        upstream = _make_upstream(expected_path)
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d/archive/${(e)yyyyMMddHHmmss}/video.ts"
                "?playseek=20240101120000-20240101130000"
            ) % upstream.port
            status, _, _ = http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            assert status == 200
            assert _get_upstream_path(upstream) == expected_path
        finally:
            upstream.stop()

    def test_end_placeholder_requires_end_value(self, shared_r2h):
        """End-derived placeholders should fail when the seek value has no end time."""
        upstream = _make_upstream("/unused")
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d/archive/${(e)yyyyMMddHHmmss}/video.ts"
                "?playseek=20240101120000-"
            ) % upstream.port
            status, _, _ = http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            assert status >= 400, "Expected request to fail without an end time"
            assert (
                len(upstream.requests_log) == 0
            ), "Upstream should not be contacted when end placeholders cannot be resolved"
        finally:
            upstream.stop()

    def test_begin_and_end_different_formats(self, shared_r2h):
        """Begin in date-only, end in time-only format in the same URL."""
        expected_path = "/archive/20240101/130000/video.ts"
        upstream = _make_upstream(expected_path)
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d/archive/${(b)yyyyMMdd}/${(e)HHmmss}/video.ts"
                "?playseek=20240101120000-20240101130000"
            ) % upstream.port
            status, _, _ = http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            assert status == 200
            assert _get_upstream_path(upstream) == expected_path
        finally:
            upstream.stop()

    def test_utc_and_end_in_query_only(self, shared_r2h):
        """Templates only in query string (no path templates) should trigger template mode."""
        upstream = _make_upstream("/stream")
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d/stream"
                "?begin={utc}&end={end}&playseek=20240101120000-20240101130000"
            ) % upstream.port
            status, _, _ = http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            assert status == 200

            full_path = _get_upstream_path(upstream)
            assert "begin=2024-01-01T12:00:00.000Z" in full_path, (
                "Query {utc} should be substituted as ISO8601, got: %s" % full_path
            )
            assert "end=2024-01-01T13:00:00.000Z" in full_path, (
                "Query {end} should be substituted as ISO8601, got: %s" % full_path
            )
        finally:
            upstream.stop()

    def test_duration_zero_same_begin_end(self, shared_r2h):
        """{duration} should be 0 when begin and end are the same."""
        expected_path = "/stream/0"
        upstream = _make_upstream(expected_path)
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d/stream/{duration}"
                "?playseek=20240101120000-20240101120000"
            ) % upstream.port
            status, _, _ = http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            assert status == 200
            assert _get_upstream_path(upstream) == expected_path
        finally:
            upstream.stop()

    def test_long_duration_24h(self, shared_r2h):
        """{duration} for a 24-hour range should be 86400."""
        expected_path = "/stream/86400"
        upstream = _make_upstream(expected_path)
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d/stream/{duration}"
                "?playseek=20240101000000-20240102000000"
            ) % upstream.port
            status, _, _ = http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            assert status == 200
            assert _get_upstream_path(upstream) == expected_path
        finally:
            upstream.stop()

    def test_february_29_leap_year(self, shared_r2h):
        """Template substitution should handle Feb 29 correctly in a leap year."""
        expected_path = "/archive/20240229/120000/file"
        upstream = _make_upstream(expected_path)
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d/archive/${(b)yyyyMMdd}/${(b)HHmmss}/file"
                "?playseek=20240229120000-20240229130000"
            ) % upstream.port
            status, _, _ = http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            assert status == 200
            assert _get_upstream_path(upstream) == expected_path
        finally:
            upstream.stop()

    def test_year_boundary(self, shared_r2h):
        """Template substitution crossing year boundary (Dec 31 -> Jan 1)."""
        # 23:00 + 2h = next day 01:00
        expected_path = "/archive/20250101010000/file"
        upstream = _make_upstream(expected_path)
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d/archive/${(b)yyyyMMddHHmmss}/file"
                "?playseek=20241231230000-20250101010000&r2h-seek-offset=7200"
            ) % upstream.port
            status, _, _ = http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            assert status == 200
            assert _get_upstream_path(upstream) == expected_path
        finally:
            upstream.stop()

    def test_tz_utc_minus_5(self, shared_r2h):
        """TZ/UTC-5: ${(b)FORMAT} uses local time, so 12:00 local stays 12:00."""
        expected_path = "/path/20240101120000/20240101130000/file"
        upstream = _make_upstream(expected_path)
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d"
                "/path/${(b)yyyyMMddHHmmss}/${(e)yyyyMMddHHmmss}/file"
                "?playseek=20240101120000-20240101130000"
            ) % upstream.port
            status, _, _ = http_get(
                "127.0.0.1",
                shared_r2h.port,
                url,
                timeout=_TIMEOUT,
                headers={"User-Agent": "TestPlayer/1.0 TZ/UTC-5"},
            )
            assert status == 200
            assert _get_upstream_path(upstream) == expected_path
        finally:
            upstream.stop()

    def test_tz_utc_no_offset(self, shared_r2h):
        """TZ/UTC (no offset) should not change values."""
        expected_path = "/path/20240101120000/20240101130000/file"
        upstream = _make_upstream(expected_path)
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d"
                "/path/${(b)yyyyMMddHHmmss}/${(e)yyyyMMddHHmmss}/file"
                "?playseek=20240101120000-20240101130000"
            ) % upstream.port
            status, _, _ = http_get(
                "127.0.0.1",
                shared_r2h.port,
                url,
                timeout=_TIMEOUT,
                headers={"User-Agent": "TestPlayer/1.0 TZ/UTC"},
            )
            assert status == 200
            assert _get_upstream_path(upstream) == expected_path
        finally:
            upstream.stop()

    def test_no_user_agent_defaults_utc(self, shared_r2h):
        """No User-Agent at all should default to UTC."""
        expected_path = "/path/20240101120000/file"
        upstream = _make_upstream(expected_path)
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d/path/${(b)yyyyMMddHHmmss}/file"
                "?playseek=20240101120000-20240101130000"
            ) % upstream.port
            status, _, _ = http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            assert status == 200
            assert _get_upstream_path(upstream) == expected_path
        finally:
            upstream.stop()

    def test_gmt_suffix_seek_with_template(self, shared_r2h):
        """GMT-suffixed seek value should work with template substitution."""
        expected_path = "/path/20240101120000/file"
        upstream = _make_upstream(expected_path)
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d/path/${(b)yyyyMMddHHmmss}/file"
                "?playseek=20240101120000GMT-20240101130000GMT"
            ) % upstream.port
            status, _, _ = http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            assert status == 200
            assert _get_upstream_path(upstream) == expected_path
        finally:
            upstream.stop()

    def test_multiple_end_templates(self, shared_r2h):
        """Multiple ${(e)...} placeholders in the same URL."""
        expected_path = "/path/20240101/130000/file"
        upstream = _make_upstream(expected_path)
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d/path/${(e)yyyyMMdd}/${(e)HHmmss}/file"
                "?playseek=20240101120000-20240101130000"
            ) % upstream.port
            status, _, _ = http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            assert status == 200
            assert _get_upstream_path(upstream) == expected_path
        finally:
            upstream.stop()

    def test_template_preserves_url_path_structure(self, shared_r2h):
        """Template substitution should not alter directory structure."""
        expected_path = "/a/b/20240101120000/c/d/file.m3u8"
        upstream = _make_upstream(expected_path)
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d/a/b/${(b)yyyyMMddHHmmss}/c/d/file.m3u8"
                "?playseek=20240101120000-20240101130000"
            ) % upstream.port
            status, _, _ = http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            assert status == 200
            assert _get_upstream_path(upstream) == expected_path
        finally:
            upstream.stop()

    def test_component_month_december(self, shared_r2h):
        """{m} should correctly show 12 for December."""
        expected_path = "/stream/12"
        upstream = _make_upstream(expected_path)
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d/stream/{m}"
                "?playseek=20241215120000-20241215130000"
            ) % upstream.port
            status, _, _ = http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            assert status == 200
            assert _get_upstream_path(upstream) == expected_path
        finally:
            upstream.stop()

    def test_component_hour_23(self, shared_r2h):
        """{H} should correctly show 23 for 11pm."""
        expected_path = "/stream/23"
        upstream = _make_upstream(expected_path)
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d/stream/{H}"
                "?playseek=20240101230000-20240102000000"
            ) % upstream.port
            status, _, _ = http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            assert status == 200
            assert _get_upstream_path(upstream) == expected_path
        finally:
            upstream.stop()

    def test_end_and_utc_iso8601_with_duration(self, shared_r2h):
        """{end} and {utc} output ISO8601, {duration} outputs seconds."""
        upstream = _make_upstream()
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d/stream/{utc}/{end}/{duration}"
                "?playseek=20240101120000-20240101130000"
            ) % upstream.port
            http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)

            path = _get_upstream_path(upstream)
            parts = path.strip("/").split("/")
            assert len(parts) >= 4, "Expected /stream/utc/end/duration, got: %s" % path
            assert "2024-01-01T12:00:00.000Z" == parts[1], (
                "Expected begin ISO8601, got: %s" % parts[1]
            )
            assert "2024-01-01T13:00:00.000Z" == parts[2], (
                "Expected end ISO8601, got: %s" % parts[2]
            )
            assert parts[3] == "3600", "Expected duration 3600, got: %s" % parts[3]
        finally:
            upstream.stop()

    def test_format_with_dots(self, shared_r2h):
        """Format pattern with literal dots: yyyy.MM.dd."""
        expected_path = "/path/2024.01.01/file"
        upstream = _make_upstream(expected_path)
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d/path/${(b)yyyy.MM.dd}/file"
                "?playseek=20240101120000-20240101130000"
            ) % upstream.port
            status, _, _ = http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            assert status == 200
            assert _get_upstream_path(upstream) == expected_path
        finally:
            upstream.stop()

    def test_format_with_colons(self, shared_r2h):
        """Format pattern with literal colons: HH:mm:ss."""
        # Note: colons are valid in URL paths
        upstream = _make_upstream()
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d/path/${(b)HH:mm:ss}/file"
                "?playseek=20240101120000-20240101130000"
            ) % upstream.port
            http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)

            path = _get_upstream_path(upstream)
            assert "12:00:00" in path, (
                "Format with colons should produce 12:00:00, got: %s" % path
            )
        finally:
            upstream.stop()

    def test_multiple_templates_utc_lutc_end_duration(self, shared_r2h):
        """Multiple keyword placeholders in one URL."""
        upstream = _make_upstream()
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d/s/{utc}/{lutc}/{end}/{duration}"
                "?playseek=20240101120000-20240101130000"
            ) % upstream.port
            http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)

            path = _get_upstream_path(upstream)
            parts = path.strip("/").split("/")
            assert len(parts) >= 5, "Expected 5 parts, got: %s" % path
            assert parts[1] == "2024-01-01T12:00:00.000Z", (
                "Expected {utc} ISO8601 begin, got: %s" % parts[1]
            )
            # {lutc} is current time ISO8601 - verify format
            assert re.match(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z", parts[2]), (
                "Expected {lutc} ISO8601 format, got: %s" % parts[2]
            )
            assert parts[3] == "2024-01-01T13:00:00.000Z", (
                "Expected {end} ISO8601 end, got: %s" % parts[3]
            )
            assert parts[4] == "3600", "Expected {duration} 3600, got: %s" % parts[4]
        finally:
            upstream.stop()

    def test_seek_offset_with_unix_timestamp_seek(self, shared_r2h):
        """r2h-seek-offset with Unix timestamp seek value and template URL."""
        # begin = 1704110400 + 3600 = 1704114000, end = 1704114000 + 3600 = 1704117600
        expected_path = "/path/20240101130000/20240101140000/file"
        upstream = _make_upstream(expected_path)
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d"
                "/path/${(b)yyyyMMddHHmmss}/${(e)yyyyMMddHHmmss}/file"
                "?playseek=%d-%d&r2h-seek-offset=3600"
            ) % (upstream.port, _BEGIN_EPOCH, _END_EPOCH)
            status, _, _ = http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            assert status == 200
            assert _get_upstream_path(upstream) == expected_path
        finally:
            upstream.stop()


@pytest.mark.rtsp
class TestRTSPPathTemplateMore:
    """Additional RTSP template tests."""

    def test_template_with_custom_seek_name(self, shared_r2h):
        """Template substitution with r2h-seek-name in RTSP."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            url = (
                "/rtsp/127.0.0.1:%d"
                "/path/${(b)yyyyMMddHHmmss}/stream"
                "?r2h-seek-name=myseek&myseek=20240101120000-20240101130000"
            ) % rtsp.port
            status, _, body = stream_get(
                "127.0.0.1",
                shared_r2h.port,
                url,
                read_bytes=4096,
                timeout=_STREAM_TIMEOUT,
            )
            assert status == 200

            describe_reqs = [
                r for r in rtsp.requests_detailed if r["method"] == "DESCRIBE"
            ]
            assert len(describe_reqs) > 0
            uri = describe_reqs[0]["uri"]
            assert "20240101120000" in uri, (
                "Template should be substituted in RTSP URI, got: %s" % uri
            )
            assert "${" not in uri, "No unresolved templates, got: %s" % uri
            assert "r2h-seek-name" not in uri, (
                "r2h-seek-name should be stripped, got: %s" % uri
            )
        finally:
            rtsp.stop()

    def test_rtsp_query_append_no_template(self, shared_r2h):
        """RTSP URL without template should append playseek as query param."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            url = (
                "/rtsp/127.0.0.1:%d/stream" "?playseek=20240101120000-20240101130000"
            ) % rtsp.port
            status, _, body = stream_get(
                "127.0.0.1",
                shared_r2h.port,
                url,
                read_bytes=4096,
                timeout=_STREAM_TIMEOUT,
            )
            assert status == 200

            describe_reqs = [
                r for r in rtsp.requests_detailed if r["method"] == "DESCRIBE"
            ]
            assert len(describe_reqs) > 0
            uri = describe_reqs[0]["uri"]
            assert "playseek=" in uri, (
                "Query-append RTSP should have playseek in URI, got: %s" % uri
            )
        finally:
            rtsp.stop()

    def test_rtsp_duration_placeholder(self, shared_r2h):
        """{duration} in RTSP URL should be substituted."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            url = (
                "/rtsp/127.0.0.1:%d/stream/{duration}"
                "?playseek=20240101120000-20240101130000"
            ) % rtsp.port
            status, _, body = stream_get(
                "127.0.0.1",
                shared_r2h.port,
                url,
                read_bytes=4096,
                timeout=_STREAM_TIMEOUT,
            )
            assert status == 200

            describe_reqs = [
                r for r in rtsp.requests_detailed if r["method"] == "DESCRIBE"
            ]
            assert len(describe_reqs) > 0
            uri = describe_reqs[0]["uri"]
            assert "/stream/3600" in uri, (
                "Duration should be 3600 in RTSP URI, got: %s" % uri
            )
        finally:
            rtsp.stop()


@pytest.mark.rtsp
class TestRTSPQueryAppendMode:
    """RTSP query-append seek handling without URL templates."""

    def test_playseek_udp(self, shared_r2h):
        """playseek query-append should work over RTSP UDP transport."""
        rtsp = MockRTSPServerUDP()
        rtsp.start()
        try:
            url = (
                "/rtsp/127.0.0.1:%d/stream" "?playseek=20240101120000-20240101130000"
            ) % rtsp.port
            status, _, body = stream_get(
                "127.0.0.1",
                shared_r2h.port,
                url,
                read_bytes=4096,
                timeout=_STREAM_TIMEOUT,
            )
            assert status == 200
            assert len(body) > 0
        finally:
            rtsp.stop()

    def test_tvdr_forwarded_in_uri(self, shared_r2h):
        """tvdr should be forwarded in the RTSP DESCRIBE URI."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            url = (
                "/rtsp/127.0.0.1:%d/stream" "?tvdr=20240601080000-20240601090000"
            ) % rtsp.port
            status, _, _ = stream_get(
                "127.0.0.1",
                shared_r2h.port,
                url,
                read_bytes=4096,
                timeout=_STREAM_TIMEOUT,
            )
            assert status == 200

            uri = _get_describe_uri(rtsp)
            assert "tvdr=" in uri, "tvdr should be forwarded in DESCRIBE URI"
        finally:
            rtsp.stop()

    def test_playseek_correct_path_in_uri(self, shared_r2h):
        """RTSP query-append should preserve the upstream server path."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            url = (
                "/rtsp/127.0.0.1:%d/live/channel1"
                "?playseek=20240101120000-20240101130000"
            ) % rtsp.port
            stream_get(
                "127.0.0.1",
                shared_r2h.port,
                url,
                read_bytes=2048,
                timeout=_STREAM_TIMEOUT,
            )

            uri = _get_describe_uri(rtsp)
            assert "/live/channel1" in uri
        finally:
            rtsp.stop()

    def test_custom_seek_forwarded_in_uri(self, shared_r2h):
        """Custom seek parameters should be forwarded in RTSP query-append mode."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            url = (
                "/rtsp/127.0.0.1:%d/stream"
                "?r2h-seek-name=myseek&myseek=20240301100000-20240301110000"
            ) % rtsp.port
            status, _, _ = stream_get(
                "127.0.0.1",
                shared_r2h.port,
                url,
                read_bytes=4096,
                timeout=_STREAM_TIMEOUT,
            )
            assert status == 200

            uri = _get_describe_uri(rtsp)
            assert "myseek=" in uri, "Custom seek param should be in DESCRIBE URI"
            assert "r2h-seek-name" not in uri, "r2h-seek-name should be stripped"
        finally:
            rtsp.stop()


@pytest.mark.rtsp
class TestRTSPStartSeek:
    """r2h-start handling for RTSP time-based seeking."""

    def test_start_adds_range_header(self, shared_r2h):
        """r2h-start should be forwarded as Range: npt=<value>- in PLAY."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            url = "/rtsp/127.0.0.1:%d/stream?r2h-start=120.5" % rtsp.port
            stream_get(
                "127.0.0.1",
                shared_r2h.port,
                url,
                read_bytes=4096,
                timeout=_STREAM_TIMEOUT,
            )

            play_reqs = [r for r in rtsp.requests_detailed if r["method"] == "PLAY"]
            assert len(play_reqs) > 0, "Expected PLAY request"
            play_headers = play_reqs[0]["headers"]
            assert "Range" in play_headers, "PLAY should have Range header"
            assert "120.5" in play_headers["Range"]
        finally:
            rtsp.stop()

    def test_start_stripped_from_rtsp_uri(self, shared_r2h):
        """r2h-start should be stripped from the RTSP URI sent upstream."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            url = "/rtsp/127.0.0.1:%d/stream?r2h-start=60" % rtsp.port
            stream_get(
                "127.0.0.1",
                shared_r2h.port,
                url,
                read_bytes=4096,
                timeout=_STREAM_TIMEOUT,
            )

            uri = _get_describe_uri(rtsp)
            assert "r2h-start" not in uri
        finally:
            rtsp.stop()

    def test_start_with_other_params(self, shared_r2h):
        """r2h-start should be stripped while other query params are preserved."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            url = "/rtsp/127.0.0.1:%d/stream?token=abc&r2h-start=30&sid=123" % rtsp.port
            stream_get(
                "127.0.0.1",
                shared_r2h.port,
                url,
                read_bytes=4096,
                timeout=_STREAM_TIMEOUT,
            )

            uri = _get_describe_uri(rtsp)
            assert "r2h-start" not in uri
            assert "token=abc" in uri
            assert "sid=123" in uri
        finally:
            rtsp.stop()

    def test_no_range_header_without_start(self, shared_r2h):
        """Without r2h-start, PLAY should not have a Range header."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            url = "/rtsp/127.0.0.1:%d/stream" % rtsp.port
            stream_get(
                "127.0.0.1",
                shared_r2h.port,
                url,
                read_bytes=4096,
                timeout=_STREAM_TIMEOUT,
            )

            play_reqs = [r for r in rtsp.requests_detailed if r["method"] == "PLAY"]
            assert len(play_reqs) > 0, "Expected PLAY request"
            assert "Range" not in play_reqs[0]["headers"]
        finally:
            rtsp.stop()


@pytest.mark.rtsp
class TestRTSPQueryAppendOffsetAndFormat:
    """Offset, timezone, and format preservation for RTSP query-append."""

    def test_positive_offset(self, shared_r2h):
        """r2h-seek-offset=3600 should add 1 hour to RTSP playseek values."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            url = (
                "/rtsp/127.0.0.1:%d/stream"
                "?playseek=20240101120000-20240101130000&r2h-seek-offset=3600"
            ) % rtsp.port
            stream_get(
                "127.0.0.1",
                shared_r2h.port,
                url,
                read_bytes=4096,
                timeout=_STREAM_TIMEOUT,
            )

            uri = _get_describe_uri(rtsp)
            assert (
                _extract_query_param(uri, "playseek") == "20240101130000-20240101140000"
            )
        finally:
            rtsp.stop()

    def test_negative_offset(self, shared_r2h):
        """r2h-seek-offset=-30 should subtract 30 seconds from RTSP playseek."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            url = (
                "/rtsp/127.0.0.1:%d/stream"
                "?playseek=20240101120000-20240101130000&r2h-seek-offset=-30"
            ) % rtsp.port
            stream_get(
                "127.0.0.1",
                shared_r2h.port,
                url,
                read_bytes=4096,
                timeout=_STREAM_TIMEOUT,
            )

            uri = _get_describe_uri(rtsp)
            assert (
                _extract_query_param(uri, "playseek") == "20240101115930-20240101125930"
            )
        finally:
            rtsp.stop()

    def test_offset_stripped_from_uri(self, shared_r2h):
        """r2h-seek-offset should not be forwarded to the RTSP server."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            url = (
                "/rtsp/127.0.0.1:%d/stream"
                "?playseek=20240101120000-20240101130000&r2h-seek-offset=3600"
            ) % rtsp.port
            stream_get(
                "127.0.0.1",
                shared_r2h.port,
                url,
                read_bytes=4096,
                timeout=_STREAM_TIMEOUT,
            )

            uri = _get_describe_uri(rtsp)
            assert "r2h-seek-offset" not in uri
        finally:
            rtsp.stop()

    def test_offset_with_unix_timestamp(self, shared_r2h):
        """r2h-seek-offset should work with Unix timestamps in RTSP."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            url = (
                "/rtsp/127.0.0.1:%d/stream"
                "?playseek=1704096000-1704099600&r2h-seek-offset=3600"
            ) % rtsp.port
            stream_get(
                "127.0.0.1",
                shared_r2h.port,
                url,
                read_bytes=4096,
                timeout=_STREAM_TIMEOUT,
            )

            uri = _get_describe_uri(rtsp)
            assert _extract_query_param(uri, "playseek") == "1704099600-1704103200"
        finally:
            rtsp.stop()

    def test_tz_utc_plus_8_converts_yyyyMMddHHmmss(self, shared_r2h):
        """TZ/UTC+8 should subtract 8 hours from yyyyMMddHHmmss in RTSP mode."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            url = (
                "/rtsp/127.0.0.1:%d/stream" "?playseek=20240101120000-20240101130000"
            ) % rtsp.port
            stream_get(
                "127.0.0.1",
                shared_r2h.port,
                url,
                read_bytes=4096,
                timeout=_STREAM_TIMEOUT,
                headers={"User-Agent": "TestPlayer/1.0 TZ/UTC+8"},
            )

            uri = _get_describe_uri(rtsp)
            assert (
                _extract_query_param(uri, "playseek") == "20240101040000-20240101050000"
            )
        finally:
            rtsp.stop()

    def test_tz_utc_minus_5_converts_yyyyMMddHHmmss(self, shared_r2h):
        """TZ/UTC-5 should add 5 hours to yyyyMMddHHmmss in RTSP mode."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            url = (
                "/rtsp/127.0.0.1:%d/stream" "?playseek=20240101120000-20240101130000"
            ) % rtsp.port
            stream_get(
                "127.0.0.1",
                shared_r2h.port,
                url,
                read_bytes=4096,
                timeout=_STREAM_TIMEOUT,
                headers={"User-Agent": "TestPlayer/1.0 TZ/UTC-5"},
            )

            uri = _get_describe_uri(rtsp)
            assert (
                _extract_query_param(uri, "playseek") == "20240101170000-20240101180000"
            )
        finally:
            rtsp.stop()

    def test_no_tz_no_conversion(self, shared_r2h):
        """Without TZ/ in User-Agent, RTSP times should not be converted."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            url = (
                "/rtsp/127.0.0.1:%d/stream" "?playseek=20240101120000-20240101130000"
            ) % rtsp.port
            stream_get(
                "127.0.0.1",
                shared_r2h.port,
                url,
                read_bytes=4096,
                timeout=_STREAM_TIMEOUT,
                headers={"User-Agent": "TestPlayer/1.0"},
            )

            uri = _get_describe_uri(rtsp)
            assert (
                _extract_query_param(uri, "playseek") == "20240101120000-20240101130000"
            )
        finally:
            rtsp.stop()

    def test_unix_timestamp_skips_tz_conversion(self, shared_r2h):
        """Unix timestamps should not be timezone-converted in RTSP mode."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            url = (
                "/rtsp/127.0.0.1:%d/stream" "?playseek=1704096000-1704099600"
            ) % rtsp.port
            stream_get(
                "127.0.0.1",
                shared_r2h.port,
                url,
                read_bytes=4096,
                timeout=_STREAM_TIMEOUT,
                headers={"User-Agent": "TestPlayer/1.0 TZ/UTC+8"},
            )

            uri = _get_describe_uri(rtsp)
            assert _extract_query_param(uri, "playseek") == "1704096000-1704099600"
        finally:
            rtsp.stop()

    def test_tz_with_offset_combined(self, shared_r2h):
        """TZ/UTC+8 combined with r2h-seek-offset should apply both in RTSP."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            url = (
                "/rtsp/127.0.0.1:%d/stream"
                "?playseek=20240101120000-20240101130000&r2h-seek-offset=3600"
            ) % rtsp.port
            stream_get(
                "127.0.0.1",
                shared_r2h.port,
                url,
                read_bytes=4096,
                timeout=_STREAM_TIMEOUT,
                headers={"User-Agent": "TestPlayer/1.0 TZ/UTC+8"},
            )

            uri = _get_describe_uri(rtsp)
            assert (
                _extract_query_param(uri, "playseek") == "20240101050000-20240101060000"
            )
        finally:
            rtsp.stop()

    def test_gmt_suffix_preserved(self, shared_r2h):
        """yyyyMMddHHmmssGMT format should preserve the GMT suffix in RTSP."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            url = (
                "/rtsp/127.0.0.1:%d/stream"
                "?playseek=20240101120000GMT-20240101130000GMT&r2h-seek-offset=3600"
            ) % rtsp.port
            stream_get(
                "127.0.0.1",
                shared_r2h.port,
                url,
                read_bytes=4096,
                timeout=_STREAM_TIMEOUT,
            )

            uri = _get_describe_uri(rtsp)
            assert (
                _extract_query_param(uri, "playseek")
                == "20240101130000GMT-20240101140000GMT"
            )
        finally:
            rtsp.stop()

    def test_unix_timestamp_format_preserved(self, shared_r2h):
        """Unix timestamp format should stay as Unix timestamp in RTSP."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            url = (
                "/rtsp/127.0.0.1:%d/stream" "?playseek=1704096000-1704099600"
            ) % rtsp.port
            stream_get(
                "127.0.0.1",
                shared_r2h.port,
                url,
                read_bytes=4096,
                timeout=_STREAM_TIMEOUT,
            )

            uri = _get_describe_uri(rtsp)
            assert _extract_query_param(uri, "playseek") == "1704096000-1704099600"
        finally:
            rtsp.stop()

    def test_gmt_suffix_with_tz_conversion(self, shared_r2h):
        """yyyyMMddHHmmssGMT with TZ/UTC+8 should convert and keep GMT suffix."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            url = (
                "/rtsp/127.0.0.1:%d/stream"
                "?playseek=20240101120000GMT-20240101130000GMT"
            ) % rtsp.port
            stream_get(
                "127.0.0.1",
                shared_r2h.port,
                url,
                read_bytes=4096,
                timeout=_STREAM_TIMEOUT,
                headers={"User-Agent": "TestPlayer/1.0 TZ/UTC+8"},
            )

            uri = _get_describe_uri(rtsp)
            assert (
                _extract_query_param(uri, "playseek")
                == "20240101040000GMT-20240101050000GMT"
            )
        finally:
            rtsp.stop()


# ===================================================================
# New placeholder format tests
# ===================================================================


@pytest.mark.http_proxy
class TestNewPlaceholderFormats:
    """Tests for newly supported placeholder formats."""

    def test_dollar_brace_utc(self, shared_r2h):
        """${utc} outputs begin time as ISO8601."""
        expected_path = "/stream/2024-01-01T12:00:00.000Z"
        upstream = _make_upstream(expected_path)
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d/stream/${utc}"
                "?playseek=20240101120000-20240101130000"
            ) % upstream.port
            status, _, _ = http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            assert status == 200
            assert _get_upstream_path(upstream) == expected_path
        finally:
            upstream.stop()

    def test_dollar_brace_keyword_format(self, shared_r2h):
        """${utc:yyyyMMddHHmmss} outputs begin time in long format UTC."""
        expected_path = "/stream/20240101120000"
        upstream = _make_upstream(expected_path)
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d/stream/${utc:yyyyMMddHHmmss}"
                "?playseek=20240101120000-20240101130000"
            ) % upstream.port
            status, _, _ = http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            assert status == 200
            assert _get_upstream_path(upstream) == expected_path
        finally:
            upstream.stop()

    def test_brace_be_short_format(self, shared_r2h):
        """{(b)YmdHMS} short format for begin time (local, no TZ = UTC)."""
        expected_path = "/stream/20240101120000"
        upstream = _make_upstream(expected_path)
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d/stream/{(b)YmdHMS}"
                "?playseek=20240101120000-20240101130000"
            ) % upstream.port
            status, _, _ = http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            assert status == 200
            assert _get_upstream_path(upstream) == expected_path
        finally:
            upstream.stop()

    def test_dollar_brace_timestamp(self, shared_r2h):
        """${timestamp} outputs current epoch as decimal."""
        upstream = _make_upstream()
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d/stream/${timestamp}"
                "?playseek=20240101120000-20240101130000"
            ) % upstream.port
            http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)

            path = _get_upstream_path(upstream)
            match = re.match(r"/stream/(\d+)", path)
            assert match, "Expected /stream/<epoch>, got: %s" % path
            ts = int(match.group(1))
            # Should be a recent epoch
            assert ts > 1700000000, "Timestamp should be a recent epoch, got: %d" % ts
        finally:
            upstream.stop()

    def test_be_timestamp_keyword(self, shared_r2h):
        """${(b)timestamp} outputs begin epoch."""
        expected_path = "/stream/%d" % _BEGIN_EPOCH
        upstream = _make_upstream(expected_path)
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d/stream/${(b)timestamp}"
                "?playseek=20240101120000-20240101130000"
            ) % upstream.port
            status, _, _ = http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            assert status == 200
            assert _get_upstream_path(upstream) == expected_path
        finally:
            upstream.stop()

    def test_utcend_placeholder(self, shared_r2h):
        """{utcend} outputs end time as ISO8601."""
        expected_path = "/stream/2024-01-01T13:00:00.000Z"
        upstream = _make_upstream(expected_path)
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d/stream/{utcend}"
                "?playseek=20240101120000-20240101130000"
            ) % upstream.port
            status, _, _ = http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            assert status == 200
            assert _get_upstream_path(upstream) == expected_path
        finally:
            upstream.stop()

    def test_now_placeholder(self, shared_r2h):
        """{now} outputs current time as ISO8601."""
        upstream = _make_upstream()
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d/stream/{now}"
                "?playseek=20240101120000-20240101130000"
            ) % upstream.port
            http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)

            path = _get_upstream_path(upstream)
            match = re.match(
                r"/stream/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z)", path
            )
            assert match, "Expected ISO8601 format for {now}, got: %s" % path
        finally:
            upstream.stop()

    def test_pipe_utc_modifier(self, shared_r2h):
        """${(b)yyyyMMddHHmmss|UTC} forces UTC output even with timezone."""
        # With TZ/UTC+8: begin 12:00 local → 04:00 UTC
        # |UTC forces UTC output: 04:00
        expected_path = "/stream/20240101040000"
        upstream = _make_upstream(expected_path)
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d/stream/${(b)yyyyMMddHHmmss|UTC}"
                "?playseek=20240101120000-20240101130000"
            ) % upstream.port
            status, _, _ = http_get(
                "127.0.0.1",
                shared_r2h.port,
                url,
                timeout=_TIMEOUT,
                headers={"User-Agent": "TestPlayer/1.0 TZ/UTC+8"},
            )
            assert status == 200
            assert _get_upstream_path(upstream) == expected_path
        finally:
            upstream.stop()

    def test_bare_be_iso8601(self, shared_r2h):
        """${(b)} bare outputs ISO8601."""
        expected_path = "/stream/2024-01-01T12:00:00.000Z"
        upstream = _make_upstream(expected_path)
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d/stream/${(b)}"
                "?playseek=20240101120000-20240101130000"
            ) % upstream.port
            status, _, _ = http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            assert status == 200
            assert _get_upstream_path(upstream) == expected_path
        finally:
            upstream.stop()

    def test_dollar_brace_components(self, shared_r2h):
        """${yyyy}, ${MM}, ${dd}, ${HH}, ${mm}, ${ss} for begin time components (UTC)."""
        expected_path = "/stream/2024/01/01/12/00/00"
        upstream = _make_upstream(expected_path)
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d/stream/${yyyy}/${MM}/${dd}/${HH}/${mm}/${ss}"
                "?playseek=20240101120000-20240101130000"
            ) % upstream.port
            status, _, _ = http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            assert status == 200
            assert _get_upstream_path(upstream) == expected_path
        finally:
            upstream.stop()

    def test_dollar_brace_duration(self, shared_r2h):
        """${duration} outputs duration in seconds."""
        expected_path = "/stream/3600"
        upstream = _make_upstream(expected_path)
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d/stream/${duration}"
                "?playseek=20240101120000-20240101130000"
            ) % upstream.port
            status, _, _ = http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            assert status == 200
            assert _get_upstream_path(upstream) == expected_path
        finally:
            upstream.stop()

    def test_brace_keyword_short_format(self, shared_r2h):
        """{utc:YmdHMS} outputs begin time in short format UTC."""
        expected_path = "/stream/20240101120000"
        upstream = _make_upstream(expected_path)
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d/stream/{utc:YmdHMS}"
                "?playseek=20240101120000-20240101130000"
            ) % upstream.port
            status, _, _ = http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            assert status == 200
            assert _get_upstream_path(upstream) == expected_path
        finally:
            upstream.stop()

    def test_brace_utcend_short_format(self, shared_r2h):
        """{utcend:YmdHMS} outputs end time in short format UTC."""
        expected_path = "/stream/20240101130000"
        upstream = _make_upstream(expected_path)
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d/stream/{utcend:YmdHMS}"
                "?playseek=20240101120000-20240101130000"
            ) % upstream.port
            status, _, _ = http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            assert status == 200
            assert _get_upstream_path(upstream) == expected_path
        finally:
            upstream.stop()
