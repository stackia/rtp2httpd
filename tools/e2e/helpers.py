"""
Shared helpers for rtp2httpd E2E tests.

Provides mock servers (RTSP TCP/UDP, HTTP upstream), multicast sender,
RTP packet crafting, and the R2HProcess wrapper.
"""

from __future__ import annotations

import http.client
import os
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
BINARY_PATH = PROJECT_ROOT / "build" / "rtp2httpd"
FIXTURES_DIR = PROJECT_ROOT / "tools" / "fixtures"

LOOPBACK_IF = "lo0" if sys.platform == "darwin" else "lo"
MCAST_ADDR = "239.255.0.1"

# ---------------------------------------------------------------------------
# Port helpers
# ---------------------------------------------------------------------------


def find_free_port() -> int:
    """Find a free TCP port on localhost."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def find_free_udp_port() -> int:
    """Find a free UDP port."""
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        s.bind(("", 0))
        return s.getsockname()[1]


def find_free_udp_port_pair() -> tuple[int, int]:
    """Find a free even/odd UDP port pair (for RTP/RTCP)."""
    for _ in range(100):
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s1:
            s1.bind(("", 0))
            p = s1.getsockname()[1]
            if p % 2 != 0:
                continue
            try:
                with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s2:
                    s2.bind(("", p + 1))
                    return p, p + 1
            except OSError:
                continue
    # fallback
    return find_free_udp_port(), find_free_udp_port()


def wait_for_port(port: int, host: str = "127.0.0.1", timeout: float = 5.0) -> bool:
    """Block until *port* is accepting TCP connections (or *timeout* expires)."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with socket.create_connection((host, port), timeout=0.5):
                return True
        except (ConnectionRefusedError, OSError, socket.timeout):
            time.sleep(0.05)
    return False


# ---------------------------------------------------------------------------
# HTTP helpers
# ---------------------------------------------------------------------------


def http_get(
    host: str,
    port: int,
    path: str,
    timeout: float = 5.0,
    headers: dict | None = None,
) -> tuple[int, dict, bytes]:
    """Simple blocking HTTP GET.  Returns (status, headers_dict, body)."""
    conn = http.client.HTTPConnection(host, port, timeout=timeout)
    try:
        conn.request("GET", path, headers=headers or {})
        resp = conn.getresponse()
        body = resp.read()
        return resp.status, dict(resp.getheaders()), body
    finally:
        conn.close()


def http_request(
    host: str,
    port: int,
    method: str,
    path: str,
    timeout: float = 5.0,
    headers: dict | None = None,
    body: bytes | None = None,
) -> tuple[int, dict, bytes]:
    """Arbitrary HTTP request.  Returns (status, headers_dict, body)."""
    conn = http.client.HTTPConnection(host, port, timeout=timeout)
    try:
        conn.request(method, path, body=body, headers=headers or {})
        resp = conn.getresponse()
        rbody = resp.read()
        return resp.status, dict(resp.getheaders()), rbody
    finally:
        conn.close()


def stream_get(
    host: str,
    port: int,
    path: str,
    read_bytes: int = 8192,
    timeout: float = 10.0,
    headers: dict | None = None,
) -> tuple[int, dict, bytes]:
    """HTTP GET that reads up to *read_bytes* from a streaming response.

    Uses HTTP/1.0 raw sockets with a short per-recv timeout so the loop
    keeps retrying until the overall *timeout* deadline expires.  This
    handles servers that take several seconds to produce the first byte
    (e.g. rtp2httpd RTSP proxy on macOS can take ~7 s for TCP interleaved
    transport setup).

    Returns ``(status, headers_dict, body_bytes)`` or ``(0, {}, b"")``
    on total failure.
    """
    try:
        sock = socket.create_connection((host, port), timeout=timeout)
    except (OSError, socket.timeout):
        return 0, {}, b""
    try:
        req_lines = ["GET %s HTTP/1.0" % path, "Host: %s" % host]
        for k, v in (headers or {}).items():
            req_lines.append("%s: %s" % (k, v))
        req_lines.append("")
        req_lines.append("")
        sock.sendall("\r\n".join(req_lines).encode())

        data = b""
        deadline = time.monotonic() + timeout
        target = read_bytes + 4096  # headroom for HTTP headers
        while len(data) < target:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            # Use short per-recv timeout so we keep retrying within deadline
            sock.settimeout(min(remaining, 1.0))
            try:
                chunk = sock.recv(4096)
            except socket.timeout:
                continue  # keep trying until deadline
            if not chunk:
                break
            data += chunk

        header_end = data.find(b"\r\n\r\n")
        if header_end < 0:
            return 0, {}, b""

        header_text = data[:header_end].decode(errors="replace")
        body = data[header_end + 4:]

        parts = header_text.split("\r\n")
        status_code = int(parts[0].split()[1])

        hdrs: dict[str, str] = {}
        for line in parts[1:]:
            if ":" in line:
                k, v = line.split(":", 1)
                hdrs[k.strip().lower()] = v.strip()

        return status_code, hdrs, body
    except (socket.timeout, OSError):
        return 0, {}, b""
    finally:
        sock.close()


# ---------------------------------------------------------------------------
# RTP packet crafting
# ---------------------------------------------------------------------------

# A minimal 188-byte MPEG-TS null packet (sync byte 0x47, PID 0x1FFF = null)
_TS_NULL_PACKET = b"\x47\x1f\xff\x10" + b"\xff" * 184


def make_rtp_packet(
    seq: int,
    timestamp: int,
    ssrc: int = 0x12345678,
    payload_type: int = 33,
    payload: bytes | None = None,
) -> bytes:
    """Create a 12-byte-header RTP packet carrying one TS null packet."""
    if payload is None:
        payload = _TS_NULL_PACKET
    header = struct.pack(
        "!BBHII",
        0x80,                     # V=2, P=0, X=0, CC=0
        payload_type & 0x7F,      # M=0, PT
        seq & 0xFFFF,
        timestamp & 0xFFFFFFFF,
        ssrc & 0xFFFFFFFF,
    )
    return header + payload


# ---------------------------------------------------------------------------
# R2HProcess  --  manages one rtp2httpd instance
# ---------------------------------------------------------------------------


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


# ---------------------------------------------------------------------------
# MulticastSender  --  pumps RTP packets to a multicast group
# ---------------------------------------------------------------------------


class MulticastSender:
    """Continuously sends RTP packets to a multicast group on loopback.

    *ts_per_rtp* controls how many 188-byte TS null packets are packed
    into each RTP datagram.  Real IPTV typically uses 7 TS/RTP which,
    at ~190 pps, produces roughly 2 Mbps of payload.
    """

    def __init__(
        self,
        addr: str = MCAST_ADDR,
        port: int = 0,
        pps: int = 200,
        ts_per_rtp: int = 7,
    ):
        self.addr = addr
        self.port = port or find_free_udp_port()
        self.pps = pps
        self.ts_per_rtp = ts_per_rtp
        self._payload = _TS_NULL_PACKET * ts_per_rtp
        self._sock: socket.socket | None = None
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self.packets_sent = 0

    def start(self) -> None:
        self._sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
        self._sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 1)
        self._sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_LOOP, 1)
        self._sock.setsockopt(
            socket.IPPROTO_IP, socket.IP_MULTICAST_IF,
            socket.inet_aton("127.0.0.1"),
        )
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()

    def _loop(self) -> None:
        seq = 0
        ts = 0
        interval = 1.0 / self.pps
        while not self._stop.is_set():
            pkt = make_rtp_packet(seq, ts, payload=self._payload)
            try:
                self._sock.sendto(pkt, (self.addr, self.port))
                self.packets_sent += 1
            except OSError:
                pass
            seq = (seq + 1) & 0xFFFF
            ts = (ts + 3600) & 0xFFFFFFFF
            self._stop.wait(interval)

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=2)
        if self._sock:
            self._sock.close()


# ---------------------------------------------------------------------------
# _RTSPServerBase  --  shared RTSP protocol scaffolding
# ---------------------------------------------------------------------------


class _RTSPServerBase:
    """Base class for mock RTSP servers (TCP interleaved and UDP variants).

    Subclasses override ``_setup_response`` and ``_after_play`` to supply
    transport-specific behaviour.
    """

    def __init__(self, port: int = 0):
        self.port = port or find_free_port()
        self._server_sock: socket.socket | None = None
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self.requests_received: list[str] = []

    # -- lifecycle -----------------------------------------------------------

    def start(self) -> None:
        self._server_sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._server_sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._server_sock.bind(("127.0.0.1", self.port))
        self._server_sock.listen(5)
        self._server_sock.settimeout(1.0)
        self._thread = threading.Thread(target=self._accept, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._server_sock:
            self._server_sock.close()
        if self._thread:
            self._thread.join(timeout=3)

    # -- override points -----------------------------------------------------

    def _setup_response(self, cseq: str, transport_hdr: str) -> str:
        """Return the full RTSP SETUP response (including trailing \\r\\n\\r\\n)."""
        raise NotImplementedError

    def _after_play(self, conn: socket.socket, addr: tuple) -> None:
        """Called right after the PLAY 200 OK is sent.  Pump data here."""
        raise NotImplementedError

    # -- internals -----------------------------------------------------------

    def _accept(self) -> None:
        while not self._stop.is_set():
            try:
                conn, addr = self._server_sock.accept()
                t = threading.Thread(target=self._handle, args=(conn, addr), daemon=True)
                t.start()
            except (socket.timeout, OSError):
                continue

    def _handle(self, conn: socket.socket, addr: tuple) -> None:
        conn.settimeout(10.0)
        transport_hdr = ""
        try:
            while True:
                data = b""
                while b"\r\n\r\n" not in data:
                    chunk = conn.recv(4096)
                    if not chunk:
                        return
                    data += chunk
                req = data.decode(errors="replace")
                first_line = req.split("\r\n")[0].split()
                method = first_line[0]
                uri = first_line[1] if len(first_line) > 1 else ""
                cseq = "1"
                for line in req.split("\r\n"):
                    lo = line.lower()
                    if lo.startswith("cseq:"):
                        cseq = line.split(":", 1)[1].strip()
                    elif lo.startswith("transport:"):
                        transport_hdr = line.split(":", 1)[1].strip()
                self.requests_received.append(method)

                if method == "OPTIONS":
                    conn.sendall(("RTSP/1.0 200 OK\r\nCSeq: %s\r\n"
                                  "Public: OPTIONS, DESCRIBE, SETUP, PLAY, TEARDOWN\r\n\r\n" % cseq).encode())
                elif method == "DESCRIBE":
                    sdp = ("v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=T\r\n"
                           "c=IN IP4 0.0.0.0\r\nt=0 0\r\n"
                           "m=video 0 RTP/AVP 33\r\na=control:*\r\n")
                    conn.sendall(("RTSP/1.0 200 OK\r\nCSeq: %s\r\n"
                                  "Content-Type: application/sdp\r\n"
                                  "Content-Base: %s\r\n"
                                  "Content-Length: %d\r\n\r\n%s" % (cseq, uri, len(sdp), sdp)).encode())
                elif method == "SETUP":
                    conn.sendall(self._setup_response(cseq, transport_hdr).encode())
                elif method == "PLAY":
                    conn.sendall(("RTSP/1.0 200 OK\r\nCSeq: %s\r\n"
                                  "Session: t1\r\n\r\n" % cseq).encode())
                    self._after_play(conn, addr)
                    return
                elif method == "TEARDOWN":
                    conn.sendall(("RTSP/1.0 200 OK\r\nCSeq: %s\r\n"
                                  "Session: t1\r\n\r\n" % cseq).encode())
                    return
        except (socket.timeout, ConnectionError, OSError):
            pass
        finally:
            conn.close()


# ---------------------------------------------------------------------------
# MockRTSPServer  --  TCP interleaved mode
# ---------------------------------------------------------------------------


class MockRTSPServer(_RTSPServerBase):
    """RTSP server using TCP interleaved transport (``$`` framing on the
    same TCP connection).  This is the transport rtp2httpd prefers.

    Sends a fixed burst of RTP packets then closes the RTSP connection so
    that rtp2httpd's kqueue-based event loop reliably flushes data to the
    HTTP client (macOS kqueue doesn't always wake for partial writes while
    the RTSP source is still connected).
    """

    def __init__(self, port: int = 0, num_packets: int = 200):
        super().__init__(port)
        self._num_packets = num_packets

    def _setup_response(self, cseq: str, transport_hdr: str) -> str:
        return ("RTSP/1.0 200 OK\r\nCSeq: %s\r\n"
                "Transport: RTP/AVP/TCP;unicast;interleaved=0-1\r\n"
                "Session: t1\r\n\r\n" % cseq)

    def _after_play(self, conn: socket.socket, addr: tuple) -> None:
        seq = 0
        ts = 0
        try:
            for _ in range(self._num_packets):
                if self._stop.is_set():
                    break
                rtp = make_rtp_packet(seq, ts)
                frame = b"\x24" + struct.pack("!BH", 0, len(rtp)) + rtp
                conn.sendall(frame)
                seq = (seq + 1) & 0xFFFF
                ts = (ts + 3600) & 0xFFFFFFFF
                time.sleep(0.01)
        except (OSError, BrokenPipeError):
            pass


# ---------------------------------------------------------------------------
# MockRTSPServerUDP  --  UDP transport mode
# ---------------------------------------------------------------------------


class MockRTSPServerUDP(_RTSPServerBase):
    """RTSP server using UDP transport.  After SETUP the server sends RTP
    packets to the ``client_port`` extracted from the Transport header.

    Sends a fixed burst then closes (same rationale as the TCP variant).
    """

    def __init__(self, port: int = 0, num_packets: int = 200):
        super().__init__(port)
        self._num_packets = num_packets
        self._server_rtp_port = 0
        self._server_rtcp_port = 0
        self._client_rtp_port = 0

    def _setup_response(self, cseq: str, transport_hdr: str) -> str:
        # Extract client_port from the transport offers
        self._client_rtp_port = 6970  # fallback
        for part in transport_hdr.replace(",", ";").split(";"):
            p = part.strip()
            if p.startswith("client_port="):
                self._client_rtp_port = int(p.split("=")[1].split("-")[0])
                break

        self._server_rtp_port, self._server_rtcp_port = find_free_udp_port_pair()
        return ("RTSP/1.0 200 OK\r\nCSeq: %s\r\n"
                "Transport: RTP/AVP;unicast;"
                "client_port=%d-%d;"
                "server_port=%d-%d\r\n"
                "Session: t1\r\n\r\n" % (
                    cseq,
                    self._client_rtp_port, self._client_rtp_port + 1,
                    self._server_rtp_port, self._server_rtcp_port))

    def _after_play(self, conn: socket.socket, addr: tuple) -> None:
        """Send RTP packets over UDP to the client's advertised port."""
        client_ip = addr[0]
        udp_sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            udp_sock.bind(("127.0.0.1", self._server_rtp_port))
        except OSError:
            udp_sock.bind(("127.0.0.1", 0))

        seq = 0
        ts = 0
        try:
            for _ in range(self._num_packets):
                if self._stop.is_set():
                    break
                rtp = make_rtp_packet(seq, ts)
                udp_sock.sendto(rtp, (client_ip, self._client_rtp_port))
                seq = (seq + 1) & 0xFFFF
                ts = (ts + 3600) & 0xFFFFFFFF
                time.sleep(0.01)
        except (OSError, BrokenPipeError):
            pass
        finally:
            udp_sock.close()


# ---------------------------------------------------------------------------
# MockHTTPUpstream  --  lightweight HTTP server for proxy tests
# ---------------------------------------------------------------------------


class _UpstreamHandler(BaseHTTPRequestHandler):
    """Handler whose per-path responses are configured via the class attr."""

    routes: dict  # set dynamically

    def do_GET(self) -> None:
        self._dispatch()

    def do_HEAD(self) -> None:
        self._dispatch(head=True)

    def do_POST(self) -> None:
        self._dispatch()

    def _dispatch(self, head: bool = False) -> None:
        path = self.path.split("?")[0]
        route = self.routes.get(path)
        if route is None:
            self.send_response(404)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        status = route.get("status", 200)
        body = route.get("body", b"")
        if isinstance(body, str):
            body = body.encode()
        extra_headers = route.get("headers", {})

        self.send_response(status)
        for k, v in extra_headers.items():
            self.send_header(k, v)
        if "Content-Length" not in extra_headers:
            self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if not head:
            self.wfile.write(body)

    def log_message(self, fmt, *args) -> None:  # noqa: ARG002
        pass  # silence


class MockHTTPUpstream:
    """Start a throwaway HTTP server with pre-configured routes."""

    def __init__(self, port: int = 0, routes: dict | None = None):
        self.port = port or find_free_port()
        self.routes = routes or {}
        self._server: HTTPServer | None = None
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        handler = type(
            "_H",
            (_UpstreamHandler,),
            {"routes": self.routes},
        )
        self._server = HTTPServer(("127.0.0.1", self.port), handler)
        self._thread = threading.Thread(
            target=self._server.serve_forever, daemon=True,
        )
        self._thread.start()

    def stop(self) -> None:
        if self._server:
            self._server.shutdown()
        if self._thread:
            self._thread.join(timeout=3)
