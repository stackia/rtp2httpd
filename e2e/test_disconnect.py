"""E2E coverage for status-page force disconnect and temporary IP blocking."""

from __future__ import annotations

import socket
import time
from urllib.parse import urlencode

import pytest
from helpers import (
    MockRTSPServer,
    R2HProcess,
    find_free_port,
    get_header,
    http_get,
    http_request,
    stream_get,
    wait_for_status_payload,
)

pytestmark = pytest.mark.rtsp


def _open_stream(port: int, rtsp_port: int, headers: dict[str, str] | None = None) -> socket.socket:
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(10)
    sock.bind(("127.0.0.1", 0))
    sock.connect(("127.0.0.1", port))
    path = f"/rtsp/127.0.0.1:{rtsp_port}/stream"
    req_lines = [f"GET {path} HTTP/1.0", "Host: 127.0.0.1"]
    for key, value in (headers or {}).items():
        req_lines.append(f"{key}: {value}")
    req_lines.append("")
    req_lines.append("")
    sock.sendall("\r\n".join(req_lines).encode())
    response = b""
    deadline = time.monotonic() + 10
    sock.settimeout(1.0)
    while b"\r\n\r\n" not in response and time.monotonic() < deadline:
        try:
            response += sock.recv(4096)
        except TimeoutError:
            continue
    assert b" 200 " in response.split(b"\r\n", 1)[0], response[:120]
    return sock


def _disconnect_client(port: int, client_id: str) -> None:
    body = urlencode({"client_id": client_id}).encode()
    status, _, response = http_request(
        "127.0.0.1",
        port,
        "POST",
        "/status/api/disconnect",
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        body=body,
    )
    assert status == 200
    assert b'"success":true' in response


def _wait_for_http_status(
    port: int, path: str, expected: int, timeout: float, headers: dict[str, str] | None = None
) -> int:
    """Poll a non-streaming endpoint until it returns *expected*."""
    deadline = time.monotonic() + timeout
    last_status = 0
    while time.monotonic() < deadline:
        last_status, _, _ = http_get("127.0.0.1", port, path, timeout=2.0, headers=headers)
        if last_status == expected:
            return last_status
        time.sleep(0.1)
    return last_status


def test_disconnect_blocks_client_ip_then_recovers(r2h_binary):
    """Force-disconnect should close the stream and reject the same IP with 429."""
    upstream = MockRTSPServer(num_packets=30000)
    upstream.start()
    port = find_free_port()
    r2h = R2HProcess(r2h_binary, port, extra_args=["-v", "4", "-m", "10", "-w", "1"])
    stream_sock = None
    try:
        r2h.start()
        stream_sock = _open_stream(port, upstream.port)
        payload = wait_for_status_payload("127.0.0.1", port, lambda value: len(value["clients"]) == 1)
        _disconnect_client(port, payload["clients"][0]["clientId"])

        path = f"/rtsp/127.0.0.1:{upstream.port}/stream"
        status, headers, _ = stream_get("127.0.0.1", port, path, read_bytes=64, timeout=5.0)
        assert status == 429
        retry_after = int(get_header(headers, "Retry-After"))
        assert 1 <= retry_after <= 5

        # Probe /status instead of the RTSP path: after the block expires we
        # only need to see that the IP is accepted again. Re-opening an RTSP
        # stream on macOS can take ~7s, which made a short stream_get poll
        # return 0 even though the block had already lifted.
        assert _wait_for_http_status(port, "/status", 200, timeout=8.0) == 200
    finally:
        if stream_sock is not None:
            stream_sock.close()
        r2h.stop()
        upstream.stop()


def test_disconnect_blocks_xff_ip_only(r2h_binary):
    """With xff enabled, only the forwarded client IP is blocked."""
    upstream = MockRTSPServer(num_packets=30000)
    upstream.start()
    port = find_free_port()
    r2h = R2HProcess(r2h_binary, port, extra_args=["-v", "4", "-m", "10", "-w", "1", "-X"])
    stream_sock = None
    try:
        r2h.start()
        blocked_ip = "203.0.113.10"
        other_ip = "203.0.113.11"
        stream_sock = _open_stream(port, upstream.port, headers={"X-Forwarded-For": blocked_ip})
        payload = wait_for_status_payload("127.0.0.1", port, lambda value: len(value["clients"]) == 1)
        assert payload["clients"][0]["clientAddr"] == blocked_ip
        _disconnect_client(port, payload["clients"][0]["clientId"])

        path = f"/rtsp/127.0.0.1:{upstream.port}/stream"
        status, headers, _ = stream_get(
            "127.0.0.1", port, path, read_bytes=64, timeout=5.0, headers={"X-Forwarded-For": blocked_ip}
        )
        assert status == 429
        assert 1 <= int(get_header(headers, "Retry-After")) <= 5

        other_status, _, _ = stream_get(
            "127.0.0.1", port, path, read_bytes=64, timeout=20.0, headers={"X-Forwarded-For": other_ip}
        )
        assert other_status == 200

        peer_status, _, _ = stream_get("127.0.0.1", port, path, read_bytes=64, timeout=20.0)
        assert peer_status == 200
    finally:
        if stream_sock is not None:
            stream_sock.close()
        r2h.stop()
        upstream.stop()
