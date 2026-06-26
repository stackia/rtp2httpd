"""
E2E tests for Unix domain socket listeners.

Tests cover CLI and config-file Unix socket binds, mixed TCP/Unix listeners,
multi-worker accept behavior, stale socket cleanup, regular-file rejection,
zero-copy disablement, and file responses over Unix sockets.
"""

from __future__ import annotations

import os
import signal
import socket
import tempfile
import time

from helpers import (
    MockHTTPUpstreamSilent,
    R2HProcess,
    find_free_port,
    http_get,
    unix_http_get,
    wait_for_unix_socket,
    write_temp_file,
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


def _wait_unix_http_status(socket_path: str, path: str, expected_status: int = 200, timeout: float = 5.0) -> None:
    deadline = time.time() + timeout
    last_status = None
    while time.time() < deadline:
        try:
            status, _, _ = unix_http_get(socket_path, path)
            last_status = status
            if status == expected_status:
                return
        except OSError:
            pass
        time.sleep(0.1)
    assert last_status == expected_status


def _wait_unix_http_body_contains(socket_path: str, path: str, needle: bytes, timeout: float = 5.0) -> bytes:
    deadline = time.time() + timeout
    last_body = b""
    while time.time() < deadline:
        try:
            status, _, body = unix_http_get(socket_path, path)
            if status == 200:
                last_body = body
                if needle in body:
                    return body
        except OSError:
            pass
        time.sleep(0.1)
    assert needle in last_body
    return last_body


def _wait_log_contains(r2h: R2HProcess, needle: str, timeout: float = 5.0) -> None:
    deadline = time.time() + timeout
    last_log = ""
    while time.time() < deadline:
        last_log = r2h.read_log()
        if needle in last_log:
            return
        time.sleep(0.1)
    assert needle in last_log


def _wait_file_contains(path: str, needle: str, timeout: float = 5.0) -> None:
    deadline = time.time() + timeout
    last_text = ""
    while time.time() < deadline:
        if os.path.exists(path):
            with open(path) as f:
                last_text = f.read()
            if needle in last_text:
                return
        time.sleep(0.1)
    assert needle in last_text


def _open_unix_http_stream(socket_path: str, path: str) -> socket.socket:
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.settimeout(5.0)
    sock.connect(socket_path)
    request = "GET %s HTTP/1.0\r\nHost: localhost\r\n\r\n" % path
    sock.sendall(request.encode())
    return sock


def _wait_status_sse_contains(socket_path: str, needle: str, timeout: float = 5.0) -> None:
    deadline = time.time() + timeout
    last_body = ""
    while time.time() < deadline:
        status, _, body = unix_http_get(socket_path, "/status/sse", timeout=0.5)
        last_body = body.decode(errors="replace")
        if status == 200 and needle in last_body:
            return
        time.sleep(0.1)
    assert needle in last_body


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
                assert "New client localhost requested URL: /status" in r2h.read_log()
            finally:
                r2h.stop()

    def test_unix_socket_client_addr_displays_as_localhost(self, r2h_binary):
        with tempfile.TemporaryDirectory() as tmpdir:
            sock_path = _socket_path(tmpdir)
            access_log_path = os.path.join(tmpdir, "access.log")
            upstream = MockHTTPUpstreamSilent()
            upstream.start()
            config = f"""\
[global]
verbosity = 4
access-log = {access_log_path}
log-format = $client_addr|$remote_addr|$remote_port

[bind]
{sock_path}
"""
            r2h = R2HProcess(r2h_binary, None, config_content=config, wait_socket_path=sock_path)
            media_sock = None
            try:
                r2h.start()
                media_sock = _open_unix_http_stream(sock_path, f"/http/127.0.0.1:{upstream.port}/hello")

                _wait_file_contains(access_log_path, "localhost|localhost|-")
                _wait_status_sse_contains(sock_path, '"clientAddr":"localhost"')
            finally:
                if media_sock:
                    media_sock.close()
                r2h.stop()
                upstream.stop()

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

    def test_active_socket_path_fails_startup(self, r2h_binary):
        with tempfile.TemporaryDirectory() as tmpdir:
            sock_path = _socket_path(tmpdir)
            active = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            active.bind(sock_path)
            active.listen(1)

            r2h = R2HProcess(r2h_binary, None, extra_args=["-v", "4"], capture_log=True, listen=sock_path)
            try:
                r2h.start(wait=False)
                assert r2h.process is not None
                r2h.process.wait(timeout=5)
                assert r2h.process.returncode != 0
                log = r2h.read_log()
                assert "already in use" in log
            finally:
                r2h.stop()
                active.close()

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

    def test_reload_keeps_old_unix_listener_when_new_path_fails(self, r2h_binary):
        with tempfile.TemporaryDirectory() as tmpdir:
            old_sock_path = os.path.join(tmpdir, "old.sock")
            bad_sock_path = os.path.join(tmpdir, "bad.sock")
            old_epg_path = os.path.join(tmpdir, "old-epg.xml")
            new_epg_path = os.path.join(tmpdir, "new-epg.xml")
            with open(bad_sock_path, "wb") as f:
                f.write(b"not a socket")
            with open(old_epg_path, "wb") as f:
                f.write(SAMPLE_EPG_XML.replace("Unix Socket Programme", "Old Programme").encode())
            with open(new_epg_path, "wb") as f:
                f.write(SAMPLE_EPG_XML.replace("Unix Socket Programme", "New Programme").encode())

            old_config = f"""\
[global]
verbosity = 4
workers = 1
status-page-path = /oldstatus

[bind]
{old_sock_path}

[services]
#EXTM3U x-tvg-url="file://{old_epg_path}"
#EXTINF:-1,Old Channel
rtp://239.0.0.1:1234
"""
            bad_config = f"""\
[global]
verbosity = 4
workers = 2
status-page-path = /newstatus

[bind]
{bad_sock_path}

[services]
#EXTM3U x-tvg-url="file://{new_epg_path}"
#EXTINF:-1,New Channel
rtp://239.0.0.2:1234
"""
            r2h = R2HProcess(
                r2h_binary, None, config_content=old_config, capture_log=True, wait_socket_path=old_sock_path
            )
            try:
                r2h.start()
                status, _, _ = unix_http_get(old_sock_path, "/oldstatus")
                assert status == 200
                status, _, body = unix_http_get(old_sock_path, "/playlist.m3u")
                assert status == 200
                playlist = body.decode()
                assert "Old Channel" in playlist
                assert "New Channel" not in playlist
                _wait_unix_http_body_contains(old_sock_path, "/epg.xml", b"Old Programme")

                assert r2h._config_path is not None
                with open(r2h._config_path, "w") as f:
                    f.write(bad_config)
                assert r2h.process is not None
                os.kill(r2h.process.pid, signal.SIGHUP)
                time.sleep(0.5)

                status, _, _ = unix_http_get(old_sock_path, "/oldstatus")
                assert status == 200
                log = r2h.read_log()
                assert "Unix socket path exists and is not a socket" in log
                assert "keeping existing workers and listeners" in log

                os.kill(r2h.process.pid, signal.SIGUSR1)
                _wait_log_contains(r2h, "Restarting worker 0")
                _wait_unix_http_status(old_sock_path, "/oldstatus")
                body = _wait_unix_http_body_contains(old_sock_path, "/playlist.m3u", b"Old Channel")
                playlist = body.decode()
                assert "Old Channel" in playlist
                assert "New Channel" not in playlist
                body = _wait_unix_http_body_contains(old_sock_path, "/epg.xml", b"Old Programme")
                assert b"Old Programme" in body
                assert b"New Programme" not in body
                status, _, _ = unix_http_get(old_sock_path, "/newstatus")
                assert status != 200
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
        epg_path = write_temp_file(SAMPLE_EPG_XML.encode(), suffix=".xml", prefix="r2h_unix_epg_")
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
