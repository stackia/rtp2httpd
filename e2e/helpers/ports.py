"""Port allocation helpers for E2E tests.

``bind(0)`` draws from the kernel ephemeral range (Linux typically 32768-60999,
macOS 49152-65535).  That races with pytest-xdist workers: a port returned by
``bind(0)`` can be reused as another worker's client source port before
rtp2httpd binds it.  CI failures such as ``rtp2httpd did not start on port
49234`` were almost all macOS ephemeral ports.

Listen ports are therefore taken from a per-xdist-worker range below those
ephemeral windows.  A short cooldown avoids immediately recycling a port that
may still be in TIME_WAIT after the previous process exits.
"""

from __future__ import annotations

import os
import socket
import threading
import time
from collections import deque

# Below Linux ip_local_port_range (32768+) and macOS net.inet.ip.portrange (49152+).
_RANGE_BASE = 14000
_RANGE_SIZE = 2300
_MAX_RANGES = 8  # 14000-32399 even with more than 8 xdist workers
_COOLDOWN = 64

_lock = threading.Lock()
_recent_tcp: deque[int] = deque(maxlen=_COOLDOWN)
_recent_udp: deque[int] = deque(maxlen=_COOLDOWN)
_tcp_cursor = 0
_udp_cursor = 0


def xdist_worker_index() -> int:
    """Return this process's pytest-xdist worker index (0 for serial runs)."""
    worker = os.environ.get("PYTEST_XDIST_WORKER", "master")
    if worker == "master":
        return 0
    if worker.startswith("gw") and worker[2:].isdigit():
        return int(worker[2:]) + 1
    return 0


def worker_port_range() -> tuple[int, int]:
    """Return the inclusive-exclusive TCP/UDP listen range for this worker."""
    start = _RANGE_BASE + (xdist_worker_index() % _MAX_RANGES) * _RANGE_SIZE
    return start, start + _RANGE_SIZE


def ipv6_loopback_available() -> bool:
    """Return True when binding a TCP socket to ::1 works on this host."""
    try:
        with socket.socket(socket.AF_INET6, socket.SOCK_STREAM) as s:
            s.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
            s.bind(("::1", 0))
        return True
    except OSError:
        return False


def _tcp_probe_targets(host: str) -> list[tuple[int, str]]:
    """Addresses whose bind success means rtp2httpd can listen here.

    Tests usually wait on 127.0.0.1, but rtp2httpd binds 0.0.0.0 (and ::).
    Probe the IPv4 wildcard so we do not hand out a port that is only free
    on the loopback address.
    """
    if host in ("127.0.0.1", "0.0.0.0", ""):
        return [(socket.AF_INET, "0.0.0.0")]
    if ":" in host:
        return [(socket.AF_INET6, host)]
    return [(socket.AF_INET, host)]


def _can_bind_tcp(host: str, port: int) -> bool:
    sockets: list[socket.socket] = []
    try:
        for family, bind_host in _tcp_probe_targets(host):
            sock = socket.socket(family, socket.SOCK_STREAM)
            sockets.append(sock)
            if family == socket.AF_INET6:
                sock.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
            sock.bind((bind_host, port))
        return True
    except OSError:
        return False
    finally:
        for sock in sockets:
            sock.close()


def _can_bind_udp(port: int) -> bool:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.bind(("", port))
        return True
    except OSError:
        return False


def find_free_port(host: str = "127.0.0.1") -> int:
    """Find a free TCP port on *host* (use "::1" for IPv6 loopback)."""
    start, end = worker_port_range()
    size = end - start
    with _lock:
        global _tcp_cursor
        for step in range(size):
            port = start + ((_tcp_cursor + step) % size)
            if port in _recent_tcp:
                continue
            if _can_bind_tcp(host, port):
                _tcp_cursor = (_tcp_cursor + step + 1) % size
                _recent_tcp.append(port)
                return port
    raise RuntimeError(f"No free TCP port in {start}-{end - 1} for {host}")


def find_free_udp_port() -> int:
    """Find a free UDP port."""
    start, end = worker_port_range()
    size = end - start
    with _lock:
        global _udp_cursor
        for step in range(size):
            port = start + ((_udp_cursor + step) % size)
            if port in _recent_udp:
                continue
            if _can_bind_udp(port):
                _udp_cursor = (_udp_cursor + step + 1) % size
                _recent_udp.append(port)
                return port
    raise RuntimeError(f"No free UDP port in {start}-{end - 1}")


def find_free_udp_port_pair() -> tuple[int, int]:
    """Find a free even/odd UDP port pair (for RTP/RTCP)."""
    start, end = worker_port_range()
    size = end - start
    with _lock:
        global _udp_cursor
        for step in range(size):
            port = start + ((_udp_cursor + step) % size)
            if port % 2 != 0 or port + 1 >= end:
                continue
            if port in _recent_udp or (port + 1) in _recent_udp:
                continue
            if _can_bind_udp(port) and _can_bind_udp(port + 1):
                _udp_cursor = (_udp_cursor + step + 2) % size
                _recent_udp.append(port)
                _recent_udp.append(port + 1)
                return port, port + 1
    raise RuntimeError(f"No free UDP port pair in {start}-{end - 1}")


def port_connectable(port: int, host: str = "127.0.0.1", timeout: float = 0.05) -> bool:
    """Return True if *host:port* accepts a TCP connection right now."""
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def unix_socket_connectable(path: str, timeout: float = 0.05) -> bool:
    """Return True if *path* accepts a Unix stream connection right now."""
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
            sock.settimeout(timeout)
            sock.connect(path)
        return True
    except OSError:
        return False


def wait_for_port(port: int, host: str = "127.0.0.1", timeout: float = 5.0) -> bool:
    """Block until *port* is accepting TCP connections (or *timeout* expires)."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if port_connectable(port, host=host, timeout=0.5):
            return True
        time.sleep(0.05)
    return False


def wait_for_unix_socket(path: str, timeout: float = 5.0) -> bool:
    """Block until *path* is accepting Unix stream socket connections."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if unix_socket_connectable(path, timeout=0.5):
            return True
        time.sleep(0.05)
    return False
