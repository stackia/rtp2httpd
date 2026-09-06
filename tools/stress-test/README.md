# Streaming server performance tools

`scripts/benchmark.sh` runs repeated, validated comparisons of rtp2httpd, msd_lite, udpxy, and TVGate. `stress_test.py` remains available for interactive PCAP replay and load debugging; its `top` samples are not used for the performance report.

## Requirements

- Linux with `/proc`, `taskset`, and `sysctl`; Python 3.14+ managed by `uv`.
- Build the required server binaries first. Missing binaries fail the run rather than silently skipping a competitor.
- The default full matrix needs at least 14 available logical CPUs: server 0, load generators/readers 1–12, controller 13. TVGate retains the caller's available CPU set and uses default multicore scheduling. The 64-client case alone needs seven CPUs; examples below show how to select them.
- Multicast and HTTP use loopback. No root permissions, recorded video, or network sysctl changes are required.

## Repeated benchmark

From the repository root:

```bash
# Refresh the project's existing dependencies and build rtp2httpd.
uv sync --group dev
pnpm install --frozen-lockfile
pnpm run web-ui:build
cmake -B build -DCMAKE_BUILD_TYPE=Release -DENABLE_AGGRESSIVE_OPT=ON
cmake --build build -j$(getconf _NPROCESSORS_ONLN)

# Four programs, four cases, five repetitions; 5 s warmup + 20 s sampling.
scripts/benchmark.sh

# Focus on 64 viewers of one 20 Mbps channel, using seven logical CPUs.
scripts/benchmark.sh rtp2httpd msd_lite \
  --cases shared64 --load-cpus 1,2,3,4,5 --controller-cpu 6

```

Default paths can all be overridden with `--binary NAME=/absolute/path`:

| Name | Default executable |
| --- | --- |
| `rtp2httpd` | `build/rtp2httpd` |
| `msd_lite` | `../msd_lite/build/src/msd_lite` |
| `udpxy` | `../udpxy/chipmunk/udpxy` |
| `tvgate` | `../tvgate/TVGate-linux-arm64` |
| `baseline` | Must be supplied explicitly |

Use a clean checkout or separate build directory when refreshing competitors; preserve any existing local changes. Resolve upstream versions before the run and supply `--revision NAME=COMMIT_OR_TAG` for every binary. The report records the exact tested revisions and build settings. TVGate is tested using its official native release binary; verify the release asset's SHA-256 before extracting it.

| Case | Clients | Sources | Payload rate per source |
| --- | ---: | ---: | ---: |
| `shared64` | 64 | 1 | 20 Mbps |
| `distinct8` | 8 | 8 | 40 Mbps |
| `shared8` | 8 | 1 | 40 Mbps |
| `high400` | 1 | 1 | 400 Mbps |

`--cases`, `--repetitions`, `--duration`, `--warmup`, `--server-cpu`, `--load-cpus`, `--controller-cpu`, and `--output` customize the run. `--tvgate-single-cpu` optionally restricts TVGate to `--server-cpu`; leave it unset to test default scheduling. Program order rotates and reverses across repetitions. Each trial starts fresh server and load processes; tests run sequentially.

## Measurement and validity

- CPU is the change in user + system CPU ticks from `/proc/PID/stat`, divided by measured wall time. **100% means one logical CPU**, not the whole machine. Include the supervisor and every child process; process CPU already includes its threads and must not be summed again by thread.
- rtp2httpd uses `-C -w 1`; msd_lite uses one event-loop thread; udpxy retains its native process-per-client model. Their complete process families are pinned to `--server-cpu`. TVGate's `GOMAXPROCS` environment override is removed, and its original available CPU set is restored after the controller pins itself. Its scheduler, buffers, connection limits, and logging use application defaults; only the listener and multicast interfaces are configured. This compares resource consumption under the specified load, with different scheduling policies.
- Each generator and reader process is pinned to a separate CPU from the single-CPU services. TVGate can run on these CPUs too. Load CPU is recorded separately. Loopback kernel work charged to the load processes is outside the server metric; this is not total system CPU or a physical-NIC throughput test.
- PSS and USS come from `smaps_rollup`, summed over the process family and sampled once per second. PSS includes proportional shared pages; USS includes private clean/dirty/huge pages. Neither includes all kernel socket memory or unmapped anonymous-file cache pages.
- The sender emits RTP payload type 33 with seven 188-byte TS null packets per datagram. Every TS packet contains a monotonically increasing marker, its complement, a source identifier, and a checked payload pattern. This tests forwarding and integrity, not video decoding.
- Readers decode HTTP chunk framing before checking payloads. Each client must receive within 2% of the target rate; each generator must also maintain that rate. The measured window must contain no gaps, duplicates, backward markers, corrupt packets, EOFs, or kernel UDP drops. The process family must remain stable and the load processes alive.
- Failures remain in the raw output as `valid: false`; the summary averages valid trials only and always reports valid/total counts. A failed or incomplete run exits nonzero. Do not describe its low CPU as a performance win.
- `resources.json` separately averages CPU and memory across every completed measurement, without filtering by payload diagnostics. The performance report uses these resource observations and does not certify forwarding correctness or sustainable maximum capacity.
- msd_lite keeps the upstream example's 48 KiB receive watermark, 64 KiB send watermark, and 1 MiB ring. Only the listener, interface, thread count/affinity, verbosity, and congestion-control name are adapted. udpxy keeps upstream buffer defaults. Generated configs and complete commands are saved locally for review.

The output directory (default `build/benchmark/YYYYMMDD-HHMMSS/`) contains:

- `metadata.json`: environment, CPU placement, sysctls, revisions, executable/script SHA-256 values.
- `trials.jsonl`: every trial, including failures, per-client rates, integrity counters, CPU, memory, socket/process/thread counts.
- `summary.json`: valid/total counts and mean/min/max CPU, PSS, USS.
- `resources.json`: completed measurement counts and mean/min/max CPU, PSS, USS, independent of payload diagnostics.
- Per-trial logs and generated msd_lite/TVGate configurations.

Results stay local in ignored directories and are not committed. Benchmarks and their helper tests are run manually, outside CI. Run the HTTP framing and TVGate launch-setting checks with:

```bash
uv run pytest tools/stress-test/test_benchmark.py -q
```

## Interactive replay

The earlier PCAP-based tool remains useful for manually stressing a server:

```bash
uv run python tools/stress-test/stress_test.py --program rtp2httpd \
  --duration 30 --clients 16 --speed 10 --same-address
```

It uses `tools/udp-replay/udp_replay.py`, curl readers, and `top` samples. It does not verify the complete output payload or provide repeated comparisons; use the benchmark harness above for published results.
