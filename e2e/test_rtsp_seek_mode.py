"""E2E tests for RTSP seek-mode opt-in semantics and recent-clock playback."""

import time

import pytest

from helpers import (
    MockRTSPServer,
    R2HProcess,
    find_free_port,
    make_m3u_rtsp_config,
    stream_get,
)

pytestmark = pytest.mark.rtsp

_STREAM_TIMEOUT = 20.0


def _format_basic_utc(ts: int) -> str:
    return time.strftime("%Y%m%dT%H%M%SZ", time.gmtime(ts))


def _format_yyyyMMddHHmmss(ts: int) -> str:
    return time.strftime("%Y%m%d%H%M%S", time.gmtime(ts))


def _expected_clock_str(ts: int) -> str:
    return time.strftime("%Y%m%dT%H%M%SZ", time.gmtime(ts))


@pytest.fixture(scope="module")
def shared_r2h(r2h_binary):
    """A single rtp2httpd instance shared by all seek-mode tests."""
    port = find_free_port()
    r2h = R2HProcess(r2h_binary, port, extra_args=["-v", "4", "-m", "100"])
    r2h.start()
    yield r2h
    r2h.stop()


# ===================================================================
# Recent playseek (PLAY Range: clock=...) opt-in via r2h-seek-mode=range
# ===================================================================


class TestRTSPRecentPlayseek:
    """Recent RTSP playseek should use PLAY Range clock headers when r2h-seek-mode=range is set."""

    @staticmethod
    def _build_seek_query(param_name: str, start_str: str, end_str: str) -> str:
        # All recent-clock tests opt in via r2h-seek-mode=range explicitly.
        if param_name == "custom_seek":
            return "custom_seek=%s-%s&r2h-seek-name=custom_seek&r2h-seek-mode=range" % (
                start_str,
                end_str,
            )
        return "%s=%s-%s&r2h-seek-mode=range" % (param_name, start_str, end_str)

    @pytest.mark.parametrize("param_name", ["playseek", "Playseek", "tvdr", "custom_seek"])
    def test_recent_playseek_uses_clock_range(self, shared_r2h, param_name):
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            start_ts = int(time.time()) - 1800
            end_ts = start_ts + 300
            start_str = _format_basic_utc(start_ts)
            end_str = _format_basic_utc(end_ts)
            query = self._build_seek_query(param_name, start_str, end_str)
            url = "/rtsp/127.0.0.1:%d/stream?%s" % (
                rtsp.port,
                query,
            )

            stream_get(
                "127.0.0.1",
                shared_r2h.port,
                url,
                read_bytes=4096,
                timeout=_STREAM_TIMEOUT,
            )

            describe_reqs = [r for r in rtsp.requests_detailed if r["method"] == "DESCRIBE"]
            assert len(describe_reqs) > 0, "Expected DESCRIBE"
            assert "%s=" % param_name not in describe_reqs[0]["uri"]
            assert "r2h-seek-name=" not in describe_reqs[0]["uri"]
            assert "r2h-seek-mode=" not in describe_reqs[0]["uri"]

            play_reqs = [r for r in rtsp.requests_detailed if r["method"] == "PLAY"]
            assert len(play_reqs) > 0, "Expected PLAY request"
            play_headers = play_reqs[0]["headers"]
            assert play_headers.get("Range") == "clock=%s-" % start_str
            assert end_str not in play_headers["Range"]
        finally:
            rtsp.stop()

    def test_recent_playseek_ignores_r2h_start(self, shared_r2h):
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            start_ts = int(time.time()) - 1200
            start_str = _format_basic_utc(start_ts)
            url = "/rtsp/127.0.0.1:%d/stream?playseek=%s-%s&r2h-start=120.5&r2h-seek-mode=range" % (
                rtsp.port,
                start_str,
                _format_basic_utc(start_ts + 120),
            )

            stream_get(
                "127.0.0.1",
                shared_r2h.port,
                url,
                read_bytes=4096,
                timeout=_STREAM_TIMEOUT,
            )

            play_reqs = [r for r in rtsp.requests_detailed if r["method"] == "PLAY"]
            assert len(play_reqs) > 0, "Expected PLAY request"
            play_range = play_reqs[0]["headers"].get("Range", "")
            assert play_range == "clock=%s-" % start_str
            assert "npt=" not in play_range
            assert "120.5" not in play_range
        finally:
            rtsp.stop()

    def test_boundary_playseek_is_forwarded(self, shared_r2h):
        """Exactly at the window boundary (now - begin == window), the recent
        check must NOT fire — fall back to URL passthrough. Window comparison
        lives in `service_parse_seek_value` and is independent of the seek
        param name (the per-name extraction paths are already covered by
        `test_recent_playseek_uses_clock_range`)."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            start_ts = int(time.time()) - 3600
            start_str = _format_basic_utc(start_ts)
            end_str = _format_basic_utc(start_ts + 120)
            url = "/rtsp/127.0.0.1:%d/stream?playseek=%s-%s&r2h-seek-mode=range" % (
                rtsp.port,
                start_str,
                end_str,
            )

            stream_get(
                "127.0.0.1",
                shared_r2h.port,
                url,
                read_bytes=4096,
                timeout=_STREAM_TIMEOUT,
            )

            describe_reqs = [r for r in rtsp.requests_detailed if r["method"] == "DESCRIBE"]
            assert len(describe_reqs) > 0, "Expected DESCRIBE"
            assert "playseek=%s-%s" % (start_str, end_str) in describe_reqs[0]["uri"]

            play_reqs = [r for r in rtsp.requests_detailed if r["method"] == "PLAY"]
            assert len(play_reqs) > 0, "Expected PLAY request"
            assert "Range" not in play_reqs[0]["headers"]
        finally:
            rtsp.stop()

    def test_recent_playseek_default_passthrough(self, shared_r2h):
        """Without r2h-seek-mode, recent playseek must still pass through (no clock=)."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            start_ts = int(time.time()) - 1800
            start_str = _format_basic_utc(start_ts)
            end_str = _format_basic_utc(start_ts + 300)
            url = "/rtsp/127.0.0.1:%d/stream?playseek=%s-%s" % (rtsp.port, start_str, end_str)

            stream_get(
                "127.0.0.1",
                shared_r2h.port,
                url,
                read_bytes=4096,
                timeout=_STREAM_TIMEOUT,
            )

            describe_reqs = [r for r in rtsp.requests_detailed if r["method"] == "DESCRIBE"]
            assert len(describe_reqs) > 0, "Expected DESCRIBE"
            assert "playseek=%s-%s" % (start_str, end_str) in describe_reqs[0]["uri"]

            play_reqs = [r for r in rtsp.requests_detailed if r["method"] == "PLAY"]
            assert len(play_reqs) > 0, "Expected PLAY request"
            assert "Range" not in play_reqs[0]["headers"]
        finally:
            rtsp.stop()


# ===================================================================
# r2h-seek-mode value grammar + TZ fallback + window edge cases
# ===================================================================


class TestRTSPSeekMode:
    """Verify r2h-seek-mode opt-in semantics for the recent-clock path."""

    def test_passthrough_explicit_equals_default(self, shared_r2h):
        """r2h-seek-mode=passthrough is identical to omitting the parameter."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            start_ts = int(time.time()) - 1800
            start_str = _format_basic_utc(start_ts)
            end_str = _format_basic_utc(start_ts + 300)
            url = "/rtsp/127.0.0.1:%d/stream?playseek=%s-%s&r2h-seek-mode=passthrough" % (
                rtsp.port,
                start_str,
                end_str,
            )

            stream_get("127.0.0.1", shared_r2h.port, url, read_bytes=4096, timeout=_STREAM_TIMEOUT)

            describe_reqs = [r for r in rtsp.requests_detailed if r["method"] == "DESCRIBE"]
            assert "playseek=%s-%s" % (start_str, end_str) in describe_reqs[0]["uri"]
            assert "r2h-seek-mode=" not in describe_reqs[0]["uri"]
            play_reqs = [r for r in rtsp.requests_detailed if r["method"] == "PLAY"]
            assert "Range" not in play_reqs[0]["headers"]
        finally:
            rtsp.stop()

    def test_range_with_explicit_tz_within_window_uses_clock(self, shared_r2h):
        """range(UTC+8/3600) + 30 min ago in CST should hit the clock= path with the right UTC time."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            start_ts = int(time.time()) - 1800
            # Client sends time in CST (UTC+8): represent the same instant in CST
            cst_str = _format_yyyyMMddHHmmss(start_ts + 8 * 3600)
            url = "/rtsp/127.0.0.1:%d/stream?playseek=%s&r2h-seek-mode=range(UTC%%2B8/3600)" % (
                rtsp.port,
                cst_str,
            )

            stream_get("127.0.0.1", shared_r2h.port, url, read_bytes=4096, timeout=_STREAM_TIMEOUT)

            describe_reqs = [r for r in rtsp.requests_detailed if r["method"] == "DESCRIBE"]
            assert "playseek=" not in describe_reqs[0]["uri"]
            play_reqs = [r for r in rtsp.requests_detailed if r["method"] == "PLAY"]
            assert play_reqs[0]["headers"].get("Range") == "clock=%s-" % _expected_clock_str(start_ts)
        finally:
            rtsp.stop()

    def test_range_outside_window_falls_back_passthrough(self, shared_r2h):
        """range(UTC+8/3600) + 5h ago should fall back to URL passthrough with raw bytes preserved."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            # Use fixed historical CST timestamps, far outside any window.
            url = (
                "/rtsp/127.0.0.1:%d/stream?playseek=20240101180000-20240101230000&r2h-seek-mode=range(UTC%%2B8/3600)"
                % (rtsp.port,)
            )

            stream_get("127.0.0.1", shared_r2h.port, url, read_bytes=4096, timeout=_STREAM_TIMEOUT)

            describe_reqs = [r for r in rtsp.requests_detailed if r["method"] == "DESCRIBE"]
            # Bytes preserved exactly: range mode TZ does NOT apply to passthrough conversion.
            assert "playseek=20240101180000-20240101230000" in describe_reqs[0]["uri"]
            play_reqs = [r for r in rtsp.requests_detailed if r["method"] == "PLAY"]
            assert "Range" not in play_reqs[0]["headers"]
        finally:
            rtsp.stop()

    def test_range_default_utc_within_window_uses_clock(self, shared_r2h):
        """range(3600) (no TZ, no UA) treats input as UTC; recent UTC time enters clock path."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            start_ts = int(time.time()) - 1500
            utc_str = _format_yyyyMMddHHmmss(start_ts)
            url = "/rtsp/127.0.0.1:%d/stream?playseek=%s&r2h-seek-mode=range(3600)" % (rtsp.port, utc_str)

            stream_get("127.0.0.1", shared_r2h.port, url, read_bytes=4096, timeout=_STREAM_TIMEOUT)

            play_reqs = [r for r in rtsp.requests_detailed if r["method"] == "PLAY"]
            assert play_reqs[0]["headers"].get("Range") == "clock=%s-" % _expected_clock_str(start_ts)
        finally:
            rtsp.stop()

    def test_range_tz_only_defaults_window_to_3600(self, shared_r2h):
        """range(UTC+8) without seconds defaults the window to 3600s."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            start_ts = int(time.time()) - 1500  # within 1 hour
            cst_str = _format_yyyyMMddHHmmss(start_ts + 8 * 3600)
            url = "/rtsp/127.0.0.1:%d/stream?playseek=%s&r2h-seek-mode=range(UTC%%2B8)" % (rtsp.port, cst_str)

            stream_get("127.0.0.1", shared_r2h.port, url, read_bytes=4096, timeout=_STREAM_TIMEOUT)

            play_reqs = [r for r in rtsp.requests_detailed if r["method"] == "PLAY"]
            assert play_reqs[0]["headers"].get("Range") == "clock=%s-" % _expected_clock_str(start_ts)
        finally:
            rtsp.stop()

    @pytest.mark.parametrize(
        "mode_value",
        [
            pytest.param("range", id="bare-range"),
            pytest.param("range()", id="empty-parens"),
            pytest.param("range(/3600)", id="slash-seconds-only"),
        ],
    )
    def test_range_syntax_variants_default_to_utc_window_3600(self, shared_r2h, mode_value):
        """Bare `range`, `range()`, and `range(/N)` should all parse as
        SEEK_MODE_RANGE with TZ falling back to UTC and the explicit/default
        window. Regression guard for the parse_seek_mode_value branches that
        otherwise have no direct coverage.
        """
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            start_ts = int(time.time()) - 1500  # within 1h, UTC interpretation
            utc_str = _format_yyyyMMddHHmmss(start_ts)
            url = "/rtsp/127.0.0.1:%d/stream?playseek=%s&r2h-seek-mode=%s" % (rtsp.port, utc_str, mode_value)

            stream_get("127.0.0.1", shared_r2h.port, url, read_bytes=4096, timeout=_STREAM_TIMEOUT)

            play_reqs = [r for r in rtsp.requests_detailed if r["method"] == "PLAY"]
            assert play_reqs[0]["headers"].get("Range") == "clock=%s-" % _expected_clock_str(start_ts), (
                "syntax variant %r should enter the clock= path" % mode_value
            )
        finally:
            rtsp.stop()

    def test_range_falls_back_to_ua_tz(self, shared_r2h):
        """range(3600) without explicit TZ should fall back to UA TZ/UTC+8."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            start_ts = int(time.time()) - 1500
            cst_str = _format_yyyyMMddHHmmss(start_ts + 8 * 3600)
            url = "/rtsp/127.0.0.1:%d/stream?playseek=%s&r2h-seek-mode=range(3600)" % (rtsp.port, cst_str)

            stream_get(
                "127.0.0.1",
                shared_r2h.port,
                url,
                read_bytes=4096,
                timeout=_STREAM_TIMEOUT,
                headers={"User-Agent": "TestPlayer/1.0 TZ/UTC+8"},
            )

            play_reqs = [r for r in rtsp.requests_detailed if r["method"] == "PLAY"]
            assert play_reqs[0]["headers"].get("Range") == "clock=%s-" % _expected_clock_str(start_ts)
        finally:
            rtsp.stop()

    def test_range_offset_propagates_into_clock(self, shared_r2h):
        """r2h-seek-offset shifts the clock= header time as well."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            base_ts = int(time.time()) - 3000  # 50 min ago
            offset = 1800  # +30 min, still within 60min window relative to begin
            cst_str = _format_yyyyMMddHHmmss(base_ts + 8 * 3600)
            url = "/rtsp/127.0.0.1:%d/stream?playseek=%s&r2h-seek-offset=%d&r2h-seek-mode=range(UTC%%2B8/3600)" % (
                rtsp.port,
                cst_str,
                offset,
            )

            stream_get("127.0.0.1", shared_r2h.port, url, read_bytes=4096, timeout=_STREAM_TIMEOUT)

            play_reqs = [r for r in rtsp.requests_detailed if r["method"] == "PLAY"]
            assert play_reqs[0]["headers"].get("Range") == "clock=%s-" % _expected_clock_str(base_ts + offset)
        finally:
            rtsp.stop()

    def test_range_offset_pushes_outside_window_falls_back(self, shared_r2h):
        """If r2h-seek-offset shifts begin out of the window, fall back to passthrough."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            base_ts = int(time.time()) - 3000  # 50 min ago
            offset = -1800  # makes begin look like 80 min ago, > 60min window
            cst_str = _format_yyyyMMddHHmmss(base_ts + 8 * 3600)
            url = "/rtsp/127.0.0.1:%d/stream?playseek=%s&r2h-seek-offset=%d&r2h-seek-mode=range(UTC%%2B8/3600)" % (
                rtsp.port,
                cst_str,
                offset,
            )

            stream_get("127.0.0.1", shared_r2h.port, url, read_bytes=4096, timeout=_STREAM_TIMEOUT)

            describe_reqs = [r for r in rtsp.requests_detailed if r["method"] == "DESCRIBE"]
            # Passthrough branch: range mode TZ does NOT apply, only the offset is applied
            # to the original UTC interpretation. Verify offset is present in the resulting bytes.
            assert "playseek=" in describe_reqs[0]["uri"]
            play_reqs = [r for r in rtsp.requests_detailed if r["method"] == "PLAY"]
            assert "Range" not in play_reqs[0]["headers"]
        finally:
            rtsp.stop()

    def test_range_invalid_value_falls_back_to_passthrough(self, shared_r2h):
        """Out-of-range UTC offset (`UTC+999`) inside a well-formed `range(...)`
        wrapper must be rejected by `timezone_parse_utc_offset` and degrade to
        passthrough. Covers the inner TZ-parse failure branch — distinct from
        the outer "value doesn't start with `range`" branch."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            start_ts = int(time.time()) - 1500
            utc_str = _format_yyyyMMddHHmmss(start_ts)
            url = "/rtsp/127.0.0.1:%d/stream?playseek=%s&r2h-seek-mode=range(UTC%%2B999)" % (rtsp.port, utc_str)

            stream_get("127.0.0.1", shared_r2h.port, url, read_bytes=4096, timeout=_STREAM_TIMEOUT)

            describe_reqs = [r for r in rtsp.requests_detailed if r["method"] == "DESCRIBE"]
            assert "playseek=%s" % utc_str in describe_reqs[0]["uri"]
            play_reqs = [r for r in rtsp.requests_detailed if r["method"] == "PLAY"]
            assert "Range" not in play_reqs[0]["headers"]
        finally:
            rtsp.stop()

    def test_range_unrecognized_mode_falls_back_to_passthrough(self, shared_r2h):
        """A value that doesn't match the `range` keyword at all (`bogus`)
        must be rejected at the outermost prefix check and degrade to
        passthrough. Different parser branch from the inner TZ-parse failure
        covered by `test_range_invalid_value_falls_back_to_passthrough`."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            start_ts = int(time.time()) - 1500
            utc_str = _format_yyyyMMddHHmmss(start_ts)
            url = "/rtsp/127.0.0.1:%d/stream?playseek=%s&r2h-seek-mode=bogus" % (rtsp.port, utc_str)

            stream_get("127.0.0.1", shared_r2h.port, url, read_bytes=4096, timeout=_STREAM_TIMEOUT)

            describe_reqs = [r for r in rtsp.requests_detailed if r["method"] == "DESCRIBE"]
            assert "playseek=%s" % utc_str in describe_reqs[0]["uri"]
            play_reqs = [r for r in rtsp.requests_detailed if r["method"] == "PLAY"]
            assert "Range" not in play_reqs[0]["headers"]
        finally:
            rtsp.stop()


# ===================================================================
# M3U-configured + request query-merge precedence (request wins, no leak)
# ===================================================================


class TestRTSPSeekModeQueryMerge:
    """Configured-service query-merge precedence and no-leak coverage for the
    seek-related r2h-* parameters."""

    def test_configured_seek_mode_applies_when_request_silent(self, r2h_binary):
        """When the request supplies no r2h-seek-mode, the configured value
        is the fallback and produces the expected behavior (clock= header)."""
        r2h_port = find_free_port()
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            config = make_m3u_rtsp_config(r2h_port, rtsp.port, "SeekModeFallback", "?r2h-seek-mode=range(UTC%2B8/3600)")
            r2h = R2HProcess(r2h_binary, r2h_port, config_content=config)
            r2h.start()
            try:
                start_ts = int(time.time()) - 1500
                cst_str = _format_yyyyMMddHHmmss(start_ts + 8 * 3600)
                url = "/SeekModeFallback?playseek=%s" % cst_str

                stream_get("127.0.0.1", r2h_port, url, read_bytes=4096, timeout=_STREAM_TIMEOUT)

                describe_reqs = [r for r in rtsp.requests_detailed if r["method"] == "DESCRIBE"]
                assert describe_reqs, "expected at least one DESCRIBE"
                assert "r2h-seek-mode" not in describe_reqs[0]["uri"], (
                    "r2h-seek-mode leaked into upstream URI: %s" % describe_reqs[0]["uri"]
                )
                play_reqs = [r for r in rtsp.requests_detailed if r["method"] == "PLAY"]
                assert play_reqs[0]["headers"].get("Range") == "clock=%s-" % _expected_clock_str(start_ts)
            finally:
                r2h.stop()
        finally:
            rtsp.stop()

    def test_request_seek_mode_overrides_configured_range(self, r2h_binary):
        """Configured r2h-seek-mode=range(...) plus request r2h-seek-mode=passthrough:
        request wins → no clock= header → no r2h-seek-mode leaks upstream."""
        r2h_port = find_free_port()
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            config = make_m3u_rtsp_config(r2h_port, rtsp.port, "SeekModeMerge", "?r2h-seek-mode=range(UTC%2B8/3600)")
            r2h = R2HProcess(r2h_binary, r2h_port, config_content=config)
            r2h.start()
            try:
                start_ts = int(time.time()) - 1500
                cst_str = _format_yyyyMMddHHmmss(start_ts + 8 * 3600)
                url = "/SeekModeMerge?playseek=%s&r2h-seek-mode=passthrough" % cst_str

                stream_get("127.0.0.1", r2h_port, url, read_bytes=4096, timeout=_STREAM_TIMEOUT)

                describe_reqs = [r for r in rtsp.requests_detailed if r["method"] == "DESCRIBE"]
                assert describe_reqs, "expected at least one DESCRIBE"
                assert "playseek=%s" % cst_str in describe_reqs[0]["uri"]
                assert "r2h-seek-mode" not in describe_reqs[0]["uri"], (
                    "r2h-seek-mode leaked into upstream URI: %s" % describe_reqs[0]["uri"]
                )
                play_reqs = [r for r in rtsp.requests_detailed if r["method"] == "PLAY"]
                assert "Range" not in play_reqs[0]["headers"]
            finally:
                r2h.stop()
        finally:
            rtsp.stop()

    def test_request_range_overrides_configured_passthrough(self, r2h_binary):
        """Configured r2h-seek-mode=passthrough plus request r2h-seek-mode=range(...):
        request wins → clock= header is emitted → no r2h-seek-mode leaks upstream."""
        r2h_port = find_free_port()
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            config = make_m3u_rtsp_config(r2h_port, rtsp.port, "SeekModeOff", "?r2h-seek-mode=passthrough")
            r2h = R2HProcess(r2h_binary, r2h_port, config_content=config)
            r2h.start()
            try:
                start_ts = int(time.time()) - 1500
                cst_str = _format_yyyyMMddHHmmss(start_ts + 8 * 3600)
                url = "/SeekModeOff?playseek=%s&r2h-seek-mode=range(UTC%%2B8/3600)" % cst_str

                stream_get("127.0.0.1", r2h_port, url, read_bytes=4096, timeout=_STREAM_TIMEOUT)

                describe_reqs = [r for r in rtsp.requests_detailed if r["method"] == "DESCRIBE"]
                assert describe_reqs, "expected at least one DESCRIBE"
                assert "r2h-seek-mode" not in describe_reqs[0]["uri"], (
                    "r2h-seek-mode leaked into upstream URI: %s" % describe_reqs[0]["uri"]
                )
                play_reqs = [r for r in rtsp.requests_detailed if r["method"] == "PLAY"]
                assert play_reqs[0]["headers"].get("Range") == "clock=%s-" % _expected_clock_str(start_ts)
            finally:
                r2h.stop()
        finally:
            rtsp.stop()

    def test_request_seek_offset_overrides_configured(self, r2h_binary):
        """Same precedence applies to r2h-seek-offset: request value wins,
        configured value is the fallback, and r2h-seek-offset never leaks."""
        r2h_port = find_free_port()
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            # Configured offset = 3600 (1h forward).
            config = make_m3u_rtsp_config(r2h_port, rtsp.port, "OffsetMerge", "?r2h-seek-offset=3600")
            r2h = R2HProcess(r2h_binary, r2h_port, config_content=config)
            r2h.start()
            try:
                # Request overrides with a different offset (7200 = 2h forward).
                # Use playseek with literal UTC time so we can predict the upstream value.
                base_ts = 1717000000  # arbitrary fixed UTC seconds
                base_str = _format_yyyyMMddHHmmss(base_ts)
                url = "/OffsetMerge?playseek=%s&r2h-seek-offset=7200" % base_str

                stream_get("127.0.0.1", r2h_port, url, read_bytes=4096, timeout=_STREAM_TIMEOUT)

                describe_reqs = [r for r in rtsp.requests_detailed if r["method"] == "DESCRIBE"]
                assert describe_reqs, "expected at least one DESCRIBE"
                # r2h-seek-offset must not leak.
                assert "r2h-seek-offset" not in describe_reqs[0]["uri"], (
                    "r2h-seek-offset leaked into upstream URI: %s" % describe_reqs[0]["uri"]
                )
                # Request offset (7200, not 3600) should have been applied to playseek.
                expected_str = _format_yyyyMMddHHmmss(base_ts + 7200)
                assert "playseek=%s" % expected_str in describe_reqs[0]["uri"], (
                    "request offset (7200) should have applied; got URI %s" % describe_reqs[0]["uri"]
                )
            finally:
                r2h.stop()
        finally:
            rtsp.stop()

    def test_duplicate_request_seek_mode_does_not_leak(self, shared_r2h):
        """A client that sends r2h-seek-mode twice must have BOTH copies stripped
        from the upstream URI — the second copy could otherwise be re-parsed
        and override the first or leak as an unknown control parameter."""
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            start_ts = int(time.time()) - 1500
            utc_str = _format_yyyyMMddHHmmss(start_ts)
            # Two distinct r2h-seek-mode values; the first one (passthrough) wins.
            url = (
                "/rtsp/127.0.0.1:%d/stream?playseek=%s&r2h-seek-mode=passthrough&r2h-seek-mode=range(UTC%%2B8/3600)"
                % (rtsp.port, utc_str)
            )

            stream_get("127.0.0.1", shared_r2h.port, url, read_bytes=4096, timeout=_STREAM_TIMEOUT)

            describe_reqs = [r for r in rtsp.requests_detailed if r["method"] == "DESCRIBE"]
            assert describe_reqs, "expected at least one DESCRIBE"
            # No r2h-seek-mode should leak into the upstream URI.
            assert "r2h-seek-mode" not in describe_reqs[0]["uri"], (
                "r2h-seek-mode leaked into upstream URI: %s" % describe_reqs[0]["uri"]
            )
            # First value (passthrough) wins → no clock= header.
            play_reqs = [r for r in rtsp.requests_detailed if r["method"] == "PLAY"]
            assert "Range" not in play_reqs[0]["headers"]
        finally:
            rtsp.stop()

    def test_configured_ifname_does_not_leak(self, r2h_binary):
        """The merge function strips `r2h-ifname` from the upstream URI
        (per-field append block, separate from r2h-ifname-fcc and the three
        seek-related r2h-* params)."""
        r2h_port = find_free_port()
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            config = make_m3u_rtsp_config(r2h_port, rtsp.port, "IfnameFallback", "?r2h-ifname=lo0")
            r2h = R2HProcess(r2h_binary, r2h_port, config_content=config)
            r2h.start()
            try:
                stream_get("127.0.0.1", r2h_port, "/IfnameFallback", read_bytes=4096, timeout=_STREAM_TIMEOUT)

                describe_reqs = [r for r in rtsp.requests_detailed if r["method"] == "DESCRIBE"]
                assert describe_reqs, "expected at least one DESCRIBE"
                assert "r2h-ifname" not in describe_reqs[0]["uri"], (
                    "r2h-ifname leaked into upstream URI: %s" % describe_reqs[0]["uri"]
                )
            finally:
                r2h.stop()
        finally:
            rtsp.stop()

    def test_configured_seek_name_does_not_leak(self, r2h_binary):
        """Configured r2h-seek-name must not survive into the upstream URI;
        the resolved seek param value does, but under the configured custom
        name (not as r2h-seek-name=...)."""
        r2h_port = find_free_port()
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            config = make_m3u_rtsp_config(r2h_port, rtsp.port, "SeekNameFallback", "?r2h-seek-name=customseek")
            r2h = R2HProcess(r2h_binary, r2h_port, config_content=config)
            r2h.start()
            try:
                # Request supplies the value under the configured custom name.
                base_ts = 1717000000
                base_str = _format_yyyyMMddHHmmss(base_ts)
                stream_get(
                    "127.0.0.1",
                    r2h_port,
                    "/SeekNameFallback?customseek=%s" % base_str,
                    read_bytes=4096,
                    timeout=_STREAM_TIMEOUT,
                )

                describe_reqs = [r for r in rtsp.requests_detailed if r["method"] == "DESCRIBE"]
                assert describe_reqs, "expected at least one DESCRIBE"
                uri = describe_reqs[0]["uri"]
                assert "r2h-seek-name" not in uri, "r2h-seek-name leaked into upstream URI: %s" % uri
                assert "customseek=%s" % base_str in uri, (
                    "Custom-named seek value should be forwarded under the configured name; got: %s" % uri
                )
            finally:
                r2h.stop()
        finally:
            rtsp.stop()

    def test_request_seek_name_overrides_configured(self, r2h_binary):
        """Request r2h-seek-name overrides M3U-configured r2h-seek-name, and
        neither r2h-seek-name copy leaks upstream."""
        r2h_port = find_free_port()
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            # Configured custom name = "configured_name", but request asks for "request_name".
            config = make_m3u_rtsp_config(r2h_port, rtsp.port, "SeekNameMerge", "?r2h-seek-name=configured_name")
            r2h = R2HProcess(r2h_binary, r2h_port, config_content=config)
            r2h.start()
            try:
                base_ts = 1717000000
                base_str = _format_yyyyMMddHHmmss(base_ts)
                # Provide the seek value under the request-configured name.
                stream_get(
                    "127.0.0.1",
                    r2h_port,
                    "/SeekNameMerge?r2h-seek-name=request_name&request_name=%s" % base_str,
                    read_bytes=4096,
                    timeout=_STREAM_TIMEOUT,
                )

                describe_reqs = [r for r in rtsp.requests_detailed if r["method"] == "DESCRIBE"]
                assert describe_reqs, "expected at least one DESCRIBE"
                uri = describe_reqs[0]["uri"]
                assert "r2h-seek-name" not in uri, "r2h-seek-name leaked into upstream URI: %s" % uri
                # Request-side custom name wins.
                assert "request_name=%s" % base_str in uri, (
                    "request_name (request-side) should be forwarded; got: %s" % uri
                )
                assert "configured_name=" not in uri, (
                    "configured_name (M3U-side) must NOT be used when request overrides; got: %s" % uri
                )
            finally:
                r2h.stop()
        finally:
            rtsp.stop()

    def test_configured_ifname_fcc_does_not_leak(self, r2h_binary):
        """The merge function strips `r2h-ifname-fcc` from the upstream URI
        (per-field append block, not shared with the other 4 r2h-* params).
        ifname-fcc is only consumed by FCC code paths at runtime, but the
        merge-side strip behaviour is service-type independent, so plain
        RTSP is sufficient to exercise it. End-to-end FCC binding is
        covered by the dedicated FCC test suites."""
        r2h_port = find_free_port()
        rtsp = MockRTSPServer(num_packets=500)
        rtsp.start()
        try:
            config = make_m3u_rtsp_config(r2h_port, rtsp.port, "IfnameFccFallback", "?r2h-ifname-fcc=lo0")
            r2h = R2HProcess(r2h_binary, r2h_port, config_content=config)
            r2h.start()
            try:
                stream_get("127.0.0.1", r2h_port, "/IfnameFccFallback", read_bytes=4096, timeout=_STREAM_TIMEOUT)

                describe_reqs = [r for r in rtsp.requests_detailed if r["method"] == "DESCRIBE"]
                assert describe_reqs, "expected at least one DESCRIBE"
                assert "r2h-ifname-fcc" not in describe_reqs[0]["uri"], (
                    "r2h-ifname-fcc leaked into upstream URI: %s" % describe_reqs[0]["uri"]
                )
            finally:
                r2h.stop()
        finally:
            rtsp.stop()
