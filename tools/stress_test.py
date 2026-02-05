#!/usr/bin/env python3
"""
Stress Test for rtp2httpd / msd_lite / udpxy

Runs a multicast replay, streaming server, and multiple curl clients
concurrently to measure CPU and memory usage under load.
"""

import argparse
import os
import subprocess
import sys
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable


# =============================================================================
# Program Configurations
# =============================================================================

# Base multicast address and port for streams
# Each client will use a different address in the same /24 subnet
MULTICAST_BASE = "239.81.0"  # /24 subnet
MULTICAST_PORT = 4056
MULTICAST_START_HOST = 1  # Start from .1 (e.g., 239.81.0.1)


def get_stream_url(client_index: int) -> str:
    """Generate stream URL for a specific client.

    Each client gets a unique multicast address in the same /24 subnet.
    """
    host = MULTICAST_START_HOST + client_index
    if host > 254:
        host = ((host - 1) % 254) + 1  # Wrap around, skip .0 and .255
    return f"rtp/{MULTICAST_BASE}.{host}:{MULTICAST_PORT}"


# Program configurations with relative paths (relative to tools directory)
PROGRAM_CONFIGS: dict[str, dict] = {
    "rtp2httpd": {
        "binary": "../src/rtp2httpd",
        "port": 5140,
        # Args builder: receives (binary_path, m3u_file, port, config_path) -> list of args
        "build_args": lambda binary, m3u, port, config: [
            str(binary),
            "-M",
            f"file://{m3u}",
            "-l",
            str(port),
            "-v",
            "1",
            "-m",
            "999",
        ],
    },
    "msd_lite": {
        "binary": "../../msd_lite/build/src/msd_lite",
        "port": 7088,
        "config": "stress-test-conf/msd_lite.conf",  # Relative to tools directory
        "build_args": lambda binary, m3u, port, config: [
            str(binary),
            "-c",
            str(config),
        ],
    },
    "udpxy": {
        "binary": "../../udpxy/chipmunk/udpxy",
        "port": 4022,
        "build_args": lambda binary, m3u, port, config: [
            str(binary),
            "-T",  # Run in foreground
            "-p",
            str(port),
            "-c",
            "999",  # Max clients
        ],
    },
    "tvgate": {
        "binary": "../../tvgate/TVGate-linux-arm64",
        "port": 8888,
        "config": "stress-test-conf/tvgate-config.yaml",  # Relative to tools directory
        "build_args": lambda binary, m3u, port, config: [
            str(binary),
            "-config",
            str(config),
        ],
    },
}


# =============================================================================
# Process Statistics
# =============================================================================


@dataclass
class ProcessStats:
    """CPU and memory statistics for a process."""

    pid: int
    name: str
    cpu_samples: list[float] = field(default_factory=list)
    pss_samples: list[float] = field(default_factory=list)  # Proportional Set Size (MB)
    uss_samples: list[float] = field(default_factory=list)  # Unique Set Size (MB)

    @property
    def cpu_avg(self) -> float:
        return (
            sum(self.cpu_samples) / len(self.cpu_samples) if self.cpu_samples else 0.0
        )

    @property
    def cpu_max(self) -> float:
        return max(self.cpu_samples) if self.cpu_samples else 0.0

    @property
    def pss_avg(self) -> float:
        return (
            sum(self.pss_samples) / len(self.pss_samples) if self.pss_samples else 0.0
        )

    @property
    def pss_max(self) -> float:
        return max(self.pss_samples) if self.pss_samples else 0.0

    @property
    def uss_avg(self) -> float:
        return (
            sum(self.uss_samples) / len(self.uss_samples) if self.uss_samples else 0.0
        )

    @property
    def uss_max(self) -> float:
        return max(self.uss_samples) if self.uss_samples else 0.0


def get_child_pids(pid: int) -> list[int]:
    """Get all child PIDs of a process (recursively)."""
    children = []
    try:
        # Read /proc/[pid]/task/[tid]/children for each thread
        task_dir = Path(f"/proc/{pid}/task")
        if task_dir.exists():
            for tid_dir in task_dir.iterdir():
                children_file = tid_dir / "children"
                if children_file.exists():
                    content = children_file.read_text().strip()
                    if content:
                        for child_pid in content.split():
                            child = int(child_pid)
                            children.append(child)
                            # Recursively get grandchildren
                            children.extend(get_child_pids(child))
    except (FileNotFoundError, PermissionError, ValueError):
        pass
    return children


@dataclass
class MemoryInfo:
    """Memory information for a process."""

    pss: float = 0.0  # Proportional Set Size (MB) - includes proportional shared
    uss: float = 0.0  # Unique Set Size (MB) - private memory only
    rss: float = 0.0  # Resident Set Size (MB) - includes all shared


def get_process_memory(pid: int) -> MemoryInfo | None:
    """Get detailed memory info (PSS, USS, RSS) for a process.

    - PSS: Proportional Set Size - shared memory divided proportionally
    - USS: Unique Set Size = Private_Clean + Private_Dirty (private memory only)
    - RSS: Resident Set Size - total physical memory including shared

    For fork'd processes, PSS is most accurate for total usage estimation,
    while USS represents memory that would be freed if process terminates.
    """
    try:
        smaps_path = Path(f"/proc/{pid}/smaps_rollup")
        if not smaps_path.exists():
            return None

        content = smaps_path.read_text()
        pss_kb = 0
        private_clean_kb = 0
        private_dirty_kb = 0
        rss_kb = 0

        for line in content.splitlines():
            parts = line.split()
            if len(parts) >= 2:
                key = parts[0].rstrip(":")
                value = int(parts[1])
                if key == "Pss":
                    pss_kb = value
                elif key == "Private_Clean":
                    private_clean_kb = value
                elif key == "Private_Dirty":
                    private_dirty_kb = value
                elif key == "Rss":
                    rss_kb = value

        uss_kb = private_clean_kb + private_dirty_kb

        return MemoryInfo(
            pss=pss_kb / 1024.0,
            uss=uss_kb / 1024.0,
            rss=rss_kb / 1024.0,
        )
    except (FileNotFoundError, PermissionError, ValueError, IndexError):
        return None


def get_process_rss(pid: int) -> float | None:
    """Get RSS (Resident Set Size) in MB for a process (fallback)."""
    try:
        with open(f"/proc/{pid}/statm", "r") as f:
            statm = f.read().split()
            rss_pages = int(statm[1])
            page_size = os.sysconf("SC_PAGE_SIZE")
            return (rss_pages * page_size) / (1024 * 1024)
    except (FileNotFoundError, ProcessLookupError, IndexError):
        return None


class ResourceMonitor(threading.Thread):
    """Thread that monitors CPU and memory usage of processes.

    Uses top for CPU measurement (more accurate, especially for io_uring programs)
    and /proc for memory measurement.
    """

    def __init__(self, pids: dict[int, str], interval: float = 1.0):
        super().__init__(daemon=True)
        self.pids = pids  # {pid: name}
        self.interval = interval
        self.running = True
        self.stats: dict[int, ProcessStats] = {
            pid: ProcessStats(pid=pid, name=name) for pid, name in pids.items()
        }

    def _get_cpu_via_top(self, pids: list[int]) -> dict[int, float]:
        """Get CPU percentage for multiple PIDs using top.

        Uses -n 2 because the first sample from top is cumulative since process
        start, while the second sample shows actual CPU usage during the interval.
        """
        result: dict[int, float] = {}
        if not pids:
            return result

        try:
            # Run top for all PIDs at once
            # -n 2: two samples (first is cumulative, second is accurate)
            # -d 0.5: 0.5 second delay between samples
            pid_str = ",".join(str(p) for p in pids)
            proc = subprocess.run(
                ["top", "-b", "-n", "2", "-d", "0.5", "-p", pid_str],
                capture_output=True,
                text=True,
                timeout=10,
            )
            if proc.returncode != 0:
                return result

            # Parse top output - we want the LAST occurrence of each PID
            # (which is from the second sample)
            for line in proc.stdout.splitlines():
                parts = line.split()
                if len(parts) >= 9 and parts[0].isdigit():
                    try:
                        pid = int(parts[0])
                        if pid in pids:
                            # CPU% is typically in column 9 (0-indexed: 8)
                            cpu_str = parts[8].replace(",", ".")
                            result[pid] = float(cpu_str)
                    except (ValueError, IndexError):
                        continue
        except subprocess.TimeoutExpired:
            pass
        return result

    def _get_cpu_with_children(self, pid: int) -> float | None:
        """Get aggregated CPU for a process and all its children."""
        # Collect all PIDs (parent + children)
        all_pids = [pid] + get_child_pids(pid)

        # Get CPU for all PIDs
        cpu_readings = self._get_cpu_via_top(all_pids)

        if not cpu_readings:
            return None

        # Sum CPU of all processes
        return sum(cpu_readings.values())

    def _get_memory(self, pid: int) -> MemoryInfo | None:
        """Get aggregated memory (PSS, USS) for a process and all children.

        PSS: Total proportional memory usage (for capacity planning)
        USS: Total private memory (would be freed if all processes exit)
        """
        mem = get_process_memory(pid)
        if mem is None:
            # Fallback to RSS only
            rss = get_process_rss(pid)
            if rss is None:
                return None
            mem = MemoryInfo(pss=rss, uss=rss, rss=rss)

        total_pss = mem.pss
        total_uss = mem.uss

        # Add memory from child processes
        for child_pid in get_child_pids(pid):
            child_mem = get_process_memory(child_pid)
            if child_mem:
                total_pss += child_mem.pss
                total_uss += child_mem.uss
            else:
                # Fallback to RSS
                child_rss = get_process_rss(child_pid)
                if child_rss:
                    total_pss += child_rss
                    total_uss += child_rss

        return MemoryInfo(pss=total_pss, uss=total_uss, rss=0)

    def run(self) -> None:
        while self.running:
            pid_list = list(self.pids.keys())

            # Get CPU and memory for each process (including children)
            for pid in pid_list:
                cpu = self._get_cpu_with_children(pid)
                if cpu is not None:
                    self.stats[pid].cpu_samples.append(cpu)

                mem = self._get_memory(pid)
                if mem is not None:
                    self.stats[pid].pss_samples.append(mem.pss)
                    self.stats[pid].uss_samples.append(mem.uss)

            time.sleep(self.interval)

    def stop(self) -> None:
        self.running = False


# =============================================================================
# Argument Parsing
# =============================================================================


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Stress test streaming servers with multicast replay and curl clients",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  %(prog)s                          # Test rtp2httpd (default)
  %(prog)s --program msd_lite       # Test msd_lite
  %(prog)s --program udpxy          # Test udpxy
  %(prog)s --duration 30 --clients 16
""",
    )
    parser.add_argument(
        "--program",
        choices=list(PROGRAM_CONFIGS.keys()),
        default="rtp2httpd",
        help="Program to test (default: rtp2httpd)",
    )
    parser.add_argument(
        "--duration",
        type=int,
        default=10,
        help="Test duration in seconds (default: 10)",
    )
    parser.add_argument(
        "--clients",
        type=int,
        default=8,
        help="Number of concurrent curl clients (default: 8)",
    )
    parser.add_argument(
        "--speed",
        type=float,
        default=5.0,
        help="Replay speed multiplier (default: 5.0)",
    )
    parser.add_argument(
        "-v",
        "--verbose",
        action="store_true",
        help="Show verbose output from subprocesses",
    )
    parser.add_argument(
        "--same-address",
        action="store_true",
        help="All clients use the same multicast address (default: each client uses a unique address)",
    )
    return parser.parse_args()


# =============================================================================
# Main Logic
# =============================================================================


def find_project_root() -> Path:
    """Find the project root directory."""
    current = Path(__file__).resolve().parent
    while current != current.parent:
        if (current / "src" / "rtp2httpd").exists() or (current / "rtp2httpd").exists():
            return current
        current = current.parent
    return Path(__file__).resolve().parent.parent


def main() -> int:
    args = parse_args()

    # Get program configuration
    config = PROGRAM_CONFIGS[args.program]
    port = config["port"]
    build_args: Callable = config["build_args"]

    project_root = find_project_root()
    tools_dir = project_root / "tools"

    # Resolve binary path (relative to tools directory)
    binary_path = (tools_dir / config["binary"]).resolve()

    # Paths
    pcapng_file = tools_dir / "fixtures" / "fec_sample.pcapng"
    m3u_file = tools_dir / "fixtures" / "sample.m3u"

    # Validate paths
    if not pcapng_file.exists():
        print(f"Error: pcapng file not found: {pcapng_file}", file=sys.stderr)
        return 1
    if not m3u_file.exists():
        print(f"Error: m3u file not found: {m3u_file}", file=sys.stderr)
        return 1
    if not binary_path.exists():
        print(f"Error: {args.program} binary not found: {binary_path}", file=sys.stderr)
        return 1

    # Check for venv
    venv_python = tools_dir / ".venv" / "bin" / "python"
    if not venv_python.exists():
        print(f"Error: Python venv not found at {venv_python}", file=sys.stderr)
        print(
            "Please run: python -m venv tools/.venv && tools/.venv/bin/pip install scapy",
            file=sys.stderr,
        )
        return 1

    print("=" * 60)
    print(f"Stress Test: {args.program}")
    print("=" * 60)
    print(f"Program:      {args.program}")
    print(f"Binary:       {binary_path}")
    print(f"Duration:     {args.duration}s")
    print(f"Clients:      {args.clients}")
    print(f"Replay speed: {args.speed}x (~{8 * args.speed:.0f} Mbps)")
    print(f"Port:         {port}")
    if args.same_address:
        print(
            f"Stream:       {MULTICAST_BASE}.{MULTICAST_START_HOST}:{MULTICAST_PORT} (same for all clients)"
        )
    else:
        print(
            f"Streams:      {MULTICAST_BASE}.{MULTICAST_START_HOST}-{MULTICAST_START_HOST + args.clients - 1}:{MULTICAST_PORT} (unique per client)"
        )
    print("=" * 60)

    processes: list[subprocess.Popen] = []
    monitor: ResourceMonitor | None = None
    server_proc: subprocess.Popen | None = None

    try:
        # 1. Start multicast replay
        print("\n[1/3] Starting multicast replay...")
        replay_cmd = [
            str(venv_python),
            str(tools_dir / "main.py"),
            str(pcapng_file),
            "--continuous",
            "--speed",
            str(args.speed),
        ]
        replay_proc = subprocess.Popen(
            replay_cmd,
            stdout=subprocess.PIPE if not args.verbose else None,
            stderr=subprocess.STDOUT if not args.verbose else None,
            cwd=str(tools_dir),
        )
        processes.append(replay_proc)
        print(f"  PID: {replay_proc.pid}")

        # Give replay a moment to start
        time.sleep(0.5)

        # 2. Start streaming server
        print(f"\n[2/3] Starting {args.program}...")
        # Resolve config path if specified (relative to tools directory)
        config_path = None
        if "config" in config:
            config_path = (tools_dir / config["config"]).resolve()
        server_cmd = build_args(binary_path, m3u_file, port, config_path)
        server_proc = subprocess.Popen(
            server_cmd,
            stdout=subprocess.PIPE if not args.verbose else None,
            stderr=subprocess.STDOUT if not args.verbose else None,
            cwd=str(project_root),
        )
        processes.append(server_proc)
        print(f"  PID: {server_proc.pid}")
        print(f"  CMD: {' '.join(server_cmd)}")

        # Give server time to start
        time.sleep(1.0)

        # Check if server is still running
        if server_proc.poll() is not None:
            print(f"Error: {args.program} exited unexpectedly", file=sys.stderr)
            return 1

        # 3. Start curl clients
        print(f"\n[3/3] Starting {args.clients} curl clients...")
        if args.same_address:
            print(
                f"  All clients use the same address: {MULTICAST_BASE}.{MULTICAST_START_HOST}:{MULTICAST_PORT}"
            )
        else:
            print(f"  Each client uses a unique address in {MULTICAST_BASE}.0/24")
        curl_procs: list[subprocess.Popen] = []

        for i in range(args.clients):
            # Use same address for all clients if --same-address, otherwise unique per client
            client_index = 0 if args.same_address else i
            stream_url = get_stream_url(client_index)
            full_stream_url = f"http://127.0.0.1:{port}/{stream_url}"
            if i == 0:
                if args.same_address:
                    print(f"  URL: {full_stream_url}")
                else:
                    print(
                        f"  URLs: {full_stream_url} ... (and {args.clients - 1} more)"
                    )
            curl_cmd = [
                "curl",
                "-o",
                "/dev/null",
                "--no-buffer",
                "-s",  # Silent mode
                full_stream_url,
            ]
            curl_proc = subprocess.Popen(
                curl_cmd,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            curl_procs.append(curl_proc)
            processes.append(curl_proc)

        print(f"  PIDs: {[p.pid for p in curl_procs]}")

        # Start resource monitoring
        print("\n[Monitoring] Starting resource monitor...")
        pids_to_monitor = {
            server_proc.pid: args.program,
            replay_proc.pid: "replay",
        }
        # Add curl processes
        for i, curl_proc in enumerate(curl_procs):
            pids_to_monitor[curl_proc.pid] = f"curl-{i+1}"

        monitor = ResourceMonitor(pids_to_monitor, interval=0.5)
        monitor.start()

        # Run for specified duration
        print(f"\n[Running] Test running for {args.duration} seconds...")
        print("  (Press Ctrl+C to stop early)\n")

        start_time = time.monotonic()
        while time.monotonic() - start_time < args.duration:
            # Check if key processes are still running
            if server_proc.poll() is not None:
                print(f"Warning: {args.program} exited during test", file=sys.stderr)
                break
            if replay_proc.poll() is not None:
                print("Warning: replay process exited during test", file=sys.stderr)
                break

            elapsed = time.monotonic() - start_time
            print(
                f"\r  Progress: {elapsed:.1f}s / {args.duration}s", end="", flush=True
            )
            time.sleep(0.5)

        print("\n")

    except KeyboardInterrupt:
        print("\n\nInterrupted by user")

    finally:
        # Stop monitor
        if monitor:
            monitor.stop()
            monitor.join(timeout=1.0)

        # Terminate all processes
        print("[Cleanup] Terminating processes...")
        for proc in processes:
            if proc.poll() is None:
                proc.terminate()

        # Wait for processes to exit
        for proc in processes:
            try:
                proc.wait(timeout=2.0)
            except subprocess.TimeoutExpired:
                proc.kill()

    # Print results
    if monitor and monitor.stats:
        print("\n" + "=" * 60)
        print("RESULTS")
        print("=" * 60)

        # Group stats
        server_stats = None
        replay_stats = None
        curl_stats: list[ProcessStats] = []

        for pid, stats in monitor.stats.items():
            if stats.name == args.program:
                server_stats = stats
            elif stats.name == "replay":
                replay_stats = stats
            elif stats.name.startswith("curl"):
                curl_stats.append(stats)

        # Server stats
        if server_stats and server_stats.cpu_samples:
            print(f"\n[{args.program}]")
            print(
                f"  CPU:  avg={server_stats.cpu_avg:6.2f}%  max={server_stats.cpu_max:6.2f}%"
            )
            print(
                f"  PSS:  avg={server_stats.pss_avg:6.2f}MB max={server_stats.pss_max:6.2f}MB"
            )
            print(
                f"  USS:  avg={server_stats.uss_avg:6.2f}MB max={server_stats.uss_max:6.2f}MB"
            )

        # Replay stats
        if replay_stats and replay_stats.cpu_samples:
            print("\n[replay (main.py)]")
            print(
                f"  CPU:  avg={replay_stats.cpu_avg:6.2f}%  max={replay_stats.cpu_max:6.2f}%"
            )
            print(
                f"  PSS:  avg={replay_stats.pss_avg:6.2f}MB max={replay_stats.pss_max:6.2f}MB"
            )
            print(
                f"  USS:  avg={replay_stats.uss_avg:6.2f}MB max={replay_stats.uss_max:6.2f}MB"
            )

        # Aggregate curl stats
        if curl_stats:
            total_cpu_avg = sum(s.cpu_avg for s in curl_stats)
            total_cpu_max = sum(s.cpu_max for s in curl_stats)
            total_pss_avg = sum(s.pss_avg for s in curl_stats)
            total_pss_max = sum(s.pss_max for s in curl_stats)
            total_uss_avg = sum(s.uss_avg for s in curl_stats)
            total_uss_max = sum(s.uss_max for s in curl_stats)

            print(f"\n[curl clients x{len(curl_stats)} (aggregated)]")
            print(f"  CPU:  avg={total_cpu_avg:6.2f}%  max={total_cpu_max:6.2f}%")
            print(f"  PSS:  avg={total_pss_avg:6.2f}MB max={total_pss_max:6.2f}MB")
            print(f"  USS:  avg={total_uss_avg:6.2f}MB max={total_uss_max:6.2f}MB")

        # Summary
        if server_stats and server_stats.cpu_samples:
            print("\n" + "-" * 60)
            print(f"SUMMARY ({args.program})")
            print("-" * 60)
            print(f"  Test duration:  {args.duration}s")
            print(f"  Clients:        {args.clients}")
            print(f"  Replay speed:   {args.speed}x (~{8 * args.speed:.0f} Mbps)")
            print(f"  CPU average:    {server_stats.cpu_avg:.2f}%")
            print(f"  CPU peak:       {server_stats.cpu_max:.2f}%")
            print(f"  PSS average:    {server_stats.pss_avg:.2f} MB (proportional)")
            print(f"  PSS peak:       {server_stats.pss_max:.2f} MB")
            print(f"  USS average:    {server_stats.uss_avg:.2f} MB (private only)")
            print(f"  USS peak:       {server_stats.uss_max:.2f} MB")
            print("=" * 60)

    return 0


if __name__ == "__main__":
    sys.exit(main())
