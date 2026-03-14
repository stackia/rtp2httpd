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
    except (OSError, socket.timeout):
        return 0, {}, b""
    try:
        req_lines = ["GET %s HTTP/1.0" % path, "Host: %s" % host]
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

        header_end = data.find(b"\r\n\r\n")
        if header_end < 0:
            return 0, {}, b""

        header_text = data[:header_end].decode(errors="replace")
        body = data[header_end + 4:]

        parts = header_text.split("\r\n")
        status_code = int(parts[0].split()[1])

        hdrs: dict[str, str] = {}
        for line in parts[1:]:
            if ":" in line:
                k, v = line.split(":", 1)
                hdrs[k.strip().lower()] = v.strip()

        return status_code, hdrs, body
    except (socket.timeout, OSError):
        return 0, {}, b""
    finally:
        sock.close()
