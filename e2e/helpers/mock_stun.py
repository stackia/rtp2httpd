"""Mock STUN server for E2E tests.

Implements a minimal RFC 5389 STUN server that responds to Binding Requests
with a configurable XOR-MAPPED-ADDRESS.  Supports a "silent" mode where no
response is sent, allowing timeout/retry testing.
"""

from __future__ import annotations

import socket
import struct
import threading

from .ports import find_free_udp_port

# STUN protocol constants (RFC 5389)
_BINDING_REQUEST = 0x0001
_BINDING_SUCCESS = 0x0101
_MAGIC_COOKIE = 0x2112A442
_ATTR_XOR_MAPPED_ADDR = 0x0020
_HEADER_SIZE = 20


class MockSTUNServer:
    """A mock STUN server that responds with a pre-configured mapped address.

    Parameters
    ----------
    port : int
        UDP port to listen on (0 = auto).
    mapped_port : int
        The mapped RTP port to advertise in XOR-MAPPED-ADDRESS.
    mapped_ip : str
        The mapped IP address to advertise (default ``"1.2.3.4"``).
    silent : bool
        If ``True``, receive requests but never respond (for timeout tests).
    """

    def __init__(
        self,
        port: int = 0,
        mapped_port: int = 50000,
        mapped_ip: str = "1.2.3.4",
        silent: bool = False,
    ):
        self.port = port or find_free_udp_port()
        self.mapped_port = mapped_port
        self.mapped_ip = mapped_ip
        self.silent = silent

        self._sock: socket.socket | None = None
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()

        # Observable state
        self.requests_received: int = 0

    def start(self) -> None:
        self._sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self._sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._sock.bind(("127.0.0.1", self.port))
        self._sock.settimeout(0.2)
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()

    def _loop(self) -> None:
        assert self._sock is not None
        while not self._stop.is_set():
            try:
                data, addr = self._sock.recvfrom(4096)
            except socket.timeout:
                continue
            except OSError:
                break

            if len(data) < _HEADER_SIZE:
                continue

            msg_type = (data[0] << 8) | data[1]
            magic = struct.unpack_from("!I", data, 4)[0]

            if msg_type == _BINDING_REQUEST and magic == _MAGIC_COOKIE:
                self.requests_received += 1
                if not self.silent:
                    transaction_id = data[8:20]
                    resp = self._build_response(transaction_id)
                    self._sock.sendto(resp, addr)

    def _build_response(self, transaction_id: bytes) -> bytes:
        """Build a STUN Binding Success Response with XOR-MAPPED-ADDRESS."""
        # XOR-MAPPED-ADDRESS attribute value (8 bytes for IPv4)
        #   [0]     reserved (0x00)
        #   [1]     family (0x01 = IPv4)
        #   [2-3]   X-Port (port XOR'd with top 16 bits of magic cookie)
        #   [4-7]   X-Address (IP XOR'd with magic cookie)
        x_port = self.mapped_port ^ (_MAGIC_COOKIE >> 16)
        ip_int = struct.unpack("!I", socket.inet_aton(self.mapped_ip))[0]
        x_addr = ip_int ^ _MAGIC_COOKIE

        attr_value = struct.pack("!BBH I", 0x00, 0x01, x_port, x_addr)
        attr_header = struct.pack("!HH", _ATTR_XOR_MAPPED_ADDR, len(attr_value))
        attrs = attr_header + attr_value

        # STUN header
        header = struct.pack(
            "!HH I",
            _BINDING_SUCCESS,
            len(attrs),
            _MAGIC_COOKIE,
        )
        return header + transaction_id + attrs

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=3)
        if self._sock:
            self._sock.close()
