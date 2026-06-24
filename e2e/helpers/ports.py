"""Port allocation helpers for E2E tests."""

from __future__ import annotations

import socket
import time


def find_free_port(host: str = "127.0.0.1") -> int:
    """Find a free TCP port on *host* (use "::1" for IPv6 loopback)."""
    family = socket.AF_INET6 if ":" in host else socket.AF_INET
    with socket.socket(family, socket.SOCK_STREAM) as s:
        s.bind((host, 0))
        return s.getsockname()[1]


def ipv6_loopback_available() -> bool:
    """Return True when binding a TCP socket to ::1 works on this host."""
    try:
        with socket.socket(socket.AF_INET6, socket.SOCK_STREAM) as s:
            s.bind(("::1", 0))
        return True
    except OSError:
        return False


def find_free_udp_port() -> int:
    """Find a free UDP port."""
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        s.bind(("", 0))
        return s.getsockname()[1]


def find_free_udp_port_pair() -> tuple[int, int]:
    """Find a free even/odd UDP port pair (for RTP/RTCP)."""
    for _ in range(100):
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s1:
            s1.bind(("", 0))
            p = s1.getsockname()[1]
            if p % 2 != 0:
                continue
            try:
                with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s2:
                    s2.bind(("", p + 1))
                    return p, p + 1
            except OSError:
                continue
    # fallback
    return find_free_udp_port(), find_free_udp_port()


def wait_for_port(port: int, host: str = "127.0.0.1", timeout: float = 5.0) -> bool:
    """Block until *port* is accepting TCP connections (or *timeout* expires)."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with socket.create_connection((host, port), timeout=0.5):
                return True
        except ConnectionRefusedError, OSError, socket.timeout:
            time.sleep(0.05)
    return False


def wait_for_unix_socket(path: str, timeout: float = 5.0) -> bool:
    """Block until *path* is accepting Unix stream socket connections."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
                sock.settimeout(0.5)
                sock.connect(path)
                return True
        except OSError:
            time.sleep(0.05)
    return False
