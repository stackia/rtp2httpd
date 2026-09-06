# Performance Benchmark

This report compares CPU usage, memory consumption, and output integrity for **rtp2httpd**, **[msd_lite](https://github.com/rozhuk-im/msd_lite)**, **[udpxy](https://github.com/pcherenkov/udpxy)**, and **[TVGate](https://github.com/qist/tvgate)** under the same multicast workload. This update adds 64 clients watching one channel, alongside the multi-channel, eight-client shared-channel, and high-bitrate tests.

## Environment and Versions

- Test date: 2026-09-06.
- Host: Apple M3 Max; Parallels Ubuntu 24.04 virtual machine with 16 vCPUs and 16 GiB RAM.
- System: Linux 6.8.0-138-generic, aarch64; all programs execute natively as ARM64 binaries.
- Compiler: GCC 13.3.0. rtp2httpd uses Release with `ENABLE_AGGRESSIVE_OPT=ON`; msd_lite uses `-O3`, LTO, and equivalent inlining, loop-unrolling, and vectorization options; udpxy uses `-O3 -flto`. TVGate uses the official release binary.
- Multicast input and HTTP output both use `lo`, with no network sysctl changes. `net.core.rmem_max` and `net.core.wmem_max` are both 212992; TCP congestion control is cubic.

| Program | Tested version |
| --- | --- |
| rtp2httpd (optimized) | [`530dc980`](https://github.com/stackia/rtp2httpd/commit/530dc980e92db6b6ea98b6ca223dffe1a0345b5c) |
| msd_lite | [`fa68e131`](https://github.com/rozhuk-im/msd_lite/commit/fa68e131343fb58c67ad77b2d26f2cb7c49a2c95), 2026-07-20; liblcb `e2f420a2` |
| udpxy | [`31d4bcfa`](https://github.com/pcherenkov/udpxy/commit/31d4bcfabaade59d3efdee015df7979febf76bae), 2026-04-13 |
| TVGate | [v3.2.0](https://github.com/qist/tvgate/releases/tag/v3.2.0), 2026-09-06 |
| rtp2httpd (pre-optimization baseline) | [`f8c243cb`](https://github.com/stackia/rtp2httpd/commit/f8c243cb6fc98e259fd2f2fe0dc992f2a845014e), used only for the 64-client comparison |

msd_lite and udpxy use the latest upstream commits retrieved for this test; TVGate uses the latest stable release available at the time. The TVGate ARM64 release archive has SHA-256 `1655a066b91debdaf2f3b39096207f80fdfc7bd9c2f227ff9dda34c48562ac3e`. Executable SHA-256 values, full commands, environment settings, and individual trials are stored in the [raw results directory](https://github.com/stackia/rtp2httpd/tree/main/tools/stress-test/results/2026-09-06).

## Methodology

All processes and threads of each server are pinned to one vCPU. rtp2httpd explicitly uses `-C -w 1`; msd_lite uses one event-loop thread; TVGate uses `GOMAXPROCS=1`; udpxy retains its native process-per-client model, with all child processes included. This compares programs under the same single-core budget, rather than assuming that each has only one process or thread.

CPU usage is the change in user and system CPU time from `/proc/PID/stat` over the entire measurement window, divided by actual wall time and summed across the server process tree. **100% means one fully occupied vCPU**. Generators, readers, and the controller run on separate vCPUs; their CPU usage is recorded separately and excluded from server CPU. PSS and USS are sampled from `smaps_rollup` once per second and summed across the process tree. PSS includes proportional shared pages; USS counts private pages. Neither includes all kernel socket memory or unmapped anonymous-file cache pages, so these metrics do not represent the service’s total memory cost.

Each RTP datagram carries seven 188-byte MPEG-TS null packets, totaling 1316 payload bytes. Every TS packet contains an increasing sequence marker, its complement, a source identifier, and fixed content for validation. Readers decode HTTP chunk framing before checking every packet's content and continuity. Each client and generator must sustain a mean payload rate within ±2% of the target, with no sequence gaps, duplicates, backward markers, content errors, client EOFs, or kernel UDP drops during the measurement window. Failed samples remain in the raw output and are explicitly marked invalid.

Trials run sequentially, changing program order across repetitions and restarting both server and load processes. Warmup starts after all clients receive data. msd_lite retains the upstream example's 48 KiB receive watermark, 64 KiB send watermark, and 1 MiB ring; only the listener, interface, thread count, logging, and congestion control are adapted. udpxy retains its default buffer settings. TVGate uses loopback upstream interfaces and a connection limit of 256.

| Scenario | Clients | Multicast sources | Payload rate per source | Repetitions | Warmup / sampling per trial |
| --- | ---: | ---: | ---: | ---: | --- |
| 64 clients, one channel | 64 | 1 | 20 Mbps | 5 | 5 s / 20 s |
| Multiple channels | 8 | 8 | 40 Mbps | 3 | 5 s / 10 s |
| 8 clients, one channel | 8 | 1 | 40 Mbps | 3 | 5 s / 10 s |
| High bitrate | 1 | 1 | 400 Mbps | 3 | 5 s / 10 s |

## Results

### 64 Clients Watching One Channel

CPU values are means of valid samples, followed by the minimum and maximum across trials. Memory values are means of valid samples; trials failing integrity checks are excluded.

| Program | Mean CPU (range) | PSS (MiB) | USS (MiB) | Valid / total trials | Multicast sockets |
| --- | --- | ---: | ---: | ---: | ---: |
| rtp2httpd | 6.97% (6.33–7.68) | 4.61 | 3.99 | 5/5 | 1 |
| msd_lite | 5.91% (5.59–6.48) | 1.37 | 1.36 | 5/5 | 1 |
| udpxy | 56.75% (54.80–58.70) | 4.61 | 4.02 | 2/5 | 64 |
| TVGate | — | — | — | 0/5 | 1 |
| rtp2httpd (baseline) | 30.10% (29.07–31.37) | 10.28 | 9.60 | 5/5 | 64 |

Both the optimized version and baseline passed all five trials. Each optimized-version client received 19.985–20.023 Mbps of payload, totaling approximately 1.28 Gbps. All five trials had no sequence gaps, backward markers, duplicates, content errors, EOFs, or kernel UDP drops.

3 udpxy trials recorded kernel UDP drops; the table includes only the other 2 trials. All five TVGate trials failed sequence-continuity checks. Their observed CPU usage was 46.93–53.37%, excluded from valid forwarding comparisons.

### Additional Scenarios

Cells show “mean CPU of valid samples; valid / total trials.”

| Scenario | rtp2httpd | msd_lite | udpxy | TVGate |
| --- | --- | --- | --- | --- |
| 8 channels, 40 Mbps each | 9.78%; 3/3 | 9.49%; 3/3 | 20.81%; 3/3 | —; 0/3 |
| 8 clients, one 40 Mbps channel | 7.21%; 3/3 | 6.07%; 3/3 | 26.93%; 3/3 | —; 0/3 |
| 1 client, 400 Mbps | 14.79%; 2/3 | 13.76%; 1/3 | —; 0/3 | —; 0/3 |

Memory values below are “PSS / USS” in MiB, using the same valid samples.

| Scenario | rtp2httpd | msd_lite | udpxy | TVGate |
| --- | --- | --- | --- | --- |
| 8 channels, 40 Mbps each | 2.28 / 1.66 | 8.95 / 8.94 | 0.80 / 0.53 | — / — |
| 8 clients, one 40 Mbps channel | 1.60 / 0.98 | 1.35 / 1.34 | 0.79 / 0.52 | — / — |
| 1 client, 400 Mbps | 1.43 / 0.84 | 1.34 / 1.33 | — / — | — / — |

When some trials fail, the mean of the remaining samples does not imply stable forwarding across all trials. Non-TVGate failures in the additional scenarios are listed below; every failed record is retained with the report.

| Scenario | Program | Trial | Kernel UDP drops | TS sequence gaps |
| --- | --- | ---: | ---: | ---: |
| 400 Mbps | rtp2httpd | 1 | 37 | 259 |
| 400 Mbps | udpxy | 1 | 29 | 203 |
| 400 Mbps | udpxy | 2 | 133 | 931 |
| 400 Mbps | msd_lite | 2 | 289 | 2023 |
| 400 Mbps | udpxy | 3 | 97 | 679 |
| 400 Mbps | msd_lite | 3 | 273 | 1911 |

### Output Integrity

TVGate receives the same RTP input through the `/udp/` endpoint recommended in its [official documentation](https://github.com/qist/tvgate/blob/main/doc/MULTICAST.md). TS content checks pass, but increasing markers jump backward and forward; a normal mean bitrate does not establish continuity. A separate single-client capture also showed sequences such as `0…6 → 0…6 → 14…20`. This report establishes only that this version failed continuity checks for this synthetic forwarding workload, without extrapolating to other video sources or versions.

For a complete measurement record, the table below includes observed TVGate CPU usage across all trials. Every sample failed continuity checks and cannot be treated as a valid forwarding performance result.

| Scenario | Observed mean CPU (range) |
| --- | --- |
| 64 clients, one 20 Mbps channel | 49.81% (46.93–53.37) |
| 8 channels, 40 Mbps each | 30.91% (30.27–31.38) |
| 8 clients, one 40 Mbps channel | 22.33% (21.83–22.74) |
| 1 client, 400 Mbps | 27.92% (25.64–30.10) |

For 64 clients watching one channel, both rtp2httpd and msd_lite passed every trial, with msd_lite using less CPU. Every program had invalid samples at 400 Mbps, so these results cannot establish a stable-forwarding performance ranking. CPU cost, buffering behavior, and output integrity must be considered together.

## Performance Optimizations in rtp2httpd

### Shared Multicast Subscriptions Within Each Worker

Each worker maintains a shared-source registry keyed by the resolved multicast address, port, SSM source address, effective upstream interface, and FEC port. Channel names, `/rtp/` versus `/udp/` spelling, and FCC server parameters do not participate in matching. Requests for the same resource create one main multicast socket and, when configured, one FEC socket.

Each source owns its lifecycle, timeout, and rejoin timers. Clients hold subscription references; releasing the last reference closes the sockets and destroys source state. When the first client leaves, event dispatch is reassigned to a surviving subscriber. Workers continue to maintain their source registries independently.

This primarily reduces duplicate local socket receives, system calls, and application processing. Multiple local sockets joining one multicast group do not necessarily cause the upstream link to carry the same number of complete streams. This benchmark does not claim network-side bandwidth savings.

### Shared Parsing, Reordering, and Batch Payloads

For ordinary multicast, the shared source parses and reorders RTP once, then combines payloads into batches with a capacity of 64 KiB. Each RTP payload remains intact: the current batch is flushed before the next payload would exceed capacity. The 1316-byte payloads used here produce batches of 49 packets, or 64484 bytes. This reduces both repeated per-client parsing and per-packet fanout and send calls. Partial batches flush at the next worker timer check after reaching 100 ms of age. The timer runs every 100 ms; scheduling also affects actual latency.

The Buffer layer adds an on-demand 64 KiB batch pool alongside the existing 1536-byte packet pool and control pool. The worker owns the batch pool, so queued data can outlive its multicast source. It initially allocates four batches and grows in increments of four. Its maximum capacity is derived from a `buffer-pool-max-size × 1536` byte budget, with room for at least four batches. This limit applies to the batch pool separately from the original packet pool. If the batch pool is exhausted, forwarding can continue through small-packet references.

Clients share the underlying payload while each owns a separate `buffer_ref_t` view. Its `owner` points to the same immutable data; list links, send offsets, and remaining lengths stay independent. A partial send updates only that client's view. The backing memory returns to the pool only after the last view is released. Each client retains its own send queue and packet-drop policy, so a slow client does not pause reception for other subscribers.

Queue limits now charge the backing buffer capacity instead of assuming “buffer count × 1536.” A batch with only a few unsent bytes still consumes the full 64 KiB allowance until that client releases its reference. This prevents shared large buffers from bypassing the existing slow-client memory limits.

### Immutable Batch Snapshots

In this Linux test, complete shared batches also use anonymous memory files created with `memfd_create`. Each file is written once, sealed, and sent to multiple clients through `sendfile`, reusing the same kernel pages. This path applies only when multiple clients share a nearly full batch. Ordinary memory buffers continue to use `sendmsg`.

Every batch gets a new file. Once published, it cannot be written, grown, or truncated; reusing pool memory never overwrites an old file. TCP may still reference its pages after `sendfile` returns and the application closes its last file reference. Immutability ensures that a new batch cannot alter those pending bytes. File creation, writing, or sealing failures retain memory sending. If a client's `sendfile` operation is unsupported, only that client's view falls back to memory sending.

### FCC, FEC, and Client Isolation

FCC unicast and switching state remain independent per client. The handoff first shares the multicast socket. After unicast and pending data have drained and the reorder sequence aligns with the shared source, the client joins shared batch delivery. The previous batch is flushed before the switch so the new subscriber does not replay older content.

Snapshots retain independent processing state. Sources configured with an FEC port share sockets but retain per-client reordering and FEC recovery. If in-band FEC first appears during a stream, the source flushes its existing batch and transfers the shared reorder window to each client before switching to private processing. The ordinary-multicast CPU measurements in this report therefore do not directly represent FCC unicast, FEC recovery, or snapshot workloads.

## Scope

This is a fixed-bitrate forwarding test inside an ARM64 Linux virtual machine. It does not measure physical-NIC throughput limits, video decoding, or maximum client capacity. Loopback kernel work charged to generators and readers is outside the server CPU metric, and host scheduling introduces variation. Other hardware, bitrates, client speeds, channel counts, and network paths require separate measurements.

## Reproducing the Tests

See [tools/stress-test/README.md](https://github.com/stackia/rtp2httpd/blob/main/tools/stress-test/README.md) for the harness and options. Prepare the corresponding binaries, then run:

```bash
# Four projects, 64 clients watching one channel, five repetitions.
scripts/benchmark.sh rtp2httpd msd_lite udpxy tvgate \
  --cases shared64 --repetitions 5 --warmup 5 --duration 20

# Three additional scenarios, three repetitions.
scripts/benchmark.sh rtp2httpd msd_lite udpxy tvgate \
  --cases distinct8 shared8 high400 --repetitions 3 --warmup 5 --duration 10
```

Use `--binary NAME=PATH` and `--revision NAME=VERSION` to identify the actual executables and versions. For the pre/post comparison, also pass the `baseline` program name and `--binary baseline=PATH`. The default output directory is under `build/benchmark/` and contains the environment, executable hashes, individual trials, summary, logs, and generated configs. Runs containing invalid samples exit with a nonzero status.
