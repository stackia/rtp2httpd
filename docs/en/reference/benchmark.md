# Performance Benchmark

Compare **rtp2httpd**, **[msd_lite](https://github.com/rozhuk-im/msd_lite)**, **[udpxy](https://github.com/pcherenkov/udpxy)**, and **[TVGate](https://github.com/qist/tvgate)** for CPU and memory consumption with multiple channels, multiple clients sharing one channel, and high-bitrate input.

## Test Environment and Versions

- Test date: 2026-09-06.
- Host: Apple M3 Max; Parallels Ubuntu 24.04 virtual machine with 16 vCPUs and 16 GiB RAM.
- System: Linux 6.8.0-138-generic, aarch64; all programs run natively on ARM64.
- Compiler: GCC 13.3.0. rtp2httpd uses Release and `ENABLE_AGGRESSIVE_OPT=ON`; msd_lite uses `-O3`, LTO, and the same inlining, loop-unrolling, and vectorization options; udpxy uses `-O3 -flto`. TVGate uses its official release binary.
- Multicast input and HTTP output both use `lo`, with no kernel network tuning. `net.core.rmem_max` and `net.core.wmem_max` are both 212992; TCP congestion control is cubic.

| Program | Tested version |
| --- | --- |
| rtp2httpd | [`b4fd92a6`](https://github.com/stackia/rtp2httpd/commit/b4fd92a6c49bd720e730aedd62cd10faeeca791f) |
| msd_lite | [`fa68e131`](https://github.com/rozhuk-im/msd_lite/commit/fa68e131343fb58c67ad77b2d26f2cb7c49a2c95), 2026-07-20; liblcb `e2f420a2` |
| udpxy | [`31d4bcfa`](https://github.com/pcherenkov/udpxy/commit/31d4bcfabaade59d3efdee015df7979febf76bae), 2026-04-13 |
| TVGate | [v3.2.0](https://github.com/qist/tvgate/releases/tag/v3.2.0), 2026-09-06 |

## Measurement Method

rtp2httpd uses `-C -w 1`, msd_lite uses one event-loop thread, and udpxy retains its native process-per-client model. All processes and threads of these three programs are pinned to one vCPU. TVGate runs without a `GOMAXPROCS` override or an additional CPU-affinity restriction, using default multicore scheduling across all 16 VM vCPUs. Scheduling policies differ, so the results describe server CPU costs under the specified input load and configuration.

CPU utilization is the change in user and system CPU time from `/proc/PID/stat` over the complete measurement window, divided by actual wall time and summed over the entire server process tree. **100% means one fully occupied vCPU**; multicore programs can exceed 100%. Generators, readers, and the measurement controller are pinned to other vCPUs. Their CPU is recorded separately and excluded from server CPU; TVGate's default scheduler can use these vCPUs too.

PSS and USS are sampled every second from `smaps_rollup` and summed over the process tree. PSS proportionally includes shared pages, while USS includes only private pages. Neither includes all kernel socket memory or unmapped anonymous-file cache pages, so these metrics do not represent total server memory cost.

Each RTP datagram carries seven 188-byte MPEG-TS null packets, totaling 1316 payload bytes. Readers decode HTTP chunk framing and continuously consume the stream. Each trial restarts the server and load processes, then warms up after every client starts receiving data. Tests run sequentially. The program order rotates each round, so every program occupies each execution position once over four rounds.

msd_lite retains the upstream example's 48 KiB receive watermark, 64 KiB send watermark, and 1 MiB ring buffer; only the listener, interface, thread count, logging, and congestion control are adapted. udpxy retains its default buffer settings. TVGate configures only its listening port and loopback multicast interfaces; concurrency, buffering, connection limits, and logging use application defaults.

## Test Scenarios

| Scenario | Clients | Multicast sources | Payload rate per source | Repetitions | Warmup / sampling per trial |
| --- | ---: | ---: | ---: | ---: | --- |
| Multiple channels | 8 | 8 | 40 Mbps | 4 | 5 s / 15 s |
| 8 clients sharing one channel | 8 | 1 | 40 Mbps | 4 | 5 s / 15 s |
| 64 clients sharing one channel | 64 | 1 | 20 Mbps | 4 | 5 s / 15 s |
| High bitrate | 1 | 1 | 400 Mbps | 4 | 5 s / 15 s |

## Results

CPU and memory statistics include every completed measurement in each scenario. They measure resource consumption under the specified load, without certifying forwarding correctness or maximum sustainable throughput.

### CPU Utilization

Values are the means of per-trial average CPU utilization, with the minimum and maximum in parentheses.

| Scenario | rtp2httpd | msd_lite | udpxy | TVGate |
| --- | ---: | ---: | ---: | ---: |
| 8 channels, 40 Mbps each | 3.69% (2.60–4.52) | 12.28% (10.98–12.92) | 23.02% (22.31–23.91) | 56.65% (56.16–57.17) |
| 8 clients, one 40 Mbps channel | 4.87% (4.64–4.98) | 5.58% (5.29–5.90) | 30.92% (29.19–32.29) | 45.09% (41.79–48.09) |
| 64 clients, one 20 Mbps channel | 4.78% (4.77–4.78) | 5.50% (5.31–5.76) | 59.93% (58.77–60.62) | 115.08% (112.50–117.97) |
| 1 client, 400 Mbps | 12.88% (9.70–14.27) | 15.46% (14.85–15.77) | 26.45% (24.58–27.68) | 57.86% (56.08–59.28) |

### PSS Memory (MiB)

| Scenario | rtp2httpd | msd_lite | udpxy | TVGate |
| --- | ---: | ---: | ---: | ---: |
| 8 channels, 40 Mbps each | 1.86 | 8.95 | 0.79 | 25.82 |
| 8 clients, one 40 Mbps channel | 1.13 | 1.35 | 0.79 | 22.76 |
| 64 clients, one 20 Mbps channel | 1.30 | 1.37 | 4.55 | 46.26 |
| 1 client, 400 Mbps | 1.26 | 1.34 | 0.32 | 19.16 |

### USS Memory (MiB)

| Scenario | rtp2httpd | msd_lite | udpxy | TVGate |
| --- | ---: | ---: | ---: | ---: |
| 8 channels, 40 Mbps each | 1.24 | 8.94 | 0.52 | 25.82 |
| 8 clients, one 40 Mbps channel | 0.51 | 1.34 | 0.52 | 22.76 |
| 64 clients, one 20 Mbps channel | 0.68 | 1.35 | 3.96 | 46.26 |
| 1 client, 400 Mbps | 0.63 | 1.33 | 0.12 | 19.16 |

## Appendix: Performance Optimization Strategies in rtp2httpd

### Allocate Memory by Lifetime

Connections allocate RTSP or HTTP proxy state only for the protocol they use. FEC group tables are allocated when recovery groups need to be stored. HTTP input buffers and parsed requests use separate anonymous memory mappings: input storage is released after parsing and routing, while ordinary media streams release parsed request data after generating response headers. HTTP proxies retain the request headers and body they still use. Temporary request pages can return directly to the operating system instead of remaining in the heap alongside long-lived connections.

Ordinary shared multicast clients use the source's reorder window instead of allocating unused private arrays. Private windows are allocated for RTSP, FCC, snapshots, or FEC processing. When FEC appears during a stream, both existing clients and later subscribers receive their own windows.

The packet pool starts with 128 buffers and grows in increments of 128. The control pool starts with 16 and grows in increments of 16. The worker periodically reclaims completely idle segments while retaining a base capacity. Client queue budgets are calculated separately from the initial allocation, so reducing initial memory does not reduce the existing buffering allowance.

### Shared Multicast Subscriptions Within Each Worker

Each worker maintains a shared-source registry keyed by the resolved multicast address, port, SSM source address, effective upstream interface, and FEC port. Channel names, `/rtp/` versus `/udp/` spelling, and FCC server parameters do not participate in matching. Requests for the same resource create one main multicast socket and, when configured, one FEC socket.

Each source owns its lifecycle, timeout, and rejoin timers. Clients hold subscription references; releasing the last reference closes the sockets and destroys source state. When the first client leaves, event dispatch is reassigned to a surviving subscriber. Workers continue to maintain their source registries independently.

This primarily reduces duplicate local socket receives, system calls, and application processing. Multiple local sockets joining one multicast group do not necessarily cause the upstream link to carry the same number of complete streams.

### Shared Parsing, Reordering, and Batch Payloads

For ordinary multicast, the shared source parses and reorders RTP once, then combines payloads into batches with a capacity of 64 KiB. Each RTP payload remains intact: the current batch is flushed before the next payload would exceed capacity. The 1316-byte payloads produce batches of 49 packets, or 64484 bytes. This reduces both repeated per-client parsing and per-packet fanout and send calls. Partial batches flush at the next worker timer check after reaching 100 ms of age. The timer runs every 100 ms; scheduling also affects actual latency.

The Buffer layer adds an on-demand 64 KiB batch pool alongside the existing 1536-byte packet pool and control pool. The worker owns the batch pool, so queued data can outlive its multicast source. It initially allocates four batches and grows in increments of four. Its maximum capacity is derived from a `buffer-pool-max-size × 1536` byte budget, with room for at least four batches. This limit applies to the batch pool separately from the original packet pool. If the batch pool is exhausted, forwarding can continue through small-packet references.

Multiple clients share the underlying payload while each owns a separate `buffer_ref_t` view. Its `owner` points to the same immutable data; list links, send offsets, and remaining lengths stay independent. A partial send updates only that client's view. The backing memory returns to the pool only after the last view is released. Each client retains its own send queue and capacity limit, so a slow client does not pause reception for other subscribers. A source with only one subscriber uses the batch descriptor directly, avoiding an extra view allocation.

Queue limits now charge the backing buffer capacity instead of assuming “buffer count × 1536.” A batch with only a few unsent bytes still consumes the full 64 KiB allowance until that client releases its reference. This prevents shared large buffers from bypassing the existing slow-client memory limits.

### Reduce Fixed Receive and Send Costs

Platforms supporting `recvmmsg` receive up to 16 datagrams per call. The worker reuses receive descriptors and unconsumed packet buffers. After processing, a packet buffer with no other references is reused for the next receive. If a reorder window, FEC state, or send queue still holds a reference, reception uses another buffer to avoid overwriting pending data. Data arrives directly in pool buffers, avoiding an additional copy after reception; platforms without batch reception receive one packet at a time. Once initial RTP reordering is complete, an expected packet can be delivered directly when the window is empty and FEC is disabled, avoiding insertion into and removal from reorder slots.

The main multicast socket is read immediately on its first readiness notification. Subsequent reception can coalesce up to 1–2 ms of work, depending on the actual receive-buffer capacity and the number of datagrams received, reducing event wakeups for continuous small packets. A 1 ms wait requires a system-reported receive buffer of at least 128 KiB; 2 ms requires at least 256 KiB and a low packet count. System scheduling also affects the actual interval. Readiness notifications are paused during deferred reception and rearmed after the socket is drained. The worker scans only sources with pending receive tasks, and removes a source's task when its last subscriber leaves.

Small receive buffers, or a failed capacity query, use level-triggered notifications. A read reaching a conservative packet-count threshold derived from buffer capacity also restores immediate reception. The packet rate is then reassessed over windows of at least 100 ms. A lower rate with twice the scheduling headroom permits another coalescing attempt, so a single burst cannot permanently disable the optimization. With level triggering, a short batch can return because remaining data still generates notifications. Deferred reception must confirm that the socket is drained so an interrupted short read cannot strand data. Each callback receives at most 256 main multicast datagrams so continuous traffic cannot occupy the event loop indefinitely. These strategies are selected automatically and require no additional configuration.

Writes enter a local worker queue first. The worker subscribes to kernel writable events only when a socket cannot make further progress, reducing per-batch event registration changes. Each connection sends at most 256 KiB per turn, and each event-loop iteration processes at most 128 write tasks. Remaining tasks stay queued so reception, timers, and other clients can also run.

Client ownership checks in status tracking use a process-local cached PID, refreshed after every fork. This removes repeated `getpid()` calls from queue and send-statistics updates.

Queue limits, counters, and high-water marks still update on every queue operation, while publication to shared status memory runs on the worker's 100 ms timer. This reduces repeated shared-memory writes and synchronization during batch enqueueing and sending. The status page displays the most recently published queue snapshot.

### Immutable Batch Snapshots

Platforms supporting memory-file sealing use `memfd_create` to create anonymous memory files for shared batches. Each file is written once, sealed, and sent to multiple clients through `sendfile`, reusing the same kernel pages. This path applies only when multiple clients share a nearly full batch. Ordinary memory buffers continue to use `sendmsg`.

Every batch gets a new file. Once published, it cannot be written, grown, or truncated; reusing pool memory never overwrites an old file. TCP may still reference its pages after `sendfile` returns and the application closes its last file reference. Immutability ensures that a new batch cannot alter those pending bytes. File creation, writing, or sealing failures retain memory sending. If a client's `sendfile` operation is unsupported, only that client's view falls back to memory sending.

### FCC, FEC, and Client Isolation

FCC unicast and switching state remain independent per client. The handoff first shares the multicast socket. After unicast and pending data have drained and the reorder sequence aligns with the shared source, the client joins shared batch delivery. The previous batch is flushed before the switch so the new subscriber does not replay older content.

Snapshots retain independent processing state. Sources configured with an FEC port share sockets but retain per-client reordering and FEC recovery. If in-band FEC first appears during a stream, the source flushes its existing batch and transfers the shared reorder window to each client before switching to private processing. The ordinary-multicast CPU measurements in this report therefore do not directly represent FCC unicast, FEC recovery, or snapshot workloads.

## Scope

This measures fixed-bitrate forwarding resources inside an ARM64 Linux virtual machine, rather than physical-NIC throughput limits, video decoding, or maximum client capacity. Loopback kernel work charged to generators and readers is outside server CPU, and host scheduling introduces variation. Other hardware, bitrates, client speeds, channel counts, and network paths require separate measurements.

## Reproducing the Tests

See [tools/stress-test/README.md](https://github.com/stackia/rtp2httpd/blob/main/tools/stress-test/README.md) for the harness and options. Prepare the corresponding binaries, then run all four scenarios:

```bash
scripts/benchmark.sh rtp2httpd msd_lite udpxy tvgate \
  --cases distinct8 shared8 shared64 high400 \
  --repetitions 4 --warmup 5 --duration 15
```

Use `--binary NAME=PATH` and `--revision NAME=VERSION` to identify the actual executables and versions. Set repetitions and sampling duration for each scenario according to the table above. CPU, PSS, and USS summaries are written to `resources.json` in the output directory, which defaults to `build/benchmark/`. Test records remain local.
