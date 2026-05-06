"""Mock FCC (Fast Channel Change) server for E2E tests.

Supports both Telecom and Huawei FCC protocols:

Telecom protocol:
  - Request:  FMT 2, PT 205
  - Response: FMT 3, PT 205
  - Sync:     FMT 4, PT 205
  - Term:     FMT 5, PT 205

Huawei protocol:
  - Request:  FMT 5, PT 205
  - Response: FMT 6, PT 205
  - Sync:     FMT 8, PT 205
  - Term:     FMT 9, PT 205
  - NAT:      0x00 0x03 prefix (non-RTCP)
"""

from __future__ import annotations

import socket
import struct
import threading

from .ports import find_free_udp_port
from .rtp import make_rtp_packet

# ---------------------------------------------------------------------------
# Telecom FCC packet builders
# ---------------------------------------------------------------------------

_TELECOM_FMT_REQ = 2
_TELECOM_FMT_RESP = 3
_TELECOM_FMT_SYN = 4
_TELECOM_FMT_TERM = 5


def _build_telecom_response(
    mcast_ip_be: bytes,
    result_code: int = 0,
    resp_type: int = 2,
    signal_port: int = 0,
    media_port: int = 0,
    fcc_ip: int = 0,
    speed: int = 10_000_000,
) -> bytes:
    """Build Telecom FCC response (FMT 3, PT 205). 36 bytes."""
    pk = bytearray(36)
    pk[0] = 0x80 | _TELECOM_FMT_RESP
    pk[1] = 205
    struct.pack_into("!H", pk, 2, 36 // 4 - 1)
    pk[8:12] = mcast_ip_be
    pk[12] = result_code
    pk[13] = resp_type
    struct.pack_into("!H", pk, 14, signal_port)
    struct.pack_into("!H", pk, 16, media_port)
    struct.pack_into("!I", pk, 20, fcc_ip)
    struct.pack_into("!I", pk, 24, 30)
    struct.pack_into("!I", pk, 28, speed)
    struct.pack_into("!I", pk, 32, speed)
    return bytes(pk)


def _build_telecom_sync(mcast_ip_be: bytes) -> bytes:
    """Build Telecom FCC sync notification (FMT 4, PT 205). 12 bytes."""
    pk = bytearray(12)
    pk[0] = 0x80 | _TELECOM_FMT_SYN
    pk[1] = 205
    struct.pack_into("!H", pk, 2, 12 // 4 - 1)
    pk[8:12] = mcast_ip_be
    return bytes(pk)


# ---------------------------------------------------------------------------
# Huawei FCC packet builders
# ---------------------------------------------------------------------------

_HUAWEI_FMT_REQ = 5
_HUAWEI_FMT_RESP = 6
_HUAWEI_FMT_SYN = 8
_HUAWEI_FMT_TERM = 9


def _build_huawei_response(
    mcast_ip_be: bytes,
    result_code: int = 1,
    resp_type: int = 2,
    server_ip_be: bytes = b"\x00\x00\x00\x00",
    server_port: int = 0,
    session_id: int = 0x12345678,
    nat_flag: int = 0,
) -> bytes:
    """Build Huawei FCC response (FMT 6, PT 205). 36 bytes.

    Layout:
      [0]     V=2, FMT=6
      [1]     PT=205
      [2-3]   Length
      [4-7]   Sender SSRC = 0
      [8-11]  Media Source SSRC (multicast IP)
      [12]    result_code (1 = success)
      [13]    reserved
      [14-15] type (nbo): 1=no unicast, 2=unicast, 3=redirect
      [16-23] reserved
      [24]    nat_flag (bit 5 => NAT traversal)
      [25]    reserved
      [26-27] server port (nbo)
      [28-31] session_id (nbo)
      [32-35] server IP (nbo)
    """
    pk = bytearray(36)
    pk[0] = 0x80 | _HUAWEI_FMT_RESP
    pk[1] = 205
    struct.pack_into("!H", pk, 2, 36 // 4 - 1)
    pk[8:12] = mcast_ip_be
    pk[12] = result_code
    struct.pack_into("!H", pk, 14, resp_type)
    pk[24] = nat_flag
    struct.pack_into("!H", pk, 26, server_port)
    struct.pack_into("!I", pk, 28, session_id)
    pk[32:36] = server_ip_be
    return bytes(pk)


def _build_huawei_short_response(
    mcast_ip_be: bytes,
    result_code: int = 1,
    resp_type: int = 2,
    first_seq: int = 0,
    bitrate_kbps: int = 8748,
) -> bytes:
    """Build Huawei FCC short response (FMT 6, PT 205). 24 bytes."""
    pk = bytearray(24)
    pk[0] = 0x80 | _HUAWEI_FMT_RESP
    pk[1] = 205
    struct.pack_into("!H", pk, 2, 24 // 4 - 1)
    pk[8:12] = mcast_ip_be
    pk[12] = result_code
    struct.pack_into("!H", pk, 14, resp_type)
    struct.pack_into("!H", pk, 16, first_seq)
    struct.pack_into("!H", pk, 20, bitrate_kbps)
    return bytes(pk)


def _build_huawei_sync(mcast_ip_be: bytes) -> bytes:
    """Build Huawei FCC sync notification (FMT 8, PT 205). 12 bytes."""
    pk = bytearray(12)
    pk[0] = 0x80 | _HUAWEI_FMT_SYN
    pk[1] = 205
    struct.pack_into("!H", pk, 2, 12 // 4 - 1)
    pk[8:12] = mcast_ip_be
    return bytes(pk)


# ---------------------------------------------------------------------------
# Mock FCC Server
# ---------------------------------------------------------------------------


class MockFCCServer:
    """A mock FCC server supporting both Telecom and Huawei protocols.

    Parameters
    ----------
    port : int
        UDP port to listen on (0 = auto).
    mcast_addr : str
        Expected multicast address (used for SSRC in responses).
    protocol : str
        "telecom" or "huawei".
    unicast_pps : int
        Packets per second for unicast RTP stream.
    sync_after : int
        Send sync notification after this many unicast packets.
        Set to 0 to never send sync (unicast only test).
    huawei_response_format : str
        "full" (36-byte response) or "short" (24-byte non-NAT response).
    redirect_to : tuple[str, int] | None
        If set, send a redirect response to this FCC server instead of starting
        unicast.
    first_unicast_seq : int
        Initial sequence number for mock unicast RTP packets and Huawei short
        response.
    bitrate_kbps : int
        Bitrate value returned in Huawei short responses.
    telecom_signal_port : int
        Optional Telecom signal port returned in the FCC response.
    telecom_media_port : int
        Optional Telecom media port returned in the FCC response.
    telecom_fcc_ip : str | None
        Optional Telecom FCC IP returned in the FCC response.
    """

    def __init__(
        self,
        port: int = 0,
        mcast_addr: str = "239.255.0.1",
        protocol: str = "telecom",
        unicast_pps: int = 300,
        sync_after: int = 100,
        huawei_response_format: str = "full",
        redirect_to: tuple[str, int] | None = None,
        first_unicast_seq: int = 0,
        bitrate_kbps: int = 8748,
        telecom_signal_port: int = 0,
        telecom_media_port: int = 0,
        telecom_fcc_ip: str | None = None,
    ):
        self.port = port or find_free_udp_port()
        self.mcast_addr = mcast_addr
        self.protocol = protocol
        self.unicast_pps = unicast_pps
        self.sync_after = sync_after
        self.huawei_response_format = huawei_response_format
        self.redirect_to = redirect_to
        self.first_unicast_seq = first_unicast_seq
        self.bitrate_kbps = bitrate_kbps
        self.telecom_signal_port = telecom_signal_port
        self.telecom_media_port = telecom_media_port
        self.telecom_fcc_ip = telecom_fcc_ip

        self._mcast_ip_be = socket.inet_aton(mcast_addr)
        self._sock: socket.socket | None = None
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()

        # Observable state
        self.requests_received = 0
        self.request_client_addrs: list[tuple[str, int]] = []
        self.terminations_received = 0
        self.unicast_packets_sent = 0

    @property
    def _fmt_req(self) -> int:
        return _HUAWEI_FMT_REQ if self.protocol == "huawei" else _TELECOM_FMT_REQ

    @property
    def _fmt_term(self) -> int:
        return _HUAWEI_FMT_TERM if self.protocol == "huawei" else _TELECOM_FMT_TERM

    def start(self) -> None:
        self._sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self._sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._sock.bind(("127.0.0.1", self.port))
        self._sock.settimeout(0.2)
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()

    def _loop(self) -> None:
        """Receive loop — runs in a dedicated thread so it is never blocked
        by the unicast sender."""
        assert self._sock is not None
        while not self._stop.is_set():
            try:
                data, addr = self._sock.recvfrom(4096)
            except socket.timeout:
                continue
            except OSError:
                break

            if len(data) < 4:
                continue

            fmt = data[0] & 0x1F
            pt = data[1]

            if pt == 205 and fmt == self._fmt_req:
                self.requests_received += 1
                self.request_client_addrs.append(addr)
                self._handle_request(addr)
            elif pt == 205 and fmt == self._fmt_term:
                self.terminations_received += 1
            # Huawei NAT traversal packets (0x00 0x03 prefix) are silently
            # accepted — no action needed from the mock server.

    def _handle_request(self, client_addr: tuple[str, int]) -> None:
        """Send response then start unicast streaming in a background thread."""
        assert self._sock is not None
        if self.protocol == "huawei" and self.redirect_to is not None:
            redirect_ip, redirect_port = self.redirect_to
            resp = _build_huawei_response(
                self._mcast_ip_be,
                resp_type=3,
                server_ip_be=socket.inet_aton(redirect_ip),
                server_port=redirect_port,
            )
        elif self.protocol == "telecom" and self.redirect_to is not None:
            redirect_ip, redirect_port = self.redirect_to
            resp = _build_telecom_response(
                self._mcast_ip_be,
                resp_type=3,
                signal_port=redirect_port,
                fcc_ip=struct.unpack("!I", socket.inet_aton(redirect_ip))[0],
            )
        elif self.protocol == "huawei" and self.huawei_response_format == "short":
            resp = _build_huawei_short_response(
                self._mcast_ip_be,
                first_seq=self.first_unicast_seq,
                bitrate_kbps=self.bitrate_kbps,
            )
        elif self.protocol == "huawei":
            resp = _build_huawei_response(self._mcast_ip_be)
        else:
            telecom_fcc_ip = 0
            if self.telecom_fcc_ip is not None:
                telecom_fcc_ip = struct.unpack("!I", socket.inet_aton(self.telecom_fcc_ip))[0]
            resp = _build_telecom_response(
                self._mcast_ip_be,
                signal_port=self.telecom_signal_port,
                media_port=self.telecom_media_port,
                fcc_ip=telecom_fcc_ip,
            )

        for _ in range(3):
            self._sock.sendto(resp, client_addr)

        if self.redirect_to is not None:
            return

        # Start unicast sender in a separate thread so the receive loop
        # keeps processing incoming packets (e.g. termination).
        t = threading.Thread(
            target=self._send_unicast,
            args=(client_addr,),
            daemon=True,
        )
        t.start()

    def _send_unicast(self, client_addr: tuple[str, int]) -> None:
        """Stream RTP unicast packets to the client."""
        assert self._sock is not None
        interval = 1.0 / self.unicast_pps
        send_addr = client_addr
        if self.protocol == "huawei" and client_addr[1] > 0:
            send_addr = (client_addr[0], client_addr[1] - 1)
        seq = self.first_unicast_seq
        ts = 0
        sent_count = 0
        while not self._stop.is_set():
            pkt = make_rtp_packet(seq, ts)
            try:
                self._sock.sendto(pkt, send_addr)
            except OSError:
                break
            self.unicast_packets_sent += 1
            sent_count += 1
            seq = (seq + 1) & 0xFFFF
            ts = (ts + 3600) & 0xFFFFFFFF

            # Send sync notification after configured packet count
            if self.sync_after > 0 and sent_count == self.sync_after:
                if self.protocol == "huawei":
                    sync_pk = _build_huawei_sync(self._mcast_ip_be)
                else:
                    sync_pk = _build_telecom_sync(self._mcast_ip_be)
                for _ in range(3):
                    try:
                        self._sock.sendto(sync_pk, client_addr)
                    except OSError:
                        pass

            self._stop.wait(interval)

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=3)
        if self._sock:
            self._sock.close()
