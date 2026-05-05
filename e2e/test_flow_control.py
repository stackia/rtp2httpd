"""
E2E coverage for the upstream flow-control fix.

A slow downstream client used to be aborted partway through a large HTTP
proxy response because the per-connection zerocopy queue would saturate and
``connection_queue_zerocopy()`` would return -1 (packet-drop semantics
inherited from RTP/UDP).  The fix pauses upstream reads when the client send
queue exceeds the high watermark and resumes them once it drops back below
the low watermark.

We can't deterministically observe individual pause/resume transitions
(they depend on kernel buffer sizes), so the test asserts the only thing
that matters end-to-end: byte-for-byte completeness of the proxied response.

The same flow-control machinery is wired into RTSP TCP interleaved transport
in src/rtsp.c, but a deterministic e2e test for it would require a more
elaborate mock that drives backpressure without closing right after sending.
The HTTP test exercises the shared infrastructure (stream_on_client_drain,
the HWM/LWM helpers, the IDLE-path POLLER_OUT preservation).
"""

import socket
import time

import pytest

from helpers import (
    MockHTTPUpstream,
    R2HProcess,
    find_free_port,
)

# These tests intentionally throttle the client to provoke backpressure.
pytestmark = pytest.mark.slow


@pytest.fixture(scope="module")
def shared_r2h(r2h_binary):
    # ``-b 128`` shrinks the global buffer pool cap to 128 buffers
    # (~192 KiB), which forces the per-connection zerocopy queue limit
    # down to ~96 KiB.  With the default cap (16384 buffers / ~24 MiB) a
    # short test body would be absorbed entirely without ever crossing
    # the HWM, defeating the whole purpose of these tests.
    port = find_free_port()
    r2h = R2HProcess(r2h_binary, port, extra_args=["-v", "4", "-m", "100", "-b", "128"])
    r2h.start()
    yield r2h
    r2h.stop()


def _slow_drain_until_eof(
    host: str,
    port: int,
    path: str,
    chunk_size: int,
    sleep_per_chunk: float,
    overall_timeout: float,
) -> tuple[int, dict, bytes]:
    """HTTP/1.0 GET that reads `chunk_size` bytes then sleeps, repeating
    until EOF or `overall_timeout` expires.

    Returns ``(status, headers_dict, body_bytes)``.  Connection-level errors
    return ``(0, {}, partial_body)`` — useful for asserting that the OLD
    (un-fixed) code drops the connection mid-transfer.
    """
    sock = socket.create_connection((host, port), timeout=overall_timeout)
    body = b""
    try:
        sock.sendall(("GET %s HTTP/1.0\r\nHost: %s\r\n\r\n" % (path, host)).encode())

        deadline = time.monotonic() + overall_timeout
        buf = b""
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            sock.settimeout(min(remaining, 2.0))
            try:
                piece = sock.recv(chunk_size)
            except socket.timeout:
                continue
            except OSError:
                break
            if not piece:
                break
            buf += piece
            if sleep_per_chunk > 0:
                time.sleep(sleep_per_chunk)

        header_end = buf.find(b"\r\n\r\n")
        if header_end < 0:
            return 0, {}, buf

        header_text = buf[:header_end].decode(errors="replace")
        body = buf[header_end + 4 :]
        parts = header_text.split("\r\n")
        # Guard against malformed status lines (truncated/corrupted response)
        # so the test fails on the assertion, not on a parse exception.
        try:
            status_code = int(parts[0].split()[1])
        except IndexError, ValueError:
            return 0, {}, buf
        hdrs = {}
        for line in parts[1:]:
            if ":" in line:
                k, v = line.split(":", 1)
                hdrs[k.strip().lower()] = v.strip()
        return status_code, hdrs, body
    finally:
        sock.close()


# ---------------------------------------------------------------------------
# HTTP proxy
# ---------------------------------------------------------------------------


@pytest.mark.http_proxy
class TestHTTPProxyBackpressure:
    """A slow HTTP client must receive the full proxied body."""

    def test_slow_client_receives_full_body(self, shared_r2h):
        # 1 MiB body comfortably exceeds the ~96 KiB zerocopy queue limit
        # imposed by the ``-b 128`` shared_r2h fixture, so the slow client
        # forces multiple pause/resume cycles before EOF.
        body_size = 1024 * 1024
        payload = bytes((i & 0xFF for i in range(body_size)))

        upstream = MockHTTPUpstream(
            routes={"/big.ts": {"status": 200, "body": payload, "headers": {"Content-Type": "video/mp2t"}}}
        )
        upstream.start()
        try:
            status, _, received = _slow_drain_until_eof(
                "127.0.0.1",
                shared_r2h.port,
                "/http/127.0.0.1:%d/big.ts" % upstream.port,
                chunk_size=8 * 1024,
                sleep_per_chunk=0.02,  # ~400 KB/s ceiling, well below pool refill rate
                overall_timeout=20.0,
            )
            assert status == 200, "Slow client should still receive a 200 response"
            assert len(received) == body_size, "Slow client received %d/%d bytes — flow control regression?" % (
                len(received),
                body_size,
            )
            assert received == payload, "Body content mismatch — corruption in proxy path"
        finally:
            upstream.stop()
