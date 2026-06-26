"""
E2E tests for HTTP resolver-layer time and seek URL template handling.
"""

import re
import time

import pytest

from helpers import (
    MockHTTPUpstream,
    R2HProcess,
    find_free_port,
    get_upstream_path as _get_upstream_path,
    http_get,
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
    """A single rtp2httpd instance shared by URL template tests."""
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


def _extract_query_param(path, param_name):
    """Extract a query parameter value from a path or URI."""
    match = re.search(r"[?&]%s=([^&]+)" % re.escape(param_name), path)
    assert match, "Expected %s= in path, got: %s" % (param_name, path)
    return match.group(1)


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

    def test_seek_offset_pair_applied(self, shared_r2h):
        """r2h-seek-offset=a,b should shift template begin and end independently."""
        # begin + 30s = 12:00:30, end - 60s = 12:59:00
        expected_path = "/path/20240101120030/20240101125900/file.m3u8"
        upstream = _make_upstream(expected_path)
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d"
                "/path/${(b)yyyyMMddHHmmss}/${(e)yyyyMMddHHmmss}/file.m3u8"
                "?playseek=20240101120000-20240101130000&r2h-seek-offset=30,-60"
            ) % upstream.port
            status, _, _ = http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            assert status == 200
            assert _get_upstream_path(upstream) == expected_path
        finally:
            upstream.stop()

    def test_seek_offset_pair_begin_only_template(self, shared_r2h):
        """When seek has no end time, r2h-seek-offset=a,b should use only begin offset."""
        expected_path = "/path/20240101120030/file.m3u8"
        upstream = _make_upstream(expected_path)
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d/path/${(b)yyyyMMddHHmmss}/file.m3u8?playseek=20240101120000&r2h-seek-offset=30,-60"
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

    def test_seek_offset_pair_with_unix_timestamp_seek(self, shared_r2h):
        """r2h-seek-offset=a,b should shift Unix timestamp begin/end independently."""
        expected_path = "/path/20240101120030/20240101125900/file"
        upstream = _make_upstream(expected_path)
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d"
                "/path/${(b)yyyyMMddHHmmss}/${(e)yyyyMMddHHmmss}/file"
                "?playseek=%d-%d&r2h-seek-offset=30,-60"
            ) % (upstream.port, _BEGIN_EPOCH, _END_EPOCH)
            status, _, _ = http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)
            assert status == 200
            assert _get_upstream_path(upstream) == expected_path
        finally:
            upstream.stop()


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

    def test_offset_pair(self, shared_r2h):
        """r2h-seek-offset=a,b should add separate begin/end offsets."""
        upstream = _make_upstream("/stream")
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d/stream?playseek=20240101120000-20240101130000&r2h-seek-offset=30,-60"
            ) % upstream.port
            http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)

            path = _get_upstream_path(upstream)
            assert _extract_query_param(path, "playseek") == "20240101120030-20240101125900"
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

    def test_overflow_offset_rejected(self, shared_r2h):
        """Overflowing r2h-seek-offset should be ignored."""
        upstream = _make_upstream("/stream")
        upstream.start()
        try:
            url = (
                "/http/127.0.0.1:%d/stream?playseek=20240101120000-20240101130000"
                "&r2h-seek-offset=999999999999999999999999999999"
            ) % upstream.port
            http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)

            path = _get_upstream_path(upstream)
            assert _extract_query_param(path, "playseek") == "20240101120000-20240101130000"
            assert "r2h-seek-offset" not in path, "r2h-seek-offset should be stripped, got: %s" % path
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

    def test_offset_pair_with_unix_timestamp(self, shared_r2h):
        """r2h-seek-offset=a,b should preserve Unix timestamp output format."""
        upstream = _make_upstream("/stream")
        upstream.start()
        try:
            url = ("/http/127.0.0.1:%d/stream?playseek=1704096000-1704099600&r2h-seek-offset=30,-60") % upstream.port
            http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT)

            path = _get_upstream_path(upstream)
            assert _extract_query_param(path, "playseek") == "1704096030-1704099540"
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
