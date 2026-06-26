"""
E2E tests for URL template placeholder syntax variants.
"""

import re

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
_DEFAULT_PLAYSEEK = "20240101120000-20240101130000"
_TZ_PLUS_8_HEADERS = {"User-Agent": "TestPlayer/1.0 TZ/UTC+8"}


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


def _assert_template_path(shared_r2h, path_template, expected_path, playseek=_DEFAULT_PLAYSEEK, headers=None):
    """Assert a proxied template path resolves to the expected upstream path."""
    upstream = _make_upstream(expected_path)
    upstream.start()
    try:
        url = ("/http/127.0.0.1:%d%s?playseek=%s") % (upstream.port, path_template, playseek)
        status, _, _ = http_get("127.0.0.1", shared_r2h.port, url, timeout=_TIMEOUT, headers=headers)
        assert status == 200
        assert _get_upstream_path(upstream) == expected_path
    finally:
        upstream.stop()


@pytest.mark.http_proxy
class TestPlaceholderSyntaxBeginTime:
    """Alternative placeholder syntaxes for begin time substitution."""

    @pytest.mark.parametrize(
        "path_template, expected_path",
        [
            pytest.param("/stream/${utc}", "/stream/2024-01-01T12:00:00.000Z", id="dollar-utc"),
            pytest.param("/stream/${utc:yyyyMMddHHmmss}", "/stream/20240101120000", id="dollar-utc-format"),
            pytest.param("/stream/{(b)YmdHMS}", "/stream/20240101120000", id="brace-b-short-format"),
            pytest.param("/stream/${(b)}", "/stream/2024-01-01T12:00:00.000Z", id="dollar-b-bare"),
            pytest.param("/stream/{utc:YmdHMS}", "/stream/20240101120000", id="brace-utc-short-format"),
        ],
    )
    def test_begin_time_syntax(self, shared_r2h, path_template, expected_path):
        """Begin-time placeholder syntaxes should resolve to the expected path."""
        _assert_template_path(shared_r2h, path_template, expected_path)


@pytest.mark.http_proxy
class TestPlaceholderSyntaxEndTime:
    """Alternative placeholder syntaxes for end time substitution."""

    @pytest.mark.parametrize(
        "path_template, expected_path",
        [
            pytest.param("/stream/{utcend}", "/stream/2024-01-01T13:00:00.000Z", id="utcend"),
            pytest.param("/stream/{utcend:YmdHMS}", "/stream/20240101130000", id="utcend-short-format"),
        ],
    )
    def test_end_time_syntax(self, shared_r2h, path_template, expected_path):
        """End-time placeholder syntaxes should resolve to the expected path."""
        _assert_template_path(shared_r2h, path_template, expected_path)


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

    @pytest.mark.parametrize(
        "path_template, expected_path",
        [
            pytest.param(
                "/stream/${yyyy}/${MM}/${dd}/${HH}/${mm}/${ss}",
                "/stream/2024/01/01/12/00/00",
                id="components",
            ),
            pytest.param("/stream/${duration}", "/stream/3600", id="duration"),
        ],
    )
    def test_component_and_duration_syntax(self, shared_r2h, path_template, expected_path):
        """Component and duration placeholders should resolve to the expected path."""
        _assert_template_path(shared_r2h, path_template, expected_path)


@pytest.mark.http_proxy
class TestPlaceholderSyntaxModifiers:
    """Placeholder modifiers like |UTC."""

    @pytest.mark.parametrize(
        "path_template, expected_path",
        [
            pytest.param("/stream/${(b)yyyyMMddHHmmss|UTC}", "/stream/20240101040000", id="begin-utc"),
            pytest.param("/stream/${(e)yyyyMMddHHmmss|UTC}", "/stream/20240101050000", id="end-utc"),
        ],
    )
    def test_pipe_utc_modifier(self, shared_r2h, path_template, expected_path):
        """The |UTC modifier should force UTC output even with a timezone header."""
        _assert_template_path(shared_r2h, path_template, expected_path, headers=_TZ_PLUS_8_HEADERS)


@pytest.mark.http_proxy
class TestPlaceholderSyntaxLongKeywords:
    """${keyword} long syntax for keywords only tested in {} short syntax so far."""

    @pytest.mark.parametrize(
        "path_template, expected_path",
        [
            pytest.param("/stream/${utcend}", "/stream/2024-01-01T13:00:00.000Z", id="utcend"),
            pytest.param("/stream/${start}", "/stream/2024-01-01T12:00:00.000Z", id="start"),
            pytest.param("/stream/${end}", "/stream/2024-01-01T13:00:00.000Z", id="end"),
            pytest.param("/stream/${(e)timestamp}", "/stream/%d" % _END_EPOCH, id="end-timestamp"),
        ],
    )
    def test_deterministic_long_keyword_syntax(self, shared_r2h, path_template, expected_path):
        """Long keyword syntaxes with fixed seek inputs should resolve to the expected path."""
        _assert_template_path(shared_r2h, path_template, expected_path)

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


@pytest.mark.http_proxy
class TestPlaceholderSyntaxKeywordFormats:
    """Keyword:FORMAT variants for all keywords."""

    @pytest.mark.parametrize(
        "path_template, expected_path",
        [
            pytest.param("/stream/${utcend:yyyyMMddHHmmss}", "/stream/20240101130000", id="utcend-long"),
            pytest.param("/stream/${start:yyyyMMddHHmmss}", "/stream/20240101120000", id="start-long"),
            pytest.param("/stream/${end:yyyyMMddHHmmss}", "/stream/20240101130000", id="end-long"),
            pytest.param("/stream/{end:YmdHMS}", "/stream/20240101130000", id="end-short"),
            pytest.param("/stream/{start:YmdHMS}", "/stream/20240101120000", id="start-short"),
        ],
    )
    def test_deterministic_keyword_format_syntax(self, shared_r2h, path_template, expected_path):
        """Keyword format variants with fixed seek inputs should resolve to the expected path."""
        _assert_template_path(shared_r2h, path_template, expected_path)

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

    @pytest.mark.parametrize(
        "path_template, expected_path, headers",
        [
            pytest.param("/stream/{(e)YmdHMS}", "/stream/20240101130000", None, id="end-short-format"),
            pytest.param("/stream/{(b)}", "/stream/2024-01-01T12:00:00.000Z", None, id="begin-bare"),
            pytest.param("/stream/{(e)}", "/stream/2024-01-01T13:00:00.000Z", None, id="end-bare"),
            pytest.param(
                "/stream/{(b)YmdHMS|UTC}",
                "/stream/20240101040000",
                _TZ_PLUS_8_HEADERS,
                id="begin-utc-modifier",
            ),
            pytest.param(
                "/stream/{(e)YmdHMS|UTC}",
                "/stream/20240101050000",
                _TZ_PLUS_8_HEADERS,
                id="end-utc-modifier",
            ),
            pytest.param("/stream/{(b)timestamp}", "/stream/%d" % _BEGIN_EPOCH, None, id="begin-timestamp"),
            pytest.param("/stream/{(e)timestamp}", "/stream/%d" % _END_EPOCH, None, id="end-timestamp"),
        ],
    )
    def test_short_begin_end_syntax(self, shared_r2h, path_template, expected_path, headers):
        """Short begin/end syntax variants should resolve to the expected path."""
        _assert_template_path(shared_r2h, path_template, expected_path, headers=headers)


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
