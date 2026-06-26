#!/usr/bin/env python3
"""
macOS-first performance benchmark for rtp2httpd.

The tool runs a fixed multicast replay workload, starts rtp2httpd, streams data
through curl clients, samples the rtp2httpd process tree CPU usage, and writes a
JSON result suitable for before/after comparisons.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import platform
import socket
import statistics
import subprocess
import sys
import time
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


MULTICAST_BASE = "239.81.0"
MULTICAST_PORT = 4056
DEFAULT_PORT = 5140
CPU_NOISY_CV_THRESHOLD = 5.0
EFFECTIVE_CPU_RELATIVE_DROP = 3.0
EFFECTIVE_CPU_ABSOLUTE_DROP = 0.5


@dataclass(frozen=True)
class Scenario:
    name: str
    clients: int
    same_address: bool
    speed: float
    warmup: int
    measure: int
    repeat: int


@dataclass
class ProcessSample:
    elapsed: float
    cpu_percent: float
    rss_mb: float
    pids: list[int]


def percentile(values: list[float], pct: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    idx = max(0, min(len(ordered) - 1, math.ceil((pct / 100.0) * len(ordered)) - 1))
    return ordered[idx]


def summarize(values: list[float]) -> dict[str, float]:
    if not values:
        return {"avg": 0.0, "median": 0.0, "p95": 0.0, "max": 0.0}
    return {
        "avg": statistics.fmean(values),
        "median": statistics.median(values),
        "p95": percentile(values, 95.0),
        "max": max(values),
    }


def coefficient_of_variation(values: list[float]) -> float:
    if len(values) < 2:
        return 0.0
    mean = statistics.fmean(values)
    if mean == 0:
        return 0.0
    return statistics.stdev(values) / mean * 100.0


def project_root() -> Path:
    current = Path(__file__).resolve().parent
    while current != current.parent:
        if (current / "CMakeLists.txt").exists() and (current / "src" / "rtp2httpd.c").exists():
            return current
        current = current.parent
    return Path(__file__).resolve().parent.parent


def run_text(cmd: list[str], cwd: Path) -> str:
    try:
        proc = subprocess.run(cmd, cwd=cwd, text=True, capture_output=True, timeout=10)
    except (OSError, subprocess.TimeoutExpired):
        return ""
    if proc.returncode != 0:
        return ""
    return proc.stdout.strip()


def git_info(root: Path) -> dict[str, Any]:
    status = run_text(["git", "status", "--porcelain"], root)
    return {
        "commit": run_text(["git", "rev-parse", "HEAD"], root),
        "branch": run_text(["git", "branch", "--show-current"], root),
        "dirty": bool(status),
    }


def environment_info() -> dict[str, Any]:
    return {
        "system": platform.system(),
        "release": platform.release(),
        "machine": platform.machine(),
        "processor": platform.processor(),
        "python": platform.python_version(),
        "cpu_count": os.cpu_count(),
    }


class ProcessSampler:
    backend_name = "unknown"

    def sample(self, root_pid: int, elapsed: float) -> ProcessSample:
        raise NotImplementedError


class PsProcessSampler(ProcessSampler):
    """Sample aggregate CPU/RSS for a root process and its descendants."""

    backend_name = "ps-process-tree"

    def _process_table(self) -> dict[int, dict[str, Any]]:
        proc = subprocess.run(
            ["ps", "-axo", "pid=,ppid=,pcpu=,rss=,comm="],
            text=True,
            capture_output=True,
            timeout=5,
        )
        if proc.returncode != 0:
            raise RuntimeError(proc.stderr.strip() or "ps failed")

        table: dict[int, dict[str, Any]] = {}
        for line in proc.stdout.splitlines():
            parts = line.split(None, 4)
            if len(parts) < 4:
                continue
            try:
                pid = int(parts[0])
                ppid = int(parts[1])
                cpu = float(parts[2])
                rss_kb = int(parts[3])
            except ValueError:
                continue
            table[pid] = {
                "ppid": ppid,
                "cpu": cpu,
                "rss_kb": rss_kb,
                "comm": parts[4] if len(parts) >= 5 else "",
            }
        return table

    def descendants(self, root_pid: int, table: dict[int, dict[str, Any]]) -> list[int]:
        children: dict[int, list[int]] = {}
        for pid, row in table.items():
            children.setdefault(row["ppid"], []).append(pid)

        result: list[int] = []
        stack = [root_pid]
        seen: set[int] = set()
        while stack:
            pid = stack.pop()
            if pid in seen:
                continue
            seen.add(pid)
            if pid in table:
                result.append(pid)
            stack.extend(children.get(pid, []))
        return sorted(result)

    def sample(self, root_pid: int, elapsed: float) -> ProcessSample:
        table = self._process_table()
        pids = self.descendants(root_pid, table)
        cpu = sum(float(table[pid]["cpu"]) for pid in pids)
        rss_kb = sum(int(table[pid]["rss_kb"]) for pid in pids)
        return ProcessSample(elapsed=elapsed, cpu_percent=cpu, rss_mb=rss_kb / 1024.0, pids=pids)


class MacOSProcessSampler(PsProcessSampler):
    backend_name = "macos-ps-process-tree"


class LinuxProcessSampler(PsProcessSampler):
    """Placeholder backend keeping the same contract until /proc sampling lands."""

    backend_name = "linux-ps-placeholder"


def create_process_sampler() -> ProcessSampler:
    if sys.platform == "darwin":
        return MacOSProcessSampler()
    if sys.platform.startswith("linux"):
        return LinuxProcessSampler()
    return PsProcessSampler()


def scenario_targets(scenario: Scenario) -> list[str]:
    count = 1 if scenario.same_address else scenario.clients
    return [f"{MULTICAST_BASE}.{idx}" for idx in range(1, count + 1)]


def client_url(port: int, scenario: Scenario, client_index: int) -> str:
    host = 1 if scenario.same_address else client_index + 1
    return f"http://127.0.0.1:{port}/rtp/{MULTICAST_BASE}.{host}:{MULTICAST_PORT}"


def wait_for_port(port: int, timeout: float = 6.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.2):
                return True
        except OSError:
            time.sleep(0.05)
    return False


def terminate_process(proc: subprocess.Popen[Any], timeout: float = 3.0) -> None:
    if proc.poll() is not None:
        return
    proc.terminate()
    try:
        proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait(timeout=timeout)


def scenario_suites() -> dict[str, list[Scenario]]:
    return {
        "quick": [
            Scenario("same_8_40m", clients=8, same_address=True, speed=5.0, warmup=10, measure=30, repeat=3),
        ],
        "full": [
            Scenario("same_1_40m", clients=1, same_address=True, speed=5.0, warmup=10, measure=60, repeat=5),
            Scenario("same_8_40m", clients=8, same_address=True, speed=5.0, warmup=10, measure=60, repeat=5),
            Scenario("same_16_40m", clients=16, same_address=True, speed=5.0, warmup=10, measure=60, repeat=5),
            Scenario("unique_8_40m", clients=8, same_address=False, speed=5.0, warmup=10, measure=60, repeat=5),
            Scenario("single_400m", clients=1, same_address=True, speed=50.0, warmup=10, measure=60, repeat=5),
        ],
    }


def apply_overrides(scenario: Scenario, args: argparse.Namespace) -> Scenario:
    return Scenario(
        name=scenario.name,
        clients=scenario.clients,
        same_address=scenario.same_address,
        speed=scenario.speed,
        warmup=args.warmup if args.warmup is not None else scenario.warmup,
        measure=args.measure if args.measure is not None else scenario.measure,
        repeat=args.repeat if args.repeat is not None else scenario.repeat,
    )


def run_repeat(
    root: Path,
    scenario: Scenario,
    repeat_index: int,
    args: argparse.Namespace,
    sampler: ProcessSampler,
) -> dict[str, Any]:
    tools_dir = root / "tools"
    pcapng = tools_dir / "fixtures" / "fec_sample.pcapng"
    binary_arg = Path(args.binary)
    binary = binary_arg if binary_arg.is_absolute() else (root / binary_arg)
    binary = binary.resolve()
    total_seconds = scenario.warmup + scenario.measure
    targets = scenario_targets(scenario)
    stdout_target = None if args.verbose else subprocess.DEVNULL
    stderr_target = None if args.verbose else subprocess.DEVNULL

    replay_cmd = [
        sys.executable,
        str(tools_dir / "main.py"),
        str(pcapng),
        "--continuous",
        "--speed",
        str(scenario.speed),
        "--multicast-if-addr",
        args.multicast_if_addr,
    ]
    for target in targets:
        replay_cmd.extend(["--target", target])

    server_cmd = [
        str(binary),
        "-C",
        "-l",
        str(args.port),
        "-m",
        "999",
        "-w",
        str(args.workers),
        "-r",
        args.multicast_ifname,
    ]

    replay_proc: subprocess.Popen[Any] | None = None
    server_proc: subprocess.Popen[Any] | None = None
    curl_procs: list[subprocess.Popen[Any]] = []
    samples: list[ProcessSample] = []
    client_bytes: list[int] = []
    error = ""
    valid = False

    try:
        replay_proc = subprocess.Popen(replay_cmd, cwd=tools_dir, stdout=stdout_target, stderr=stderr_target)
        time.sleep(0.5)

        server_proc = subprocess.Popen(server_cmd, cwd=root, stdout=stdout_target, stderr=stderr_target)
        if not wait_for_port(args.port):
            if server_proc.poll() is not None:
                error = f"rtp2httpd exited before accepting connections (code={server_proc.returncode})"
            else:
                error = f"rtp2httpd did not listen on 127.0.0.1:{args.port}"
            raise RuntimeError(error)

        urls = [client_url(args.port, scenario, i) for i in range(scenario.clients)]
        for url in urls:
            curl_cmd = [
                "curl",
                "-sS",
                "--no-buffer",
                "--max-time",
                str(total_seconds),
                "-o",
                "/dev/null",
                "-w",
                "%{size_download}",
                url,
            ]
            curl_procs.append(
                subprocess.Popen(curl_cmd, stdout=subprocess.PIPE, stderr=stderr_target, text=True)
            )

        start = time.monotonic()
        measure_start = start + scenario.warmup
        deadline = start + total_seconds
        next_sample = measure_start

        while time.monotonic() < deadline:
            now = time.monotonic()
            if replay_proc.poll() is not None:
                error = f"replay exited during benchmark (code={replay_proc.returncode})"
                raise RuntimeError(error)
            if server_proc.poll() is not None:
                error = f"rtp2httpd exited during benchmark (code={server_proc.returncode})"
                raise RuntimeError(error)
            for idx, proc in enumerate(curl_procs):
                if proc.poll() is not None and now < deadline - 0.5:
                    error = f"curl client {idx + 1} exited before measurement ended"
                    raise RuntimeError(error)

            if now >= next_sample:
                samples.append(sampler.sample(server_proc.pid, now - measure_start))
                next_sample += 1.0
            else:
                time.sleep(min(0.2, next_sample - now))

        for proc in curl_procs:
            try:
                out, _ = proc.communicate(timeout=3)
            except subprocess.TimeoutExpired:
                terminate_process(proc)
                out = ""
            try:
                client_bytes.append(int((out or "0").strip() or "0"))
            except ValueError:
                client_bytes.append(0)

        if len(client_bytes) != scenario.clients:
            error = f"expected {scenario.clients} client byte counts, got {len(client_bytes)}"
        elif any(value <= 0 for value in client_bytes):
            error = "one or more clients received zero bytes"
        elif not samples:
            error = "no CPU samples collected"
        else:
            valid = True
    except Exception as exc:
        if not error:
            error = str(exc)
    finally:
        for proc in curl_procs:
            terminate_process(proc)
        if server_proc:
            terminate_process(server_proc)
        if replay_proc:
            terminate_process(replay_proc)

    cpu_values = [sample.cpu_percent for sample in samples]
    rss_values = [sample.rss_mb for sample in samples]
    return {
        "repeat": repeat_index,
        "valid": valid,
        "error": error,
        "scenario": asdict(scenario),
        "commands": {
            "replay": replay_cmd,
            "server": server_cmd,
            "clients": [client_url(args.port, scenario, i) for i in range(scenario.clients)],
        },
        "samples": [asdict(sample) for sample in samples],
        "cpu": summarize(cpu_values),
        "rss_mb": summarize(rss_values),
        "client_bytes": client_bytes,
    }


def summarize_scenario(repeats: list[dict[str, Any]]) -> dict[str, Any]:
    valid_repeats = [repeat for repeat in repeats if repeat["valid"]]
    cpu_avgs = [float(repeat["cpu"]["avg"]) for repeat in valid_repeats]
    cv = coefficient_of_variation(cpu_avgs)
    return {
        "valid_repeats": len(valid_repeats),
        "total_repeats": len(repeats),
        "cpu_avg_mean": statistics.fmean(cpu_avgs) if cpu_avgs else 0.0,
        "cpu_avg_median": statistics.median(cpu_avgs) if cpu_avgs else 0.0,
        "cpu_avg_cv_percent": cv,
        "noisy": cv > CPU_NOISY_CV_THRESHOLD,
        "valid": len(valid_repeats) == len(repeats) and bool(valid_repeats),
    }


def run_suite(args: argparse.Namespace) -> int:
    root = project_root()
    binary_arg = Path(args.binary)
    binary = binary_arg if binary_arg.is_absolute() else (root / binary_arg)
    binary = binary.resolve()
    if not binary.exists():
        print(f"Error: rtp2httpd binary not found: {binary}", file=sys.stderr)
        return 1

    suites = scenario_suites()
    scenarios = [apply_overrides(s, args) for s in suites[args.suite]]
    if args.scenario:
        selected = set(args.scenario)
        scenarios = [s for s in scenarios if s.name in selected]
        missing = selected - {s.name for s in scenarios}
        if missing:
            print(f"Error: unknown scenario(s): {', '.join(sorted(missing))}", file=sys.stderr)
            return 1

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    output_path = output_dir / f"{args.label}.json"
    sampler = create_process_sampler()

    result: dict[str, Any] = {
        "label": args.label,
        "created_at": datetime.now(UTC).isoformat(),
        "command": [sys.executable, *sys.argv],
        "git": git_info(root),
        "environment": environment_info(),
        "build": {
            "binary": str(binary),
            "type": "Release",
            "aggressive_opt": True,
            "recommended_command": "cmake -B build -DCMAKE_BUILD_TYPE=Release -DENABLE_AGGRESSIVE_OPT=ON && cmake --build build -j$(sysctl -n hw.ncpu)",
        },
        "sampler": {
            "backend": sampler.backend_name,
        },
        "defaults": {
            "port": args.port,
            "workers": args.workers,
            "multicast_ifname": args.multicast_ifname,
            "multicast_if_addr": args.multicast_if_addr,
        },
        "rules": {
            "noisy_cv_percent": CPU_NOISY_CV_THRESHOLD,
            "effective_cpu_relative_drop_percent": EFFECTIVE_CPU_RELATIVE_DROP,
            "effective_cpu_absolute_drop_points": EFFECTIVE_CPU_ABSOLUTE_DROP,
        },
        "scenarios": [],
    }

    had_failure = False
    for scenario in scenarios:
        print(
            f"Running {scenario.name}: clients={scenario.clients} same_address={scenario.same_address} "
            f"speed={scenario.speed} warmup={scenario.warmup}s measure={scenario.measure}s repeat={scenario.repeat}"
        )
        repeats = []
        for idx in range(1, scenario.repeat + 1):
            print(f"  repeat {idx}/{scenario.repeat}")
            repeat = run_repeat(root, scenario, idx, args, sampler)
            if not repeat["valid"]:
                had_failure = True
                print(f"    invalid: {repeat['error']}")
            else:
                print(f"    cpu avg={repeat['cpu']['avg']:.2f}% max={repeat['cpu']['max']:.2f}%")
            repeats.append(repeat)
            time.sleep(args.cooldown)

        summary = summarize_scenario(repeats)
        if summary["noisy"]:
            print(
                f"  noisy: repeat CPU avg CV={summary['cpu_avg_cv_percent']:.2f}% "
                f"(threshold {CPU_NOISY_CV_THRESHOLD:.2f}%)"
            )
        result["scenarios"].append(
            {
                "name": scenario.name,
                "config": asdict(scenario),
                "summary": summary,
                "repeats": repeats,
            }
        )

    output_path.write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(f"Wrote {output_path}")
    return 1 if had_failure else 0


def load_result(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def scenario_map(result: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {scenario["name"]: scenario for scenario in result.get("scenarios", [])}


def compare_results(args: argparse.Namespace) -> int:
    baseline = load_result(Path(args.baseline))
    candidate = load_result(Path(args.candidate))
    base_map = scenario_map(baseline)
    cand_map = scenario_map(candidate)
    names = sorted(set(base_map) & set(cand_map))
    if not names:
        print("No overlapping scenarios", file=sys.stderr)
        return 1

    print(f"Baseline:  {baseline.get('label', args.baseline)}")
    print(f"Candidate: {candidate.get('label', args.candidate)}")
    print("")
    print("| Scenario | Baseline CPU avg | Candidate CPU avg | Delta | Result |")
    print("| --- | ---: | ---: | ---: | --- |")
    for name in names:
        base_cpu = float(base_map[name]["summary"].get("cpu_avg_mean", 0.0))
        cand_cpu = float(cand_map[name]["summary"].get("cpu_avg_mean", 0.0))
        delta = base_cpu - cand_cpu
        pct = (delta / base_cpu * 100.0) if base_cpu > 0 else 0.0
        effective = delta >= EFFECTIVE_CPU_ABSOLUTE_DROP and pct >= EFFECTIVE_CPU_RELATIVE_DROP
        result = "effective" if effective else "not significant"
        if cand_map[name]["summary"].get("noisy") or base_map[name]["summary"].get("noisy"):
            result = f"{result}, noisy"
        print(f"| {name} | {base_cpu:.2f}% | {cand_cpu:.2f}% | {delta:+.2f}% ({pct:+.2f}%) | {result} |")
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run and compare rtp2httpd performance benchmarks")
    subparsers = parser.add_subparsers(dest="command", required=True)

    run_parser = subparsers.add_parser("run", help="Run benchmark suite")
    run_parser.add_argument("--suite", choices=sorted(scenario_suites()), default="quick")
    run_parser.add_argument("--label", required=True)
    run_parser.add_argument("--output-dir", default="perf-results")
    run_parser.add_argument("--binary", default="build/rtp2httpd")
    run_parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    run_parser.add_argument("--workers", type=int, default=1)
    run_parser.add_argument("--multicast-ifname", default="lo0" if sys.platform == "darwin" else "lo")
    run_parser.add_argument("--multicast-if-addr", default="127.0.0.1")
    run_parser.add_argument("--scenario", action="append", help="Run only this scenario name")
    run_parser.add_argument("--warmup", type=int, help="Override scenario warmup seconds")
    run_parser.add_argument("--measure", type=int, help="Override scenario measurement seconds")
    run_parser.add_argument("--repeat", type=int, help="Override scenario repeat count")
    run_parser.add_argument("--cooldown", type=float, default=2.0, help="Seconds to wait between repeats")
    run_parser.add_argument("-v", "--verbose", action="store_true", help="Show subprocess output")

    compare_parser = subparsers.add_parser("compare", help="Compare two JSON benchmark results")
    compare_parser.add_argument("baseline")
    compare_parser.add_argument("candidate")

    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.command == "run":
        return run_suite(args)
    if args.command == "compare":
        return compare_results(args)
    raise AssertionError(f"unknown command: {args.command}")


if __name__ == "__main__":
    sys.exit(main())
