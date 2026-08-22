"""Unit coverage for listen-port allocation.

These tests do not start rtp2httpd.  They guard the ephemeral-port race that
caused CI failures such as ``rtp2httpd did not start on port 49234``.
"""

import os
import socket

import pytest
from helpers import (
    R2HProcess,
    find_free_port,
    find_free_udp_port,
    find_free_udp_port_pair,
    wait_for_port,
    worker_port_range,
)


def test_find_free_port_stays_in_worker_range():
    start, end = worker_port_range()
    port = find_free_port()
    assert start <= port < end
    assert port < 32768


def test_find_free_port_does_not_reuse_immediately():
    first = find_free_port()
    second = find_free_port()
    assert first != second


def test_find_free_port_is_bindable_on_wildcard():
    port = find_free_port()
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("0.0.0.0", port))
        sock.listen(1)
        assert wait_for_port(port, timeout=1.0)


def test_find_free_udp_port_stays_in_worker_range():
    start, end = worker_port_range()
    port = find_free_udp_port()
    assert start <= port < end
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.bind(("", port))


def test_find_free_udp_port_pair_is_adjacent_and_bindable():
    start, end = worker_port_range()
    even, odd = find_free_udp_port_pair()
    assert even % 2 == 0
    assert odd == even + 1
    assert start <= even < odd < end
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s1, socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s2:
        s1.bind(("", even))
        s2.bind(("", odd))


def test_r2h_start_fail_fast_includes_exit_code(tmp_path):
    # FreeBSD has no /bin/false; use a portable immediate-exit script.
    script = tmp_path / "immediate_exit"
    script.write_text("#!/bin/sh\nexit 7\n")
    os.chmod(script, 0o755)
    r2h = R2HProcess(script, find_free_port())
    try:
        with pytest.raises(RuntimeError, match="exited with code 7"):
            r2h.start()
    finally:
        r2h.stop()
