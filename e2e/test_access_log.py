"""
E2E tests for access log configuration and formatting.

These tests use HTTP proxy requests because they exercise real media-client
status registration without depending on multicast availability.
"""

import re

import pytest

from helpers import (
    LOOPBACK_IF,
    MCAST_ADDR,
    MockHTTPUpstream,
    MulticastSender,
    R2HProcess,
    find_free_port,
    find_free_udp_port,
    http_get,
    stream_get,
)

pytestmark = pytest.mark.http_proxy


def _config(port: int, global_lines: list[str] | None = None) -> str:
    lines = ["[global]", "verbosity = 4"]
    if global_lines:
        lines.extend(global_lines)
    lines.extend(["", "[bind]", f"* {port}"])
    return "\n".join(lines) + "\n"


def _request_proxy(port: int, upstream: MockHTTPUpstream, path: str = "/hello", headers: dict | None = None):
    return http_get(
        "127.0.0.1",
        port,
        f"/http/127.0.0.1:{upstream.port}{path}",
        timeout=5.0,
        headers=headers,
    )


def _start_upstream() -> MockHTTPUpstream:
    upstream = MockHTTPUpstream(
        routes={
            "/hello": {"status": 200, "body": b"world", "headers": {"Content-Type": "text/plain"}},
        }
    )
    upstream.start()
    return upstream


def test_access_log_disabled_by_default(r2h_binary, tmp_path):
    port = find_free_port()
    log_path = tmp_path / "access.log"
    r2h = R2HProcess(r2h_binary, port, config_content=_config(port))
    upstream = _start_upstream()
    try:
        r2h.start()
        status, _, body = _request_proxy(port, upstream)
        assert status == 200
        assert body == b"world"
        assert not log_path.exists()
    finally:
        r2h.stop()
        upstream.stop()


def test_config_access_log_writes_default_line(r2h_binary, tmp_path):
    port = find_free_port()
    log_path = tmp_path / "access.log"
    r2h = R2HProcess(
        r2h_binary,
        port,
        config_content=_config(port, [f"access-log = {log_path}"]),
    )
    upstream = _start_upstream()
    try:
        r2h.start()
        status, _, body = _request_proxy(port, upstream)
        assert status == 200
        assert body == b"world"

        lines = log_path.read_text().splitlines()
        assert len(lines) == 1
        assert re.search(
            rf'^127\.0\.0\.1:\d+ \[[^\]]+\] "/http/127\.0\.0\.1:{upstream.port}/hello" http "http://127\.0\.0\.1:{upstream.port}/hello"$',
            lines[0],
        )
    finally:
        r2h.stop()
        upstream.stop()


def test_cli_access_log_overrides_config(r2h_binary, tmp_path):
    port = find_free_port()
    config_log_path = tmp_path / "config-access.log"
    cli_log_path = tmp_path / "cli-access.log"
    r2h = R2HProcess(
        r2h_binary,
        port,
        config_content=_config(
            port,
            [
                f"access-log = {config_log_path}",
                "log-format = config $service_type",
            ],
        ),
        extra_args=[
            "--access-log",
            str(cli_log_path),
            "--log-format",
            "cli $service_type $request",
        ],
    )
    upstream = _start_upstream()
    try:
        r2h.start()
        status, _, body = _request_proxy(port, upstream)
        assert status == 200
        assert body == b"world"

        assert not config_log_path.exists()
        assert cli_log_path.read_text().strip() == f"cli http GET /http/127.0.0.1:{upstream.port}/hello"
    finally:
        r2h.stop()
        upstream.stop()


def test_custom_format_filters_token_and_expands_placeholders(r2h_binary, tmp_path):
    port = find_free_port()
    log_path = tmp_path / "access.log"
    log_format = (
        "$$ $request_method $service_url $remote_addr $remote_port $host $http_user_agent "
        "$service_type $upstream_url $client_id $worker_id $state $state_code"
    )
    r2h = R2HProcess(
        r2h_binary,
        port,
        config_content=_config(
            port,
            [
                f"access-log = {log_path}",
                f"log-format = {log_format}",
                "r2h-token = secret-token",
            ],
        ),
    )
    upstream = _start_upstream()
    try:
        r2h.start()
        status, _, body = _request_proxy(
            port,
            upstream,
            "/hello?r2h-token=secret-token&foo=bar",
            headers={"Host": "example.test", "User-Agent": 'Agent"Test'},
        )
        assert status == 200
        assert body == b"world"

        line = log_path.read_text().strip()
        assert line.startswith("$ GET ")
        assert "secret-token" not in line
        assert f"/http/127.0.0.1:{upstream.port}/hello?foo=bar" in line
        assert "127.0.0.1" in line
        assert "example.test" in line
        assert 'Agent\\"Test' in line
        assert f"http://127.0.0.1:{upstream.port}/hello?foo=bar" in line
        assert line.endswith("$client_id $worker_id $state $state_code")
    finally:
        r2h.stop()
        upstream.stop()


def test_client_addr_uses_x_forwarded_for_when_enabled(r2h_binary, tmp_path):
    port = find_free_port()
    log_path = tmp_path / "access.log"
    r2h = R2HProcess(
        r2h_binary,
        port,
        config_content=_config(
            port,
            [
                f"access-log = {log_path}",
                "log-format = $client_addr|$remote_addr|$remote_port|$http_x_forwarded_for",
                "xff = 1",
            ],
        ),
    )
    upstream = _start_upstream()
    try:
        r2h.start()
        status, _, body = _request_proxy(
            port,
            upstream,
            headers={"X-Forwarded-For": "203.0.113.7, 10.0.0.1"},
        )
        assert status == 200
        assert body == b"world"
        assert log_path.read_text().strip() == "203.0.113.7|203.0.113.7|-|203.0.113.7"
    finally:
        r2h.stop()
        upstream.stop()


def test_user_agent_token_is_redacted(r2h_binary, tmp_path):
    port = find_free_port()
    log_path = tmp_path / "access.log"
    r2h = R2HProcess(
        r2h_binary,
        port,
        config_content=_config(
            port,
            [
                f"access-log = {log_path}",
                "log-format = $http_user_agent",
                "r2h-token = secret-token",
            ],
        ),
    )
    upstream = _start_upstream()
    try:
        r2h.start()
        status, _, body = _request_proxy(
            port,
            upstream,
            headers={"User-Agent": "Player/1.0 R2HTOKEN/secret-token TZ/UTC+8"},
        )
        assert status == 200
        assert body == b"world"
        assert log_path.read_text().strip() == "Player/1.0 TZ/UTC+8"
    finally:
        r2h.stop()
        upstream.stop()


@pytest.mark.multicast
def test_rtp_upstream_url_filters_token(r2h_binary, tmp_path):
    port = find_free_port()
    mcast_port = find_free_udp_port()
    log_path = tmp_path / "access.log"
    config = f"""\
[global]
verbosity = 4
access-log = {log_path}
log-format = $service_url|$upstream_url
r2h-token = secret-token

[bind]
* {port}

[services]
#EXTM3U
#EXTINF:-1,RTP Channel
rtp://{MCAST_ADDR}:{mcast_port}?fcc=127.0.0.1:15970
"""
    r2h = R2HProcess(
        r2h_binary,
        port,
        config_content=config,
        extra_args=["-m", "100", "-r", LOOPBACK_IF],
    )
    sender = MulticastSender(addr=MCAST_ADDR, port=mcast_port, pps=200)
    sender.start()
    try:
        r2h.start()
        status, _, _ = stream_get(
            "127.0.0.1",
            port,
            "/RTP%20Channel?r2h-token=secret-token&snapshot=1",
            read_bytes=4096,
            timeout=10.0,
        )
        assert status == 200

        line = log_path.read_text().strip()
        assert "secret-token" not in line
        assert "snapshot=1" in line
        assert f"rtp://{MCAST_ADDR}:{mcast_port}" in line
        assert "fcc=127.0.0.1:15970" in line
        assert "r2h-token" not in line
    finally:
        r2h.stop()
        sender.stop()


def test_non_media_requests_are_not_logged(r2h_binary, tmp_path):
    port = find_free_port()
    log_path = tmp_path / "access.log"
    r2h = R2HProcess(
        r2h_binary,
        port,
        config_content=_config(port, [f"access-log = {log_path}"]),
    )
    try:
        r2h.start()
        status, _, _ = http_get("127.0.0.1", port, "/status")
        assert status == 200
        assert not log_path.exists()
    finally:
        r2h.stop()
