"""Mock RTSP servers for E2E tests (TCP interleaved and UDP variants)."""

from __future__ import annotations

import socket
import struct
import threading
import time

from .ports import find_free_port, find_free_udp_port_pair
from .rtp import TS_NULL_PACKET, make_rtp_packet

# ---------------------------------------------------------------------------
# _RTSPServerBase  --  shared RTSP protocol scaffolding
# ---------------------------------------------------------------------------


class _RTSPServerBase:
    """Base class for mock RTSP servers (TCP interleaved and UDP variants).

    Subclasses override ``_setup_response`` and ``_after_play`` to supply
    transport-specific behaviour.
    """

    def __init__(
        self,
        port: int = 0,
        sdp_control: str = "*",
        content_base: str | None = "auto",
        custom_sdp: str | None = None,
        options_session_id: str | None = None,
        play_response_headers: list[tuple[str, str]] | None = None,
        close_after_describe: bool = False,
        reset_after_describe: bool = False,
        redirect_describe_to: str | None = None,
        challenge_describe_once: bool = False,
        host: str = "127.0.0.1",
    ):
        """
        Args:
            port: TCP port to listen on (0 = auto-select).
            sdp_control: Value for ``a=control:`` in SDP (default ``*``).
            content_base: Controls the Content-Base header in DESCRIBE:
                ``"auto"`` (default) uses the request URI (appending ``/``
                for relative controls); ``None`` omits the header entirely;
                any other string is sent verbatim.
            custom_sdp: If set, replaces the auto-generated SDP body.
            options_session_id: If set, OPTIONS responds with this Session ID
                and every subsequent request (DESCRIBE, SETUP, PLAY, ...)
                must echo it (simulates HMS-style servers).
            play_response_headers: Extra headers to append to the PLAY 200 OK
                (e.g. ``[("Scale", "2.0"), ("Range", "npt=0-30")]``).
            close_after_describe: Close the control connection immediately after
                sending the DESCRIBE response.
            reset_after_describe: Reset the control connection immediately after
                sending the DESCRIBE response.
            redirect_describe_to: If set, DESCRIBE answers ``302`` with this
                ``Location`` instead of an SDP body.
            challenge_describe_once: If set, the first DESCRIBE answers ``401``
                with a Basic challenge and the retry is served normally.
            host: Address to listen on (use "::1" for IPv6 loopback).
        """
        self.host = host
        self.port = port or find_free_port(host)
        self._sdp_control = sdp_control
        self._content_base = content_base
        self._custom_sdp = custom_sdp
        self._options_session_id = options_session_id
        self._play_response_headers = play_response_headers or []
        self._close_after_describe = close_after_describe
        self._reset_after_describe = reset_after_describe
        self._redirect_describe_to = redirect_describe_to
        self._challenge_describe_once = challenge_describe_once
        self._describe_challenged = False
        self._server_sock: socket.socket | None = None
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self.requests_received: list[str] = []
        self.requests_detailed: list[dict] = []
        self.control_peer: tuple | None = None

    # -- lifecycle -----------------------------------------------------------

    def start(self) -> None:
        family = socket.AF_INET6 if ":" in self.host else socket.AF_INET
        self._server_sock = socket.socket(family, socket.SOCK_STREAM)
        self._server_sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._server_sock.bind((self.host, self.port))
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

    def _session_id(self) -> str:
        """Session ID returned by OPTIONS/SETUP/PLAY (HMS uses OPTIONS session)."""
        return self._options_session_id or "t1"

    # -- internals -----------------------------------------------------------

    def _accept(self) -> None:
        assert self._server_sock is not None
        while not self._stop.is_set():
            try:
                conn, addr = self._server_sock.accept()
                t = threading.Thread(target=self._handle, args=(conn, addr), daemon=True)
                t.start()
            except TimeoutError, OSError:
                continue

    def _handle(self, conn: socket.socket, addr: tuple) -> None:
        conn.settimeout(10.0)
        self.control_peer = addr
        transport_hdr = ""
        try:
            pending = b""
            while True:
                while b"\r\n\r\n" not in pending:
                    chunk = conn.recv(4096)
                    if not chunk:
                        return
                    pending += chunk
                # Split off exactly one request; anything left is a later
                # request that arrived in the same segment.  Keeping it buffered
                # (rather than folding it into this one) is what makes an
                # unexpectedly pipelined request visible to tests.
                data, pending = pending.split(b"\r\n\r\n", 1)
                req = data.decode(errors="replace") + "\r\n\r\n"
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
                self.requests_detailed.append(
                    {
                        "method": method,
                        "uri": uri,
                        "headers": req_headers_map,
                    }
                )

                # HMS-style servers assign the session at OPTIONS time and
                # close the connection if any later request doesn't echo it.
                if (
                    self._options_session_id
                    and method != "OPTIONS"
                    and req_headers_map.get("Session") != self._options_session_id
                ):
                    return

                if method == "OPTIONS":
                    session_line = ""
                    if self._options_session_id:
                        session_line = f"Session: {self._options_session_id}\r\n"
                    conn.sendall(
                        (
                            f"RTSP/1.0 200 OK\r\nCSeq: {cseq}\r\n"
                            f"{session_line}"
                            "Public: OPTIONS, DESCRIBE, SETUP, PLAY, TEARDOWN\r\n\r\n"
                        ).encode()
                    )
                elif method == "DESCRIBE":
                    if self._redirect_describe_to:
                        conn.sendall(
                            (
                                f"RTSP/1.0 302 Moved Temporarily\r\nCSeq: {cseq}\r\n"
                                f"Location: {self._redirect_describe_to}\r\n\r\n"
                            ).encode()
                        )
                        return
                    if self._challenge_describe_once and not self._describe_challenged:
                        self._describe_challenged = True
                        conn.sendall(
                            (
                                f"RTSP/1.0 401 Unauthorized\r\nCSeq: {cseq}\r\n"
                                'WWW-Authenticate: Basic realm="mock"\r\n\r\n'
                            ).encode()
                        )
                        continue
                    if self._custom_sdp is not None:
                        sdp = self._custom_sdp
                    else:
                        sdp = (
                            "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=T\r\n"
                            "c=IN IP4 0.0.0.0\r\nt=0 0\r\n"
                            f"m=video 0 RTP/AVP 33\r\na=control:{self._sdp_control}\r\n"
                        )
                    # Build Content-Base header (or omit it)
                    cb_header = ""
                    if self._content_base is None:
                        pass  # no Content-Base header
                    elif self._content_base == "auto":
                        # When control is a relative URL, Content-Base must
                        # end with '/' for correct RFC 3986 resolution.
                        cb_val = uri
                        if (
                            self._sdp_control != "*"
                            and not self._sdp_control.startswith("rtsp://")
                            and not cb_val.endswith("/")
                        ):
                            cb_val += "/"
                        cb_header = f"Content-Base: {cb_val}\r\n"
                    else:
                        cb_header = f"Content-Base: {self._content_base}\r\n"
                    conn.sendall(
                        (
                            f"RTSP/1.0 200 OK\r\nCSeq: {cseq}\r\nContent-Type: application/sdp\r\n{cb_header}Content-Length: {len(sdp)}\r\n\r\n{sdp}"
                        ).encode()
                    )
                    if self._reset_after_describe:
                        conn.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))
                        return
                    if self._close_after_describe:
                        return
                elif method == "SETUP":
                    conn.sendall(self._setup_response(cseq, transport_hdr).encode())
                elif method == "PLAY":
                    extra_headers = "".join("{}: {}\r\n".format(*item) for item in self._play_response_headers)
                    conn.sendall(
                        (
                            f"RTSP/1.0 200 OK\r\nCSeq: {cseq}\r\nSession: {self._session_id()}\r\n{extra_headers}\r\n"
                        ).encode()
                    )
                    self._after_play(conn, addr)
                    return
                elif method == "TEARDOWN":
                    conn.sendall((f"RTSP/1.0 200 OK\r\nCSeq: {cseq}\r\nSession: {self._session_id()}\r\n\r\n").encode())
                    return
        except TimeoutError, ConnectionError, OSError:
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

    With ``encapsulate_rtp=False`` the interleaved frames carry bare MPEG-TS
    instead, which is how ``MP2T/TCP`` upstreams behave.
    """

    def __init__(
        self,
        port: int = 0,
        num_packets: int = 200,
        sdp_control: str = "*",
        content_base: str | None = "auto",
        custom_sdp: str | None = None,
        options_session_id: str | None = None,
        play_response_headers: list[tuple[str, str]] | None = None,
        close_after_describe: bool = False,
        reset_after_describe: bool = False,
        redirect_describe_to: str | None = None,
        challenge_describe_once: bool = False,
        encapsulate_rtp: bool = True,
        setup_transport: str = "RTP/AVP/TCP;unicast;interleaved=0-1",
        host: str = "127.0.0.1",
    ):
        super().__init__(
            port,
            sdp_control=sdp_control,
            content_base=content_base,
            custom_sdp=custom_sdp,
            options_session_id=options_session_id,
            play_response_headers=play_response_headers,
            close_after_describe=close_after_describe,
            reset_after_describe=reset_after_describe,
            redirect_describe_to=redirect_describe_to,
            challenge_describe_once=challenge_describe_once,
            host=host,
        )
        self._num_packets = num_packets
        self._encapsulate_rtp = encapsulate_rtp
        self._setup_transport = setup_transport

    def _setup_response(self, cseq: str, transport_hdr: str) -> str:
        return f"RTSP/1.0 200 OK\r\nCSeq: {cseq}\r\nTransport: {self._setup_transport}\r\nSession: {self._session_id()}\r\n\r\n"

    def _after_play(self, conn: socket.socket, addr: tuple) -> None:
        seq = 0
        ts = 0
        try:
            for _ in range(self._num_packets):
                if self._stop.is_set():
                    break
                if self._encapsulate_rtp:
                    payload = make_rtp_packet(seq, ts)
                else:
                    # Bare MPEG-TS, one 1316-byte chunk (7 x 188) per frame.
                    payload = TS_NULL_PACKET * 7
                frame = b"\x24" + struct.pack("!BH", 0, len(payload)) + payload
                conn.sendall(frame)
                seq = (seq + 1) & 0xFFFF
                ts = (ts + 3600) & 0xFFFFFFFF
                time.sleep(0.001)
        except OSError, BrokenPipeError:
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
        return f"RTSP/1.0 200 OK\r\nCSeq: {cseq}\r\nTransport: RTP/AVP;unicast;client_port={self._client_rtp_port}-{(self._client_rtp_port + 1)};server_port={self._server_rtp_port}-{self._server_rtcp_port}\r\nSession: t1\r\n\r\n"

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
        except OSError, BrokenPipeError:
            pass
        finally:
            udp_sock.close()


# ---------------------------------------------------------------------------
# MockRTSPServerZTE  --  ZTE UDP NAT traversal mode
# ---------------------------------------------------------------------------


class MockRTSPServerZTE(_RTSPServerBase):
    """RTSP server that starts UDP media only after a valid ZTE punch packet.

    ``expected_ip`` / ``expected_control_port`` override what the punch packet is
    validated against; leave them unset to expect the RTSP control connection's
    own endpoint.  Set them when rtp2httpd advertises a STUN-discovered mapping
    instead, in which case the UDP source port no longer matches the advertised
    RTP port and ``check_source_port`` must be disabled.

    ``echo_probe_after`` makes the server bounce the 84-byte punch packet back
    onto the media port after that many RTP packets, the way ZTE servers
    acknowledge a punch mid-stream.  It reproduces the stray non-RTP datagram
    that must never reach the client's MPEG-TS output.
    """

    def __init__(
        self,
        port: int = 0,
        num_packets: int = 200,
        expected_ip: str | None = None,
        expected_control_port: int | None = None,
        check_source_port: bool = True,
        echo_probe_after: int | None = None,
    ):
        super().__init__(port)
        self._num_packets = num_packets
        self._expected_ip = expected_ip
        self._expected_control_port = expected_control_port
        self._check_source_port = check_source_port
        self._echo_probe_after = echo_probe_after
        self._server_rtp_socket: socket.socket | None = None
        self._server_rtcp_socket: socket.socket | None = None
        self._receiver_thread: threading.Thread | None = None
        self._play_started = threading.Event()
        self._valid_probe = threading.Event()
        self._client_rtp_port = 0
        self._client_address = ""
        self._server_rtp_port = 0
        self._server_rtcp_port = 0
        self.udp_datagrams: list[tuple[bytes, tuple]] = []

    @property
    def valid_probe_received(self) -> bool:
        return self._valid_probe.is_set()

    def stop(self) -> None:
        self._play_started.set()
        super().stop()
        if self._server_rtp_socket:
            self._server_rtp_socket.close()
        if self._server_rtcp_socket:
            self._server_rtcp_socket.close()
        if self._receiver_thread:
            self._receiver_thread.join(timeout=2)

    def _setup_response(self, cseq: str, transport_hdr: str) -> str:
        for part in transport_hdr.split(";"):
            part = part.strip()
            if part.startswith("client_port="):
                self._client_rtp_port = int(part.split("=", 1)[1].split("-", 1)[0])
            elif part.startswith("client_address="):
                self._client_address = part.split("=", 1)[1]

        while True:
            rtp_port, rtcp_port = find_free_udp_port_pair()
            rtp_socket = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            rtcp_socket = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            try:
                rtp_socket.bind((self.host, rtp_port))
                rtcp_socket.bind((self.host, rtcp_port))
                break
            except OSError:
                rtp_socket.close()
                rtcp_socket.close()

        self._server_rtp_socket = rtp_socket
        self._server_rtcp_socket = rtcp_socket
        self._server_rtp_port = rtp_port
        self._server_rtcp_port = rtcp_port
        self._receiver_thread = threading.Thread(target=self._receive_probes, daemon=True)
        self._receiver_thread.start()

        return f"RTSP/1.0 200 OK\r\nCSeq: {cseq}\r\nTransport: MP2T/RTP/UDP;unicast;client_port={self._client_rtp_port}-{(self._client_rtp_port + 1)};server_port={self._server_rtp_port}-{self._server_rtcp_port}\r\nSession: t1\r\n\r\n"

    def _receive_probes(self) -> None:
        assert self._server_rtp_socket is not None
        self._server_rtp_socket.settimeout(0.05)
        while not self._stop.is_set():
            try:
                payload, source = self._server_rtp_socket.recvfrom(2048)
                self.udp_datagrams.append((payload, source))
                if self._probe_is_valid(payload, source):
                    self._valid_probe.set()
            except TimeoutError:
                if self._play_started.is_set():
                    return
            except OSError:
                return

    def _probe_is_valid(self, payload: bytes, source: tuple) -> bool:
        if not self.control_peer or len(payload) != 84:
            return False
        expected_ip = socket.inet_aton(self._expected_ip or self.control_peer[0])
        expected_tcp_port = self._expected_control_port or self.control_peer[1]
        if self._check_source_port and source[1] != self._client_rtp_port:
            return False
        return (
            payload[:8] == b"ZXV10STB"
            and payload[8:12] == b"\x7f\xff\xff\xff"
            and payload[12:16] == expected_ip
            and struct.unpack("!H", payload[16:18])[0] == self._client_rtp_port
            and struct.unpack("!H", payload[18:20])[0] == expected_tcp_port
            and payload[20:] == bytes(64)
            and source[0] == self.control_peer[0]
        )

    def _after_play(self, conn: socket.socket, addr: tuple) -> None:
        self._play_started.set()
        if not self._valid_probe.wait(timeout=2.0) or not self.udp_datagrams:
            return
        if self._receiver_thread:
            self._receiver_thread.join(timeout=0.2)

        assert self._server_rtp_socket is not None
        probe, destination = next(
            (payload, source) for payload, source in self.udp_datagrams if self._probe_is_valid(payload, source)
        )
        seq = 0
        ts = 0
        try:
            for index in range(self._num_packets):
                if self._stop.is_set():
                    break
                if index == self._echo_probe_after:
                    self._server_rtp_socket.sendto(probe, destination)
                self._server_rtp_socket.sendto(make_rtp_packet(seq, ts), destination)
                seq = (seq + 1) & 0xFFFF
                ts = (ts + 3600) & 0xFFFFFFFF
                time.sleep(0.001)
        except OSError:
            pass


# ---------------------------------------------------------------------------
# MockRTSPServerSilent  --  accepts connection but never responds
# ---------------------------------------------------------------------------


class MockRTSPServerSilent(_RTSPServerBase):
    """Accepts connection but never responds (for timeout tests)."""

    def _setup_response(self, cseq: str, transport_hdr: str) -> str:
        return ""  # never called

    def _after_play(self, conn: socket.socket, addr: tuple) -> None:
        pass  # never called

    def _handle(self, conn: socket.socket, addr: tuple) -> None:
        """Override: accept connection but send nothing."""
        try:
            while not self._stop.is_set():
                time.sleep(0.1)
        finally:
            conn.close()


# ---------------------------------------------------------------------------
# MockRTSPServerNoTeardownResponse  --  normal handshake, silent TEARDOWN
# ---------------------------------------------------------------------------


class MockRTSPServerNoMedia(_RTSPServerBase):
    """Completes full RTSP handshake but never sends any media data."""

    def _setup_response(self, cseq: str, transport_hdr: str) -> str:
        return (
            f"RTSP/1.0 200 OK\r\nCSeq: {cseq}\r\nTransport: RTP/AVP/TCP;unicast;interleaved=0-1\r\nSession: t1\r\n\r\n"
        )

    def _after_play(self, conn: socket.socket, addr: tuple) -> None:
        """Send PLAY 200 OK but no media packets — just hold connection."""
        conn.settimeout(1.0)
        try:
            while not self._stop.is_set():
                try:
                    data = conn.recv(4096)
                    if not data:
                        break
                except TimeoutError:
                    continue
        except ConnectionError, OSError:
            pass
        finally:
            conn.close()


class MockRTSPServerNoTeardownResponse(_RTSPServerBase):
    """Normal RTSP handshake through PLAY, but never responds to TEARDOWN."""

    def __init__(self, port: int = 0, num_packets: int = 50):
        super().__init__(port)
        self._num_packets = num_packets

    def _setup_response(self, cseq: str, transport_hdr: str) -> str:
        return (
            f"RTSP/1.0 200 OK\r\nCSeq: {cseq}\r\nTransport: RTP/AVP/TCP;unicast;interleaved=0-1\r\nSession: t1\r\n\r\n"
        )

    def _after_play(self, conn: socket.socket, addr: tuple) -> None:
        """Send a few packets then keep connection alive."""
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
        except OSError, BrokenPipeError:
            return

        # Now wait for TEARDOWN but don't respond to it
        conn.settimeout(1.0)
        try:
            while not self._stop.is_set():
                try:
                    data = conn.recv(4096)
                    if not data:
                        break
                    # Got TEARDOWN (or anything) — just ignore and hold connection
                except TimeoutError:
                    continue
        except ConnectionError, OSError:
            pass
        finally:
            conn.close()
