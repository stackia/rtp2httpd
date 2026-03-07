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
    R2HProcess,
    find_free_port,
    http_get,
    http_request,
    stream_get,
    wait_for_port,
)


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
            r2h_binary, port,
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
                "127.0.0.1", port, url,
                read_bytes=256, timeout=3.0,
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
# UDPxy toggle
# ---------------------------------------------------------------------------


class TestUDPxyConfig:
    """Test udpxy = no in config disables /udp/ URLs."""

    def test_udpxy_disabled_in_config(self, r2h_binary):
        port = find_free_port()
        config = f"""\
[global]
verbosity = 4
udpxy = no

[bind]
* {port}
"""
        r2h = R2HProcess(r2h_binary, port, config_content=config)
        try:
            r2h.start()
            status, _, _ = stream_get(
                "127.0.0.1", port,
                "/udp/239.0.0.1:1234",
                read_bytes=256, timeout=3.0,
            )
            assert status == 404
        finally:
            r2h.stop()

    def test_udpxy_enabled_by_default(self, r2h_binary):
        """With default settings, /udp/ should be recognized (even if upstream
        is unreachable, it should NOT return 404)."""
        port = find_free_port()
        r2h = R2HProcess(
            r2h_binary, port,
            extra_args=["-v", "4", "-m", "100"],
        )
        try:
            r2h.start()
            # We don't have a multicast sender, so we won't get 200,
            # but it should not be 404 either
            status, _, _ = http_request(
                "127.0.0.1", port, "HEAD",
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
            r2h_binary, port,
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
            r2h_binary, port,
            extra_args=["-v", "4", "-m", "100", "-w", "2"],
        )
        try:
            r2h.start()
            assert wait_for_port(port)
            # Server should still respond to requests
            status, _, _ = http_get(
                "127.0.0.1", port, "/status", timeout=3.0,
            )
            assert status == 200
        finally:
            r2h.stop()


# ---------------------------------------------------------------------------
# Status & player page custom paths
# ---------------------------------------------------------------------------


class TestCustomPaths:
    """Custom -s / -p paths for status and player pages."""

    def test_custom_status_path(self, r2h_binary):
        port = find_free_port()
        r2h = R2HProcess(
            r2h_binary, port,
            extra_args=["-v", "4", "-m", "100", "-s", "/my-status"],
        )
        try:
            r2h.start()
            # Custom path should work
            status, _, _ = http_get("127.0.0.1", port, "/my-status")
            assert status == 200
            # Default path should 404
            status2, _, _ = http_get("127.0.0.1", port, "/status")
            assert status2 == 404
        finally:
            r2h.stop()

    def test_custom_player_path(self, r2h_binary):
        port = find_free_port()
        r2h = R2HProcess(
            r2h_binary, port,
            extra_args=["-v", "4", "-m", "100", "-p", "/my-player"],
        )
        try:
            r2h.start()
            status, _, _ = http_get("127.0.0.1", port, "/my-player")
            assert status == 200
            status2, _, _ = http_get("127.0.0.1", port, "/player")
            assert status2 == 404
        finally:
            r2h.stop()


# ---------------------------------------------------------------------------
# Hostname validation
# ---------------------------------------------------------------------------


class TestHostnameValidation:
    """The -H flag restricts access based on the Host header."""

    def test_hostname_match(self, r2h_binary):
        port = find_free_port()
        r2h = R2HProcess(
            r2h_binary, port,
            extra_args=["-v", "4", "-m", "100", "-H", f"myhost:{port}"],
        )
        try:
            r2h.start()
            status, _, _ = http_get(
                "127.0.0.1", port, "/status",
                headers={"Host": f"myhost:{port}"},
            )
            assert status == 200
        finally:
            r2h.stop()

    def test_hostname_mismatch(self, r2h_binary):
        port = find_free_port()
        r2h = R2HProcess(
            r2h_binary, port,
            extra_args=["-v", "4", "-m", "100", "-H", "allowed-host"],
        )
        try:
            r2h.start()
            status, _, _ = http_get(
                "127.0.0.1", port, "/status",
                headers={"Host": "evil-host"},
            )
            assert status == 400
        finally:
            r2h.stop()


# ---------------------------------------------------------------------------
# CORS
# ---------------------------------------------------------------------------


class TestCORS:
    """The -O flag enables CORS headers."""

    def test_cors_origin_header(self, r2h_binary):
        port = find_free_port()
        r2h = R2HProcess(
            r2h_binary, port,
            extra_args=["-v", "4", "-m", "100", "-O", "*"],
        )
        try:
            r2h.start()
            status, hdrs, _ = http_get("127.0.0.1", port, "/status")
            assert status == 200
            acao = hdrs.get("Access-Control-Allow-Origin",
                           hdrs.get("access-control-allow-origin", ""))
            assert acao == "*"
        finally:
            r2h.stop()

    def test_cors_preflight(self, r2h_binary):
        """OPTIONS request should return 204 with CORS headers."""
        port = find_free_port()
        r2h = R2HProcess(
            r2h_binary, port,
            extra_args=["-v", "4", "-m", "100", "-O", "*"],
        )
        try:
            r2h.start()
            status, hdrs, _ = http_request(
                "127.0.0.1", port, "OPTIONS", "/status",
                headers={
                    "Origin": "http://example.com",
                    "Access-Control-Request-Method": "GET",
                },
            )
            assert status == 204
            assert "Access-Control-Allow-Methods" in hdrs or \
                   "access-control-allow-methods" in hdrs
        finally:
            r2h.stop()

    def test_cors_specific_origin(self, r2h_binary):
        """CORS with a specific origin should return that origin."""
        port = find_free_port()
        r2h = R2HProcess(
            r2h_binary, port,
            extra_args=["-v", "4", "-m", "100", "-O", "http://mysite.com"],
        )
        try:
            r2h.start()
            status, hdrs, _ = http_get("127.0.0.1", port, "/status")
            assert status == 200
            acao = hdrs.get("Access-Control-Allow-Origin",
                           hdrs.get("access-control-allow-origin", ""))
            assert acao == "http://mysite.com"
        finally:
            r2h.stop()


# ---------------------------------------------------------------------------
# XFF (X-Forwarded-For) support
# ---------------------------------------------------------------------------


class TestXFF:
    """The -X / --xff flag enables X-Forwarded-For header support."""

    def test_xff_flag_accepted(self, r2h_binary):
        """Server should start and respond with -X flag enabled."""
        port = find_free_port()
        r2h = R2HProcess(
            r2h_binary, port,
            extra_args=["-v", "4", "-m", "100", "-X"],
        )
        try:
            r2h.start()
            status, _, _ = http_get("127.0.0.1", port, "/status")
            assert status == 200
        finally:
            r2h.stop()

    def test_xff_with_forwarded_header(self, r2h_binary):
        """With -X, requests with X-Forwarded-For should be accepted normally."""
        port = find_free_port()
        r2h = R2HProcess(
            r2h_binary, port,
            extra_args=["-v", "4", "-m", "100", "-X"],
        )
        try:
            r2h.start()
            status, _, _ = http_get(
                "127.0.0.1", port, "/status",
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
                "127.0.0.1", port, "/playlist.m3u",
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
            r2h_binary, port,
            extra_args=["-q", "-m", "100"],
        )
        try:
            r2h.start()
            status, _, _ = http_get("127.0.0.1", port, "/status")
            assert status == 200
        finally:
            r2h.stop()


# ---------------------------------------------------------------------------
# XFF in config file
# ---------------------------------------------------------------------------


class TestXFFConfig:
    """XFF can also be enabled via config file."""

    def test_xff_config_option(self, r2h_binary):
        port = find_free_port()
        config = f"""\
[global]
verbosity = 4
xff = yes

[bind]
* {port}
"""
        r2h = R2HProcess(r2h_binary, port, config_content=config)
        try:
            r2h.start()
            status, _, _ = http_get(
                "127.0.0.1", port, "/status",
                headers={"X-Forwarded-For": "192.168.1.1"},
            )
            assert status == 200
        finally:
            r2h.stop()
