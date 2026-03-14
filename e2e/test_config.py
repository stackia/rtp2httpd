"""
E2E tests for configuration parsing.

Tests cover command-line flags, config file sections, default values,
and precedence rules.
"""

import os
import tempfile
import time  # needed for TestMaxClients deadline loop

import pytest

from helpers import (
    MockHTTPUpstream,
    MockRTSPServer,
    R2HProcess,
    find_free_port,
    http_get,
    http_request,
    stream_get,
    wait_for_port,
)


_INLINE_M3U = """\
#EXTM3U
#EXTINF:-1,Config Test
rtp://239.0.0.1:1234
"""


def _build_config(
    port: int,
    global_lines: list[str] | None = None,
    services_content: str | None = None,
) -> str:
    lines = ["[global]", "verbosity = 4"]
    if global_lines:
        lines.extend(global_lines)
    lines.extend(["", "[bind]", f"* {port}"])

    if services_content:
        lines.extend(["", "[services]"])
        lines.extend(services_content.strip().splitlines())

    return "\n".join(lines) + "\n"


def _value_config_line(option_name: str):
    def builder(value):
        return [f"{option_name} = {value}"]

    return builder


def _value_cli_args(flag: str):
    def builder(value):
        return [flag, value]

    return builder


def _bool_config_line(option_name: str):
    def builder(enabled):
        return [f"{option_name} = {'yes' if enabled else 'no'}"]

    return builder


def _enable_flag(flag: str):
    def builder(enabled):
        return [flag] if enabled else []

    return builder


def _disable_flag(flag: str):
    def builder(enabled):
        return [] if enabled else [flag]

    return builder


def _hostname_config_line(value):
    return [f"hostname = {value[0]}"]


def _hostname_cli_args(value):
    return ["-H", value[0]]


def _assert_status_page_path(port: int, expected_path: str):
    status, _, _ = http_get("127.0.0.1", port, expected_path)
    assert status == 200
    if expected_path != "/status":
        status2, _, _ = http_get("127.0.0.1", port, "/status")
        assert status2 == 404


def _assert_player_page_path(port: int, expected_path: str):
    status, _, _ = http_get("127.0.0.1", port, expected_path)
    assert status == 200
    if expected_path != "/player":
        status2, _, _ = http_get("127.0.0.1", port, "/player")
        assert status2 == 404


def _assert_hostname(port: int, expected_hosts: tuple[str, str]):
    allowed_host, rejected_host = expected_hosts

    status, _, _ = http_get(
        "127.0.0.1",
        port,
        "/status",
        headers={"Host": allowed_host},
    )
    assert status == 200

    status, _, _ = http_get(
        "127.0.0.1",
        port,
        "/status",
        headers={"Host": rejected_host},
    )
    assert status == 400


def _assert_cors_origin(port: int, expected_origin: str):
    status, hdrs, _ = http_get("127.0.0.1", port, "/status")
    assert status == 200
    acao = hdrs.get(
        "Access-Control-Allow-Origin",
        hdrs.get("access-control-allow-origin", ""),
    )
    assert acao == expected_origin


def _assert_xff_enabled(port: int, expected_host: str):
    status, _, body = http_get(
        "127.0.0.1",
        port,
        "/playlist.m3u",
        headers={
            "X-Forwarded-Host": expected_host,
            "X-Forwarded-Proto": "https",
        },
    )
    assert status == 200
    assert expected_host in body.decode()


def _assert_udpxy_state(port: int, expected_enabled: bool):
    status, _, _ = http_request(
        "127.0.0.1",
        port,
        "HEAD",
        "/udp/239.0.0.1:1234",
        timeout=3.0,
    )
    assert status == (200 if expected_enabled else 404)


def _assert_rtsp_user_agent(port: int, expected_user_agent: str):
    rtsp = MockRTSPServer(num_packets=50)
    rtsp.start()
    try:
        status, _, body = stream_get(
            "127.0.0.1",
            port,
            "/rtsp/127.0.0.1:%d/stream" % rtsp.port,
            read_bytes=1024,
            timeout=10.0,
        )
        assert status == 200, f"Expected 200, got {status}"
        assert len(body) > 0, "Expected RTSP stream body"

        option_reqs = [
            req for req in rtsp.requests_detailed if req["method"] == "OPTIONS"
        ]
        assert option_reqs, "Expected OPTIONS request"
        assert option_reqs[0]["headers"].get("User-Agent") == expected_user_agent
    finally:
        rtsp.stop()


def _assert_http_proxy_user_agent(port: int, expected_user_agent: str):
    upstream = MockHTTPUpstream(
        routes={
            "/headers": {"status": 200, "body": b"ok"},
        }
    )
    upstream.start()
    try:
        status, _, body = http_get(
            "127.0.0.1",
            port,
            f"/http/127.0.0.1:{upstream.port}/headers",
            timeout=5.0,
            headers={"User-Agent": "ClientUserAgent/0.1"},
        )
        assert status == 200
        assert body == b"ok"
        assert upstream.requests_log, "Expected upstream request"
        assert (
            upstream.requests_log[0]["headers"].get("User-Agent") == expected_user_agent
        )
    finally:
        upstream.stop()


OPTION_SOURCE_PRIORITY_CASES = [
    pytest.param(
        {
            "name": "status-page-path",
            "config_lines": _value_config_line("status-page-path"),
            "cli_args": _value_cli_args("-s"),
            "config_source_value": "/cfg-status",
            "cli_source_value": "/cli-status",
            "priority_config_value": "/config-status",
            "priority_cli_value": "/override-status",
            "assertion": _assert_status_page_path,
        },
        id="status-page-path",
    ),
    pytest.param(
        {
            "name": "player-page-path",
            "config_lines": _value_config_line("player-page-path"),
            "cli_args": _value_cli_args("-p"),
            "config_source_value": "/cfg-player",
            "cli_source_value": "/cli-player",
            "priority_config_value": "/config-player",
            "priority_cli_value": "/override-player",
            "assertion": _assert_player_page_path,
        },
        id="player-page-path",
    ),
    pytest.param(
        {
            "name": "hostname",
            "config_lines": _hostname_config_line,
            "cli_args": _hostname_cli_args,
            "config_source_value": ("config-host", "bad-host"),
            "cli_source_value": ("cli-host", "bad-host"),
            "priority_config_value": ("config-host", "bad-host"),
            "priority_cli_value": ("cli-host", "config-host"),
            "assertion": _assert_hostname,
        },
        id="hostname",
    ),
    pytest.param(
        {
            "name": "cors-allow-origin",
            "config_lines": _value_config_line("cors-allow-origin"),
            "cli_args": _value_cli_args("-O"),
            "config_source_value": "http://config.example.com",
            "cli_source_value": "http://cli.example.com",
            "priority_config_value": "http://config.example.com",
            "priority_cli_value": "http://override.example.com",
            "assertion": _assert_cors_origin,
        },
        id="cors-allow-origin",
    ),
    pytest.param(
        {
            "name": "xff",
            "config_lines": _bool_config_line("xff"),
            "cli_args": _enable_flag("-X"),
            "config_source_value": True,
            "cli_source_value": True,
            "priority_config_value": False,
            "priority_cli_value": True,
            "assertion": _assert_xff_enabled,
            "assertion_expected": "public.example.com",
            "services_content": _INLINE_M3U,
        },
        id="xff",
    ),
    pytest.param(
        {
            "name": "udpxy",
            "config_lines": _bool_config_line("udpxy"),
            "cli_args": _disable_flag("-U"),
            "config_source_value": False,
            "cli_source_value": False,
            "priority_config_value": True,
            "priority_cli_value": False,
            "assertion": _assert_udpxy_state,
        },
        id="udpxy",
    ),
    pytest.param(
        {
            "name": "http-proxy-user-agent",
            "config_lines": _value_config_line("http-proxy-user-agent"),
            "cli_args": _value_cli_args("--http-proxy-user-agent"),
            "config_source_value": "ConfigHttpProxyUA/1.0",
            "cli_source_value": "CliHttpProxyUA/2.0",
            "priority_config_value": "ConfigHttpProxyUA/1.0",
            "priority_cli_value": "CliOverrideHttpProxyUA/3.0",
            "assertion": _assert_http_proxy_user_agent,
        },
        id="http-proxy-user-agent",
    ),
    pytest.param(
        {
            "name": "rtsp-user-agent",
            "config_lines": _value_config_line("rtsp-user-agent"),
            "cli_args": _value_cli_args("--rtsp-user-agent"),
            "config_source_value": "MyConfigAgent/1.0",
            "cli_source_value": "MyCliAgent/2.0",
            "priority_config_value": "ConfigAgent/1.0",
            "priority_cli_value": "CliOverrideAgent/3.0",
            "assertion": _assert_rtsp_user_agent,
        },
        id="rtsp-user-agent",
    ),
]


def _run_option_source_case(
    r2h_binary, case, *, config_value=None, cli_value=None, expected_value=None
):
    port = find_free_port()
    global_lines = []

    if config_value is not None:
        global_lines.extend(case["config_lines"](config_value))

    services_content = case.get("services_content")
    config_content = None
    if global_lines or services_content:
        config_content = _build_config(
            port,
            global_lines=global_lines,
            services_content=services_content,
        )

    extra_args = []
    if cli_value is not None:
        extra_args.extend(case["cli_args"](cli_value))

    r2h = R2HProcess(
        r2h_binary,
        port,
        extra_args=extra_args,
        config_content=config_content,
    )
    try:
        r2h.start()
        case["assertion"](
            port,
            (
                expected_value
                if expected_value is not None
                else case.get("assertion_expected")
            ),
        )
    finally:
        r2h.stop()


# ---------------------------------------------------------------------------
# Default behaviour (no config, minimal flags)
# ---------------------------------------------------------------------------


class TestDefaults:
    """Verify rtp2httpd starts with sensible defaults."""

    def test_starts_with_noconfig(self, r2h_binary):
        """rtp2httpd -C should start and listen on the given port."""
        port = find_free_port()
        r2h = R2HProcess(r2h_binary, port, extra_args=["-v", "4", "-m", "5"])
        try:
            r2h.start()
            assert wait_for_port(port)
        finally:
            r2h.stop()


# ---------------------------------------------------------------------------
# Custom port via -l
# ---------------------------------------------------------------------------


class TestCustomPort:
    """The -l flag should determine the listen port."""

    def test_listen_port(self, r2h_binary):
        port = find_free_port()
        r2h = R2HProcess(r2h_binary, port, extra_args=["-v", "4"])
        try:
            r2h.start()
            # Port should be reachable
            assert wait_for_port(port)
        finally:
            r2h.stop()


# ---------------------------------------------------------------------------
# Max clients (-m)
# ---------------------------------------------------------------------------


class TestMaxClients:
    """The -m flag limits concurrent streaming connections."""

    @pytest.mark.slow
    def test_max_clients_enforced(self, r2h_binary):
        """When maxclients=1 and one client is streaming an RTSP source,
        a second stream request should get 503 Service Unavailable."""
        import socket as _socket
        from helpers import MockRTSPServerUDP

        rtsp = MockRTSPServerUDP(num_packets=2000)
        rtsp.start()

        port = find_free_port()
        r2h = R2HProcess(
            r2h_binary,
            port,
            extra_args=["-v", "4", "-m", "1"],
        )
        try:
            r2h.start()
            url = "/rtsp/127.0.0.1:%d/test" % rtsp.port

            # First client: open streaming connection and keep it alive
            sock1 = _socket.create_connection(("127.0.0.1", port), timeout=20)
            sock1.sendall(("GET %s HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n" % url).encode())
            # Wait until we get the 200 OK headers
            resp1 = b""
            deadline = time.monotonic() + 20
            sock1.settimeout(1.0)
            while b"\r\n\r\n" not in resp1 and time.monotonic() < deadline:
                try:
                    resp1 += sock1.recv(4096)
                except _socket.timeout:
                    continue
            assert b"200" in resp1, "First client did not get 200: %r" % resp1[:80]

            # Connection is active - the server has registered this client.
            time.sleep(0.2)

            # Second client should be rejected
            status2, _, _ = stream_get(
                "127.0.0.1",
                port,
                url,
                read_bytes=256,
                timeout=3.0,
            )
            assert status2 == 503

            sock1.close()
        finally:
            r2h.stop()
            rtsp.stop()


# ---------------------------------------------------------------------------
# Config file sections
# ---------------------------------------------------------------------------


class TestConfigFile:
    """Test config file parsing with all sections."""

    def test_global_and_bind_sections(self, r2h_binary):
        """A config with [global] and [bind] should be parsed correctly."""
        port = find_free_port()
        config = f"""\
[global]
verbosity = 4
maxclients = 50

[bind]
* {port}
"""
        r2h = R2HProcess(r2h_binary, port, config_content=config)
        try:
            r2h.start()
            assert wait_for_port(port)
        finally:
            r2h.stop()

    def test_services_section(self, r2h_binary):
        """A [services] section with inline M3U should produce a playlist."""
        port = find_free_port()
        config = f"""\
[global]
verbosity = 4

[bind]
* {port}

[services]
#EXTM3U
#EXTINF:-1,Config Test
rtp://239.0.0.1:1234
"""
        r2h = R2HProcess(r2h_binary, port, config_content=config)
        try:
            r2h.start()
            status, _, body = http_get("127.0.0.1", port, "/playlist.m3u")
            assert status == 200
            assert b"Config Test" in body
        finally:
            r2h.stop()

    def test_commented_lines_ignored(self, r2h_binary):
        """Lines starting with ; or # (outside [services]) should be ignored."""
        port = find_free_port()
        config = f"""\
# This is a comment
; This too
[global]
verbosity = 4
; maxclients = 1
# hostname = invalid

[bind]
* {port}
"""
        r2h = R2HProcess(r2h_binary, port, config_content=config)
        try:
            r2h.start()
            assert wait_for_port(port)
        finally:
            r2h.stop()


# ---------------------------------------------------------------------------
# Command-line overrides config
# ---------------------------------------------------------------------------


class TestCLIOverridesConfig:
    """CLI flags take precedence over config file values."""

    def test_cli_port_overrides_bind(self, r2h_binary):
        """The -l flag should override the [bind] section."""
        config_port = find_free_port()
        cli_port = find_free_port()
        config = f"""\
[global]
verbosity = 4

[bind]
* {config_port}
"""
        r2h = R2HProcess(
            r2h_binary,
            cli_port,
            config_content=config,
        )
        try:
            r2h.start()
            # CLI port should be active
            assert wait_for_port(cli_port)
        finally:
            r2h.stop()


# ---------------------------------------------------------------------------
# Config file / CLI / priority coverage
# ---------------------------------------------------------------------------


class TestOptionSourcesAndPriority:
    """Config file, CLI, and CLI-over-config coverage for multiple options."""

    @pytest.mark.parametrize("case", OPTION_SOURCE_PRIORITY_CASES)
    def test_option_from_config(self, r2h_binary, case):
        expected_value = case.get("assertion_expected", case["config_source_value"])
        _run_option_source_case(
            r2h_binary,
            case,
            config_value=case["config_source_value"],
            expected_value=expected_value,
        )

    @pytest.mark.parametrize("case", OPTION_SOURCE_PRIORITY_CASES)
    def test_option_from_cli(self, r2h_binary, case):
        expected_value = case.get("assertion_expected", case["cli_source_value"])
        _run_option_source_case(
            r2h_binary,
            case,
            cli_value=case["cli_source_value"],
            expected_value=expected_value,
        )

    @pytest.mark.parametrize("case", OPTION_SOURCE_PRIORITY_CASES)
    def test_cli_overrides_config(self, r2h_binary, case):
        expected_value = case.get("assertion_expected", case["priority_cli_value"])
        _run_option_source_case(
            r2h_binary,
            case,
            config_value=case["priority_config_value"],
            cli_value=case["priority_cli_value"],
            expected_value=expected_value,
        )


# ---------------------------------------------------------------------------
# UDPxy toggle
# ---------------------------------------------------------------------------


class TestUDPxyConfig:
    """Test udpxy = no in config disables /udp/ URLs."""

    def test_udpxy_enabled_by_default(self, r2h_binary):
        """With default settings, /udp/ should be recognized (even if upstream
        is unreachable, it should NOT return 404)."""
        port = find_free_port()
        r2h = R2HProcess(
            r2h_binary,
            port,
            extra_args=["-v", "4", "-m", "100"],
        )
        try:
            r2h.start()
            # We don't have a multicast sender, so we won't get 200,
            # but it should not be 404 either
            status, _, _ = http_request(
                "127.0.0.1",
                port,
                "HEAD",
                "/udp/239.0.0.1:1234",
                timeout=3.0,
            )
            assert status == 200  # HEAD on RTP/UDP returns 200
        finally:
            r2h.stop()


# ---------------------------------------------------------------------------
# Workers config
# ---------------------------------------------------------------------------


class TestWorkers:
    """Test workers configuration."""

    def test_single_worker(self, r2h_binary):
        port = find_free_port()
        r2h = R2HProcess(
            r2h_binary,
            port,
            extra_args=["-v", "4", "-m", "100", "-w", "1"],
        )
        try:
            r2h.start()
            assert wait_for_port(port)
        finally:
            r2h.stop()

    def test_multiple_workers(self, r2h_binary):
        port = find_free_port()
        r2h = R2HProcess(
            r2h_binary,
            port,
            extra_args=["-v", "4", "-m", "100", "-w", "2"],
        )
        try:
            r2h.start()
            assert wait_for_port(port)
            # Server should still respond to requests
            status, _, _ = http_get(
                "127.0.0.1",
                port,
                "/status",
                timeout=3.0,
            )
            assert status == 200
        finally:
            r2h.stop()


# ---------------------------------------------------------------------------
# CORS
# ---------------------------------------------------------------------------


class TestCORS:
    """The -O flag enables CORS headers."""

    def test_cors_preflight(self, r2h_binary):
        """OPTIONS request should return 204 with CORS headers."""
        port = find_free_port()
        r2h = R2HProcess(
            r2h_binary,
            port,
            extra_args=["-v", "4", "-m", "100", "-O", "*"],
        )
        try:
            r2h.start()
            status, hdrs, _ = http_request(
                "127.0.0.1",
                port,
                "OPTIONS",
                "/status",
                headers={
                    "Origin": "http://example.com",
                    "Access-Control-Request-Method": "GET",
                },
            )
            assert status == 204
            assert (
                "Access-Control-Allow-Methods" in hdrs
                or "access-control-allow-methods" in hdrs
            )
        finally:
            r2h.stop()


# ---------------------------------------------------------------------------
# XFF (X-Forwarded-For) support
# ---------------------------------------------------------------------------


class TestXFF:
    """The -X / --xff flag enables X-Forwarded-For header support."""

    def test_xff_with_forwarded_header(self, r2h_binary):
        """With -X, requests with X-Forwarded-For should be accepted normally."""
        port = find_free_port()
        r2h = R2HProcess(
            r2h_binary,
            port,
            extra_args=["-v", "4", "-m", "100", "-X"],
        )
        try:
            r2h.start()
            status, _, _ = http_get(
                "127.0.0.1",
                port,
                "/status",
                headers={"X-Forwarded-For": "10.0.0.1"},
            )
            assert status == 200
        finally:
            r2h.stop()

    def test_xff_m3u_url_uses_forwarded_host(self, r2h_binary):
        """With -X and X-Forwarded-Host, M3U URLs should use the forwarded host."""
        port = find_free_port()
        config = f"""\
[global]
verbosity = 4
xff = yes

[bind]
* {port}

[services]
#EXTM3U
#EXTINF:-1,XFF Channel
rtp://239.0.0.1:1234
"""
        r2h = R2HProcess(r2h_binary, port, config_content=config)
        try:
            r2h.start()
            status, _, body = http_get(
                "127.0.0.1",
                port,
                "/playlist.m3u",
                headers={
                    "X-Forwarded-Host": "public.example.com",
                    "X-Forwarded-Proto": "https",
                },
            )
            assert status == 200
            text = body.decode()
            # With XFF enabled and X-Forwarded-Host set, the base URL
            # in the M3U should use the forwarded host
            assert "public.example.com" in text
        finally:
            r2h.stop()


# ---------------------------------------------------------------------------
# Quiet mode
# ---------------------------------------------------------------------------


class TestQuietMode:
    """The -q flag suppresses non-essential output."""

    def test_quiet_mode_starts(self, r2h_binary):
        """Server should start and respond normally with -q flag."""
        port = find_free_port()
        r2h = R2HProcess(
            r2h_binary,
            port,
            extra_args=["-q", "-m", "100"],
        )
        try:
            r2h.start()
            status, _, _ = http_get("127.0.0.1", port, "/status")
            assert status == 200
        finally:
            r2h.stop()
