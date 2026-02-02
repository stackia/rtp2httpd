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
from threading import Thread, Event, Lock

from scapy.all import PcapNgReader, UDP, IP, Raw


def is_rtp_packet(payload: bytes) -> bool:
    """Check if payload is an RTP packet (version 2)."""
    return len(payload) >= 12 and (payload[0] & 0xC0) == 0x80


def patch_rtp_sequence(payload: bytes, seq_offset: int) -> bytes:
    """Patch RTP sequence number in payload.

    RTP header format (first 12 bytes):
    - Byte 0: V=2, P, X, CC
    - Byte 1: M, PT
    - Bytes 2-3: Sequence number (big-endian)
    """
    if not is_rtp_packet(payload):
        return payload

    # Calculate new sequence number (wrap at 65536)
    orig_seq = (payload[2] << 8) | payload[3]
    new_seq = (orig_seq + seq_offset) & 0xFFFF

    # Patch in place using bytearray
    patched = bytearray(payload)
    patched[2] = (new_seq >> 8) & 0xFF
    patched[3] = new_seq & 0xFF

    return bytes(patched)


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
  %(prog)s fixtures/fec_sample.pcapng --speed 2.0           # 2x speed
  %(prog)s fixtures/fec_sample.pcapng --speed 10 --continuous  # Stress test
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
    parser.add_argument(
        "--speed",
        type=float,
        default=1.0,
        metavar="MULTIPLIER",
        help="Playback speed multiplier (e.g., 2.0 for 2x, default: 1.0)",
    )
    parser.add_argument(
        "--continuous",
        action="store_true",
        help="Continuous replay without gaps, with incrementing RTP seq numbers",
    )
    return parser.parse_args()


def load_packets(filepath: Path) -> list[PacketInfo]:
    """Load UDP packets from pcapng file."""
    packets: list[PacketInfo] = []

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

    if packets:
        duration = packets[-1].timestamp - packets[0].timestamp
        dests = set((p.dst_addr, p.dst_port) for p in packets)
        print(
            f"Loaded {len(packets)} UDP packets (duration: {duration:.2f}s)",
            flush=True,
        )
        for addr, port in sorted(dests):
            count = sum(1 for p in packets if p.dst_addr == addr and p.dst_port == port)
            print(f"  -> {addr}:{port} ({count} packets)", flush=True)
    else:
        print("No UDP packets found in file", flush=True)

    return packets


def ip_to_proc_format(ip: str) -> str:
    """Convert IP address to /proc/net/igmp format (reversed hex)."""
    octets = [int(x) for x in ip.split(".")]
    # /proc/net/igmp uses reversed byte order
    return f"{octets[3]:02X}{octets[2]:02X}{octets[1]:02X}{octets[0]:02X}"


def proc_format_to_ip(hex_str: str) -> str:
    """Convert /proc/net/igmp hex format back to IP address."""
    # hex_str is in reversed byte order: DDCCBBAA for AA.BB.CC.DD
    octets = [
        int(hex_str[6:8], 16),
        int(hex_str[4:6], 16),
        int(hex_str[2:4], 16),
        int(hex_str[0:2], 16),
    ]
    return f"{octets[0]}.{octets[1]}.{octets[2]}.{octets[3]}"


def check_igmp_membership(group_addr: str) -> bool:
    """Check if any process is subscribed to the multicast group."""
    target = ip_to_proc_format(group_addr)

    try:
        with open("/proc/net/igmp", "r") as f:
            content = f.read()
            return target in content
    except IOError:
        return False


def get_subnet_for_ip(ip: str, prefix_len: int = 24) -> str:
    """Get the /prefix_len subnet for an IP address."""
    octets = [int(x) for x in ip.split(".")]
    ip_int = (octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]
    mask = (0xFFFFFFFF << (32 - prefix_len)) & 0xFFFFFFFF
    net_int = ip_int & mask

    net_octets = [
        (net_int >> 24) & 0xFF,
        (net_int >> 16) & 0xFF,
        (net_int >> 8) & 0xFF,
        net_int & 0xFF,
    ]
    return (
        f"{net_octets[0]}.{net_octets[1]}.{net_octets[2]}.{net_octets[3]}/{prefix_len}"
    )


def is_ip_in_subnet(ip: str, subnet: str) -> bool:
    """Check if an IP address is within a subnet (e.g., 239.81.0.0/24)."""
    net_addr, prefix_len = subnet.split("/")
    prefix_len = int(prefix_len)

    ip_octets = [int(x) for x in ip.split(".")]
    net_octets = [int(x) for x in net_addr.split(".")]

    ip_int = (
        (ip_octets[0] << 24) | (ip_octets[1] << 16) | (ip_octets[2] << 8) | ip_octets[3]
    )
    net_int = (
        (net_octets[0] << 24)
        | (net_octets[1] << 16)
        | (net_octets[2] << 8)
        | net_octets[3]
    )

    mask = (0xFFFFFFFF << (32 - prefix_len)) & 0xFFFFFFFF
    return (ip_int & mask) == (net_int & mask)


def get_igmp_joined_groups(subnets: list[str]) -> set[str]:
    """Get all multicast groups currently joined that are within the specified subnets."""
    joined = set()

    try:
        with open("/proc/net/igmp", "r") as f:
            for line in f:
                # Skip header and interface lines
                line = line.strip()
                if not line or line.startswith("Idx") or "\t" not in line:
                    continue

                # Lines with group addresses start with a tab and have hex address
                parts = line.split()
                if len(parts) >= 1:
                    hex_addr = parts[0]
                    if len(hex_addr) == 8:
                        try:
                            ip = proc_format_to_ip(hex_addr)
                            for subnet in subnets:
                                if is_ip_in_subnet(ip, subnet):
                                    joined.add(ip)
                                    break
                        except (ValueError, IndexError):
                            continue
    except IOError:
        pass

    return joined


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
            raise OSError(f"Failed to bind to interface {interface}: {e}") from e

    return sock


class IGMPMonitor(Thread):
    """Thread that monitors /proc/net/igmp for group membership.

    Supports two modes:
    1. Fixed groups mode: monitors specific addresses (legacy)
    2. Subnet mode: monitors entire subnets and dynamically tracks joined groups
    """

    def __init__(
        self,
        groups: dict[str, Event] | None = None,
        subnets: list[str] | None = None,
        on_join: callable = None,
        on_leave: callable = None,
    ):
        super().__init__(daemon=True)
        self.groups = groups or {}  # {address: joined_event}
        self.subnets = subnets or []  # Subnets to monitor (e.g., ["239.81.0.0/24"])
        self.on_join = on_join  # Callback when a new group is joined
        self.on_leave = on_leave  # Callback when a group is left
        self._active_groups: set[str] = set()  # Currently joined groups in subnets
        self._lock = Lock()  # Protect active_groups access
        self.running = True

    def run(self) -> None:
        if self.subnets:
            print(
                f"IGMP monitor started for subnets: {', '.join(self.subnets)}",
                flush=True,
            )
        else:
            print("IGMP monitor started (polling /proc/net/igmp)", flush=True)

        while self.running:
            # Handle fixed groups (legacy mode)
            for addr, event in self.groups.items():
                is_joined = check_igmp_membership(addr)

                if is_joined and not event.is_set():
                    print(f"IGMP Join detected: {addr}", flush=True)
                    event.set()
                elif not is_joined and event.is_set():
                    print(f"IGMP Leave detected: {addr}", flush=True)
                    event.clear()

            # Handle subnet monitoring (new mode)
            if self.subnets:
                current_joined = get_igmp_joined_groups(self.subnets)

                with self._lock:
                    # Detect new joins
                    new_joins = current_joined - self._active_groups
                    for addr in new_joins:
                        print(f"IGMP Join detected: {addr}", flush=True)
                        if self.on_join:
                            self.on_join(addr)

                    # Detect leaves
                    leaves = self._active_groups - current_joined
                    for addr in leaves:
                        print(f"IGMP Leave detected: {addr}", flush=True)
                        if self.on_leave:
                            self.on_leave(addr)

                    self._active_groups = current_joined

            time.sleep(0.05)  # Poll every 50ms for faster response

    def get_active_groups(self) -> set[str]:
        """Return currently active (joined) groups."""
        with self._lock:
            return self._active_groups.copy()

    def stop(self) -> None:
        self.running = False


def replay_loop(
    packets: list[PacketInfo],
    sock: socket.socket,
    group_events: dict[str, Event] | None = None,
    igmp_monitor: IGMPMonitor | None = None,
    loss_rate: float = 0.0,
    reorder_rate: float = 0.0,
    speed: float = 1.0,
    continuous: bool = False,
    verbose: bool = False,
) -> None:
    """Continuously replay packets when IGMP join is active.

    Optimized for maximum throughput with minimal overhead.
    """
    if not packets:
        print("No packets to replay")
        return

    group_events = group_events or {}

    loop_count = 0
    total_packets_sent = 0
    total_packets_dropped = 0
    total_packets_reordered = 0
    total_bytes_sent = 0
    start_time = time.monotonic()

    # Pre-calculate relative timestamps for speed adjustment
    base_ts = packets[0].timestamp
    relative_times = tuple((p.timestamp - base_ts) / speed for p in packets)

    # Pre-extract payload and port for faster access
    packet_data = tuple((p.payload, p.dst_port) for p in packets)
    num_packets = len(packets)

    # For continuous mode: track RTP sequence offset per stream (by dest port)
    stream_seq_offsets: dict[int, int] = {}
    stream_rtp_counts: dict[int, int] = {}
    for payload, port in packet_data:
        if is_rtp_packet(payload):
            stream_rtp_counts[port] = stream_rtp_counts.get(port, 0) + 1
            if port not in stream_seq_offsets:
                stream_seq_offsets[port] = 0

    # Get unique ports from pcap
    pcap_ports = set(p.dst_port for p in packets)

    if igmp_monitor and igmp_monitor.subnets:
        print(
            f"Waiting for IGMP Join on subnets: {', '.join(igmp_monitor.subnets)}",
            flush=True,
        )
        print(
            f"Will replay to any joined address using ports: "
            f"{', '.join(str(p) for p in sorted(pcap_ports))}",
            flush=True,
        )
    else:
        pcap_dests = set((p.dst_addr, p.dst_port) for p in packets)
        dest_str = ", ".join(f"{addr}:{port}" for addr, port in sorted(pcap_dests))
        print(f"Waiting for IGMP Join on {dest_str}...", flush=True)

    # Show mode information
    mode_parts = []
    if speed != 1.0:
        mode_parts.append(f"speed={speed:.1f}x")
    if continuous:
        mode_parts.append("continuous")
    if loss_rate > 0:
        mode_parts.append(f"loss={loss_rate:.1f}%")
    if reorder_rate > 0:
        mode_parts.append(f"reorder={reorder_rate:.1f}%")
    if mode_parts:
        print(f"Mode: {', '.join(mode_parts)}", flush=True)

    print("(Ctrl+C to stop)", flush=True)

    # Periodic stats tracking
    stats_interval = 5.0
    last_stats_time = time.monotonic()
    interval_packets = 0
    interval_bytes = 0

    # Track current targets
    current_targets: set[str] = set()

    # Cache function references for speed
    monotonic = time.monotonic
    sleep = time.sleep
    sendto = sock.sendto
    random_fn = random.random if (loss_rate > 0 or reorder_rate > 0) else None

    # Always use timing for bandwidth/speed control
    # Timing is essential for controlled replay at specific speeds

    def get_target_addresses() -> set[str]:
        if igmp_monitor and igmp_monitor.subnets:
            return igmp_monitor.get_active_groups()
        return {addr for addr, event in group_events.items() if event.is_set()}

    try:
        while True:
            targets = get_target_addresses()

            if not targets:
                if current_targets:
                    print("All groups left, waiting for Join...", flush=True)
                    current_targets.clear()
                sleep(0.1)
                continue

            # Log new targets
            new_targets = targets - current_targets
            for addr in sorted(new_targets):
                if current_targets:
                    print(f"Adding target: {addr}", flush=True)
            current_targets = targets.copy()

            loop_count += 1
            loop_start = monotonic()
            packets_this_loop = 0
            dropped_this_loop = 0
            reordered_this_loop = 0

            if loop_count == 1:
                print(
                    f"Starting replay to {len(targets)} target(s): "
                    f"{', '.join(sorted(targets))}",
                    flush=True,
                )

            # Convert targets to list for faster iteration
            target_list = list(targets)
            target_count = len(target_list)

            # Pre-build destination tuples for each target and port
            # This avoids tuple creation in the hot loop
            dest_cache: dict[tuple[str, int], tuple[str, int]] = {}
            for addr in target_list:
                for port in pcap_ports:
                    dest_cache[(addr, port)] = (addr, port)

            # Reorder buffer for packet reordering simulation
            reorder_buffer: list[tuple[bytes, int, float, list[str]]] = []

            i = 0
            next_target_refresh = 500  # Refresh targets every 500 packets

            # Check if we need loss/reorder simulation
            use_loss = loss_rate > 0 and random_fn is not None
            use_reorder = reorder_rate > 0 and random_fn is not None

            # Fast path: no loss/reorder simulation
            if not use_loss and not use_reorder:
                while i < num_packets:
                    # Refresh targets periodically
                    if i >= next_target_refresh:
                        targets = get_target_addresses()
                        if not targets:
                            break
                        target_list = list(targets)
                        target_count = len(target_list)
                        next_target_refresh = i + 500

                    payload, port = packet_data[i]

                    # Timing: single monotonic() call, sleep handles the wait
                    target_time = loop_start + relative_times[i]
                    wait_time = target_time - monotonic()
                    if wait_time > 0.001:
                        sleep(wait_time)

                    # Patch RTP sequence number in continuous mode
                    if continuous and port in stream_seq_offsets:
                        offset = stream_seq_offsets[port]
                        if offset > 0:
                            payload = patch_rtp_sequence(payload, offset)

                    # Send to all targets - unrolled for common cases
                    payload_len = len(payload)
                    if target_count == 1:
                        sendto(payload, (target_list[0], port))
                        total_packets_sent += 1
                        total_bytes_sent += payload_len
                        packets_this_loop += 1
                        interval_packets += 1
                        interval_bytes += payload_len
                    elif target_count == 2:
                        sendto(payload, (target_list[0], port))
                        sendto(payload, (target_list[1], port))
                        total_packets_sent += 2
                        total_bytes_sent += payload_len * 2
                        packets_this_loop += 2
                        interval_packets += 2
                        interval_bytes += payload_len * 2
                    else:
                        for dst_addr in target_list:
                            sendto(payload, (dst_addr, port))
                        total_packets_sent += target_count
                        total_bytes_sent += payload_len * target_count
                        packets_this_loop += target_count
                        interval_packets += target_count
                        interval_bytes += payload_len * target_count

                    i += 1
            else:
                # Slow path: with loss/reorder simulation
                while i < num_packets:
                    # Refresh targets periodically
                    if i >= next_target_refresh:
                        targets = get_target_addresses()
                        if not targets:
                            break
                        target_list = list(targets)
                        target_count = len(target_list)
                        next_target_refresh = i + 500

                    payload, port = packet_data[i]

                    # Timing control
                    target_time = loop_start + relative_times[i]
                    now = monotonic()
                    wait_time = target_time - now

                    if wait_time > 0.001:
                        sleep(wait_time)
                        now = target_time  # Assume sleep was accurate enough

                    # Process reorder buffer
                    if reorder_buffer:
                        j = 0
                        while j < len(reorder_buffer):
                            buf_payload, buf_port, buf_time, buf_targets = (
                                reorder_buffer[j]
                            )
                            if now >= buf_time:
                                for dst_addr in buf_targets:
                                    sendto(buf_payload, (dst_addr, buf_port))
                                    total_packets_sent += 1
                                    total_bytes_sent += len(buf_payload)
                                    packets_this_loop += 1
                                reorder_buffer.pop(j)
                            else:
                                j += 1

                    # Simulate packet loss
                    if use_loss and random_fn() * 100 < loss_rate:
                        dropped_this_loop += 1
                        total_packets_dropped += 1
                        i += 1
                        continue

                    # Simulate packet reordering
                    if use_reorder and random_fn() * 100 < reorder_rate:
                        delay_time = random.uniform(0.001, 0.01)
                        reorder_buffer.append(
                            (payload, port, now + delay_time, target_list.copy())
                        )
                        reordered_this_loop += 1
                        total_packets_reordered += 1
                        i += 1
                        continue

                    # Patch RTP sequence number in continuous mode
                    if continuous and port in stream_seq_offsets:
                        offset = stream_seq_offsets[port]
                        if offset > 0:
                            payload = patch_rtp_sequence(payload, offset)

                    # Send to all targets
                    payload_len = len(payload)
                    if target_count == 1:
                        sendto(payload, (target_list[0], port))
                        total_packets_sent += 1
                        total_bytes_sent += payload_len
                        packets_this_loop += 1
                        interval_packets += 1
                        interval_bytes += payload_len
                    elif target_count == 2:
                        sendto(payload, (target_list[0], port))
                        sendto(payload, (target_list[1], port))
                        total_packets_sent += 2
                        total_bytes_sent += payload_len * 2
                        packets_this_loop += 2
                        interval_packets += 2
                        interval_bytes += payload_len * 2
                    else:
                        for dst_addr in target_list:
                            sendto(payload, (dst_addr, port))
                        total_packets_sent += target_count
                        total_bytes_sent += payload_len * target_count
                        packets_this_loop += target_count
                        interval_packets += target_count
                        interval_bytes += payload_len * target_count

                    i += 1

            # Stats output at end of each loop (time-based, every stats_interval)
            now = monotonic()
            if now - last_stats_time >= stats_interval:
                elapsed_interval = now - last_stats_time
                pkt_rate = interval_packets / elapsed_interval
                byte_rate = interval_bytes / elapsed_interval
                print(
                    f"[Stats] {target_count} target(s), {pkt_rate:.1f} pkt/s, "
                    f"{byte_rate / 1024 / 1024:.2f} MB/s, "
                    f"{byte_rate * 8 / 1024 / 1024:.2f} Mbps",
                    flush=True,
                )
                last_stats_time = now
                interval_packets = 0
                interval_bytes = 0

            # Flush remaining reorder buffer
            for buf_payload, buf_port, _, buf_targets in reorder_buffer:
                for dst_addr in buf_targets:
                    sendto(buf_payload, (dst_addr, buf_port))
                    total_packets_sent += 1
                    total_bytes_sent += len(buf_payload)
                    packets_this_loop += 1

            loop_duration = monotonic() - loop_start

            if verbose and packets_this_loop > 0:
                stats = f"Loop {loop_count}: {packets_this_loop} packets"
                if dropped_this_loop > 0:
                    stats += f", {dropped_this_loop} dropped"
                if reordered_this_loop > 0:
                    stats += f", {reordered_this_loop} reordered"
                stats += f" to {len(current_targets)} target(s)"
                stats += f" in {loop_duration:.2f}s"
                print(stats, flush=True)

            if continuous:
                for port, count in stream_rtp_counts.items():
                    stream_seq_offsets[port] += count
            else:
                if verbose:
                    print("Waiting 3s before next loop...", flush=True)
                sleep(3.0)

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

    if args.speed <= 0:
        print("Error: --speed must be greater than 0", file=sys.stderr)
        return 1

    try:
        packets = load_packets(args.pcapng_file)
    except Exception as e:
        print(f"Error loading pcapng file: {e}", file=sys.stderr)
        return 1

    if not packets:
        print("Error: No UDP packets found in file", file=sys.stderr)
        return 1

    # Calculate subnets to monitor based on destination addresses in pcap
    # Each unique destination IP gets its corresponding /24 subnet monitored
    pcap_addrs = set(p.dst_addr for p in packets)
    subnets = sorted(set(get_subnet_for_ip(addr) for addr in pcap_addrs))

    print(
        f"Monitoring IGMP for subnets (based on pcap): {', '.join(subnets)}",
        flush=True,
    )

    # Start IGMP monitor in subnet mode
    igmp_monitor = IGMPMonitor(subnets=subnets)
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
            igmp_monitor=igmp_monitor,
            loss_rate=args.loss,
            reorder_rate=args.reorder,
            speed=args.speed,
            continuous=args.continuous,
            verbose=args.verbose,
        )
    finally:
        igmp_monitor.stop()
        sock.close()

    return 0


if __name__ == "__main__":
    sys.exit(main())
