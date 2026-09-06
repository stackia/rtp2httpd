"""Exercise the production poller backend against the host kernel."""

from helpers import run_native_test


def test_poller_trigger_mode_transitions(tmp_path):
    run_native_test(tmp_path, "poller_modes", ["src/poller_epoll.c", "src/poller_kqueue.c"])
