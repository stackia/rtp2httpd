#!/usr/bin/env python3
"""
Multicast UDP Replay Tool with IGMP Monitoring

Reads a pcapng file containing UDP multicast packets (RTP/FEC data)
and replays them when a process joins the multicast group.
Stops replaying when no process is subscribed to the group.
Used for testing rtp2httpd with controlled data sources.
"""

import argparse
import random
import socket
import struct
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from threading import Thread, Event

from scapy.all import PcapNgReader, UDP, IP, Raw


@dataclass
class PacketInfo:
    """Parsed UDP packet information."""

    timestamp: float
    payload: bytes
    dst_addr: str
    dst_port: int


def parse_args() -> argparse.Namespace:
    """Parse command-line arguments."""
    parser = argparse.ArgumentParser(
        description="Replay multicast UDP packets from pcapng file.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  %(prog)s fixtures/fec_sample.pcapng
  %(prog)s fixtures/fec_sample.pcapng -i eth0
  %(prog)s fixtures/fec_sample.pcapng -v
  %(prog)s fixtures/fec_sample.pcapng --loss 1.0 --reorder 2.0
""",
    )
    parser.add_argument("pcapng_file", type=Path, help="Path to pcapng file")
    parser.add_argument(
        "-i",
        "--interface",
        help="Network interface for multicast (e.g., eth0)",
    )
    parser.add_argument(
        "-v",
        "--verbose",
        action="store_true",
        help="Show verbose output",
    )
    parser.add_argument(
        "--loss",
        type=float,
        default=0.0,
        metavar="PERCENT",
        help="Packet loss rate in percent (0-100, default: 0)",
    )
    parser.add_argument(
        "--reorder",
        type=float,
        default=0.0,
        metavar="PERCENT",
        help="Packet reorder rate in percent (0-100, default: 0)",
    )
    return parser.parse_args()


def load_packets(filepath: Path, verbose: bool = False) -> list[PacketInfo]:
    """Load UDP packets from pcapng file."""
    packets: list[PacketInfo] = []

    if verbose:
        print(f"Loading {filepath}...", flush=True)

    with PcapNgReader(str(filepath)) as reader:
        for pkt in reader:
            if UDP in pkt and IP in pkt:
                if Raw in pkt:
                    payload = bytes(pkt[Raw].load)
                else:
                    payload = bytes(pkt[UDP].payload)

                if payload:
                    packets.append(
                        PacketInfo(
                            timestamp=float(pkt.time),
                            payload=payload,
                            dst_addr=pkt[IP].dst,
                            dst_port=pkt[UDP].dport,
                        )
                    )

    if verbose:
        if packets:
            duration = packets[-1].timestamp - packets[0].timestamp
            dests = set((p.dst_addr, p.dst_port) for p in packets)
            print(
                f"Loaded {len(packets)} UDP packets (duration: {duration:.2f}s)",
                flush=True,
            )
            for addr, port in sorted(dests):
                count = sum(
                    1 for p in packets
                    if p.dst_addr == addr and p.dst_port == port
                )
                print(f"  -> {addr}:{port} ({count} packets)", flush=True)
        else:
            print("No UDP packets found in file", flush=True)

    return packets


def ip_to_proc_format(ip: str) -> str:
    """Convert IP address to /proc/net/igmp format (reversed hex)."""
    octets = [int(x) for x in ip.split(".")]
    # /proc/net/igmp uses reversed byte order
    return f"{octets[3]:02X}{octets[2]:02X}{octets[1]:02X}{octets[0]:02X}"


def check_igmp_membership(group_addr: str) -> bool:
    """Check if any process is subscribed to the multicast group."""
    target = ip_to_proc_format(group_addr)

    try:
        with open("/proc/net/igmp", "r") as f:
            content = f.read()
            return target in content
    except IOError:
        return False


def get_interface_ip(interface: str) -> str:
    """Get IP address of a network interface."""
    import fcntl

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        ifreq = struct.pack("256s", interface.encode()[:15])
        result = fcntl.ioctl(sock.fileno(), 0x8915, ifreq)  # SIOCGIFADDR
        return socket.inet_ntoa(result[20:24])
    finally:
        sock.close()


def create_multicast_socket(
    interface: str | None = None,
    ttl: int = 1,
) -> socket.socket:
    """Create UDP socket configured for multicast sending."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
    sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, ttl)
    sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_LOOP, 1)

    if interface:
        try:
            ip_addr = get_interface_ip(interface)
            sock.setsockopt(
                socket.IPPROTO_IP,
                socket.IP_MULTICAST_IF,
                socket.inet_aton(ip_addr),
            )
        except OSError as e:
            raise OSError(
                f"Failed to bind to interface {interface}: {e}"
            ) from e

    return sock


class IGMPMonitor(Thread):
    """Thread that monitors /proc/net/igmp for group membership."""

    def __init__(
        self,
        groups: dict[str, Event],
        verbose: bool = False,
    ):
        super().__init__(daemon=True)
        self.groups = groups  # {address: joined_event}
        self.verbose = verbose
        self.running = True

    def run(self) -> None:
        if self.verbose:
            print("IGMP monitor started (polling /proc/net/igmp)", flush=True)

        while self.running:
            for addr, event in self.groups.items():
                is_joined = check_igmp_membership(addr)

                if is_joined and not event.is_set():
                    if self.verbose:
                        print(f"IGMP Join detected: {addr}", flush=True)
                    event.set()
                elif not is_joined and event.is_set():
                    if self.verbose:
                        print(f"IGMP Leave detected: {addr}", flush=True)
                    event.clear()

            time.sleep(0.05)  # Poll every 50ms for faster response

    def stop(self) -> None:
        self.running = False


def replay_loop(
    packets: list[PacketInfo],
    sock: socket.socket,
    group_events: dict[str, Event],
    loss_rate: float = 0.0,
    reorder_rate: float = 0.0,
    verbose: bool = False,
) -> None:
    """Continuously replay packets when IGMP join is active."""
    if not packets:
        print("No packets to replay")
        return

    loop_count = 0
    total_packets_sent = 0
    total_packets_dropped = 0
    total_packets_reordered = 0
    total_bytes_sent = 0
    start_time = time.monotonic()

    dests = set((p.dst_addr, p.dst_port) for p in packets)
    dest_str = ", ".join(f"{addr}:{port}" for addr, port in sorted(dests))
    print(f"Waiting for IGMP Join on {dest_str}...", flush=True)
    if loss_rate > 0 or reorder_rate > 0:
        print(
            f"Simulation: loss={loss_rate:.1f}%, reorder={reorder_rate:.1f}%",
            flush=True,
        )
    print("(Ctrl+C to stop)", flush=True)

    # Buffer for reordering (holds delayed packets)
    reorder_buffer: list[tuple[PacketInfo, float]] = []

    try:
        while True:
            # Check if any group is joined
            any_joined = any(event.is_set() for event in group_events.values())

            if not any_joined:
                time.sleep(0.1)
                continue

            loop_count += 1
            loop_start = time.monotonic()
            packets_this_loop = 0
            dropped_this_loop = 0
            reordered_this_loop = 0

            if verbose and loop_count == 1:
                print("Starting replay...", flush=True)

            for i, pkt in enumerate(packets):
                # Check if this group is still joined
                if pkt.dst_addr in group_events:
                    if not group_events[pkt.dst_addr].is_set():
                        continue

                # Apply original timing
                if i > 0:
                    delay = pkt.timestamp - packets[i - 1].timestamp
                    if delay > 0:
                        time.sleep(delay)

                # Check again after sleep
                if pkt.dst_addr in group_events:
                    if not group_events[pkt.dst_addr].is_set():
                        continue

                # Send any buffered reordered packets that are due
                now = time.monotonic()
                due_packets = [
                    (p, t) for p, t in reorder_buffer if now >= t
                ]
                for delayed_pkt, _ in due_packets:
                    sock.sendto(
                        delayed_pkt.payload,
                        (delayed_pkt.dst_addr, delayed_pkt.dst_port),
                    )
                    total_packets_sent += 1
                    total_bytes_sent += len(delayed_pkt.payload)
                    packets_this_loop += 1
                reorder_buffer = [
                    (p, t) for p, t in reorder_buffer if now < t
                ]

                # Simulate packet loss
                if loss_rate > 0 and random.random() * 100 < loss_rate:
                    dropped_this_loop += 1
                    total_packets_dropped += 1
                    continue

                # Simulate packet reordering
                if reorder_rate > 0 and random.random() * 100 < reorder_rate:
                    # Delay this packet by 1-5 packets worth of time
                    delay_time = random.uniform(0.001, 0.01)
                    reorder_buffer.append((pkt, time.monotonic() + delay_time))
                    reordered_this_loop += 1
                    total_packets_reordered += 1
                    continue

                sock.sendto(pkt.payload, (pkt.dst_addr, pkt.dst_port))
                total_packets_sent += 1
                total_bytes_sent += len(pkt.payload)
                packets_this_loop += 1

            # Flush remaining reorder buffer at end of loop
            for delayed_pkt, _ in reorder_buffer:
                sock.sendto(
                    delayed_pkt.payload,
                    (delayed_pkt.dst_addr, delayed_pkt.dst_port),
                )
                total_packets_sent += 1
                total_bytes_sent += len(delayed_pkt.payload)
                packets_this_loop += 1
            reorder_buffer.clear()

            loop_duration = time.monotonic() - loop_start

            if verbose and packets_this_loop > 0:
                stats = f"Loop {loop_count}: {packets_this_loop} packets"
                if dropped_this_loop > 0:
                    stats += f", {dropped_this_loop} dropped"
                if reordered_this_loop > 0:
                    stats += f", {reordered_this_loop} reordered"
                stats += f" in {loop_duration:.2f}s"
                print(stats, flush=True)

            # Wait 3 seconds before next loop
            if verbose:
                print("Waiting 3s before next loop...", flush=True)
            time.sleep(3.0)

            # Check if still joined before next loop
            any_joined = any(event.is_set() for event in group_events.values())
            if not any_joined:
                if verbose:
                    print("All groups left, waiting for Join...", flush=True)

    except KeyboardInterrupt:
        pass

    elapsed = time.monotonic() - start_time
    print(f"\nStopped after {loop_count} loop(s)", flush=True)
    print(
        f"Total: {total_packets_sent} packets sent, "
        f"{total_bytes_sent / 1024:.1f} KB",
        flush=True,
    )
    if total_packets_dropped > 0:
        print(f"Dropped: {total_packets_dropped} packets", flush=True)
    if total_packets_reordered > 0:
        print(f"Reordered: {total_packets_reordered} packets", flush=True)
    if elapsed > 0:
        print(
            f"Duration: {elapsed:.1f}s, "
            f"Rate: {total_packets_sent / elapsed:.1f} pkt/s",
            flush=True,
        )


def main() -> int:
    """Main entry point."""
    args = parse_args()

    if not args.pcapng_file.exists():
        print(f"Error: File not found: {args.pcapng_file}", file=sys.stderr)
        return 1

    if not 0 <= args.loss <= 100:
        print("Error: --loss must be between 0 and 100", file=sys.stderr)
        return 1

    if not 0 <= args.reorder <= 100:
        print("Error: --reorder must be between 0 and 100", file=sys.stderr)
        return 1

    try:
        packets = load_packets(args.pcapng_file, verbose=args.verbose)
    except Exception as e:
        print(f"Error loading pcapng file: {e}", file=sys.stderr)
        return 1

    if not packets:
        print("Error: No UDP packets found in file", file=sys.stderr)
        return 1

    # Get unique multicast groups
    groups = set(p.dst_addr for p in packets)
    group_events: dict[str, Event] = {addr: Event() for addr in groups}

    if args.verbose:
        print(
            f"Monitoring IGMP for groups: {', '.join(sorted(groups))}",
            flush=True,
        )

    # Start IGMP monitor
    igmp_monitor = IGMPMonitor(group_events, verbose=args.verbose)
    igmp_monitor.start()

    try:
        sock = create_multicast_socket(args.interface)
    except OSError as e:
        print(f"Error creating socket: {e}", file=sys.stderr)
        return 1

    try:
        replay_loop(
            packets,
            sock,
            group_events,
            loss_rate=args.loss,
            reorder_rate=args.reorder,
            verbose=args.verbose,
        )
    finally:
        igmp_monitor.stop()
        sock.close()

    return 0


if __name__ == "__main__":
    sys.exit(main())
