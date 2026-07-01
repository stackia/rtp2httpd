# Stress test

Automated performance tests for streaming servers: rtp2httpd, msd_lite, udpxy, and tvgate.

## What it does

1. Starts multicast packet replay with `tools/udp-replay/udp_replay.py --continuous --speed N`.
2. Launches the streaming server under test.
3. Spawns multiple concurrent curl clients, each requesting a unique multicast address by default.
4. Monitors CPU and memory usage, including forked child processes.
5. Reports statistics after the test.

## Requirements

- Python 3.14+
- [uv](https://docs.astral.sh/uv/)
- Linux (uses `/proc`, `/proc/net/igmp`, and `top`)
- `curl`
- The server binary being tested

The default binary locations are resolved relative to the repository root:

| Program   | Path                                  |
| --------- | ------------------------------------- |
| rtp2httpd | `build/rtp2httpd`                     |
| msd_lite  | `../msd_lite/build/src/msd_lite`      |
| udpxy     | `../udpxy/chipmunk/udpxy`             |
| tvgate    | `../tvgate/TVGate-linux-arm64`        |

External program configs live under `tools/stress-test/conf/`.

## Usage

```bash
# Test rtp2httpd (default)
uv run python tools/stress-test/stress_test.py

# Test msd_lite
uv run python tools/stress-test/stress_test.py --program msd_lite

# Test udpxy
uv run python tools/stress-test/stress_test.py --program udpxy

# Test tvgate
uv run python tools/stress-test/stress_test.py --program tvgate

# Custom parameters
uv run python tools/stress-test/stress_test.py --duration 30 --clients 16 --speed 10

# Verbose output (show subprocess output)
uv run python tools/stress-test/stress_test.py -v
```

## Options

| Option           | Default     | Description                                                  |
| ---------------- | ----------- | ------------------------------------------------------------ |
| `--program`      | `rtp2httpd` | Program to test: rtp2httpd, msd_lite, udpxy, tvgate          |
| `--duration`     | `10`        | Test duration in seconds                                     |
| `--clients`      | `8`         | Number of concurrent curl clients                            |
| `--speed`        | `5.0`       | Replay speed multiplier (5x is approximately 40 Mbps)        |
| `--same-address` | -           | All clients use the same multicast address (default: unique) |
| `-v, --verbose`  | -           | Show verbose output from subprocesses                        |

## Benchmark suite

Run the full benchmark matrix from the repository root:

```bash
scripts/benchmark.sh
```

Run one program only:

```bash
scripts/benchmark.sh rtp2httpd
scripts/benchmark.sh tvgate
```

Benchmark results are saved to `tools/stress-test/benchmark_results_YYYYMMDD_HHMMSS.txt`.

## Example output

```text
============================================================
Stress Test: rtp2httpd
============================================================
Program:      rtp2httpd
Binary:       /path/to/rtp2httpd
Duration:     10s
Clients:      8
Replay speed: 5.0x (~40 Mbps)
Port:         5140
Streams:      239.81.0.1-8:4056 (unique per client)
============================================================

[1/3] Starting multicast replay...
  PID: 12345

[2/3] Starting rtp2httpd...
  PID: 12346

[3/3] Starting 8 curl clients...
  Each client uses a unique address in 239.81.0.0/24
  URLs: http://127.0.0.1:5140/rtp/239.81.0.1:4056 ... (and 7 more)
  PIDs: [12347, 12348, ...]

[Running] Test running for 10 seconds...
  Progress: 10.0s / 10s

============================================================
RESULTS
============================================================

[rtp2httpd]
  CPU:  avg=  2.00%  max=  2.00%
  PSS:  avg=  3.62MB max=  3.62MB
  USS:  avg=  3.62MB max=  3.62MB

[replay (udp_replay.py)]
  CPU:  avg=100.67%  max=102.00%
  PSS:  avg= 69.47MB max= 69.47MB
  USS:  avg= 69.47MB max= 69.47MB

[curl clients x4 (aggregated)]
  CPU:  avg=  0.00%  max=  0.00%
  PSS:  avg= 38.62MB max= 38.62MB
  USS:  avg= 38.62MB max= 38.62MB
```

## Unique multicast addresses

By default, each curl client requests a unique multicast address in the same /24 subnet:

- Client 1: `239.81.0.1:4056`
- Client 2: `239.81.0.2:4056`
- Client 3: `239.81.0.3:4056`

This tests the server's ability to handle multiple independent streams. Use `--same-address` to have all clients request the same address for a traditional single-stream stress test.

## CPU measurement

- Uses `top -b -n 2` for CPU sampling. The first sample is cumulative, and the second reflects current usage.
- Aggregates CPU usage across the parent process and all forked child processes.
- More accurate than `/proc/[pid]/stat` for programs using io_uring.

## Memory measurement

Reports two memory metrics for forked processes:

- PSS (Proportional Set Size): shared memory divided proportionally among all sharing processes. Best for capacity planning.
- USS (Unique Set Size): private memory only (`Private_Clean + Private_Dirty`). Represents memory freed when the process exits.

Both metrics are read from `/proc/[pid]/smaps_rollup` on Linux 4.14+ and aggregated across child processes.
