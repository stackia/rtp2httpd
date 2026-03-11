"""Port allocation helpers for E2E tests."""

from __future__ import annotations

import socket
import time


def find_free_port() -> int:
    """Find a free TCP port on localhost."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


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
        except (ConnectionRefusedError, OSError, socket.timeout):
            time.sleep(0.05)
    return False
