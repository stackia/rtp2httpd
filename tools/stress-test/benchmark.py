"""Validated Linux multicast benchmark. Run through scripts/benchmark.sh.

No video fixture or extra packages: RTP carries seven numbered MPEG-TS null packets.
Load processes use fixed CPUs. TVGate retains the caller's default CPU affinity.
"""

import argparse
import hashlib
import json
import multiprocessing as mp
import os
import platform
import selectors
import signal
import socket
import statistics
import struct
import subprocess
import time
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FIELDS = 8  # bytes, TS packets, gaps, duplicates, corrupt packets, ready, EOF, backward markers
PAYLOAD = 7 * 188
CASES = {
    "shared64": (64, 1, 20),
    "distinct8": (8, 8, 40),
    "shared8": (8, 1, 40),
    "high400": (1, 1, 400),
}
FILL = b"\xff" * 172


def free_port(kind=socket.SOCK_STREAM):
    with socket.socket(socket.AF_INET, kind) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def process_family(pid):
    found, pending = set(), [pid]
    while pending:
        current = pending.pop()
        if current in found:
            continue
        found.add(current)
        # Children can belong to any thread (e.g. Go), not just the thread-group leader.
        for task in Path(f"/proc/{current}/task").glob("*/children"):
            try:
                pending.extend(map(int, task.read_text().split()))
            except FileNotFoundError:
                pass
    return found


def process_stats(pids):
    result = {}
    for pid in pids:
        fields = Path(f"/proc/{pid}/stat").read_text().split(") ", 1)[1].split()
        result[pid] = (int(fields[11]), int(fields[12]))
    return result


def cpu_delta(before, after, elapsed):
    return [
        sum(after[pid][i] - before[pid][i] for pid in before) / os.sysconf("SC_CLK_TCK") / elapsed * 100 for i in (0, 1)
    ]


def memory_mib(pids):
    pss = uss = 0
    for pid in pids:
        for line in Path(f"/proc/{pid}/smaps_rollup").read_text().splitlines():
            key, *value = line.split()
            if key == "Pss:":
                pss += int(value[0])
            elif key in ("Private_Clean:", "Private_Dirty:", "Private_Hugetlb:"):
                uss += int(value[0])
    return pss / 1024, uss / 1024


def udp_stats(pids):
    inodes = set()
    for pid in pids:
        for fd in Path(f"/proc/{pid}/fd").iterdir():
            try:
                link = os.readlink(fd)
                if link.startswith("socket:["):
                    inodes.add(link[8:-1])
            except FileNotFoundError:
                pass
    rows = [line.split() for line in Path("/proc/net/udp").read_text().splitlines()[1:]]
    matched = [row for row in rows if row[9] in inodes]
    return {"sockets": len(matched), "drops": sum(int(row[-1]) for row in matched)}


def sender(group, port, mbps, cpu, source, stop, sent, errors):
    try:
        os.sched_setaffinity(0, {cpu})
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_IF, socket.inet_aton("127.0.0.1"))
            sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_LOOP, 1)
            sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 1)
            packet = bytearray(12 + PAYLOAD)
            packet[0:2] = b"\x80\x21"
            struct.pack_into("!I", packet, 8, source + 1)
            for j in range(7):
                offset = 12 + j * 188
                packet[offset : offset + 3] = b"\x47\x1f\xff"
                struct.pack_into("!I", packet, offset + 12, source)
                packet[offset + 16 : offset + 188] = FILL
            origin = time.monotonic()
            pps = mbps * 1e6 / (PAYLOAD * 8)
            count = 0
            while not stop.is_set():
                target = int((time.monotonic() - origin) * pps)
                for _ in range(min(target - count, 256)):
                    struct.pack_into("!HI", packet, 2, count & 65535, int(count * 90000 / pps) & 0xFFFFFFFF)
                    for j in range(7):
                        marker = (count * 7 + j) & 0xFFFFFFFF
                        offset = 12 + j * 188
                        packet[offset + 3] = 0x10 | (marker & 15)
                        struct.pack_into("!II", packet, offset + 4, marker, marker ^ 0xFFFFFFFF)
                    sock.sendto(packet, (group, port))
                    count += 1
                sent[source] = count
                if count >= target:
                    stop.wait(0.0005)
    except (OSError, ValueError, struct.error) as exc:
        errors.put(f"sender {source}: {exc!r}")


class HTTPBody:
    """Incremental HTTP/1.1 header and chunk framing decoder."""

    def __init__(self):
        self.pending = b""
        self.headers = False
        self.chunked = False
        self.remaining = None
        self.separator = False
        self.finished = False

    def feed(self, data):
        self.pending += data
        if not self.headers:
            if b"\r\n\r\n" not in self.pending:
                if len(self.pending) > 65536:
                    raise ValueError("oversized HTTP header")
                return b""
            header, self.pending = self.pending.split(b"\r\n\r\n", 1)
            if header.split(b"\r\n", 1)[0].split()[1] != b"200":
                raise ValueError(f"HTTP error: {header[:200]!r}")
            self.chunked = any(
                line.lower().startswith(b"transfer-encoding:") and b"chunked" in line.lower()
                for line in header.split(b"\r\n")[1:]
            )
            self.headers = True
        if not self.chunked:
            data, self.pending = self.pending, b""
            return data
        output = []
        while not self.finished:
            if self.separator:
                if len(self.pending) < 2:
                    break
                if self.pending[:2] != b"\r\n":
                    raise ValueError("invalid chunk terminator")
                self.pending = self.pending[2:]
                self.separator = False
            if self.remaining is None:
                if b"\r\n" not in self.pending:
                    break
                size, self.pending = self.pending.split(b"\r\n", 1)
                self.remaining = int(size.split(b";", 1)[0], 16)
                if self.remaining == 0:
                    self.finished = True
                    break
            count = min(len(self.pending), self.remaining)
            output.append(self.pending[:count])
            self.pending = self.pending[count:]
            self.remaining -= count
            if self.remaining:
                break
            self.remaining = None
            self.separator = True
        return b"".join(output)


def consumers(port, sources, ids, cpu, stop, counters, errors, path_prefix):
    try:
        os.sched_setaffinity(0, {cpu})
        with selectors.DefaultSelector() as selector:
            for client in ids:
                group, udp_port, source = sources[client]
                sock = socket.create_connection(("127.0.0.1", port), timeout=5)
                sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 1024 * 1024)
                sock.sendall(
                    f"GET /{path_prefix}/{group}:{udp_port} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n".encode()
                )
                sock.setblocking(False)
                selector.register(sock, selectors.EVENT_READ, [client, source, HTTPBody(), b"", None])
            while not stop.is_set():
                for key, _ in selector.select(0.1):
                    assert isinstance(key.fileobj, socket.socket)
                    client, source, decoder, carry, previous = key.data
                    data = key.fileobj.recv(256 * 1024)
                    base = client * FIELDS
                    if not data:
                        counters[base + 6] += 1
                        selector.unregister(key.fileobj)
                        key.fileobj.close()
                        continue
                    carry += decoder.feed(data)
                    size = len(carry) // 188 * 188
                    gaps = duplicates = corrupt = backward = 0
                    for offset in range(0, size, 188):
                        marker, complement, packet_source = struct.unpack_from("!III", carry, offset + 4)
                        if (
                            carry[offset : offset + 3] != b"\x47\x1f\xff"
                            or carry[offset + 3] != (0x10 | (marker & 15))
                            or complement != marker ^ 0xFFFFFFFF
                            or packet_source != source
                            or carry[offset + 16 : offset + 188] != FILL
                        ):
                            corrupt += 1
                        if previous is not None:
                            diff = (marker - previous) & 0xFFFFFFFF
                            if diff == 0:
                                duplicates += 1
                            elif diff != 1:
                                if diff < 0x80000000:
                                    gaps += diff - 1
                                else:
                                    backward += 1
                        previous = marker
                    counters[base] += size
                    counters[base + 1] += size // 188
                    counters[base + 2] += gaps
                    counters[base + 3] += duplicates
                    counters[base + 4] += corrupt
                    counters[base + 5] = int(decoder.headers)
                    counters[base + 7] += backward
                    key.data[3:] = [carry[size:], previous]
                    if decoder.finished:
                        counters[base + 6] += 1
                        selector.unregister(key.fileobj)
                        key.fileobj.close()
            for key in list(selector.get_map().values()):
                assert isinstance(key.fileobj, socket.socket)
                key.fileobj.close()
    except (OSError, ValueError, struct.error, IndexError) as exc:
        errors.put(f"consumer: {exc!r}")


def command_for(program, binary, port, stem, server_cpus):
    env = os.environ.copy()
    if program in ("rtp2httpd", "baseline"):
        command = [str(binary), "-C", "-w", "1", "-m", "256", "-r", "lo", "-v", "1", "-l", f"127.0.0.1:{port}"]
    elif program == "msd_lite":
        tree = ET.parse(ROOT / "tools/stress-test/conf/msd_lite.conf")
        root = tree.getroot()
        changes = {
            "log/level": "1",
            "threadPool/threadsCountMax": "1",
            "threadPool/fBindToCPU": "no",
            "HTTP/bindList/bind/address": f"127.0.0.1:{port}",
            "sourceProfileList/sourceProfile/multicast/ifName": "lo",
            "hubProfileList/hubProfile/skt/congestionControl": "cubic",
        }
        for path, value in changes.items():
            element = root.find(path)
            if element is None:
                raise ValueError(f"missing msd_lite setting: {path}")
            element.text = value
        bindings = root.find("HTTP/bindList")
        if bindings is None:
            raise ValueError("missing msd_lite bindings")
        for binding in list(bindings)[1:]:
            bindings.remove(binding)
        config = stem.with_suffix(".xml")
        tree.write(config, encoding="utf-8", xml_declaration=True)
        command = [str(binary), "-c", str(config), "-l", "1"]
    elif program == "udpxy":
        # Preserve upstream data-buffer defaults. Pin all forked clients to the same CPU.
        command = [str(binary), "-T", "-a", "127.0.0.1", "-m", "lo", "-p", str(port), "-c", "256"]
    else:
        config = stem.with_suffix(".yaml")
        config.write_text(f"server:\n  port: {port}\nmulticast:\n  multicast_ifaces: [lo]\n  upstream_interface: lo\n")
        env.pop("GOMAXPROCS", None)
        command = [str(binary), "-config", str(config)]
    # Restore the caller's affinity for TVGate: the controller pins itself before spawning.
    return ["taskset", "-c", ",".join(map(str, server_cpus)), *command], env


def trial(program, case, repetition, order, args, binaries):
    clients, count, mbps = CASES[case]
    context = mp.get_context("spawn")
    stop, errors = context.Event(), context.Queue()
    counters = context.Array("Q", clients * FIELDS, lock=False)
    sent = context.Array("Q", count, lock=False)
    streams = [(f"239.255.77.{i + 1}", free_port(socket.SOCK_DGRAM), i) for i in range(count)]
    sources = [streams[i % count] for i in range(clients)]
    port = free_port()
    stem = args.output / f"{case}-{repetition:02d}-{program}"
    server_cpus = args.available_cpus if program == "tvgate" and not args.tvgate_single_cpu else [args.server_cpu]
    command, env = command_for(program, binaries[program], port, stem, server_cpus)
    path_prefix = "udp" if program == "tvgate" else "rtp"
    result = {
        "program": program,
        "case": case,
        "repetition": repetition,
        "order": order,
        "command": command,
        "clients": clients,
        "sources": count,
        "target_mbps": mbps,
        "valid": False,
        "server_cpus": server_cpus,
        "request_prefix": path_prefix,
    }
    children = []
    with stem.with_suffix(".log").open("w") as log:
        daemon = subprocess.Popen(command, env=env, stdout=log, stderr=log, start_new_session=True)
        try:
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline:
                if daemon.poll() is not None:
                    raise RuntimeError(f"server exited {daemon.returncode}; see {stem.name}.log")
                try:
                    with socket.create_connection(("127.0.0.1", port), timeout=0.1):
                        break
                except OSError:
                    time.sleep(0.05)
            else:
                raise RuntimeError("server not ready")
            collectors = min(4, clients)
            available = [cpu for cpu in args.load_cpus if cpu != args.server_cpu]
            for source, (group, udp_port, _) in enumerate(streams):
                child = context.Process(
                    target=sender,
                    args=(group, udp_port, mbps, available[collectors + source], source, stop, sent, errors),
                )
                child.start()
                children.append(child)
            for i in range(collectors):
                child = context.Process(
                    target=consumers,
                    args=(
                        port,
                        sources,
                        list(range(i, clients, collectors)),
                        available[i],
                        stop,
                        counters,
                        errors,
                        path_prefix,
                    ),
                )
                child.start()
                children.append(child)
            deadline = time.monotonic() + 20
            while not all(counters[i * FIELDS] >= 65536 for i in range(clients)):
                if time.monotonic() > deadline or not errors.empty():
                    raise RuntimeError("not all clients received data")
                time.sleep(0.05)
            time.sleep(args.warmup)
            pids = process_family(daemon.pid)
            tids = [int(t.name) for pid in pids for t in Path(f"/proc/{pid}/task").iterdir()]
            if any(os.sched_getaffinity(tid) != set(server_cpus) for tid in tids):
                raise RuntimeError("server affinity changed")
            before_udp = udp_stats(pids)
            before_clients, before_sent = list(counters), list(sent)
            before = process_stats(pids)
            load_pids = [p.pid for p in children]
            before_load = process_stats(load_pids)
            begin = time.monotonic()
            memory = []
            for _ in range(args.duration):
                time.sleep(1)
                memory.append(memory_mib(pids))
            elapsed = time.monotonic() - begin
            after = process_stats(pids)
            after_clients, after_sent = list(counters), list(sent)
            after_load = process_stats(load_pids)
            after_udp = udp_stats(pids)
            user, system = cpu_delta(before, after, elapsed)
            rates = [
                (after_clients[i * FIELDS] - before_clients[i * FIELDS]) * 8 / elapsed / 1e6 for i in range(clients)
            ]
            source_rates = [(after_sent[i] - before_sent[i]) * PAYLOAD * 8 / elapsed / 1e6 for i in range(count)]
            deltas = [
                sum(after_clients[i * FIELDS + j] - before_clients[i * FIELDS + j] for i in range(clients))
                for j in range(FIELDS)
            ]
            result.update(
                {
                    "duration_s": elapsed,
                    "cpu_pct": user + system,
                    "user_cpu_pct": user,
                    "system_cpu_pct": system,
                    "pss_mib": statistics.mean(m[0] for m in memory),
                    "uss_mib": statistics.mean(m[1] for m in memory),
                    "server_processes": len(pids),
                    "server_threads": len(tids),
                    "multicast_sockets": after_udp["sockets"],
                    "client_mbps": rates,
                    "source_mbps": source_rates,
                    "gaps": deltas[2],
                    "duplicates": deltas[3],
                    "corrupt_packets": deltas[4],
                    "backward_markers": deltas[7],
                    "closed_clients": deltas[6],
                    "kernel_udp_drops": after_udp["drops"] - before_udp["drops"],
                    "load_cpu_pct": sum(cpu_delta(before_load, after_load, elapsed)),
                    "family_stable": pids == process_family(daemon.pid),
                }
            )
            result["valid"] = (
                not any(deltas[i] for i in (2, 3, 4, 6, 7))
                and result["kernel_udp_drops"] == 0
                and result["family_stable"]
                and all(abs(rate / mbps - 1) < 0.02 for rate in source_rates + rates)
                and all(child.is_alive() for child in children)
            )
        except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as exc:
            result["error"] = repr(exc)
        finally:
            stop.set()
            for child in children:
                child.join(timeout=3)
                if child.is_alive():
                    child.terminate()
                    child.join(timeout=3)
            if daemon.poll() is None:
                os.killpg(daemon.pid, signal.SIGTERM)
                try:
                    daemon.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    os.killpg(daemon.pid, signal.SIGKILL)
                    daemon.wait()
            issues = []
            while not errors.empty():
                issues.append(errors.get())
            if issues:
                result["load_errors"] = issues
                result["valid"] = False
    return result


def program_order(programs, repetition):
    """Balance every position before reversing the next complete rotation."""
    offset = repetition % len(programs)
    order = programs[offset:] + programs[:offset]
    if (repetition // len(programs)) % 2:
        order.reverse()
    return order


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("programs", nargs="*", choices=["rtp2httpd", "msd_lite", "udpxy", "tvgate", "baseline"])
    parser.add_argument("--binary", action="append", default=[], metavar="NAME=PATH")
    parser.add_argument("--revision", action="append", default=[], metavar="NAME=REVISION")
    parser.add_argument("--cases", nargs="+", choices=CASES, default=list(CASES))
    parser.add_argument("--repetitions", type=int, default=5)
    parser.add_argument("--duration", type=int, default=20)
    parser.add_argument("--warmup", type=float, default=5)
    parser.add_argument("--server-cpu", type=int, default=0)
    parser.add_argument("--tvgate-single-cpu", action="store_true", help="also restrict TVGate to --server-cpu")
    parser.add_argument("--controller-cpu", type=int, default=13)
    parser.add_argument("--load-cpus", default="1,2,3,4,5,6,7,8,9,10,11,12")
    parser.add_argument("--output", type=Path, default=ROOT / "build/benchmark" / time.strftime("%Y%m%d-%H%M%S"))
    args = parser.parse_args()
    if platform.system() != "Linux":
        parser.error("measurement requires Linux /proc and taskset")
    if args.duration < 1 or args.repetitions < 1 or args.warmup < 0:
        parser.error("duration/repetitions must be positive and warmup nonnegative")
    args.load_cpus = list(dict.fromkeys(map(int, args.load_cpus.split(","))))
    required = max(min(4, CASES[c][0]) + CASES[c][1] for c in args.cases)
    if args.server_cpu in args.load_cpus or len(args.load_cpus) < required:
        parser.error(f"choose at least {required} load CPUs, disjoint from --server-cpu")
    if not {args.server_cpu, *args.load_cpus} <= os.sched_getaffinity(0):
        parser.error("requested CPUs are outside the current process affinity")
    if args.controller_cpu in {args.server_cpu, *args.load_cpus} or args.controller_cpu not in os.sched_getaffinity(0):
        parser.error("choose a separate available --controller-cpu")
    args.available_cpus = sorted(os.sched_getaffinity(0))
    os.sched_setaffinity(0, {args.controller_cpu})
    programs = args.programs or ["rtp2httpd", "msd_lite", "udpxy", "tvgate"]
    binaries = {
        "rtp2httpd": ROOT / "build/rtp2httpd",
        "msd_lite": ROOT.parent / "msd_lite/build/src/msd_lite",
        "udpxy": ROOT.parent / "udpxy/chipmunk/udpxy",
        "tvgate": ROOT.parent / "tvgate/TVGate-linux-arm64",
    }
    for value in args.binary:
        name, path = value.split("=", 1)
        binaries[name] = Path(path).resolve()
    revisions = dict(value.split("=", 1) for value in args.revision)
    for name in programs:
        if name not in binaries or not os.access(binaries[name], os.X_OK):
            parser.error(f"missing executable for {name}; pass --binary {name}=PATH")
    args.output = args.output.resolve()
    args.output.mkdir(parents=True, exist_ok=False)
    metadata = {
        "timestamp_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "platform": platform.platform(),
        "machine": platform.machine(),
        "cpu_count": os.cpu_count(),
        "server_cpu": args.server_cpu,
        "tvgate_cpus": [args.server_cpu] if args.tvgate_single_cpu else args.available_cpus,
        "tvgate_gomaxprocs": "unset",
        "load_cpus": args.load_cpus,
        "controller_cpu": args.controller_cpu,
        "warmup_s": args.warmup,
        "duration_s": args.duration,
        "repetitions": args.repetitions,
        "cases": {c: CASES[c] for c in args.cases},
        "script_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "binaries": {
            p: {
                "path": str(binaries[p]),
                "revision": revisions.get(p, "unspecified"),
                "sha256": hashlib.sha256(binaries[p].read_bytes()).hexdigest(),
            }
            for p in programs
        },
        "sysctl": subprocess.check_output(
            ["sysctl", "net.core.rmem_max", "net.core.wmem_max", "net.ipv4.tcp_congestion_control"], text=True
        ).strip(),
    }
    (args.output / "metadata.json").write_text(json.dumps(metadata, indent=2) + "\n")
    rows = []
    with (args.output / "trials.jsonl").open("w") as output:
        for case in args.cases:
            for repetition in range(args.repetitions):
                order = program_order(programs, repetition)
                for position, program in enumerate(order):
                    row = trial(program, case, repetition, position, args, binaries)
                    rows.append(row)
                    output.write(json.dumps(row) + "\n")
                    output.flush()
                    print(json.dumps(row), flush=True)
                    time.sleep(1)
    summary = []
    for case in args.cases:
        for program in programs:
            measured = [r for r in rows if r["case"] == case and r["program"] == program]
            valid = [r for r in measured if r["valid"]]
            item = {"case": case, "program": program, "valid_trials": len(valid), "total_trials": len(measured)}
            for field in ("cpu_pct", "pss_mib", "uss_mib"):
                values = [r[field] for r in valid]
                item[field] = (
                    {"mean": statistics.mean(values), "min": min(values), "max": max(values)} if values else None
                )
            summary.append(item)
    (args.output / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    # Resource observations include every completed measurement, independently of integrity.
    resources = []
    for case in args.cases:
        for program in programs:
            completed = [
                r for r in rows if r["case"] == case and r["program"] == program and "cpu_pct" in r and "error" not in r
            ]
            item = {"case": case, "program": program, "measured_trials": len(completed)}
            for field in ("cpu_pct", "pss_mib", "uss_mib"):
                values = [r[field] for r in completed]
                item[field] = (
                    {"mean": statistics.mean(values), "min": min(values), "max": max(values)} if values else None
                )
            resources.append(item)
    (args.output / "resources.json").write_text(json.dumps(resources, indent=2) + "\n")
    return 0 if all(row["valid"] for row in rows) else 1


if __name__ == "__main__":
    raise SystemExit(main())
