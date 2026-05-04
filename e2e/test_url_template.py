"""
E2E tests for time and seek processing.

Covers two distinct layers:
1. Resolver-layer URL handling for direct HTTP/RTSP requests.
2. M3U catchup-source rewrite and closed-loop consumption from /playlist.m3u.
"""

import re
import time

import pytest

from helpers import (
    MockHTTPUpstream,
    MockRTSPServer,
    MockRTSPServerUDP,
    R2HProcess,
    extract_catchup_source,
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

    @pytest.mark.parametrize(
        "url_path_template, expected_path, playseek",
        [
            pytest.param(
                "/stream/{utc}/data",
                "/stream/2024-01-01T12:00:00.000Z/data",
                "20240101120000-20240101130000",
                id="utc",
            ),
            pytest.param(
                "/stream/{start}",
                "/stream/2024-01-01T12:00:00.000Z",
                "20240101120000-20240101130000",
                id="start-alias",
            ),
            pytest.param(
                "/stream/{end}",
                "/stream/2024-01-01T13:00:00.000Z",
                "20240101120000-20240101130000",
                id="end",
            ),
            pytest.param(
                "/stream/{duration}",
                "/stream/3600",
                "20240101120000-20240101130000",
                id="duration",
            ),
            pytest.param(
                "/stream/{Y}",
                "/stream/2024",
                "20240101120000-20240101130000",
                id="Y-year",
            ),
            pytest.param(
                "/stream/{m}",
                "/stream/01",
                "20240101120000-20240101130000",
                id="m-month",
            ),
            pytest.param(
                "/stream/{d}",
                "/stream/01",
                "20240101120000-20240101130000",
                id="d-day",
            ),
            pytest.param(
                "/stream/{H}",
                "/stream/12",
                "20240101120000-20240101130000",
                id="H-hour",
            ),
            pytest.param(
                "/stream/{M}",
                "/stream/30",
                "20240101123000-20240101133000",
                id="M-minute",
            ),
            pytest.param(
                "/stream/{S}",
                "/stream/45",
                "20240101120045-20240101130045",
                id="S-second",
            ),
        ],
    )
    def test_placeholder_substitution(self, shared_r2h, url_path_template, expected_path, playseek):
        """Keyword and time-component placeholders should be correctly substituted."""
        upstream = _make_upstream(expected_path)
        upstream.start()
        try:
            url = ("/http/127.0.0.1:%d%s?playseek=%s") % (upstream.port, url_path_template, playseek)
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
                "/http/127.0.0.1:%d/stream/{Y}/{m}/{d}/{H}/{M}/{S}?playseek=20240101120000-20240101130000"
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
            url = ("/http/127.0.0.1:%d/path/${(b)yyyyMMddHHmmss}/${(e)yyyyMMddHHmmss}/file.m3u8") % upstream.port
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
                "/http/127.0.0.1:%d/path/${(b)yyyyMMddHHmmss}/data?ts={utc}&playseek=20240101120000-20240101130000"
            ) % upstream.port
            status, _, _ = http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            assert status == 200

            full_path = _get_upstream_path(upstream)
            # Path substituted
            assert full_path.startswith("/path/20240101120000/data")
            # Query template also substituted (ISO8601)
            assert "ts=2024-01-01T12" in full_path, (
                "Query template {utc} should be substituted as ISO8601, got: %s" % full_path
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
                "/http/127.0.0.1:%d/path/${(b)yyyyMMdd}/${(b)HHmmss}/file?playseek=20240101120000-20240101130000"
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
            url = ("/http/127.0.0.1:%d/path/${(b)yyyyMMddHHmmss}/file?playseek=20240101120000") % upstream.port
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
            url = ("/http/127.0.0.1:%d/path/${(b)yyyyMMddHHmmss}/${(e)yyyyMMddHHmmss}/file?playseek=%d-%d") % (
                upstream.port,
                _BEGIN_EPOCH,
                _END_EPOCH,
            )
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
            url = ("/http/127.0.0.1:%d/stream/{offset}?playseek=20240101120000-20240101130000") % upstream.port
            http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)

            path = _get_upstream_path(upstream)
            # {offset} should be replaced with a large positive number
            # (current time - 2024-01-01 12:00:00 UTC)
            match = re.match(r"/stream/(\d+)", path)
            assert match, "Expected /stream/<number>, got: %s" % path
            offset_val = int(match.group(1))
            # The offset should be at least a few million seconds (we're past 2024)
            assert offset_val > 1000000, "Offset should be large (time since 2024-01-01), got: %d" % offset_val
        finally:
            upstream.stop()

    def test_utc_and_begin_format_in_same_url(self, shared_r2h):
        """Both {utc} (ISO8601) and ${(b)yyyyMMddHHmmss} in the same URL should both substitute."""
        expected_path = "/path/2024-01-01T12:00:00.000Z/20240101120000/file"
        upstream = _make_upstream(expected_path)
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d/path/{utc}/${(b)yyyyMMddHHmmss}/file?playseek=20240101120000-20240101130000"
            ) % upstream.port
            status, _, _ = http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            assert status == 200
            assert _get_upstream_path(upstream) == expected_path
        finally:
            upstream.stop()

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
                "/http/127.0.0.1:%d/archive/${(e)yyyyMMddHHmmss}/video.ts?playseek=20240101120000-20240101130000"
            ) % upstream.port
            status, _, _ = http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            assert status == 200
            assert _get_upstream_path(upstream) == expected_path
        finally:
            upstream.stop()

    def test_begin_and_end_different_formats(self, shared_r2h):
        """Begin in date-only, end in time-only format in the same URL."""
        expected_path = "/archive/20240101/130000/video.ts"
        upstream = _make_upstream(expected_path)
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d/archive/${(b)yyyyMMdd}/${(e)HHmmss}/video.ts?playseek=20240101120000-20240101130000"
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
                "/http/127.0.0.1:%d/stream?begin={utc}&end={end}&playseek=20240101120000-20240101130000"
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
            url = ("/http/127.0.0.1:%d/stream/{duration}?playseek=20240101120000-20240101120000") % upstream.port
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
            url = ("/http/127.0.0.1:%d/stream/{duration}?playseek=20240101000000-20240102000000") % upstream.port
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
                "/http/127.0.0.1:%d/path/${(e)yyyyMMdd}/${(e)HHmmss}/file?playseek=20240101120000-20240101130000"
            ) % upstream.port
            status, _, _ = http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            assert status == 200
            assert _get_upstream_path(upstream) == expected_path
        finally:
            upstream.stop()

    @pytest.mark.parametrize(
        "placeholder, expected_path, playseek",
        [
            pytest.param("{m}", "/stream/12", "20241215120000-20241215130000", id="m-december"),
            pytest.param("{H}", "/stream/23", "20240101230000-20240102000000", id="H-hour-23"),
        ],
    )
    def test_component_boundary_value(self, shared_r2h, placeholder, expected_path, playseek):
        """Time component placeholders should handle boundary values correctly."""
        upstream = _make_upstream(expected_path)
        upstream.start()
        try:
            url = ("/http/127.0.0.1:%d/stream/%s?playseek=%s") % (upstream.port, placeholder, playseek)
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
                "/http/127.0.0.1:%d/stream/{utc}/{end}/{duration}?playseek=20240101120000-20240101130000"
            ) % upstream.port
            http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)

            path = _get_upstream_path(upstream)
            parts = path.strip("/").split("/")
            assert len(parts) >= 4, "Expected /stream/utc/end/duration, got: %s" % path
            assert "2024-01-01T12:00:00.000Z" == parts[1], "Expected begin ISO8601, got: %s" % parts[1]
            assert "2024-01-01T13:00:00.000Z" == parts[2], "Expected end ISO8601, got: %s" % parts[2]
            assert parts[3] == "3600", "Expected duration 3600, got: %s" % parts[3]
        finally:
            upstream.stop()

    def test_multiple_templates_utc_lutc_end_duration(self, shared_r2h):
        """Multiple keyword placeholders in one URL."""
        upstream = _make_upstream()
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d/s/{utc}/{lutc}/{end}/{duration}?playseek=20240101120000-20240101130000"
            ) % upstream.port
            http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)

            path = _get_upstream_path(upstream)
            parts = path.strip("/").split("/")
            assert len(parts) >= 5, "Expected 5 parts, got: %s" % path
            assert parts[1] == "2024-01-01T12:00:00.000Z", "Expected {utc} ISO8601 begin, got: %s" % parts[1]
            # {lutc} is current time ISO8601 - verify format
            assert re.match(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z", parts[2]), (
                "Expected {lutc} ISO8601 format, got: %s" % parts[2]
            )
            assert parts[3] == "2024-01-01T13:00:00.000Z", "Expected {end} ISO8601 end, got: %s" % parts[3]
            assert parts[4] == "3600", "Expected {duration} 3600, got: %s" % parts[4]
        finally:
            upstream.stop()


# ===================================================================
# Template with timezone and seek offset
# ===================================================================


@pytest.mark.http_proxy
class TestHTTPPathTemplateTimezone:
    """Verify timezone and offset interaction with path-level templates."""

    @pytest.mark.parametrize(
        "tz",
        [
            pytest.param("TZ/UTC+8", id="utc-plus-8"),
            pytest.param("TZ/UTC-5", id="utc-minus-5"),
            pytest.param("TZ/UTC", id="utc-no-offset"),
        ],
    )
    def test_tz_format_passthrough(self, shared_r2h, tz):
        """${(b)FORMAT} uses local time, so times should remain unchanged regardless of TZ."""
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
                headers={"User-Agent": "TestPlayer/1.0 %s" % tz},
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

    def test_seek_mode_is_noop_for_http_template(self, shared_r2h):
        """r2h-seek-mode is documented as RTSP-only — it must NOT shift HTTP
        URL-template placeholders, even when the seek time is "recent" enough
        for the RTSP clock= path to fire. Regression guard for the prior bug
        where the recent-clock recompute mutated begin_tm_utc shared with the
        URL-template path.
        """
        # Pick a recent-ish time in CST so range(UTC+8/3600) would normally
        # interpret it as 8h earlier in UTC. The HTTP path must ignore that
        # and render placeholders from the original begin_str unchanged.
        ts_utc = int(time.time()) - 1500  # 25 min ago
        cst_str = time.strftime("%Y%m%d%H%M%S", time.gmtime(ts_utc + 8 * 3600))
        # The HTTP template uses local time (no UA TZ): the rendered path
        # equals the input string verbatim.
        expected_path = "/path/%s/file.m3u8" % cst_str
        upstream = _make_upstream(expected_path)
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d/path/${(b)yyyyMMddHHmmss}/file.m3u8?playseek=%s&r2h-seek-mode=range(UTC%%2B8/3600)"
            ) % (upstream.port, cst_str)
            status, _, _ = http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            assert status == 200
            assert _get_upstream_path(upstream) == expected_path, (
                "r2h-seek-mode leaked into HTTP template: got %s, expected %s"
                % (_get_upstream_path(upstream), expected_path)
            )
        finally:
            upstream.stop()

    def test_lutc_with_timezone(self, shared_r2h):
        """{lutc} should return current time as ISO8601 UTC."""
        upstream = _make_upstream()
        upstream.start()
        try:
            url = ("/http/127.0.0.1:%d/stream/{lutc}?playseek=20240101120000-20240101130000") % upstream.port
            http_get(
                "127.0.0.1",
                shared_r2h.port,
                url,
                timeout=_TIMEOUT,
                headers={"User-Agent": "TestPlayer/1.0 TZ/UTC+8"},
            )

            path = _get_upstream_path(upstream)
            # {lutc} outputs current time as ISO8601 - verify format
            match = re.match(r"/stream/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z)", path)
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
            url = ("/http/127.0.0.1:%d/stream/{utc}?playseek=20240101120000-20240101130000") % upstream.port
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
            url = ("/http/127.0.0.1:%d/stream/{duration}?playseek=20240101120000-20240101130000") % upstream.port
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

    def test_no_user_agent_defaults_utc(self, shared_r2h):
        """No User-Agent at all should default to UTC."""
        expected_path = "/path/20240101120000/file"
        upstream = _make_upstream(expected_path)
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d/path/${(b)yyyyMMddHHmmss}/file?playseek=20240101120000-20240101130000"
            ) % upstream.port
            status, _, _ = http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            assert status == 200
            assert _get_upstream_path(upstream) == expected_path
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
            url = ("/http/127.0.0.1:%d/{utc}/?playseek=20240101120000-20240101130000") % upstream.port
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
                "/http/127.0.0.1:%d/cctv/${(b)yyyyMMddHHmmss}/data.ts?playseek=20240101120000-20240101130000"
            ) % upstream.port
            status, _, _ = http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            assert status == 200
            assert _get_upstream_path(upstream) == expected_path
        finally:
            upstream.stop()

    @pytest.mark.parametrize(
        "format_pattern, expected_segment",
        [
            pytest.param("yyyyMMdd", "20240101", id="date-only"),
            pytest.param("HHmmss", "120000", id="time-only"),
            pytest.param("yyyyMMdd_HHmmss", "20240101_120000", id="underscore"),
            pytest.param("yyyy.MM.dd", "2024.01.01", id="dots"),
        ],
    )
    def test_begin_format_pattern(self, shared_r2h, format_pattern, expected_segment):
        """${(b)FORMAT} should format begin time according to the pattern."""
        expected_path = "/path/%s/file" % expected_segment
        upstream = _make_upstream(expected_path)
        upstream.start()
        try:
            url = ("/http/127.0.0.1:%d/path/${(b)%s}/file?playseek=20240101120000-20240101130000") % (
                upstream.port,
                format_pattern,
            )
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
            url = ("/http/127.0.0.1:%d/stream/{foo}/{utc}?playseek=20240101120000-20240101130000") % upstream.port
            http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)

            path = _get_upstream_path(upstream)
            assert "{foo}" in path, "Unknown placeholder should pass through, got: %s" % path
            assert "2024-01-01T12:00:00.000Z" in path, "Known placeholder {utc} should still be substituted as ISO8601"
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
            url = ("/http/127.0.0.1:%d/path/${(b)yyyyMMddHHmmss}/file?playseek=20240101120000-") % upstream.port
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
                "/http/127.0.0.1:%d/path/${(b)yyyyMMddHHmmss}/file?quality=hd&playseek=20240101120000-20240101130000"
            ) % upstream.port
            status, _, _ = http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            assert status == 200

            full_path = _get_upstream_path(upstream)
            assert full_path.startswith("/path/20240101120000/file")
            assert "quality=hd" in full_path, "Static query params should be preserved, got: %s" % full_path
        finally:
            upstream.stop()

    def test_end_placeholder_requires_end_value(self, shared_r2h):
        """End-derived placeholders should fail when the seek value has no end time."""
        upstream = _make_upstream("/unused")
        upstream.start()
        try:
            url = ("/http/127.0.0.1:%d/archive/${(e)yyyyMMddHHmmss}/video.ts?playseek=20240101120000-") % upstream.port
            status, _, _ = http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            assert status >= 400, "Expected request to fail without an end time"
            assert len(upstream.requests_log) == 0, (
                "Upstream should not be contacted when end placeholders cannot be resolved"
            )
        finally:
            upstream.stop()

    def test_february_29_leap_year(self, shared_r2h):
        """Template substitution should handle Feb 29 correctly in a leap year."""
        expected_path = "/archive/20240229/120000/file"
        upstream = _make_upstream(expected_path)
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d/archive/${(b)yyyyMMdd}/${(b)HHmmss}/file?playseek=20240229120000-20240229130000"
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

    def test_gmt_suffix_seek_with_template(self, shared_r2h):
        """GMT-suffixed seek value should work with template substitution."""
        expected_path = "/path/20240101120000/file"
        upstream = _make_upstream(expected_path)
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d/path/${(b)yyyyMMddHHmmss}/file?playseek=20240101120000GMT-20240101130000GMT"
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
                "/http/127.0.0.1:%d/a/b/${(b)yyyyMMddHHmmss}/c/d/file.m3u8?playseek=20240101120000-20240101130000"
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
            url = ("/http/127.0.0.1:%d/path/${(b)HH:mm:ss}/file?playseek=20240101120000-20240101130000") % upstream.port
            http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)

            path = _get_upstream_path(upstream)
            assert "12:00:00" in path, "Format with colons should produce 12:00:00, got: %s" % path
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

            describe_reqs = [r for r in rtsp.requests_detailed if r["method"] == "DESCRIBE"]
            assert len(describe_reqs) > 0, "Expected DESCRIBE request"
            uri = describe_reqs[0]["uri"]
            assert "20240101120000" in uri, "Begin template should be substituted in DESCRIBE URI, got: %s" % uri
            assert "20240101130000" in uri, "End template should be substituted in DESCRIBE URI, got: %s" % uri
            assert "${" not in uri, "No unresolved templates should remain in URI, got: %s" % uri
        finally:
            rtsp.stop()

    def test_utc_in_rtsp_uri(self, shared_r2h):
        """{utc} in RTSP URL should be substituted with ISO8601."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            url = ("/rtsp/127.0.0.1:%d/stream/{utc}?playseek=20240101120000-20240101130000") % rtsp.port
            status, _, body = stream_get(
                "127.0.0.1",
                shared_r2h.port,
                url,
                read_bytes=4096,
                timeout=_STREAM_TIMEOUT,
            )
            assert status == 200

            describe_reqs = [r for r in rtsp.requests_detailed if r["method"] == "DESCRIBE"]
            assert len(describe_reqs) > 0
            uri = describe_reqs[0]["uri"]
            assert "2024-01-01T12:00:00.000Z" in uri, "Expected ISO8601 in URI, got: %s" % uri
        finally:
            rtsp.stop()

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

            describe_reqs = [r for r in rtsp.requests_detailed if r["method"] == "DESCRIBE"]
            assert len(describe_reqs) > 0
            uri = describe_reqs[0]["uri"]
            assert "20240101120000" in uri, "Template should be substituted in RTSP URI, got: %s" % uri
            assert "${" not in uri, "No unresolved templates, got: %s" % uri
            assert "r2h-seek-name" not in uri, "r2h-seek-name should be stripped, got: %s" % uri
        finally:
            rtsp.stop()

    def test_rtsp_duration_placeholder(self, shared_r2h):
        """{duration} in RTSP URL should be substituted."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            url = ("/rtsp/127.0.0.1:%d/stream/{duration}?playseek=20240101120000-20240101130000") % rtsp.port
            status, _, body = stream_get(
                "127.0.0.1",
                shared_r2h.port,
                url,
                read_bytes=4096,
                timeout=_STREAM_TIMEOUT,
            )
            assert status == 200

            describe_reqs = [r for r in rtsp.requests_detailed if r["method"] == "DESCRIBE"]
            assert len(describe_reqs) > 0
            uri = describe_reqs[0]["uri"]
            assert "/stream/3600" in uri, "Duration should be 3600 in RTSP URI, got: %s" % uri
        finally:
            rtsp.stop()

    def test_template_expands_when_recent_clock_path_fires(self, shared_r2h):
        """${...} placeholders in the RTSP URL must still expand even when
        the recent-clock path fires (r2h-seek-mode=range + begin within the
        window). Regression guard for a bug where the recent-clock branch
        forwarded a NULL parse_result to the URL resolver, leaving
        placeholders unresolved in the DESCRIBE URI."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            start_ts = int(time.time()) - 1500  # 25 min ago, within 1h window
            # UTC-format yyyyMMddHHmmss + no UA TZ + range(3600): begin_tm_utc
            # echoes the same string back via ${(b)yyyyMMddHHmmss}, and the
            # recent-clock path also fires (verified via PLAY Range header).
            utc_str = time.strftime("%Y%m%d%H%M%S", time.gmtime(start_ts))
            url = ("/rtsp/127.0.0.1:%d/path/${(b)yyyyMMddHHmmss}/stream?playseek=%s&r2h-seek-mode=range(3600)") % (
                rtsp.port,
                utc_str,
            )

            stream_get("127.0.0.1", shared_r2h.port, url, read_bytes=4096, timeout=_STREAM_TIMEOUT)

            uri = _get_describe_uri(rtsp)
            assert "${" not in uri, "Template placeholder left unresolved in DESCRIBE URI: %s" % uri
            assert ("/path/%s/stream" % utc_str) in uri, (
                "Begin template should be substituted in DESCRIBE URI, got: %s" % uri
            )
            # Cross-check the recent-clock path actually fired.
            play_reqs = [r for r in rtsp.requests_detailed if r["method"] == "PLAY"]
            expected_clock = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime(start_ts))
            assert play_reqs[0]["headers"].get("Range") == "clock=%s-" % expected_clock
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
            url = ("/http/127.0.0.1:%d/stream?playseek=20240101120000-20240101130000") % upstream.port
            status, _, _ = http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            assert status == 200

            path = _get_upstream_path(upstream)
            assert "playseek=" in path, "Query-append mode should append playseek, got: %s" % path
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
                "/http/127.0.0.1:%d/stream?r2h-seek-name=myseek&myseek=20240301100000-20240301110000"
            ) % upstream.port
            status, _, _ = http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            assert status == 200

            path = _get_upstream_path(upstream)
            assert "myseek=" in path, "Custom seek param should be forwarded, got: %s" % path
        finally:
            upstream.stop()

    def test_r2h_seek_name_stripped(self, shared_r2h):
        """r2h-seek-name should be stripped from the upstream URL."""
        upstream = _make_upstream("/stream")
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d/stream?r2h-seek-name=myseek&myseek=20240301100000-20240301110000"
            ) % upstream.port
            http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)

            path = _get_upstream_path(upstream)
            assert "r2h-seek-name" not in path, "r2h-seek-name should be stripped, got: %s" % path
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
                "/http/127.0.0.1:%d/stream?playseek=20240101120000-20240101130000&r2h-seek-offset=3600"
            ) % upstream.port
            http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)

            path = _get_upstream_path(upstream)
            assert _extract_query_param(path, "playseek") == "20240101130000-20240101140000"
        finally:
            upstream.stop()

    def test_negative_offset(self, shared_r2h):
        """r2h-seek-offset=-30 should subtract 30 seconds."""
        upstream = _make_upstream("/stream")
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d/stream?playseek=20240101120000-20240101130000&r2h-seek-offset=-30"
            ) % upstream.port
            http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)

            path = _get_upstream_path(upstream)
            assert _extract_query_param(path, "playseek") == "20240101115930-20240101125930"
        finally:
            upstream.stop()

    def test_offset_stripped_from_upstream(self, shared_r2h):
        """r2h-seek-offset should be stripped from the upstream URL."""
        upstream = _make_upstream("/stream")
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d/stream?playseek=20240101120000-20240101130000&r2h-seek-offset=3600"
            ) % upstream.port
            http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)

            path = _get_upstream_path(upstream)
            assert "r2h-seek-offset" not in path, "r2h-seek-offset should be stripped, got: %s" % path
        finally:
            upstream.stop()

    def test_offset_with_unix_timestamp(self, shared_r2h):
        """r2h-seek-offset should work with Unix timestamps."""
        upstream = _make_upstream("/stream")
        upstream.start()
        try:
            url = ("/http/127.0.0.1:%d/stream?playseek=1704096000-1704099600&r2h-seek-offset=3600") % upstream.port
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
            url = ("/http/127.0.0.1:%d/stream?playseek=20240101120000-20240101130000") % upstream.port
            http_get(
                "127.0.0.1",
                shared_r2h.port,
                url,
                timeout=_TIMEOUT,
                headers={"User-Agent": "TestPlayer/1.0 TZ/UTC-5"},
            )

            path = _get_upstream_path(upstream)
            assert _extract_query_param(path, "playseek") == "20240101170000-20240101180000"
        finally:
            upstream.stop()

    def test_no_tz_no_conversion(self, shared_r2h):
        """Without TZ/ in User-Agent, times should not be converted."""
        upstream = _make_upstream("/stream")
        upstream.start()
        try:
            url = ("/http/127.0.0.1:%d/stream?playseek=20240101120000-20240101130000") % upstream.port
            http_get(
                "127.0.0.1",
                shared_r2h.port,
                url,
                timeout=_TIMEOUT,
                headers={"User-Agent": "TestPlayer/1.0"},
            )

            path = _get_upstream_path(upstream)
            assert _extract_query_param(path, "playseek") == "20240101120000-20240101130000"
        finally:
            upstream.stop()

    def test_unix_timestamp_skips_tz_conversion(self, shared_r2h):
        """Unix timestamps should not be affected by User-Agent timezone."""
        upstream = _make_upstream("/stream")
        upstream.start()
        try:
            url = ("/http/127.0.0.1:%d/stream?playseek=1704096000-1704099600") % upstream.port
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
                "/http/127.0.0.1:%d/stream?playseek=20240101120000-20240101130000&r2h-seek-offset=3600"
            ) % upstream.port
            http_get(
                "127.0.0.1",
                shared_r2h.port,
                url,
                timeout=_TIMEOUT,
                headers={"User-Agent": "TestPlayer/1.0 TZ/UTC+8"},
            )

            path = _get_upstream_path(upstream)
            assert _extract_query_param(path, "playseek") == "20240101050000-20240101060000"
        finally:
            upstream.stop()

    def test_gmt_suffix_preserved(self, shared_r2h):
        """yyyyMMddHHmmssGMT format should preserve the GMT suffix."""
        upstream = _make_upstream("/stream")
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d/stream?playseek=20240101120000GMT-20240101130000GMT&r2h-seek-offset=3600"
            ) % upstream.port
            http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)

            path = _get_upstream_path(upstream)
            assert _extract_query_param(path, "playseek") == "20240101130000GMT-20240101140000GMT"
        finally:
            upstream.stop()

    def test_unix_timestamp_format_preserved(self, shared_r2h):
        """Unix timestamp format should stay as Unix timestamp."""
        upstream = _make_upstream("/stream")
        upstream.start()
        try:
            url = ("/http/127.0.0.1:%d/stream?playseek=1704096000-1704099600") % upstream.port
            http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)

            path = _get_upstream_path(upstream)
            assert _extract_query_param(path, "playseek") == "1704096000-1704099600"
        finally:
            upstream.stop()

    def test_gmt_suffix_ignores_ua_tz(self, shared_r2h):
        """yyyyMMddHHmmssGMT is a self-contained UTC marker; UA TZ must NOT
        shift the value, mirroring the ISO-8601 `Z` suffix contract."""
        upstream = _make_upstream("/stream")
        upstream.start()
        try:
            url = ("/http/127.0.0.1:%d/stream?playseek=20240101120000GMT-20240101130000GMT") % upstream.port
            http_get(
                "127.0.0.1",
                shared_r2h.port,
                url,
                timeout=_TIMEOUT,
                headers={"User-Agent": "TestPlayer/1.0 TZ/UTC+8"},
            )

            path = _get_upstream_path(upstream)
            assert _extract_query_param(path, "playseek") == "20240101120000GMT-20240101130000GMT"
        finally:
            upstream.stop()

    def test_gmt_suffix_with_ua_tz_still_applies_seek_offset(self, shared_r2h):
        """GMT suffix overrides UA TZ, but r2h-seek-offset is a deliberate
        per-request shift and must still apply (it is not a TZ override)."""
        upstream = _make_upstream("/stream")
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d/stream?playseek=20240101120000GMT-20240101130000GMT&r2h-seek-offset=3600"
            ) % upstream.port
            http_get(
                "127.0.0.1",
                shared_r2h.port,
                url,
                timeout=_TIMEOUT,
                headers={"User-Agent": "TestPlayer/1.0 TZ/UTC+8"},
            )

            path = _get_upstream_path(upstream)
            # 12:00 GMT (UA TZ ignored) + 3600s = 13:00 GMT, NOT 05:00 GMT.
            assert _extract_query_param(path, "playseek") == "20240101130000GMT-20240101140000GMT"
        finally:
            upstream.stop()

    def test_tvdr_appended(self, shared_r2h):
        """Non-template URL with tvdr should append as query parameter."""
        upstream = _make_upstream("/stream")
        upstream.start()
        try:
            url = ("/http/127.0.0.1:%d/stream?tvdr=20240601080000-20240601090000") % upstream.port
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
            assert path == "/stream", "URL without seek should be unchanged, got: %s" % path
        finally:
            upstream.stop()

    def test_append_with_existing_query(self, shared_r2h):
        """Non-template URL with existing query params + seek should append with &."""
        upstream = _make_upstream("/stream")
        upstream.start()
        try:
            url = ("/http/127.0.0.1:%d/stream?token=abc&playseek=20240101120000-20240101130000") % upstream.port
            status, _, _ = http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            assert status == 200

            path = _get_upstream_path(upstream)
            assert "token=abc" in path, "Existing query params should be preserved"
            assert "playseek=" in path, "Seek should be appended"
            assert "&playseek=" in path, "Seek should be appended with & separator, got: %s" % path
        finally:
            upstream.stop()

    def test_tz_conversion_in_query_append(self, shared_r2h):
        """TZ conversion should work in query-append mode."""
        upstream = _make_upstream("/stream")
        upstream.start()
        try:
            url = ("/http/127.0.0.1:%d/stream?playseek=20240101120000-20240101130000") % upstream.port
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
                "/http/127.0.0.1:%d/stream?playseek=2024-01-01T12:00:00.000Z-2024-01-01T13:00:00.000Z"
            ) % upstream.port
            status, _, _ = http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            assert status == 200

            path = _get_upstream_path(upstream)
            match = re.search(r"playseek=([^&]+)", path)
            assert match, "Expected playseek in path"
            assert match.group(1) == "2024-01-01T12:00:00.000Z-2024-01-01T13:00:00.000Z", (
                "ISO8601 seek range should remain intact after splitting, got: %s" % match.group(1)
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
                "Path template catchup-source should keep original placeholder format, got:\n%s" % text
            )
        finally:
            r2h.stop()

    def test_query_only_templates_become_playseek_carrier(self, r2h_binary):
        """Query-only catchup templates should be folded into a playseek carrier."""
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

            _, catchup_source = extract_catchup_source(text, "Query Template Ch")
            assert "playseek={utc:YmdHMS}-{utcend:YmdHMS}" in catchup_source, (
                "Expected query templates to become playseek carrier, got: %s" % catchup_source
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
            catchup_lines = [line for line in lines if "catchup-source=" in line]
            if len(catchup_lines) > 0:
                catchup_line = catchup_lines[0]
                assert "playseek={utc}" not in catchup_line, "No-template catchup should not get playseek injected"
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
            assert "playseek=" in text, "Path template with ${(b)...} should inject playseek"
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
            assert "playseek=${(b)yyyyMMdd}${(b)HHmmss}-${(e)yyyyMMdd}${(e)HHmmss}" in text, (
                "Expected original placeholder fragments in playseek, got:\n%s" % text
            )
        finally:
            r2h.stop()

    def test_query_templates_prefer_playseek_carrier(self, r2h_binary):
        """Query templates should become the proxied playseek carrier when present."""
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
            _, catchup_source = extract_catchup_source(text, "Mixed Channel")
            assert "playseek={utc}" in catchup_source, (
                "Expected query begin template to become playseek carrier, got: %s" % catchup_source
            )
            assert "begin={utc}" not in catchup_source, (
                "Expected original query template to be folded into playseek, got: %s" % catchup_source
            )
        finally:
            r2h.stop()

    def test_main_service_query_templates_are_preserved_in_playlist(self, r2h_binary):
        """Main service URL should keep template query params in transformed playlist output."""
        port = find_free_port()
        config = f"""\
[global]
verbosity = 4
maxclients = 10

[bind]
* {port}

[services]
#EXTM3U
#EXTINF:-1,Main Query Template Ch
http://10.10.10.1:8888/live/stream.m3u8?token=1&begin={{utc}}
"""
        r2h = R2HProcess(r2h_binary, port, config_content=config)
        try:
            r2h.start()
            status, _, body = http_get("127.0.0.1", port, "/playlist.m3u")
            text = body.decode()

            assert status == 200
            assert "Main Query Template Ch" in text

            lines = text.splitlines()
            channel_index = lines.index("#EXTINF:-1,Main Query Template Ch")
            service_url = lines[channel_index + 1]

            assert "/Main%20Query%20Template%20Ch?begin={utc}" in service_url, (
                "Expected transformed main service URL to preserve template query, got: %s" % service_url
            )
            assert "token=1" not in service_url, (
                "Expected static query params to stay stripped from transformed main service URL, got: %s" % service_url
            )
        finally:
            r2h.stop()

    def test_append_catchup_exposes_playseek_carrier(self, r2h_binary):
        """Append-mode query templates should also expose a fixed playseek carrier."""
        port = find_free_port()
        config = f"""\
[global]
verbosity = 4
maxclients = 10

[bind]
* {port}

[services]
#EXTM3U
#EXTINF:-1 catchup="append" catchup-source="?playseek={{utc}}-{{utcend}}&duration={{duration}}",Placeholder Ch
http://10.10.10.1:8888/live/stream.m3u8
"""
        r2h = R2HProcess(r2h_binary, port, config_content=config)
        try:
            r2h.start()
            status, _, body = http_get("127.0.0.1", port, "/playlist.m3u")
            text = body.decode()

            assert status == 200
            _, catchup_source = extract_catchup_source(text, "Placeholder Ch")
            assert "playseek={utc}-{utcend}" in catchup_source, (
                "Expected append-mode placeholders to expose playseek carrier, got: %s" % catchup_source
            )
        finally:
            r2h.stop()

    def test_append_query_templates_become_playseek_carrier(self, r2h_binary):
        """Append-mode start/end query templates should be folded into playseek."""
        port = find_free_port()
        config = f"""\
[global]
verbosity = 4
maxclients = 10

[bind]
* {port}

[services]
#EXTM3U
#EXTINF:-1 catchup="append" catchup-source="?starttime=${{(b)yyyyMMdd|UTC}}T${{(b)HHmmss|UTC}}&endtime=${{(e)yyyyMMdd|UTC}}T${{(e)HHmmss|UTC}}&r2h-seek-offset=3600",Append Offset Ch
http://10.10.10.1:8888/live/stream.m3u8
"""
        r2h = R2HProcess(r2h_binary, port, config_content=config)
        try:
            r2h.start()
            status, _, body = http_get("127.0.0.1", port, "/playlist.m3u")
            text = body.decode()

            assert status == 200
            _, catchup_source = extract_catchup_source(text, "Append Offset Ch")
            assert (
                "playseek=${(b)yyyyMMdd|UTC}T${(b)HHmmss|UTC}-${(e)yyyyMMdd|UTC}T${(e)HHmmss|UTC}" in catchup_source
            ), "Expected append-mode query templates to become playseek carrier, got: %s" % catchup_source
        finally:
            r2h.stop()

    def test_append_query_templates_without_prefix_become_playseek_carrier(self, r2h_binary):
        """Append-mode query templates without a leading separator should also be folded into playseek."""
        port = find_free_port()
        config = f"""\
[global]
verbosity = 4
maxclients = 10

[bind]
* {port}

[services]
#EXTM3U
#EXTINF:-1 catchup="append" catchup-source="starttime=${{(b)yyyyMMdd|UTC}}T${{(b)HHmmss|UTC}}&endtime=${{(e)yyyyMMdd|UTC}}T${{(e)HHmmss|UTC}}&r2h-seek-offset=3600",Append No Prefix Ch
http://10.10.10.1:8888/live/stream.m3u8
"""
        r2h = R2HProcess(r2h_binary, port, config_content=config)
        try:
            r2h.start()
            status, _, body = http_get("127.0.0.1", port, "/playlist.m3u")
            text = body.decode()

            assert status == 200
            _, catchup_source = extract_catchup_source(text, "Append No Prefix Ch")
            assert (
                "playseek=${(b)yyyyMMdd|UTC}T${(b)HHmmss|UTC}-${(e)yyyyMMdd|UTC}T${(e)HHmmss|UTC}" in catchup_source
            ), (
                "Expected append-mode query templates without prefix to become playseek carrier, got: %s"
                % catchup_source
            )
        finally:
            r2h.stop()


# ===================================================================
# M3U catchup-source closed-loop consumption
# ===================================================================


@pytest.mark.http_proxy
class TestM3UCatchupConsumption:
    """Verify playlist-emitted catchup links can be consumed end-to-end."""

    def test_catchup_source_url_label_is_not_stripped(self, r2h_binary):
        """catchup-source should treat a trailing $label literally, not as a supported label suffix."""
        expected_path = "/archive/file$HD.m3u8"
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
#EXTINF:-1 catchup="default" catchup-source="http://127.0.0.1:{upstream.port}/archive/file$HD.m3u8",Catchup Label Literal Ch
rtp://239.0.0.1:1234
"""
        r2h = R2HProcess(r2h_binary, port, config_content=config)
        try:
            r2h.start()
            status, _, body = http_get("127.0.0.1", port, "/playlist.m3u")
            assert status == 200

            _, catchup_source = extract_catchup_source(body.decode(), "Catchup Label Literal Ch")

            status, _, _ = http_get(
                "127.0.0.1",
                port,
                _absolute_url_to_path(catchup_source),
                timeout=_TIMEOUT,
            )
            assert status == 200
            assert _get_upstream_path(upstream) == expected_path
        finally:
            r2h.stop()
            upstream.stop()

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

            _, catchup_source = extract_catchup_source(body.decode(), "Template Loop Channel")
            resolved_url = catchup_source.replace("${(b)yyyyMMddHHmmss}", "20240101120000")
            resolved_url = resolved_url.replace("${(e)yyyyMMddHHmmss}", "20240101130000")

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
        """A catchup-source with path and query templates should resolve via playseek after player substitution."""
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

            _, catchup_source = extract_catchup_source(body.decode(), "Mixed Loop Channel")
            resolved_url = catchup_source.replace("${(b)yyyyMMddHHmmss}", "20240101120000")
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

    def test_current_time_templates_survive_playseek_rewrite(self, r2h_binary):
        """Current-time placeholders should still resolve when catchup rewrite derives playseek from begin templates."""
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
#EXTINF:-1 catchup="default" catchup-source="http://127.0.0.1:{upstream.port}/path/${{(b)yyyyMMddHHmmss}}/1.m3u8?now={{lutc}}&ts={{timestamp}}&begin={{utc}}",Current Time Loop Channel
rtp://239.0.0.1:1234
"""
        r2h = R2HProcess(r2h_binary, port, config_content=config)
        try:
            r2h.start()
            status, _, body = http_get("127.0.0.1", port, "/playlist.m3u")
            assert status == 200

            _, catchup_source = extract_catchup_source(body.decode(), "Current Time Loop Channel")
            assert "playseek={utc}" in catchup_source

            resolved_url = catchup_source.replace("{utc}", "2024-01-01T12:00:00.000Z")

            status, _, _ = http_get(
                "127.0.0.1",
                port,
                _absolute_url_to_path(resolved_url),
                timeout=_TIMEOUT,
            )
            assert status == 200

            full_path = _get_upstream_path(upstream)
            assert full_path.startswith(expected_path)
            assert "begin=2024-01-01T12:00:00.000Z" in full_path
            assert re.search(r"[?&]now=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z", full_path), (
                "Expected {lutc} to resolve as ISO8601 UTC, got: %s" % full_path
            )
            assert re.search(r"[?&]ts=\d+", full_path), (
                "Expected {timestamp} to resolve as Unix timestamp, got: %s" % full_path
            )
        finally:
            r2h.stop()
            upstream.stop()

    def test_query_template_offset_applies_via_playseek_carrier(self, r2h_binary):
        """Query-template catchup with r2h-seek-offset should apply offset after proxied playseek request."""
        expected_path = "/VINN.mp4/master.m3u8"
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
#EXTINF:-1 catchup="default" catchup-source="http://127.0.0.1:{upstream.port}/VINN.mp4/master.m3u8?starttime=${{(b)yyyyMMdd|UTC}}T${{(b)HHmmss|UTC}}&endtime=${{(e)yyyyMMdd|UTC}}T${{(e)HHmmss|UTC}}&r2h-seek-offset=3600",Offset Loop Channel
rtp://239.0.0.1:1234
"""
        r2h = R2HProcess(r2h_binary, port, config_content=config)
        try:
            r2h.start()
            status, _, body = http_get("127.0.0.1", port, "/playlist.m3u")
            assert status == 200

            _, catchup_source = extract_catchup_source(body.decode(), "Offset Loop Channel")
            assert (
                "playseek=${(b)yyyyMMdd|UTC}T${(b)HHmmss|UTC}-${(e)yyyyMMdd|UTC}T${(e)HHmmss|UTC}" in catchup_source
            ), "Expected start/end query templates to become playseek carrier"

            resolved_url = catchup_source.replace("${(b)yyyyMMdd|UTC}T${(b)HHmmss|UTC}", "20240101T120000")
            resolved_url = resolved_url.replace("${(e)yyyyMMdd|UTC}T${(e)HHmmss|UTC}", "20240101T130000")

            status, _, _ = http_get(
                "127.0.0.1",
                port,
                _absolute_url_to_path(resolved_url),
                timeout=_TIMEOUT,
            )
            assert status == 200

            full_path = _get_upstream_path(upstream)
            assert "starttime=20240101T130000" in full_path, (
                "Expected r2h-seek-offset to shift starttime by +1h, got: %s" % full_path
            )
            assert "endtime=20240101T140000" in full_path, (
                "Expected r2h-seek-offset to shift endtime by +1h, got: %s" % full_path
            )
        finally:
            r2h.stop()
            upstream.stop()

    def test_append_query_template_offset_applies_via_playseek_carrier(self, r2h_binary):
        """Append-mode query-template catchup should also apply offset after proxied playseek request."""
        expected_path = "/VINN.mp4/master.m3u8"
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
#EXTINF:-1 catchup="append" catchup-source="?starttime=${{(b)yyyyMMdd|UTC}}T${{(b)HHmmss|UTC}}&endtime=${{(e)yyyyMMdd|UTC}}T${{(e)HHmmss|UTC}}&r2h-seek-offset=3600",Append Offset Loop Channel
http://127.0.0.1:{upstream.port}/VINN.mp4/master.m3u8
"""
        r2h = R2HProcess(r2h_binary, port, config_content=config)
        try:
            r2h.start()
            status, _, body = http_get("127.0.0.1", port, "/playlist.m3u")
            assert status == 200

            _, catchup_source = extract_catchup_source(body.decode(), "Append Offset Loop Channel")
            assert (
                "playseek=${(b)yyyyMMdd|UTC}T${(b)HHmmss|UTC}-${(e)yyyyMMdd|UTC}T${(e)HHmmss|UTC}" in catchup_source
            ), "Expected append-mode templates to become playseek carrier"

            resolved_url = catchup_source.replace("${(b)yyyyMMdd|UTC}T${(b)HHmmss|UTC}", "20240101T120000")
            resolved_url = resolved_url.replace("${(e)yyyyMMdd|UTC}T${(e)HHmmss|UTC}", "20240101T130000")

            status, _, _ = http_get(
                "127.0.0.1",
                port,
                _absolute_url_to_path(resolved_url),
                timeout=_TIMEOUT,
            )
            assert status == 200

            full_path = _get_upstream_path(upstream)
            assert "starttime=20240101T130000" in full_path, (
                "Expected append-mode r2h-seek-offset to shift starttime by +1h, got: %s" % full_path
            )
            assert "endtime=20240101T140000" in full_path, (
                "Expected append-mode r2h-seek-offset to shift endtime by +1h, got: %s" % full_path
            )
        finally:
            r2h.stop()
            upstream.stop()

    def test_append_no_prefix_query_template_offset_applies_via_playseek_carrier(self, r2h_binary):
        """Append-mode query-template catchup without a leading separator should also apply offset."""
        expected_path = "/VINN.mp4/master.m3u8"
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
#EXTINF:-1 catchup="append" catchup-source="starttime=${{(b)yyyyMMdd|UTC}}T${{(b)HHmmss|UTC}}&endtime=${{(e)yyyyMMdd|UTC}}T${{(e)HHmmss|UTC}}&r2h-seek-offset=3600",Append No Prefix Loop Channel
http://127.0.0.1:{upstream.port}/VINN.mp4/master.m3u8
"""
        r2h = R2HProcess(r2h_binary, port, config_content=config)
        try:
            r2h.start()
            status, _, body = http_get("127.0.0.1", port, "/playlist.m3u")
            assert status == 200

            _, catchup_source = extract_catchup_source(body.decode(), "Append No Prefix Loop Channel")
            assert (
                "playseek=${(b)yyyyMMdd|UTC}T${(b)HHmmss|UTC}-${(e)yyyyMMdd|UTC}T${(e)HHmmss|UTC}" in catchup_source
            ), "Expected append-mode templates without prefix to become playseek carrier"

            resolved_url = catchup_source.replace("${(b)yyyyMMdd|UTC}T${(b)HHmmss|UTC}", "20240101T120000")
            resolved_url = resolved_url.replace("${(e)yyyyMMdd|UTC}T${(e)HHmmss|UTC}", "20240101T130000")

            status, _, _ = http_get(
                "127.0.0.1",
                port,
                _absolute_url_to_path(resolved_url),
                timeout=_TIMEOUT,
            )
            assert status == 200

            full_path = _get_upstream_path(upstream)
            assert "starttime=20240101T130000" in full_path, (
                "Expected append-mode no-prefix r2h-seek-offset to shift starttime by +1h, got: %s" % full_path
            )
            assert "endtime=20240101T140000" in full_path, (
                "Expected append-mode no-prefix r2h-seek-offset to shift endtime by +1h, got: %s" % full_path
            )
        finally:
            r2h.stop()
            upstream.stop()


@pytest.mark.rtsp
class TestRTSPQueryAppendMode:
    """RTSP query-append seek handling without URL templates."""

    def test_query_append_no_template(self, shared_r2h):
        """RTSP URL without template should append playseek as query param."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            url = ("/rtsp/127.0.0.1:%d/stream?playseek=20240101120000-20240101130000") % rtsp.port
            status, _, body = stream_get(
                "127.0.0.1",
                shared_r2h.port,
                url,
                read_bytes=4096,
                timeout=_STREAM_TIMEOUT,
            )
            assert status == 200

            describe_reqs = [r for r in rtsp.requests_detailed if r["method"] == "DESCRIBE"]
            assert len(describe_reqs) > 0
            uri = describe_reqs[0]["uri"]
            assert "playseek=" in uri, "Query-append RTSP should have playseek in URI, got: %s" % uri
        finally:
            rtsp.stop()

    def test_playseek_udp(self, shared_r2h):
        """playseek query-append should work over RTSP UDP transport."""
        rtsp = MockRTSPServerUDP()
        rtsp.start()
        try:
            url = ("/rtsp/127.0.0.1:%d/stream?playseek=20240101120000-20240101130000") % rtsp.port
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
            url = ("/rtsp/127.0.0.1:%d/stream?tvdr=20240601080000-20240601090000") % rtsp.port
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
            url = ("/rtsp/127.0.0.1:%d/live/channel1?playseek=20240101120000-20240101130000") % rtsp.port
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
            url = ("/rtsp/127.0.0.1:%d/stream?r2h-seek-name=myseek&myseek=20240301100000-20240301110000") % rtsp.port
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
class TestRTSPQueryAppendOffsetAndFormat:
    """Offset, timezone, and format preservation for RTSP query-append."""

    def test_positive_offset(self, shared_r2h):
        """r2h-seek-offset=3600 should add 1 hour to RTSP playseek values."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            url = ("/rtsp/127.0.0.1:%d/stream?playseek=20240101120000-20240101130000&r2h-seek-offset=3600") % rtsp.port
            stream_get(
                "127.0.0.1",
                shared_r2h.port,
                url,
                read_bytes=4096,
                timeout=_STREAM_TIMEOUT,
            )

            uri = _get_describe_uri(rtsp)
            assert _extract_query_param(uri, "playseek") == "20240101130000-20240101140000"
        finally:
            rtsp.stop()

    def test_negative_offset(self, shared_r2h):
        """r2h-seek-offset=-30 should subtract 30 seconds from RTSP playseek."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            url = ("/rtsp/127.0.0.1:%d/stream?playseek=20240101120000-20240101130000&r2h-seek-offset=-30") % rtsp.port
            stream_get(
                "127.0.0.1",
                shared_r2h.port,
                url,
                read_bytes=4096,
                timeout=_STREAM_TIMEOUT,
            )

            uri = _get_describe_uri(rtsp)
            assert _extract_query_param(uri, "playseek") == "20240101115930-20240101125930"
        finally:
            rtsp.stop()

    def test_offset_stripped_from_uri(self, shared_r2h):
        """r2h-seek-offset should not be forwarded to the RTSP server."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            url = ("/rtsp/127.0.0.1:%d/stream?playseek=20240101120000-20240101130000&r2h-seek-offset=3600") % rtsp.port
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
            url = ("/rtsp/127.0.0.1:%d/stream?playseek=1704096000-1704099600&r2h-seek-offset=3600") % rtsp.port
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
            url = ("/rtsp/127.0.0.1:%d/stream?playseek=20240101120000-20240101130000") % rtsp.port
            stream_get(
                "127.0.0.1",
                shared_r2h.port,
                url,
                read_bytes=4096,
                timeout=_STREAM_TIMEOUT,
                headers={"User-Agent": "TestPlayer/1.0 TZ/UTC+8"},
            )

            uri = _get_describe_uri(rtsp)
            assert _extract_query_param(uri, "playseek") == "20240101040000-20240101050000"
        finally:
            rtsp.stop()

    def test_tz_utc_minus_5_converts_yyyyMMddHHmmss(self, shared_r2h):
        """TZ/UTC-5 should add 5 hours to yyyyMMddHHmmss in RTSP mode."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            url = ("/rtsp/127.0.0.1:%d/stream?playseek=20240101120000-20240101130000") % rtsp.port
            stream_get(
                "127.0.0.1",
                shared_r2h.port,
                url,
                read_bytes=4096,
                timeout=_STREAM_TIMEOUT,
                headers={"User-Agent": "TestPlayer/1.0 TZ/UTC-5"},
            )

            uri = _get_describe_uri(rtsp)
            assert _extract_query_param(uri, "playseek") == "20240101170000-20240101180000"
        finally:
            rtsp.stop()

    def test_no_tz_no_conversion(self, shared_r2h):
        """Without TZ/ in User-Agent, RTSP times should not be converted."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            url = ("/rtsp/127.0.0.1:%d/stream?playseek=20240101120000-20240101130000") % rtsp.port
            stream_get(
                "127.0.0.1",
                shared_r2h.port,
                url,
                read_bytes=4096,
                timeout=_STREAM_TIMEOUT,
                headers={"User-Agent": "TestPlayer/1.0"},
            )

            uri = _get_describe_uri(rtsp)
            assert _extract_query_param(uri, "playseek") == "20240101120000-20240101130000"
        finally:
            rtsp.stop()

    def test_unix_timestamp_skips_tz_conversion(self, shared_r2h):
        """Unix timestamps should not be timezone-converted in RTSP mode."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            url = ("/rtsp/127.0.0.1:%d/stream?playseek=1704096000-1704099600") % rtsp.port
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
            url = ("/rtsp/127.0.0.1:%d/stream?playseek=20240101120000-20240101130000&r2h-seek-offset=3600") % rtsp.port
            stream_get(
                "127.0.0.1",
                shared_r2h.port,
                url,
                read_bytes=4096,
                timeout=_STREAM_TIMEOUT,
                headers={"User-Agent": "TestPlayer/1.0 TZ/UTC+8"},
            )

            uri = _get_describe_uri(rtsp)
            assert _extract_query_param(uri, "playseek") == "20240101050000-20240101060000"
        finally:
            rtsp.stop()

    def test_gmt_suffix_preserved(self, shared_r2h):
        """yyyyMMddHHmmssGMT format should preserve the GMT suffix in RTSP."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            url = (
                "/rtsp/127.0.0.1:%d/stream?playseek=20240101120000GMT-20240101130000GMT&r2h-seek-offset=3600"
            ) % rtsp.port
            stream_get(
                "127.0.0.1",
                shared_r2h.port,
                url,
                read_bytes=4096,
                timeout=_STREAM_TIMEOUT,
            )

            uri = _get_describe_uri(rtsp)
            assert _extract_query_param(uri, "playseek") == "20240101130000GMT-20240101140000GMT"
        finally:
            rtsp.stop()

    def test_unix_timestamp_format_preserved(self, shared_r2h):
        """Unix timestamp format should stay as Unix timestamp in RTSP."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            url = ("/rtsp/127.0.0.1:%d/stream?playseek=1704096000-1704099600") % rtsp.port
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

    def test_gmt_suffix_ignores_ua_tz(self, shared_r2h):
        """yyyyMMddHHmmssGMT is a self-contained UTC marker; UA TZ must NOT
        shift the value in RTSP either, mirroring the ISO-8601 `Z` contract."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            url = ("/rtsp/127.0.0.1:%d/stream?playseek=20240101120000GMT-20240101130000GMT") % rtsp.port
            stream_get(
                "127.0.0.1",
                shared_r2h.port,
                url,
                read_bytes=4096,
                timeout=_STREAM_TIMEOUT,
                headers={"User-Agent": "TestPlayer/1.0 TZ/UTC+8"},
            )

            uri = _get_describe_uri(rtsp)
            assert _extract_query_param(uri, "playseek") == "20240101120000GMT-20240101130000GMT"
        finally:
            rtsp.stop()

    def test_iso8601_z_ignores_range_mode_tz(self, shared_r2h):
        """Companion to the UA-TZ self-contained-TZ tests above: when the seek
        input is ISO-8601 with an embedded `Z` suffix, neither UA TZ NOR
        r2h-seek-mode=range(<TZ>) may shift the parsed instant. Exercises
        the recent-clock path (PLAY Range: clock=...) since range(<TZ>) is
        the only entry point for the explicit-TZ recompute branch."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            start_ts = int(time.time()) - 1500  # 25 min ago, within 1h window
            iso_str = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime(start_ts))
            # range(UTC+9) AND a UA TZ that disagrees with both the range TZ
            # and the embedded `Z` — the `Z` wins regardless.
            url = "/rtsp/127.0.0.1:%d/stream?playseek=%s&r2h-seek-mode=range(UTC%%2B9/3600)" % (rtsp.port, iso_str)

            stream_get(
                "127.0.0.1",
                shared_r2h.port,
                url,
                read_bytes=4096,
                timeout=_STREAM_TIMEOUT,
                headers={"User-Agent": "TestPlayer/1.0 TZ/UTC+8"},
            )

            play_reqs = [r for r in rtsp.requests_detailed if r["method"] == "PLAY"]
            expected_clock = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime(start_ts))
            assert play_reqs[0]["headers"].get("Range") == "clock=%s-" % expected_clock, (
                "Embedded `Z` must take precedence over both range(<TZ>) and UA TZ — "
                "got Range header %r" % play_reqs[0]["headers"].get("Range")
            )
        finally:
            rtsp.stop()

    def test_gmt_suffix_ignores_range_mode_tz(self, shared_r2h):
        """Companion to test_gmt_suffix_ignores_ua_tz: same self-contained-TZ
        contract on the recent-clock path. range(<TZ>) is the only entry
        point for the explicit-TZ recompute branch, so it's the only way
        to fully prove the GMT suffix is authoritative everywhere."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            start_ts = int(time.time()) - 1500  # 25 min ago, within 1h window
            gmt_str = time.strftime("%Y%m%d%H%M%S", time.gmtime(start_ts)) + "GMT"
            url = "/rtsp/127.0.0.1:%d/stream?playseek=%s&r2h-seek-mode=range(UTC%%2B9/3600)" % (rtsp.port, gmt_str)

            stream_get(
                "127.0.0.1",
                shared_r2h.port,
                url,
                read_bytes=4096,
                timeout=_STREAM_TIMEOUT,
                headers={"User-Agent": "TestPlayer/1.0 TZ/UTC+8"},
            )

            play_reqs = [r for r in rtsp.requests_detailed if r["method"] == "PLAY"]
            expected_clock = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime(start_ts))
            assert play_reqs[0]["headers"].get("Range") == "clock=%s-" % expected_clock, (
                "GMT suffix must take precedence over both range(<TZ>) and UA TZ — "
                "got Range header %r" % play_reqs[0]["headers"].get("Range")
            )
        finally:
            rtsp.stop()


# ===================================================================
# New placeholder format tests
# ===================================================================


@pytest.mark.http_proxy
class TestPlaceholderSyntaxBeginTime:
    """Alternative placeholder syntaxes for begin time substitution."""

    def test_dollar_brace_utc(self, shared_r2h):
        """${utc} outputs begin time as ISO8601."""
        expected_path = "/stream/2024-01-01T12:00:00.000Z"
        upstream = _make_upstream(expected_path)
        upstream.start()
        try:
            url = ("/http/127.0.0.1:%d/stream/${utc}?playseek=20240101120000-20240101130000") % upstream.port
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
                "/http/127.0.0.1:%d/stream/${utc:yyyyMMddHHmmss}?playseek=20240101120000-20240101130000"
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
            url = ("/http/127.0.0.1:%d/stream/{(b)YmdHMS}?playseek=20240101120000-20240101130000") % upstream.port
            status, _, _ = http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
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
            url = ("/http/127.0.0.1:%d/stream/${(b)}?playseek=20240101120000-20240101130000") % upstream.port
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
            url = ("/http/127.0.0.1:%d/stream/{utc:YmdHMS}?playseek=20240101120000-20240101130000") % upstream.port
            status, _, _ = http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            assert status == 200
            assert _get_upstream_path(upstream) == expected_path
        finally:
            upstream.stop()


@pytest.mark.http_proxy
class TestPlaceholderSyntaxEndTime:
    """Alternative placeholder syntaxes for end time substitution."""

    def test_utcend_placeholder(self, shared_r2h):
        """{utcend} outputs end time as ISO8601."""
        expected_path = "/stream/2024-01-01T13:00:00.000Z"
        upstream = _make_upstream(expected_path)
        upstream.start()
        try:
            url = ("/http/127.0.0.1:%d/stream/{utcend}?playseek=20240101120000-20240101130000") % upstream.port
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
            url = ("/http/127.0.0.1:%d/stream/{utcend:YmdHMS}?playseek=20240101120000-20240101130000") % upstream.port
            status, _, _ = http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            assert status == 200
            assert _get_upstream_path(upstream) == expected_path
        finally:
            upstream.stop()


@pytest.mark.http_proxy
class TestPlaceholderSyntaxTimestamp:
    """Epoch timestamp placeholder variants."""

    def test_dollar_brace_timestamp(self, shared_r2h):
        """${timestamp} outputs current epoch as decimal."""
        upstream = _make_upstream()
        upstream.start()
        try:
            url = ("/http/127.0.0.1:%d/stream/${timestamp}?playseek=20240101120000-20240101130000") % upstream.port
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
            url = ("/http/127.0.0.1:%d/stream/${(b)timestamp}?playseek=20240101120000-20240101130000") % upstream.port
            status, _, _ = http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            assert status == 200
            assert _get_upstream_path(upstream) == expected_path
        finally:
            upstream.stop()


@pytest.mark.http_proxy
class TestPlaceholderSyntaxCurrentTime:
    """Placeholders for current wall-clock time."""

    def test_now_placeholder(self, shared_r2h):
        """{now} outputs current time as ISO8601."""
        upstream = _make_upstream()
        upstream.start()
        try:
            url = ("/http/127.0.0.1:%d/stream/{now}?playseek=20240101120000-20240101130000") % upstream.port
            http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)

            path = _get_upstream_path(upstream)
            match = re.match(r"/stream/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z)", path)
            assert match, "Expected ISO8601 format for {now}, got: %s" % path
        finally:
            upstream.stop()


@pytest.mark.http_proxy
class TestPlaceholderSyntaxComponentsAndDuration:
    """Component placeholders (${yyyy}, etc.) and ${duration} with $ syntax."""

    def test_dollar_brace_components(self, shared_r2h):
        """${yyyy}, ${MM}, ${dd}, ${HH}, ${mm}, ${ss} for begin time components (UTC)."""
        expected_path = "/stream/2024/01/01/12/00/00"
        upstream = _make_upstream(expected_path)
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d/stream/${yyyy}/${MM}/${dd}/${HH}/${mm}/${ss}?playseek=20240101120000-20240101130000"
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
            url = ("/http/127.0.0.1:%d/stream/${duration}?playseek=20240101120000-20240101130000") % upstream.port
            status, _, _ = http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            assert status == 200
            assert _get_upstream_path(upstream) == expected_path
        finally:
            upstream.stop()


@pytest.mark.http_proxy
class TestPlaceholderSyntaxModifiers:
    """Placeholder modifiers like |UTC."""

    def test_pipe_utc_modifier(self, shared_r2h):
        """${(b)yyyyMMddHHmmss|UTC} forces UTC output even with timezone."""
        # With TZ/UTC+8: begin 12:00 local → 04:00 UTC
        # |UTC forces UTC output: 04:00
        expected_path = "/stream/20240101040000"
        upstream = _make_upstream(expected_path)
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d/stream/${(b)yyyyMMddHHmmss|UTC}?playseek=20240101120000-20240101130000"
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

    def test_pipe_utc_modifier_end(self, shared_r2h):
        """${(e)yyyyMMddHHmmss|UTC} forces UTC output for end time."""
        expected_path = "/stream/20240101050000"
        upstream = _make_upstream(expected_path)
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d/stream/${(e)yyyyMMddHHmmss|UTC}?playseek=20240101120000-20240101130000"
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


# ===================================================================
# Missing placeholder syntax coverage
# ===================================================================


@pytest.mark.http_proxy
class TestPlaceholderSyntaxLongKeywords:
    """${keyword} long syntax for keywords only tested in {} short syntax so far."""

    def test_dollar_brace_utcend(self, shared_r2h):
        """${utcend} outputs end time as ISO8601."""
        expected_path = "/stream/2024-01-01T13:00:00.000Z"
        upstream = _make_upstream(expected_path)
        upstream.start()
        try:
            url = ("/http/127.0.0.1:%d/stream/${utcend}?playseek=20240101120000-20240101130000") % upstream.port
            status, _, _ = http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            assert status == 200
            assert _get_upstream_path(upstream) == expected_path
        finally:
            upstream.stop()

    def test_dollar_brace_start(self, shared_r2h):
        """${start} outputs begin time as ISO8601."""
        expected_path = "/stream/2024-01-01T12:00:00.000Z"
        upstream = _make_upstream(expected_path)
        upstream.start()
        try:
            url = ("/http/127.0.0.1:%d/stream/${start}?playseek=20240101120000-20240101130000") % upstream.port
            status, _, _ = http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            assert status == 200
            assert _get_upstream_path(upstream) == expected_path
        finally:
            upstream.stop()

    def test_dollar_brace_end(self, shared_r2h):
        """${end} outputs end time as ISO8601."""
        expected_path = "/stream/2024-01-01T13:00:00.000Z"
        upstream = _make_upstream(expected_path)
        upstream.start()
        try:
            url = ("/http/127.0.0.1:%d/stream/${end}?playseek=20240101120000-20240101130000") % upstream.port
            status, _, _ = http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            assert status == 200
            assert _get_upstream_path(upstream) == expected_path
        finally:
            upstream.stop()

    def test_dollar_brace_lutc(self, shared_r2h):
        """${lutc} outputs current time as ISO8601."""
        upstream = _make_upstream()
        upstream.start()
        try:
            url = ("/http/127.0.0.1:%d/stream/${lutc}?playseek=20240101120000-20240101130000") % upstream.port
            http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            path = _get_upstream_path(upstream)
            assert re.match(r"/stream/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z", path), (
                "Expected ISO8601 for ${lutc}, got: %s" % path
            )
        finally:
            upstream.stop()

    def test_dollar_brace_now(self, shared_r2h):
        """${now} outputs current time as ISO8601."""
        upstream = _make_upstream()
        upstream.start()
        try:
            url = ("/http/127.0.0.1:%d/stream/${now}?playseek=20240101120000-20240101130000") % upstream.port
            http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            path = _get_upstream_path(upstream)
            assert re.match(r"/stream/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z", path), (
                "Expected ISO8601 for ${now}, got: %s" % path
            )
        finally:
            upstream.stop()

    def test_dollar_brace_offset(self, shared_r2h):
        """${offset} outputs seconds since begin."""
        upstream = _make_upstream()
        upstream.start()
        try:
            url = ("/http/127.0.0.1:%d/stream/${offset}?playseek=20240101120000-20240101130000") % upstream.port
            http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            path = _get_upstream_path(upstream)
            match = re.match(r"/stream/(\d+)", path)
            assert match, "Expected numeric offset, got: %s" % path
            assert int(match.group(1)) > 1000000
        finally:
            upstream.stop()

    def test_dollar_brace_e_timestamp(self, shared_r2h):
        """${(e)timestamp} outputs end time as epoch."""
        expected_path = "/stream/%d" % _END_EPOCH
        upstream = _make_upstream(expected_path)
        upstream.start()
        try:
            url = ("/http/127.0.0.1:%d/stream/${(e)timestamp}?playseek=20240101120000-20240101130000") % upstream.port
            status, _, _ = http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            assert status == 200
            assert _get_upstream_path(upstream) == expected_path
        finally:
            upstream.stop()


@pytest.mark.http_proxy
class TestPlaceholderSyntaxKeywordFormats:
    """Keyword:FORMAT variants for all keywords."""

    def test_utcend_long_format(self, shared_r2h):
        """${utcend:yyyyMMddHHmmss} outputs end time in long format."""
        expected_path = "/stream/20240101130000"
        upstream = _make_upstream(expected_path)
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d/stream/${utcend:yyyyMMddHHmmss}?playseek=20240101120000-20240101130000"
            ) % upstream.port
            status, _, _ = http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            assert status == 200
            assert _get_upstream_path(upstream) == expected_path
        finally:
            upstream.stop()

    def test_start_long_format(self, shared_r2h):
        """${start:yyyyMMddHHmmss} outputs begin time in long format."""
        expected_path = "/stream/20240101120000"
        upstream = _make_upstream(expected_path)
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d/stream/${start:yyyyMMddHHmmss}?playseek=20240101120000-20240101130000"
            ) % upstream.port
            status, _, _ = http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            assert status == 200
            assert _get_upstream_path(upstream) == expected_path
        finally:
            upstream.stop()

    def test_end_long_format(self, shared_r2h):
        """${end:yyyyMMddHHmmss} outputs end time in long format."""
        expected_path = "/stream/20240101130000"
        upstream = _make_upstream(expected_path)
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d/stream/${end:yyyyMMddHHmmss}?playseek=20240101120000-20240101130000"
            ) % upstream.port
            status, _, _ = http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            assert status == 200
            assert _get_upstream_path(upstream) == expected_path
        finally:
            upstream.stop()

    def test_lutc_long_format(self, shared_r2h):
        """${lutc:yyyyMMddHHmmss} outputs current time in long format."""
        upstream = _make_upstream()
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d/stream/${lutc:yyyyMMddHHmmss}?playseek=20240101120000-20240101130000"
            ) % upstream.port
            http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            path = _get_upstream_path(upstream)
            assert re.match(r"/stream/\d{14}", path), (
                "Expected 14-digit formatted time for ${lutc:FORMAT}, got: %s" % path
            )
        finally:
            upstream.stop()

    def test_now_long_format(self, shared_r2h):
        """${now:yyyyMMddHHmmss} outputs current time in long format."""
        upstream = _make_upstream()
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d/stream/${now:yyyyMMddHHmmss}?playseek=20240101120000-20240101130000"
            ) % upstream.port
            http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            path = _get_upstream_path(upstream)
            assert re.match(r"/stream/\d{14}", path), (
                "Expected 14-digit formatted time for ${now:FORMAT}, got: %s" % path
            )
        finally:
            upstream.stop()

    def test_timestamp_long_format(self, shared_r2h):
        """${timestamp:yyyyMMddHHmmss} outputs current time in long format."""
        upstream = _make_upstream()
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d/stream/${timestamp:yyyyMMddHHmmss}?playseek=20240101120000-20240101130000"
            ) % upstream.port
            http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            path = _get_upstream_path(upstream)
            assert re.match(r"/stream/\d{14}", path), (
                "Expected 14-digit formatted time for ${timestamp:FORMAT}, got: %s" % path
            )
        finally:
            upstream.stop()

    def test_end_short_format(self, shared_r2h):
        """{end:YmdHMS} outputs end time in short format."""
        expected_path = "/stream/20240101130000"
        upstream = _make_upstream(expected_path)
        upstream.start()
        try:
            url = ("/http/127.0.0.1:%d/stream/{end:YmdHMS}?playseek=20240101120000-20240101130000") % upstream.port
            status, _, _ = http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            assert status == 200
            assert _get_upstream_path(upstream) == expected_path
        finally:
            upstream.stop()

    def test_start_short_format(self, shared_r2h):
        """{start:YmdHMS} outputs begin time in short format."""
        expected_path = "/stream/20240101120000"
        upstream = _make_upstream(expected_path)
        upstream.start()
        try:
            url = ("/http/127.0.0.1:%d/stream/{start:YmdHMS}?playseek=20240101120000-20240101130000") % upstream.port
            status, _, _ = http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            assert status == 200
            assert _get_upstream_path(upstream) == expected_path
        finally:
            upstream.stop()

    def test_lutc_short_format(self, shared_r2h):
        """{lutc:YmdHMS} outputs current time in short format."""
        upstream = _make_upstream()
        upstream.start()
        try:
            url = ("/http/127.0.0.1:%d/stream/{lutc:YmdHMS}?playseek=20240101120000-20240101130000") % upstream.port
            http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            path = _get_upstream_path(upstream)
            assert re.match(r"/stream/\d{14}", path), (
                "Expected 14-digit formatted time for {lutc:FORMAT}, got: %s" % path
            )
        finally:
            upstream.stop()

    def test_now_short_format(self, shared_r2h):
        """{now:YmdHMS} outputs current time in short format."""
        upstream = _make_upstream()
        upstream.start()
        try:
            url = ("/http/127.0.0.1:%d/stream/{now:YmdHMS}?playseek=20240101120000-20240101130000") % upstream.port
            http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            path = _get_upstream_path(upstream)
            assert re.match(r"/stream/\d{14}", path), (
                "Expected 14-digit formatted time for {now:FORMAT}, got: %s" % path
            )
        finally:
            upstream.stop()

    def test_timestamp_short_format(self, shared_r2h):
        """{timestamp:YmdHMS} outputs current time in short format."""
        upstream = _make_upstream()
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d/stream/{timestamp:YmdHMS}?playseek=20240101120000-20240101130000"
            ) % upstream.port
            http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            path = _get_upstream_path(upstream)
            assert re.match(r"/stream/\d{14}", path), (
                "Expected 14-digit formatted time for {timestamp:FORMAT}, got: %s" % path
            )
        finally:
            upstream.stop()


@pytest.mark.http_proxy
class TestPlaceholderSyntaxShortBeginEnd:
    """{(b)FORMAT} and {(e)FORMAT} short syntax without $ prefix."""

    def test_brace_be_end_short_format(self, shared_r2h):
        """{(e)YmdHMS} without $ — end time in short format."""
        expected_path = "/stream/20240101130000"
        upstream = _make_upstream(expected_path)
        upstream.start()
        try:
            url = ("/http/127.0.0.1:%d/stream/{(e)YmdHMS}?playseek=20240101120000-20240101130000") % upstream.port
            status, _, _ = http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            assert status == 200
            assert _get_upstream_path(upstream) == expected_path
        finally:
            upstream.stop()

    def test_brace_be_begin_iso8601(self, shared_r2h):
        """{(b)} bare without $ — should output ISO8601."""
        expected_path = "/stream/2024-01-01T12:00:00.000Z"
        upstream = _make_upstream(expected_path)
        upstream.start()
        try:
            url = ("/http/127.0.0.1:%d/stream/{(b)}?playseek=20240101120000-20240101130000") % upstream.port
            status, _, _ = http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            assert status == 200
            assert _get_upstream_path(upstream) == expected_path
        finally:
            upstream.stop()

    def test_brace_be_end_iso8601(self, shared_r2h):
        """{(e)} bare without $ — should output ISO8601."""
        expected_path = "/stream/2024-01-01T13:00:00.000Z"
        upstream = _make_upstream(expected_path)
        upstream.start()
        try:
            url = ("/http/127.0.0.1:%d/stream/{(e)}?playseek=20240101120000-20240101130000") % upstream.port
            status, _, _ = http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            assert status == 200
            assert _get_upstream_path(upstream) == expected_path
        finally:
            upstream.stop()

    def test_brace_be_begin_utc_modifier(self, shared_r2h):
        """{(b)YmdHMS|UTC} without $ — |UTC forces UTC output."""
        expected_path = "/stream/20240101040000"
        upstream = _make_upstream(expected_path)
        upstream.start()
        try:
            url = ("/http/127.0.0.1:%d/stream/{(b)YmdHMS|UTC}?playseek=20240101120000-20240101130000") % upstream.port
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

    def test_brace_be_end_utc_modifier(self, shared_r2h):
        """{(e)YmdHMS|UTC} without $ — |UTC forces UTC for end time."""
        expected_path = "/stream/20240101050000"
        upstream = _make_upstream(expected_path)
        upstream.start()
        try:
            url = ("/http/127.0.0.1:%d/stream/{(e)YmdHMS|UTC}?playseek=20240101120000-20240101130000") % upstream.port
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

    def test_brace_be_begin_timestamp(self, shared_r2h):
        """{(b)timestamp} without $ — begin time as epoch."""
        expected_path = "/stream/%d" % _BEGIN_EPOCH
        upstream = _make_upstream(expected_path)
        upstream.start()
        try:
            url = ("/http/127.0.0.1:%d/stream/{(b)timestamp}?playseek=20240101120000-20240101130000") % upstream.port
            status, _, _ = http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            assert status == 200
            assert _get_upstream_path(upstream) == expected_path
        finally:
            upstream.stop()

    def test_brace_be_end_timestamp(self, shared_r2h):
        """{(e)timestamp} without $ — end time as epoch."""
        expected_path = "/stream/%d" % _END_EPOCH
        upstream = _make_upstream(expected_path)
        upstream.start()
        try:
            url = ("/http/127.0.0.1:%d/stream/{(e)timestamp}?playseek=20240101120000-20240101130000") % upstream.port
            status, _, _ = http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            assert status == 200
            assert _get_upstream_path(upstream) == expected_path
        finally:
            upstream.stop()


# ===================================================================
# Timezone conversion with different seek value formats
# ===================================================================


@pytest.mark.http_proxy
class TestSeekValueFormats:
    """Verify template substitution with different seek value formats."""

    def test_basic_iso8601_seek_value(self, shared_r2h):
        """YYYYMMDDTHHMMSS basic ISO 8601 format as seek value."""
        expected_path = "/path/20240101120000/20240101130000/file.m3u8"
        upstream = _make_upstream(expected_path)
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d"
                "/path/${(b)yyyyMMddHHmmss}/${(e)yyyyMMddHHmmss}/file.m3u8"
                "?playseek=20240101T120000-20240101T130000"
            ) % upstream.port
            status, _, _ = http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            assert status == 200
            assert _get_upstream_path(upstream) == expected_path
        finally:
            upstream.stop()

    def test_basic_iso8601_seek_with_z_suffix(self, shared_r2h):
        """YYYYMMDDTHHMMSSZ basic ISO 8601 with Z timezone."""
        expected_path = "/path/20240101120000/20240101130000/file.m3u8"
        upstream = _make_upstream(expected_path)
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d"
                "/path/${(b)yyyyMMddHHmmss}/${(e)yyyyMMddHHmmss}/file.m3u8"
                "?playseek=20240101T120000Z-20240101T130000Z"
            ) % upstream.port
            status, _, _ = http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            assert status == 200
            assert _get_upstream_path(upstream) == expected_path
        finally:
            upstream.stop()

    def test_iso8601_seek_with_positive_tz_offset(self, shared_r2h):
        """ISO 8601 with +08:00 timezone — should convert to UTC before substitution."""
        # 2024-01-01T20:00:00+08:00 = 2024-01-01T12:00:00Z
        # 2024-01-01T21:00:00+08:00 = 2024-01-01T13:00:00Z
        expected_path = "/path/20240101120000/20240101130000/file.m3u8"
        upstream = _make_upstream(expected_path)
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d"
                "/path/${(b)yyyyMMddHHmmss}/${(e)yyyyMMddHHmmss}/file.m3u8"
                "?playseek=2024-01-01T20:00:00.000%%2B08:00-2024-01-01T21:00:00.000%%2B08:00"
            ) % upstream.port
            status, _, _ = http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            assert status == 200
            assert _get_upstream_path(upstream) == expected_path
        finally:
            upstream.stop()

    def test_iso8601_seek_with_negative_tz_offset(self, shared_r2h):
        """ISO 8601 with -05:00 timezone — should convert to UTC before substitution."""
        # 2024-01-01T07:00:00-05:00 = 2024-01-01T12:00:00Z
        # 2024-01-01T08:00:00-05:00 = 2024-01-01T13:00:00Z
        expected_path = "/path/20240101120000/20240101130000/file.m3u8"
        upstream = _make_upstream(expected_path)
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d"
                "/path/${(b)yyyyMMddHHmmss}/${(e)yyyyMMddHHmmss}/file.m3u8"
                "?playseek=2024-01-01T07:00:00.000-05:00-2024-01-01T08:00:00.000-05:00"
            ) % upstream.port
            status, _, _ = http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            assert status == 200
            assert _get_upstream_path(upstream) == expected_path
        finally:
            upstream.stop()

    def test_basic_iso8601_seek_with_tz_offset(self, shared_r2h):
        """Basic ISO 8601 (YYYYMMDDTHHMMSS+HH:MM) with timezone offset."""
        # 20240101T200000+08:00 = 2024-01-01T12:00:00Z
        # 20240101T210000+08:00 = 2024-01-01T13:00:00Z
        expected_path = "/path/20240101120000/20240101130000/file.m3u8"
        upstream = _make_upstream(expected_path)
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d"
                "/path/${(b)yyyyMMddHHmmss}/${(e)yyyyMMddHHmmss}/file.m3u8"
                "?playseek=20240101T200000%%2B08:00-20240101T210000%%2B08:00"
            ) % upstream.port
            status, _, _ = http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            assert status == 200
            assert _get_upstream_path(upstream) == expected_path
        finally:
            upstream.stop()

    def test_basic_iso8601_seek_in_query_append_mode(self, shared_r2h):
        """Basic ISO 8601 seek value in query-append mode should be converted."""
        expected_path = "/stream/live.m3u8"
        upstream = _make_upstream(expected_path)
        upstream.start()
        try:
            url = ("/http/127.0.0.1:%d/stream/live.m3u8?playseek=20240101T120000-20240101T130000") % upstream.port
            status, _, _ = http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            assert status == 200
            full_path = _get_upstream_path(upstream)
            assert full_path.startswith(expected_path)
            # The playseek param should be converted (basic ISO → basic ISO)
            assert "playseek=20240101T120000-20240101T130000" in full_path
        finally:
            upstream.stop()

    def test_basic_iso8601_with_tz_offset_preserves_bytes_in_query_append(self, shared_r2h):
        """Basic ISO 8601 input with an embedded `±HH:MM` suffix is self-contained;
        the query-append converter must round-trip the bytes verbatim."""
        expected_path = "/stream/live.m3u8"
        upstream = _make_upstream(expected_path)
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d/stream/live.m3u8?playseek=20240101T200000%%2B08:00-20240101T210000%%2B08:00"
            ) % upstream.port
            status, _, _ = http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            assert status == 200
            full_path = _get_upstream_path(upstream)
            assert "playseek=20240101T200000+08:00-20240101T210000+08:00" in full_path, full_path
        finally:
            upstream.stop()

    def test_basic_iso8601_with_tz_offset_and_seek_offset_shifts_clock_in_original_tz(self, shared_r2h):
        """`r2h-seek-offset` against a self-contained `±HH:MM` input shifts the
        clock within the original TZ frame, preserving the suffix."""
        expected_path = "/stream/live.m3u8"
        upstream = _make_upstream(expected_path)
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d/stream/live.m3u8"
                "?playseek=20240101T200000%%2B08:00-20240101T210000%%2B08:00&r2h-seek-offset=3600"
            ) % upstream.port
            status, _, _ = http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            assert status == 200
            full_path = _get_upstream_path(upstream)
            assert "playseek=20240101T210000+08:00-20240101T220000+08:00" in full_path, full_path
        finally:
            upstream.stop()
