"""R2HProcess -- manages one rtp2httpd instance for testing."""

from __future__ import annotations

import os
import subprocess
import tempfile
import time
from pathlib import Path

from .ports import port_connectable, unix_socket_connectable


def make_m3u_rtsp_config(r2h_port: int, rtsp_port: int, channel_name: str, configured_url_query: str = "") -> str:
    """Build a minimal rtp2httpd config with one M3U-configured RTSP channel.

    `configured_url_query` is appended verbatim after `/stream` (so callers
    pass e.g. `"?r2h-seek-mode=range"` or `""` for none)."""
    return f"[global]\nverbosity = 4\n\n[bind]\n* {r2h_port}\n\n[services]\n#EXTM3U\n#EXTINF:-1,{channel_name}\nrtsp://127.0.0.1:{rtsp_port}/stream{configured_url_query}\n"


class R2HProcess:
    """Start / stop a rtp2httpd server for testing."""

    def __init__(
        self,
        binary: str | Path,
        port: int | None,
        extra_args: list[str] | None = None,
        config_content: str | None = None,
        capture_log: bool = False,
        listen: str | None = None,
        wait_socket_path: str | None = None,
    ):
        self.binary = str(binary)
        self.port = port
        self.extra_args = list(extra_args or [])
        self.config_content = config_content
        self.capture_log = capture_log
        self.listen = listen
        self.wait_socket_path = wait_socket_path
        self.process: subprocess.Popen | None = None
        self._config_path: str | None = None
        self._log_path: str | None = None
        self._log_handle = None

    # -- lifecycle -----------------------------------------------------------

    def start(self, wait: bool = True) -> None:
        args = self._build_args()
        log_fd, self._log_path = tempfile.mkstemp(suffix=".log", prefix="r2h_log_")
        self._log_handle = os.fdopen(log_fd, "w")
        try:
            self.process = subprocess.Popen(args, stdout=self._log_handle, stderr=self._log_handle)
        except OSError as exc:
            raise RuntimeError(f"failed to spawn rtp2httpd: {exc}.\nCommand: {' '.join(args)}") from exc
        if wait:
            error = self._wait_until_ready()
            if error:
                detail = self._startup_failure_detail(args, error)
                self.stop()
                raise RuntimeError(detail)

    def stop(self) -> None:
        if self.process and self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()
        if self._log_handle is not None:
            self._log_handle.close()
            self._log_handle = None
        if self._log_path:
            try:
                os.unlink(self._log_path)
            except FileNotFoundError:
                pass
            self._log_path = None
        if self._config_path:
            try:
                os.unlink(self._config_path)
            except FileNotFoundError:
                pass
            self._config_path = None

    def read_log(self) -> str:
        """Return the captured rtp2httpd stdout/stderr."""
        assert self._log_path is not None, "read_log requires the process to have been started"
        if self._log_handle is not None:
            self._log_handle.flush()
        with open(self._log_path) as f:
            return f.read()

    # -- internals -----------------------------------------------------------

    def _ready_timeout(self) -> float:
        return 10.0 if os.environ.get("CI") else 6.0

    def _is_listening(self) -> bool:
        if self.wait_socket_path:
            return unix_socket_connectable(self.wait_socket_path)
        if self.listen and self.listen.startswith("/"):
            return unix_socket_connectable(self.listen)
        if self.port is not None:
            return port_connectable(self.port)
        return True

    def _wait_until_ready(self) -> str | None:
        """Return None when ready, or a short reason if startup failed."""
        assert self.process is not None
        timeout = self._ready_timeout()
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self.process.poll() is not None:
                return f"process exited with code {self.process.returncode}"
            if self._is_listening():
                return None
            time.sleep(0.05)
        return f"timed out after {timeout:.1f}s waiting for listen"

    def _startup_failure_detail(self, args: list[str], error: str) -> str:
        if self.wait_socket_path:
            target = f"Unix socket {self.wait_socket_path}"
        elif self.listen and self.listen.startswith("/"):
            target = f"Unix socket {self.listen}"
        elif self.port is not None:
            target = f"port {self.port}"
        else:
            target = "the configured listener"
        log = ""
        try:
            log = self.read_log().strip()
        except OSError:
            pass
        if len(log) > 4000:
            log = log[-4000:]
        detail = f"rtp2httpd did not start on {target}: {error}.\nCommand: {' '.join(args)}"
        if log:
            detail += f"\n--- rtp2httpd log ---\n{log}\n--- end log ---"
        return detail

    def _build_args(self) -> list[str]:
        if self.config_content is not None:
            fd, path = tempfile.mkstemp(suffix=".conf", prefix="r2h_test_")
            with os.fdopen(fd, "w") as f:
                f.write(self.config_content)
            self._config_path = path
            args = [self.binary, "-c", path]
        else:
            args = [self.binary, "-C"]

        if self.listen is not None:
            args.extend(["-l", self.listen])
        elif self.port is not None:
            args.extend(["-l", str(self.port)])
        args.extend(self.extra_args)
        return args
