"""Mock RTSP servers for E2E tests (TCP interleaved and UDP variants)."""

from __future__ import annotations

import socket
import struct
import threading
import time

from .ports import find_free_port, find_free_udp_port_pair
from .rtp import make_rtp_packet


# ---------------------------------------------------------------------------
# _RTSPServerBase  --  shared RTSP protocol scaffolding
# ---------------------------------------------------------------------------


class _RTSPServerBase:
    """Base class for mock RTSP servers (TCP interleaved and UDP variants).

    Subclasses override ``_setup_response`` and ``_after_play`` to supply
    transport-specific behaviour.
    """

    def __init__(self, port: int = 0, sdp_control: str = "*",
                 content_base: str = "auto", custom_sdp: str | None = None):
        """
        Args:
            port: TCP port to listen on (0 = auto-select).
            sdp_control: Value for ``a=control:`` in SDP (default ``*``).
            content_base: Controls the Content-Base header in DESCRIBE:
                ``"auto"`` (default) uses the request URI (appending ``/``
                for relative controls); ``None`` omits the header entirely;
                any other string is sent verbatim.
            custom_sdp: If set, replaces the auto-generated SDP body.
        """
        self.port = port or find_free_port()
        self._sdp_control = sdp_control
        self._content_base = content_base
        self._custom_sdp = custom_sdp
        self._server_sock: socket.socket | None = None
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self.requests_received: list[str] = []
        self.requests_detailed: list[dict] = []

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
                # Capture full request details for test verification
                req_headers_map: dict[str, str] = {}
                for hdr_line in req.split("\r\n")[1:]:
                    if hdr_line and ":" in hdr_line:
                        hk, hv = hdr_line.split(":", 1)
                        req_headers_map[hk.strip()] = hv.strip()
                self.requests_detailed.append({
                    "method": method,
                    "uri": uri,
                    "headers": req_headers_map,
                })

                if method == "OPTIONS":
                    conn.sendall(("RTSP/1.0 200 OK\r\nCSeq: %s\r\n"
                                  "Public: OPTIONS, DESCRIBE, SETUP, PLAY, TEARDOWN\r\n\r\n" % cseq).encode())
                elif method == "DESCRIBE":
                    if self._custom_sdp is not None:
                        sdp = self._custom_sdp
                    else:
                        sdp = ("v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=T\r\n"
                               "c=IN IP4 0.0.0.0\r\nt=0 0\r\n"
                               "m=video 0 RTP/AVP 33\r\na=control:%s\r\n"
                               % self._sdp_control)
                    # Build Content-Base header (or omit it)
                    cb_header = ""
                    if self._content_base is None:
                        pass  # no Content-Base header
                    elif self._content_base == "auto":
                        # When control is a relative URL, Content-Base must
                        # end with '/' for correct RFC 3986 resolution.
                        cb_val = uri
                        if self._sdp_control != "*" and not self._sdp_control.startswith("rtsp://"):
                            if not cb_val.endswith("/"):
                                cb_val += "/"
                        cb_header = "Content-Base: %s\r\n" % cb_val
                    else:
                        cb_header = "Content-Base: %s\r\n" % self._content_base
                    conn.sendall(("RTSP/1.0 200 OK\r\nCSeq: %s\r\n"
                                  "Content-Type: application/sdp\r\n"
                                  "%s"
                                  "Content-Length: %d\r\n\r\n%s" % (cseq, cb_header, len(sdp), sdp)).encode())
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

    def __init__(self, port: int = 0, num_packets: int = 200,
                 sdp_control: str = "*", content_base: str = "auto",
                 custom_sdp: str | None = None):
        super().__init__(port, sdp_control=sdp_control,
                         content_base=content_base, custom_sdp=custom_sdp)
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
                time.sleep(0.001)
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
                time.sleep(0.001)
        except (OSError, BrokenPipeError):
            pass
        finally:
            udp_sock.close()
