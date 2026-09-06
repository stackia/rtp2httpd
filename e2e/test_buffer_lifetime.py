"""Check shared payload lifetime and queue accounting against real sockets."""

from helpers import run_native_test


def test_buffer_lifetime(tmp_path):
    run_native_test(tmp_path, "buffer_lifetime", ["src/buffer_pool.c", "src/send_queue.c"])
