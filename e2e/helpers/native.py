"""Compile small kernel/resource integration checks against production C code."""

import os
import platform
import shlex
import subprocess
from pathlib import Path

from .constants import PROJECT_ROOT


def run_native_test(tmp_path: Path, name: str, sources: list[str]) -> None:
    executable = tmp_path / name
    subprocess.run(
        [
            *shlex.split(os.environ.get("CC", "cc")),
            "-std=gnu11",
            "-Wall",
            "-Wextra",
            "-Werror",
            *(["-D_GNU_SOURCE"] if platform.system() == "Linux" else []),
            "-I",
            str(PROJECT_ROOT / "src"),
            str(PROJECT_ROOT / "e2e" / f"{name}.c"),
            *(str(PROJECT_ROOT / source) for source in sources),
            "-o",
            str(executable),
        ],
        check=True,
        capture_output=True,
        text=True,
        timeout=30,
    )
    subprocess.run([str(executable)], check=True, capture_output=True, text=True, timeout=10)
