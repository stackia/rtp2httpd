"""HTTP client helpers for E2E tests."""

from __future__ import annotations

import http.client
import re
import socket
import time


def http_get(
    host: str,
    port: int,
    path: str,
    timeout: float = 5.0,
    headers: dict | None = None,
) -> tuple[int, dict, bytes]:
    """Simple blocking HTTP GET.  Returns (status, headers_dict, body)."""
    conn = http.client.HTTPConnection(host, port, timeout=timeout)
    try:
        conn.request("GET", path, headers=headers or {})
        resp = conn.getresponse()
        body = resp.read()
        return resp.status, dict(resp.getheaders()), body
    finally:
        conn.close()


def http_request(
    host: str,
    port: int,
    method: str,
    path: str,
    timeout: float = 5.0,
    headers: dict | None = None,
    body: bytes | None = None,
) -> tuple[int, dict, bytes]:
    """Arbitrary HTTP request.  Returns (status, headers_dict, body)."""
    conn = http.client.HTTPConnection(host, port, timeout=timeout)
    try:
        conn.request(method, path, body=body, headers=headers or {})
        resp = conn.getresponse()
        rbody = resp.read()
        return resp.status, dict(resp.getheaders()), rbody
    finally:
        conn.close()


def _parse_raw_http_response(data: bytes, lower_header_names: bool = False) -> tuple[int, dict, bytes]:
    header_end = data.find(b"\r\n\r\n")
    if header_end < 0:
        return 0, {}, b""

    header_text = data[:header_end].decode(errors="replace")
    body = data[header_end + 4 :]
    parts = header_text.split("\r\n")
    status_line = parts[0].split()
    if len(status_line) < 2:
        return 0, {}, b""
    try:
        status_code = int(status_line[1])
    except ValueError:
        return 0, {}, b""

    hdrs: dict[str, str] = {}
    for line in parts[1:]:
        if ":" in line:
            k, v = line.split(":", 1)
            key = k.strip().lower() if lower_header_names else k.strip()
            hdrs[key] = v.strip()

    return status_code, hdrs, body


def unix_http_request(
    socket_path: str,
    method: str,
    path: str,
    timeout: float = 5.0,
    headers: dict | None = None,
    body: bytes | None = None,
) -> tuple[int, dict, bytes]:
    """HTTP request over a Unix domain socket. Returns (status, headers, body)."""
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.settimeout(timeout)
    try:
        sock.connect(socket_path)
        req_lines = ["%s %s HTTP/1.0" % (method, path), "Host: localhost"]
        payload = body or b""
        for k, v in (headers or {}).items():
            req_lines.append("%s: %s" % (k, v))
        if payload:
            req_lines.append("Content-Length: %d" % len(payload))
        req_lines.append("")
        req_lines.append("")
        sock.sendall("\r\n".join(req_lines).encode() + payload)

        data = b""
        while True:
            try:
                chunk = sock.recv(4096)
            except socket.timeout:
                break
            if not chunk:
                break
            data += chunk
        return _parse_raw_http_response(data)
    finally:
        sock.close()


def unix_http_get(
    socket_path: str,
    path: str,
    timeout: float = 5.0,
    headers: dict | None = None,
) -> tuple[int, dict, bytes]:
    """HTTP GET over a Unix domain socket. Returns (status, headers, body)."""
    return unix_http_request(socket_path, "GET", path, timeout=timeout, headers=headers)


def extract_catchup_source(playlist_text, channel_name):
    """Extract catchup-source URL from the EXTINF line for a channel.

    Returns ``(line, catchup_source_url)``.
    """
    for line in playlist_text.splitlines():
        if channel_name in line and "catchup-source=" in line:
            match = re.search(r'catchup-source="([^"]+)"', line)
            assert match, "Expected catchup-source in line: %s" % line
            return line, match.group(1)
    raise AssertionError("Expected catchup-source line for channel: %s" % channel_name)


def stream_get(
    host: str,
    port: int,
    path: str,
    read_bytes: int = 8192,
    timeout: float = 10.0,
    headers: dict | None = None,
) -> tuple[int, dict, bytes]:
    """HTTP GET that reads up to *read_bytes* from a streaming response.

    Uses HTTP/1.0 raw sockets with a short per-recv timeout so the loop
    keeps retrying until the overall *timeout* deadline expires.  This
    handles servers that take several seconds to produce the first byte
    (e.g. rtp2httpd RTSP proxy on macOS can take ~7 s for TCP interleaved
    transport setup).

    Returns ``(status, headers_dict, body_bytes)`` or ``(0, {}, b"")``
    on total failure.
    """
    try:
        sock = socket.create_connection((host, port), timeout=timeout)
    except OSError, socket.timeout:
        return 0, {}, b""
    try:
        host_hdr = "[%s]" % host if ":" in host and not host.startswith("[") else host
        req_lines = ["GET %s HTTP/1.0" % path, "Host: %s" % host_hdr]
        for k, v in (headers or {}).items():
            req_lines.append("%s: %s" % (k, v))
        req_lines.append("")
        req_lines.append("")
        sock.sendall("\r\n".join(req_lines).encode())

        data = b""
        deadline = time.monotonic() + timeout
        target = read_bytes + 4096  # headroom for HTTP headers
        while len(data) < target:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            # Use short per-recv timeout so we keep retrying within deadline
            sock.settimeout(min(remaining, 1.0))
            try:
                chunk = sock.recv(4096)
            except socket.timeout:
                continue  # keep trying until deadline
            if not chunk:
                break
            data += chunk

        return _parse_raw_http_response(data, lower_header_names=True)
    except socket.timeout, OSError:
        return 0, {}, b""
    finally:
        sock.close()
