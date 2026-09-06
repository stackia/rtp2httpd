"""Exercise the production poller backend against the host kernel."""

import os
import shlex
import subprocess
from pathlib import Path


def test_poller_trigger_mode_transitions(tmp_path):
    root = Path(__file__).resolve().parent.parent
    executable = tmp_path / "poller_modes"
    compiler = shlex.split(os.environ.get("CC", "cc"))
    subprocess.run(
        [
            *compiler,
            "-std=c11",
            "-Wall",
            "-Wextra",
            "-Werror",
            "-I",
            str(root / "src"),
            str(root / "e2e/poller_modes.c"),
            str(root / "src/poller_epoll.c"),
            str(root / "src/poller_kqueue.c"),
            "-o",
            str(executable),
        ],
        check=True,
        capture_output=True,
        text=True,
        timeout=30,
    )
    subprocess.run([str(executable)], check=True, capture_output=True, text=True, timeout=10)
