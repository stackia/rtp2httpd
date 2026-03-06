"""R2HProcess -- manages one rtp2httpd instance for testing."""

from __future__ import annotations

import os
import subprocess
import tempfile
from pathlib import Path

from .ports import wait_for_port


class R2HProcess:
    """Start / stop a rtp2httpd server for testing."""

    def __init__(
        self,
        binary: str | Path,
        port: int,
        extra_args: list[str] | None = None,
        config_content: str | None = None,
    ):
        self.binary = str(binary)
        self.port = port
        self.extra_args = list(extra_args or [])
        self.config_content = config_content
        self.process: subprocess.Popen | None = None
        self._config_path: str | None = None

    # -- lifecycle -----------------------------------------------------------

    def start(self, wait: bool = True) -> None:
        args = self._build_args()
        self.process = subprocess.Popen(
            args,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
        )
        if wait and not wait_for_port(self.port, timeout=6.0):
            out = self.get_output()
            self.stop()
            raise RuntimeError(
                "rtp2httpd did not start on port %d.\n"
                "Command: %s\nOutput:\n%s" % (self.port, " ".join(args), out)
            )

    def stop(self) -> None:
        if self.process and self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()
        if self._config_path:
            try:
                os.unlink(self._config_path)
            except FileNotFoundError:
                pass
            self._config_path = None

    def get_output(self) -> str:
        if self.process and self.process.stdout:
            import select
            readable = select.select([self.process.stdout], [], [], 0.1)[0]
            if readable:
                return self.process.stdout.read1(65536).decode("utf-8", errors="replace")
        return ""

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
