"""
E2E tests for Unix domain socket listeners.

Tests cover CLI and config-file Unix socket binds, mixed TCP/Unix listeners,
multi-worker accept behavior, stale socket cleanup, regular-file rejection,
zero-copy disablement, and file responses over Unix sockets.
"""

from __future__ import annotations

import os
import socket
import tempfile
import time

from helpers import (
    R2HProcess,
    find_free_port,
    http_get,
    unix_http_get,
    wait_for_unix_socket,
)

SAMPLE_EPG_XML = """\
<?xml version="1.0" encoding="UTF-8"?>
<tv generator-info-name="test">
  <channel id="CH1">
    <display-name>Channel 1</display-name>
  </channel>
  <programme start="20260101000000 +0000" stop="20260101010000 +0000" channel="CH1">
    <title>Unix Socket Programme</title>
  </programme>
</tv>
"""


def _socket_path(tmpdir: str) -> str:
    return os.path.join(tmpdir, "rtp2httpd.sock")


def _write_tmp(data: bytes, suffix: str = ".xml") -> str:
    fd, path = tempfile.mkstemp(suffix=suffix, prefix="r2h_unix_epg_")
    with os.fdopen(fd, "wb") as f:
        f.write(data)
    return path


class TestUnixSocketListen:
    def test_cli_unix_socket_serves_status(self, r2h_binary):
        with tempfile.TemporaryDirectory() as tmpdir:
            sock_path = _socket_path(tmpdir)
            r2h = R2HProcess(r2h_binary, None, extra_args=["-v", "4"], capture_log=True, listen=sock_path)
            try:
                r2h.start()
                status, hdrs, body = unix_http_get(sock_path, "/status")
                content_type = hdrs.get("Content-Type", "").lower()
                assert status == 200
                assert "text/html" in content_type
                assert len(body) > 0
                assert "New client unix requested URL: /status" in r2h.read_log()
            finally:
                r2h.stop()

    def test_config_unix_socket_serves_status(self, r2h_binary):
        with tempfile.TemporaryDirectory() as tmpdir:
            sock_path = _socket_path(tmpdir)
            config = f"""\
[global]
verbosity = 4

[bind]
{sock_path}
"""
            r2h = R2HProcess(r2h_binary, None, config_content=config, wait_socket_path=sock_path)
            try:
                r2h.start()
                status, _, _ = unix_http_get(sock_path, "/status")
                assert status == 200
            finally:
                r2h.stop()

    def test_mixed_tcp_and_unix_listeners(self, r2h_binary):
        port = find_free_port()
        with tempfile.TemporaryDirectory() as tmpdir:
            sock_path = _socket_path(tmpdir)
            r2h = R2HProcess(r2h_binary, port, extra_args=["-v", "4", "-l", sock_path])
            try:
                r2h.start()
                assert wait_for_unix_socket(sock_path)

                status, _, _ = http_get("127.0.0.1", port, "/status")
                assert status == 200

                status, _, _ = unix_http_get(sock_path, "/status")
                assert status == 200
            finally:
                r2h.stop()

    def test_unix_socket_multiple_workers(self, r2h_binary):
        with tempfile.TemporaryDirectory() as tmpdir:
            sock_path = _socket_path(tmpdir)
            r2h = R2HProcess(r2h_binary, None, extra_args=["-v", "4", "-w", "2"], listen=sock_path)
            try:
                r2h.start()
                for _ in range(8):
                    status, _, _ = unix_http_get(sock_path, "/status")
                    assert status == 200
            finally:
                r2h.stop()

    def test_stale_socket_path_is_cleaned(self, r2h_binary):
        with tempfile.TemporaryDirectory() as tmpdir:
            sock_path = _socket_path(tmpdir)
            stale = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            try:
                stale.bind(sock_path)
            finally:
                stale.close()

            r2h = R2HProcess(r2h_binary, None, extra_args=["-v", "4"], listen=sock_path)
            try:
                r2h.start()
                status, _, _ = unix_http_get(sock_path, "/status")
                assert status == 200
            finally:
                r2h.stop()

    def test_regular_file_socket_path_fails_startup(self, r2h_binary):
        with tempfile.TemporaryDirectory() as tmpdir:
            sock_path = _socket_path(tmpdir)
            with open(sock_path, "wb") as f:
                f.write(b"not a socket")

            r2h = R2HProcess(r2h_binary, None, extra_args=["-v", "4"], capture_log=True, listen=sock_path)
            try:
                r2h.start(wait=False)
                assert r2h.process is not None
                r2h.process.wait(timeout=5)
                assert r2h.process.returncode != 0
                log = r2h.read_log()
                assert "not a socket" in log
            finally:
                r2h.stop()

    def test_unix_socket_disables_zerocopy(self, r2h_binary):
        with tempfile.TemporaryDirectory() as tmpdir:
            sock_path = _socket_path(tmpdir)
            r2h = R2HProcess(
                r2h_binary,
                None,
                extra_args=["-v", "4", "--zerocopy-on-send"],
                capture_log=True,
                listen=sock_path,
            )
            try:
                r2h.start()
                status, _, _ = unix_http_get(sock_path, "/status")
                assert status == 200
                log = r2h.read_log()
                assert "Zero-copy send disabled because Unix socket listener is configured" in log
            finally:
                r2h.stop()

    def test_epg_file_response_over_unix_socket(self, r2h_binary):
        epg_path = _write_tmp(SAMPLE_EPG_XML.encode())
        try:
            with tempfile.TemporaryDirectory() as tmpdir:
                sock_path = _socket_path(tmpdir)
                config = f"""\
[global]
verbosity = 4

[bind]
{sock_path}

[services]
#EXTM3U x-tvg-url="file://{epg_path}"
#EXTINF:-1,Channel
rtp://239.0.0.1:1234
"""
                r2h = R2HProcess(r2h_binary, None, config_content=config, wait_socket_path=sock_path)
                try:
                    r2h.start()
                    time.sleep(0.5)
                    status, hdrs, body = unix_http_get(sock_path, "/epg.xml")
                    assert status == 200
                    assert "xml" in hdrs.get("Content-Type", "").lower()
                    assert b"Unix Socket Programme" in body
                finally:
                    r2h.stop()
        finally:
            os.unlink(epg_path)
