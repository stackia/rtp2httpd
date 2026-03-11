"""
E2E tests for error handling.

Tests cover 404 for unknown paths, invalid URLs, unsupported methods,
and other edge cases.
"""

import socket
import time

import pytest

from helpers import (
    R2HProcess,
    find_free_port,
    http_get,
    http_request,
    stream_get,
)


# ---------------------------------------------------------------------------
# Module-scoped shared rtp2httpd instance (basic -v 4 -m 100)
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def basic_r2h(r2h_binary):
    """A single rtp2httpd instance shared by tests using default config."""
    port = find_free_port()
    r2h = R2HProcess(r2h_binary, port, extra_args=["-v", "4", "-m", "100"])
    r2h.start()
    yield r2h
    r2h.stop()


# ---------------------------------------------------------------------------
# 404 for unknown paths
# ---------------------------------------------------------------------------


class TestNotFound:
    """Paths that don't match any route should return 404."""

    def test_random_path_404(self, basic_r2h):
        status, _, _ = http_get("127.0.0.1", basic_r2h.port, "/nonexistent/path")
        assert status == 404

    def test_typo_status_page_404(self, basic_r2h):
        """A close-but-wrong path should still 404."""
        status, _, _ = http_get("127.0.0.1", basic_r2h.port, "/statuss")
        assert status == 404

    def test_unknown_service_name_404(self, r2h_binary):
        """A service name that doesn't exist should return 404."""
        port = find_free_port()
        config = f"""\
[global]
verbosity = 4

[bind]
* {port}

[services]
#EXTM3U
#EXTINF:-1,Known Channel
rtp://239.0.0.1:1234
"""
        r2h = R2HProcess(r2h_binary, port, config_content=config)
        try:
            r2h.start()
            status, _, _ = http_get("127.0.0.1", port, "/Unknown%20Channel")
            assert status == 404
        finally:
            r2h.stop()


# ---------------------------------------------------------------------------
# Invalid RTP/UDP address
# ---------------------------------------------------------------------------


class TestInvalidAddress:
    """Malformed multicast addresses should be rejected."""

    def test_no_port_in_rtp_url(self, basic_r2h):
        status, _, _ = stream_get(
            "127.0.0.1", basic_r2h.port,
            "/rtp/239.0.0.1",  # missing :port
            read_bytes=256, timeout=3.0,
        )
        # rtp2httpd may accept it (200 then close) or reject (400/404/503)
        assert status in (0, 200, 400, 404, 503)

    def test_invalid_ip_in_rtp_url(self, basic_r2h):
        status, _, _ = stream_get(
            "127.0.0.1", basic_r2h.port,
            "/rtp/not-an-ip:1234",
            read_bytes=256, timeout=3.0,
        )
        assert status in (0, 200, 400, 404, 500, 503)


# ---------------------------------------------------------------------------
# Method handling
# ---------------------------------------------------------------------------


class TestMethodHandling:
    """Verify responses to various HTTP methods."""

    def test_get_status_200(self, basic_r2h):
        status, _, _ = http_request("127.0.0.1", basic_r2h.port, "GET", "/status")
        assert status == 200

    def test_head_status_200(self, basic_r2h):
        """HEAD should also work on the status page."""
        status, _, body = http_request("127.0.0.1", basic_r2h.port, "HEAD", "/status")
        # HEAD on status might return 200 with empty body
        # or the implementation might not support HEAD explicitly
        assert status in (200, 501)

    def test_post_on_status_rejected(self, basic_r2h):
        """POST to a non-API endpoint should be rejected or ignored."""
        status, _, _ = http_request(
            "127.0.0.1", basic_r2h.port, "POST", "/nonexistent",
            body=b"test",
        )
        # Should get 404 or 501
        assert status in (400, 404, 501)


# ---------------------------------------------------------------------------
# Malformed HTTP
# ---------------------------------------------------------------------------


class TestMalformedHTTP:
    """Send garbage and verify the server doesn't crash."""

    def test_garbage_request(self, basic_r2h):
        """Sending non-HTTP data should not crash the server."""
        # Send garbage
        sock = socket.create_connection(("127.0.0.1", basic_r2h.port), timeout=3)
        sock.sendall(b"THIS IS NOT HTTP\r\n\r\n")
        try:
            sock.recv(1024)
        except Exception:
            pass
        sock.close()

        time.sleep(0.05)

        # Server should still be alive
        status, _, _ = http_get("127.0.0.1", basic_r2h.port, "/status")
        assert status == 200

    def test_empty_request(self, basic_r2h):
        """An empty request (just connection close) should be handled."""
        sock = socket.create_connection(("127.0.0.1", basic_r2h.port), timeout=3)
        sock.close()

        time.sleep(0.05)

        # Server should still be alive
        status, _, _ = http_get("127.0.0.1", basic_r2h.port, "/status")
        assert status == 200

    def test_very_long_url(self, basic_r2h):
        """A very long URL should be handled without crashing."""
        long_path = "/" + "a" * 8000
        status, _, _ = http_get("127.0.0.1", basic_r2h.port, long_path, timeout=3.0)
        # Should either return an error or close the connection
        assert status in (0, 400, 404, 414, 500)

        time.sleep(0.05)

        # Server still alive
        status, _, _ = http_get("127.0.0.1", basic_r2h.port, "/status")
        assert status == 200


# ---------------------------------------------------------------------------
# Concurrent connections
# ---------------------------------------------------------------------------


class TestConcurrentConnections:
    """Multiple simultaneous connections should be handled."""

    def test_many_quick_requests(self, basic_r2h):
        """10 rapid sequential requests should all succeed."""
        for _ in range(10):
            status, _, _ = http_get("127.0.0.1", basic_r2h.port, "/status", timeout=3.0)
            assert status == 200

    def test_parallel_status_requests(self, basic_r2h):
        """5 parallel GET /status requests should all return 200."""
        import concurrent.futures

        with concurrent.futures.ThreadPoolExecutor(max_workers=5) as pool:
            futures = [
                pool.submit(http_get, "127.0.0.1", basic_r2h.port, "/status", 3.0)
                for _ in range(5)
            ]
            for f in concurrent.futures.as_completed(futures):
                status, _, _ = f.result()
                assert status == 200


# ---------------------------------------------------------------------------
# Trailing slash handling
# ---------------------------------------------------------------------------


class TestTrailingSlash:
    """URLs with trailing slashes should still work."""

    def test_status_trailing_slash(self, basic_r2h):
        status, _, _ = http_get("127.0.0.1", basic_r2h.port, "/status/")
        assert status == 200

    def test_player_trailing_slash(self, basic_r2h):
        status, _, _ = http_get("127.0.0.1", basic_r2h.port, "/player/")
        assert status == 200


# ---------------------------------------------------------------------------
# Connection close behaviour
# ---------------------------------------------------------------------------


class TestConnectionClose:
    """Verify the server properly closes connections."""

    def test_server_sends_connection_close(self, basic_r2h):
        """Non-streaming responses should have Connection: close."""
        status, hdrs, _ = http_get("127.0.0.1", basic_r2h.port, "/status")
        assert status == 200
        conn_hdr = hdrs.get("Connection", hdrs.get("connection", ""))
        assert "close" in conn_hdr.lower() or conn_hdr == ""


# ---------------------------------------------------------------------------
# r2h-ifname query parameter
# ---------------------------------------------------------------------------


class TestIfnameParam:
    """The r2h-ifname query parameter overrides the upstream interface.
    Even with an invalid interface, the request should be accepted (HEAD)."""

    def test_ifname_param_accepted(self, basic_r2h):
        status, _, _ = http_request(
            "127.0.0.1", basic_r2h.port, "HEAD",
            "/rtp/239.0.0.1:1234?r2h-ifname=lo0",
            timeout=3.0,
        )
        # HEAD should succeed regardless of interface
        assert status == 200
