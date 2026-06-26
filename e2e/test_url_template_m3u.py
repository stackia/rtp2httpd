"""
E2E tests for M3U catchup-source template rewrite and consumption.
"""

import re

import pytest

from helpers import (
    MockHTTPUpstream,
    R2HProcess,
    build_config,
    extract_catchup_source,
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


def _absolute_url_to_path(url):
    """Convert an absolute proxy URL back into an HTTP path for local requests."""
    match = re.match(r"https?://[^/]+(/.*)$", url)
    assert match, "Expected absolute HTTP URL, got: %s" % url
    return match.group(1)


@pytest.fixture(scope="module")
def catchup_rewrite_playlist(r2h_binary):
    """Playlist generated from all catchup rewrite cases with one rtp2httpd process."""
    port = find_free_port()
    services = """\
#EXTM3U
#EXTINF:-1 catchup="default" catchup-source="http://10.10.10.1:8888/path/${(b)yyyyMMddHHmmss}/${(e)yyyyMMddHHmmss}/1.m3u8",Template Channel
rtp://239.0.0.1:1234
#EXTINF:-1 catchup="default" catchup-source="rtsp://10.0.0.50:554/playback?seek={utc:YmdHMS}-{utcend:YmdHMS}",Query Template Ch
rtp://239.0.0.1:1234
#EXTINF:-1 catchup="default" catchup-source="rtsp://10.0.0.50:554/playback?tvdr=${(b)yyyyMMddHHmmss}GMT-${(e)yyyyMMddHHmmss}GMT&r2h-seek-offset=-28800",TVDR Template Ch
rtp://239.0.0.1:1234
#EXTINF:-1 catchup="default" catchup-source="rtsp://10.0.0.50:554/playback?customseek={utc:YmdHMS}-{utcend:YmdHMS}&r2h-seek-name=customseek",Custom Seek Template Ch
rtp://239.0.0.1:1234
#EXTINF:-1 catchup="default" catchup-source="http://10.10.10.1:8888/playback/cctv-1/stream.m3u8",Plain Channel
rtp://239.0.0.1:1234
#EXTINF:-1 catchup="default" catchup-source="http://10.10.10.1:8888/cctv/${(b)yyyyMMdd}/${(e)HHmmss}/stream.ts",Dollar Brace Ch
rtp://239.0.0.1:1234
#EXTINF:-1 catchup="default" catchup-source="http://10.10.10.1:8888/path/${(b)yyyyMMdd}/${(b)HHmmss}/${(e)yyyyMMdd}/${(e)HHmmss}/1.m3u8",Canonical Channel
rtp://239.0.0.1:1234
#EXTINF:-1 catchup="default" catchup-source="http://10.10.10.1:8888/path/${(b)yyyyMMddHHmmss}/1.m3u8?token=1&begin={utc}",Mixed Channel
rtp://239.0.0.1:1234
#EXTINF:-1,Main Query Template Ch
http://10.10.10.1:8888/live/stream.m3u8?token=1&begin={utc}
#EXTINF:-1 catchup="append" catchup-source="?playseek={utc}-{utcend}&duration={duration}",Placeholder Ch
http://10.10.10.1:8888/live/stream.m3u8
#EXTINF:-1 catchup="append" catchup-source="?starttime=${(b)yyyyMMdd|UTC}T${(b)HHmmss|UTC}&endtime=${(e)yyyyMMdd|UTC}T${(e)HHmmss|UTC}&r2h-seek-offset=3600",Append Offset Ch
http://10.10.10.1:8888/live/stream.m3u8
#EXTINF:-1 catchup="append" catchup-source="starttime=${(b)yyyyMMdd|UTC}T${(b)HHmmss|UTC}&endtime=${(e)yyyyMMdd|UTC}T${(e)HHmmss|UTC}&r2h-seek-offset=3600",Append No Prefix Ch
http://10.10.10.1:8888/live/stream.m3u8
"""
    config = build_config(port, global_lines=["maxclients = 10"], services_content=services)
    r2h = R2HProcess(r2h_binary, port, config_content=config)
    try:
        r2h.start()
        status, _, body = http_get("127.0.0.1", port, "/playlist.m3u")
        assert status == 200
        yield body.decode()
    finally:
        r2h.stop()


class TestM3UCatchupRewrite:
    """Verify /playlist.m3u rewrite output for catchup-source templates."""

    def test_path_template_gets_playseek_injected(self, catchup_rewrite_playlist):
        """Catchup-source with path templates should preserve original placeholders in playseek."""
        text = catchup_rewrite_playlist
        assert "Template Channel" in text
        assert "playseek=${(b)yyyyMMddHHmmss}-${(e)yyyyMMddHHmmss}" in text, (
            "Path template catchup-source should keep original placeholder format, got:\n%s" % text
        )

    def test_query_only_templates_become_playseek_carrier(self, catchup_rewrite_playlist):
        """Query-only catchup templates should be folded into a playseek carrier."""
        _, catchup_source = extract_catchup_source(catchup_rewrite_playlist, "Query Template Ch")
        assert "playseek={utc:YmdHMS}-{utcend:YmdHMS}" in catchup_source, (
            "Expected query templates to become playseek carrier, got: %s" % catchup_source
        )

    def test_query_only_tvdr_range_preserves_seek_param_name(self, catchup_rewrite_playlist):
        """A tvdr range template should keep tvdr as the playlist seek carrier."""
        _, catchup_source = extract_catchup_source(catchup_rewrite_playlist, "TVDR Template Ch")
        assert "tvdr=${(b)yyyyMMddHHmmss}GMT-${(e)yyyyMMddHHmmss}GMT" in catchup_source, (
            "Expected tvdr range to stay under tvdr, got: %s" % catchup_source
        )
        assert "playseek=" not in catchup_source

    def test_query_only_explicit_seek_name_preserves_param_name(self, catchup_rewrite_playlist):
        """A configured custom seek name should be preserved as the playlist seek carrier."""
        _, catchup_source = extract_catchup_source(catchup_rewrite_playlist, "Custom Seek Template Ch")
        assert "customseek={utc:YmdHMS}-{utcend:YmdHMS}" in catchup_source, (
            "Expected explicit seek name to stay under customseek, got: %s" % catchup_source
        )
        assert "playseek=" not in catchup_source

    def test_no_template_no_injection(self, catchup_rewrite_playlist):
        """Catchup-source without any templates should not get playseek injected."""
        line, catchup_source = extract_catchup_source(catchup_rewrite_playlist, "Plain Channel")
        assert "playseek={utc}" not in line, "No-template catchup should not get playseek injected"
        assert "playseek=" not in catchup_source

    def test_path_template_with_dollar_brace(self, catchup_rewrite_playlist):
        """Catchup-source with ${(b)...} in path should trigger injection."""
        line, _ = extract_catchup_source(catchup_rewrite_playlist, "Dollar Brace Ch")
        assert "playseek=" in line, "Path template with ${(b)...} should inject playseek"

    def test_path_template_uses_original_playseek_format(self, catchup_rewrite_playlist):
        """Multi-part path templates should keep the original placeholder fragments in playseek."""
        assert "playseek=${(b)yyyyMMdd}${(b)HHmmss}-${(e)yyyyMMdd}${(e)HHmmss}" in catchup_rewrite_playlist, (
            "Expected original placeholder fragments in playseek, got:\n%s" % catchup_rewrite_playlist
        )

    def test_query_templates_prefer_playseek_carrier(self, catchup_rewrite_playlist):
        """Query templates should become the proxied playseek carrier when present."""
        _, catchup_source = extract_catchup_source(catchup_rewrite_playlist, "Mixed Channel")
        assert "playseek={utc}" in catchup_source, (
            "Expected query begin template to become playseek carrier, got: %s" % catchup_source
        )
        assert "begin={utc}" not in catchup_source, (
            "Expected original query template to be folded into playseek, got: %s" % catchup_source
        )

    def test_main_service_query_templates_are_preserved_in_playlist(self, catchup_rewrite_playlist):
        """Main service URL should keep template query params in transformed playlist output."""
        text = catchup_rewrite_playlist
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

    def test_append_catchup_exposes_playseek_carrier(self, catchup_rewrite_playlist):
        """Append-mode query templates should also expose a fixed playseek carrier."""
        _, catchup_source = extract_catchup_source(catchup_rewrite_playlist, "Placeholder Ch")
        assert "playseek={utc}-{utcend}" in catchup_source, (
            "Expected append-mode placeholders to expose playseek carrier, got: %s" % catchup_source
        )

    def test_append_query_templates_become_playseek_carrier(self, catchup_rewrite_playlist):
        """Append-mode start/end query templates should be folded into playseek."""
        _, catchup_source = extract_catchup_source(catchup_rewrite_playlist, "Append Offset Ch")
        assert "playseek=${(b)yyyyMMdd|UTC}T${(b)HHmmss|UTC}-${(e)yyyyMMdd|UTC}T${(e)HHmmss|UTC}" in catchup_source, (
            "Expected append-mode query templates to become playseek carrier, got: %s" % catchup_source
        )

    def test_append_query_templates_without_prefix_become_playseek_carrier(self, catchup_rewrite_playlist):
        """Append-mode query templates without a leading separator should also be folded into playseek."""
        _, catchup_source = extract_catchup_source(catchup_rewrite_playlist, "Append No Prefix Ch")
        assert "playseek=${(b)yyyyMMdd|UTC}T${(b)HHmmss|UTC}-${(e)yyyyMMdd|UTC}T${(e)HHmmss|UTC}" in catchup_source, (
            "Expected append-mode query templates without prefix to become playseek carrier, got: %s" % catchup_source
        )


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
