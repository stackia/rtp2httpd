"""E2E coverage for supervisor PID file lifecycle and locking."""

from __future__ import annotations

import fcntl
import os
import signal
import time
from pathlib import Path

import pytest

from helpers import R2HProcess, build_config, find_free_port


def _wait_for(predicate, timeout: float = 5.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.05)
    return predicate()


def _pid_file_contains(path: Path, pid: int) -> bool:
    try:
        return path.read_text() == f"{pid}\n"
    except FileNotFoundError:
        return False


def _wait_for_exit(r2h: R2HProcess) -> int:
    assert r2h.process is not None
    return r2h.process.wait(timeout=5)


class TestPIDFileSources:
    @pytest.mark.parametrize("source", ["cli", "config"])
    def test_writes_supervisor_pid_and_removes_file_on_stop(self, r2h_binary, tmp_path, source):
        port = find_free_port()
        pid_path = tmp_path / f"{source}.pid"
        if source == "cli":
            r2h = R2HProcess(r2h_binary, port, extra_args=["--pid-file", str(pid_path)])
        else:
            config = build_config(port, global_lines=[f"pid-file = {pid_path}"])
            r2h = R2HProcess(r2h_binary, port, config_content=config)

        try:
            r2h.start()
            assert r2h.process is not None
            pid = r2h.process.pid
            assert _wait_for(lambda: _pid_file_contains(pid_path, pid))
        finally:
            r2h.stop()

        assert not pid_path.exists()

    def test_cli_overrides_config_file_path(self, r2h_binary, tmp_path):
        port = find_free_port()
        config_path = tmp_path / "config.pid"
        cli_path = tmp_path / "cli.pid"
        config = build_config(port, global_lines=[f"pid-file = {config_path}"])
        r2h = R2HProcess(
            r2h_binary,
            port,
            config_content=config,
            extra_args=["--pid-file", str(cli_path)],
        )
        try:
            r2h.start()
            assert r2h.process is not None
            pid = r2h.process.pid
            assert _wait_for(lambda: _pid_file_contains(cli_path, pid))
            assert not config_path.exists()
        finally:
            r2h.stop()

    def test_relative_path_uses_process_working_directory(self, r2h_binary, tmp_path):
        port = find_free_port()
        pid_path = tmp_path / "relative.pid"
        relative_path = os.path.relpath(pid_path, Path.cwd())
        r2h = R2HProcess(r2h_binary, port, extra_args=["--pid-file", relative_path])
        try:
            r2h.start()
            assert r2h.process is not None
            pid = r2h.process.pid
            assert _wait_for(lambda: _pid_file_contains(pid_path, pid))
        finally:
            r2h.stop()

        assert not pid_path.exists()


class TestPIDFileLocking:
    def test_locked_file_rejects_second_instance(self, r2h_binary, tmp_path):
        pid_path = tmp_path / "shared.pid"
        first = R2HProcess(r2h_binary, find_free_port(), extra_args=["--pid-file", str(pid_path)])
        second = R2HProcess(r2h_binary, find_free_port(), extra_args=["--pid-file", str(pid_path)])
        try:
            first.start()
            assert first.process is not None
            first_pid = first.process.pid
            assert _wait_for(lambda: _pid_file_contains(pid_path, first_pid))

            second.start(wait=False)
            assert _wait_for_exit(second) != 0
            assert pid_path.read_text() == f"{first_pid}\n"
        finally:
            second.stop()
            first.stop()

    def test_unlocked_stale_file_is_replaced(self, r2h_binary, tmp_path):
        pid_path = tmp_path / "stale.pid"
        pid_path.write_text("999999\n")
        r2h = R2HProcess(r2h_binary, find_free_port(), extra_args=["--pid-file", str(pid_path)])
        try:
            r2h.start()
            assert r2h.process is not None
            pid = r2h.process.pid
            assert _wait_for(lambda: _pid_file_contains(pid_path, pid))
        finally:
            r2h.stop()


class TestPIDFileFailures:
    @pytest.mark.parametrize("invalid_kind", ["missing-parent", "directory", "symlink"])
    def test_invalid_target_rejects_startup(self, r2h_binary, tmp_path, invalid_kind):
        if invalid_kind == "missing-parent":
            pid_path = tmp_path / "missing" / "rtp2httpd.pid"
        elif invalid_kind == "directory":
            pid_path = tmp_path / "pid-directory"
            pid_path.mkdir()
        else:
            target = tmp_path / "target.pid"
            target.write_text("unchanged\n")
            pid_path = tmp_path / "pid-link"
            pid_path.symlink_to(target)

        r2h = R2HProcess(r2h_binary, find_free_port(), extra_args=["--pid-file", str(pid_path)])
        try:
            r2h.start(wait=False)
            assert _wait_for_exit(r2h) != 0
        finally:
            r2h.stop()


class TestPIDFileReload:
    @pytest.mark.parametrize("replacement", ["missing", "stale"])
    def test_reload_reclaims_replaced_same_path(self, r2h_binary, tmp_path, replacement):
        port = find_free_port()
        pid_path = tmp_path / "same.pid"
        config = build_config(port, global_lines=[f"pid-file = {pid_path}"])
        first = R2HProcess(r2h_binary, port, config_content=config)
        second = R2HProcess(r2h_binary, find_free_port(), extra_args=["--pid-file", str(pid_path)])
        try:
            first.start()
            assert first.process is not None
            pid = first.process.pid
            assert _wait_for(lambda: _pid_file_contains(pid_path, pid))

            pid_path.unlink()
            if replacement == "stale":
                pid_path.write_text("999999\n")

            os.kill(pid, signal.SIGHUP)
            assert _wait_for(lambda: _pid_file_contains(pid_path, pid))

            second.start(wait=False)
            assert _wait_for_exit(second) != 0
            assert pid_path.read_text() == f"{pid}\n"
        finally:
            second.stop()
            first.stop()

    def test_reload_equivalent_path_keeps_file_and_lock(self, r2h_binary, tmp_path):
        port = find_free_port()
        pid_path = tmp_path / "same.pid"
        equivalent_path = f"{tmp_path}/./same.pid"
        config = build_config(port, global_lines=[f"pid-file = {pid_path}"])
        first = R2HProcess(r2h_binary, port, config_content=config, capture_log=True)
        second = R2HProcess(r2h_binary, find_free_port(), extra_args=["--pid-file", str(pid_path)])
        try:
            first.start()
            assert first.process is not None
            assert first._config_path is not None
            pid = first.process.pid
            assert _wait_for(lambda: _pid_file_contains(pid_path, pid))

            Path(first._config_path).write_text(build_config(port, global_lines=[f"pid-file = {equivalent_path}"]))
            os.kill(pid, signal.SIGHUP)

            assert _wait_for(lambda: "Configuration reloaded successfully" in first.read_log())
            assert pid_path.read_text() == f"{pid}\n"

            second.start(wait=False)
            assert _wait_for_exit(second) != 0
            assert pid_path.read_text() == f"{pid}\n"
        finally:
            second.stop()
            first.stop()

    def test_reload_moves_pid_file(self, r2h_binary, tmp_path):
        port = find_free_port()
        old_path = tmp_path / "old.pid"
        new_path = tmp_path / "new.pid"
        config = build_config(port, global_lines=[f"pid-file = {old_path}"])
        r2h = R2HProcess(r2h_binary, port, config_content=config)
        try:
            r2h.start()
            assert r2h.process is not None
            assert r2h._config_path is not None
            pid = r2h.process.pid
            assert _wait_for(lambda: _pid_file_contains(old_path, pid))

            Path(r2h._config_path).write_text(build_config(port, global_lines=[f"pid-file = {new_path}"]))
            os.kill(pid, signal.SIGHUP)

            assert _wait_for(lambda: _pid_file_contains(new_path, pid) and not old_path.exists())

            Path(r2h._config_path).write_text(build_config(port))
            os.kill(pid, signal.SIGHUP)
            assert _wait_for(lambda: not new_path.exists())
        finally:
            r2h.stop()

        assert not new_path.exists()

    def test_reload_lock_failure_keeps_old_pid_file(self, r2h_binary, tmp_path):
        port = find_free_port()
        old_path = tmp_path / "old.pid"
        locked_path = tmp_path / "locked.pid"
        config = build_config(port, global_lines=[f"pid-file = {old_path}"])
        r2h = R2HProcess(r2h_binary, port, config_content=config, capture_log=True)

        with locked_path.open("w+") as locked_file:
            fcntl.lockf(locked_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
            try:
                r2h.start()
                assert r2h.process is not None
                assert r2h._config_path is not None
                pid = r2h.process.pid
                assert _wait_for(lambda: _pid_file_contains(old_path, pid))

                Path(r2h._config_path).write_text(build_config(port, global_lines=[f"pid-file = {locked_path}"]))
                os.kill(pid, signal.SIGHUP)

                assert _wait_for(lambda: "Failed to prepare PID file" in r2h.read_log())
                assert old_path.read_text() == f"{pid}\n"
            finally:
                r2h.stop()
