"""R2HProcess -- manages one rtp2httpd instance for testing."""

from __future__ import annotations

import os
import subprocess
import tempfile
from pathlib import Path

from .ports import wait_for_port


def make_m3u_rtsp_config(r2h_port: int, rtsp_port: int, channel_name: str, configured_url_query: str = "") -> str:
    """Build a minimal rtp2httpd config with one M3U-configured RTSP channel.

    `configured_url_query` is appended verbatim after `/stream` (so callers
    pass e.g. `"?r2h-seek-mode=range"` or `""` for none)."""
    return (
        "[global]\nverbosity = 4\n\n[bind]\n* %d\n\n[services]\n#EXTM3U\n#EXTINF:-1,%s\nrtsp://127.0.0.1:%d/stream%s\n"
    ) % (r2h_port, channel_name, rtsp_port, configured_url_query)


class R2HProcess:
    """Start / stop a rtp2httpd server for testing."""

    def __init__(
        self,
        binary: str | Path,
        port: int,
        extra_args: list[str] | None = None,
        config_content: str | None = None,
        capture_log: bool = False,
    ):
        self.binary = str(binary)
        self.port = port
        self.extra_args = list(extra_args or [])
        self.config_content = config_content
        self.capture_log = capture_log
        self.process: subprocess.Popen | None = None
        self._config_path: str | None = None
        self._log_path: str | None = None
        self._log_handle = None

    # -- lifecycle -----------------------------------------------------------

    def start(self, wait: bool = True) -> None:
        args = self._build_args()
        if self.capture_log:
            log_fd, self._log_path = tempfile.mkstemp(suffix=".log", prefix="r2h_log_")
            self._log_handle = os.fdopen(log_fd, "w")
            self.process = subprocess.Popen(args, stdout=self._log_handle, stderr=self._log_handle)
        else:
            self.process = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if wait and not wait_for_port(self.port, timeout=6.0):
            self.stop()
            raise RuntimeError("rtp2httpd did not start on port %d.\nCommand: %s" % (self.port, " ".join(args)))

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
        assert self._log_path is not None, "read_log requires capture_log=True at construction time"
        with open(self._log_path) as f:
            return f.read()

    # -- internals -----------------------------------------------------------

    def _build_args(self) -> list[str]:
        if self.config_content is not None:
            fd, path = tempfile.mkstemp(suffix=".conf", prefix="r2h_test_")
            with os.fdopen(fd, "w") as f:
                f.write(self.config_content)
            self._config_path = path
            args = [self.binary, "-c", path]
        else:
            args = [self.binary, "-C"]

        args.extend(["-l", str(self.port)])
        args.extend(self.extra_args)
        return args
