"""RTP packet crafting and multicast sender for E2E tests."""

from __future__ import annotations

import socket
import struct
import threading

from .constants import MCAST_ADDR
from .ports import find_free_udp_port

# A minimal 188-byte MPEG-TS null packet (sync byte 0x47, PID 0x1FFF = null)
_TS_NULL_PACKET = b"\x47\x1f\xff\x10" + b"\xff" * 184


def _make_ts_with_marker(marker: int) -> bytes:
    """TS null packet with a 2-byte big-endian marker embedded at bytes 4-5."""
    return b"\x47\x1f\xff\x10" + struct.pack("!H", marker & 0xFFFF) + b"\xff" * 182


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
        reorder_distance: int = 0,
        unique_payloads: bool = False,
        send_duplicates: bool = False,
    ):
        self.addr = addr
        self.port = port or find_free_udp_port()
        self.pps = pps
        self.ts_per_rtp = ts_per_rtp
        self.reorder_distance = reorder_distance
        self.unique_payloads = unique_payloads
        self.send_duplicates = send_duplicates
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
        buf: list[bytes] = []
        while not self._stop.is_set():
            if self.unique_payloads:
                payload = _make_ts_with_marker(seq) * self.ts_per_rtp
            else:
                payload = self._payload
            pkt = make_rtp_packet(seq, ts, payload=payload)

            if self.reorder_distance > 1:
                buf.append(pkt)
                if len(buf) >= self.reorder_distance:
                    for p in reversed(buf):
                        self._send(p)
                    buf.clear()
            else:
                self._send(pkt)
                if self.send_duplicates:
                    self._send(pkt)

            seq = (seq + 1) & 0xFFFF
            ts = (ts + 3600) & 0xFFFFFFFF
            self._stop.wait(interval)

        # Flush remaining buffered packets on stop
        for p in reversed(buf):
            self._send(p)

    def _send(self, pkt: bytes) -> None:
        try:
            self._sock.sendto(pkt, (self.addr, self.port))
            self.packets_sent += 1
        except OSError:
            pass

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=2)
        if self._sock:
            self._sock.close()
