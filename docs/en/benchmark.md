# Performance Benchmark Report

Language: [中文](../benchmark.md) | [English](benchmark.md)

Performance comparison of four multicast-to-unicast programs: **rtp2httpd**, **[msd_lite](https://github.com/rozhuk-im/msd_lite)**, **[udpxy](https://github.com/pcherenkov/udpxy)**, and **[tvgate](https://github.com/qist/tvgate)**.

## Test Environment

- **Platform**: Ubuntu 24.04 on Apple M3 Max (Parallels Desktop VM)
- **Architecture**: aarch64 (all programs are native arm64 builds)
- **Kernel**: Linux 6.8.0-90-generic
- **Duration per test**: 10 seconds
- **Measurement method**:
  - CPU: sampled with `top -b -n 2`
  - Memory: USS (Unique Set Size) read from `/proc/[pid]/smaps_rollup`
  - If a process forks, CPU and memory are summed across parent and children
- **Versions**:
  - rtp2httpd: v3.8.3
  - msd_lite: commit 79a6c62 (2025-05-02)
  - udpxy: commit 56fc563 (2026-01-26)
  - tvgate: v2.1.8

## Test Scenarios

| Test             | Description                                                                |
| ---------------- | -------------------------------------------------------------------------- |
| **Multi-stream** | 8 clients, each requesting a different multicast address, ~40 Mbps per stream (4K IPTV bitrate) |
| **Single-stream**| 8 clients, all requesting the same multicast address, ~40 Mbps per stream  |
| **High-bandwidth** | 1 client, ~400 Mbps per stream                                           |

## Summary Results

### CPU Usage (%)

| Scenario              | rtp2httpd     | msd_lite | udpxy   | tvgate  |
| --------------------- | ------------- | -------- | ------- | ------- |
| Multi-stream (8 unique addresses) | 🏆 **17.00%** | 25.80%   | 106.00% | 331.00% |
| Single-stream (8 same address)    | 🏆 **14.00%** | 14.20%   | 85.00%  | 51.45%  |
| High-bandwidth (400 Mbps)         | 🏆 **26.73%** | 39.50%   | 30.85%  | 89.53%  |

### Memory Usage (MB)

| Scenario              | rtp2httpd   | msd_lite    | udpxy | tvgate |
| --------------------- | ----------- | ----------- | ----- | ------ |
| Multi-stream (8 unique addresses) | 🏆 **4.50** | 10.25       | 12.53 | 182.00 |
| Single-stream (8 same address)    | 4.88        | 🏆 **2.62** | 12.53 | 33.25  |
| High-bandwidth (400 Mbps)         | 3.88        | 🏆 **2.62** | 3.21  | 47.38  |

## Detailed Results

### Test 1: Multi-stream (8 clients, different addresses, ~40 Mbps)

Each client requests a different multicast address (239.81.0.1-8), testing the server's ability to handle multiple independent streams.

| Metric   | rtp2httpd      | msd_lite | udpxy    | tvgate    |
| -------- | -------------- | -------- | -------- | --------- |
| CPU Avg  | 🏆 **17.00%**  | 25.80%   | 106.00%  | 331.00%   |
| CPU Peak | 🏆 **18.00%**  | 30.00%   | 116.00%  | 332.00%   |
| Memory Avg | 🏆 **4.50 MB** | 10.25 MB | 12.53 MB | 182.00 MB |

### Test 2: Single-stream (8 clients, same address, ~40 Mbps)

All 8 clients request the same multicast address, testing multicast reuse efficiency.

| Metric   | rtp2httpd     | msd_lite       | udpxy    | tvgate   |
| -------- | ------------- | -------------- | -------- | -------- |
| CPU Avg  | 🏆 **14.00%** | 14.20%         | 85.00%   | 51.45%   |
| CPU Peak | 18.00%        | 🏆 **15.00%**  | 108.00%  | 52.90%   |
| Memory Avg | 4.88 MB       | 🏆 **2.62 MB** | 12.53 MB | 33.25 MB |

### Test 3: High-bandwidth (1 client, ~400 Mbps)

Single client receives a high-bandwidth stream (50x playback ≈ 400 Mbps).

| Metric   | rtp2httpd     | msd_lite       | udpxy   | tvgate   |
| -------- | ------------- | -------------- | ------- | -------- |
| CPU Avg  | 🏆 **26.73%** | 39.50%         | 30.85%  | 89.53%   |
| CPU Peak | 🏆 **29.40%** | 40.00%         | 46.00%  | 96.00%   |
| Memory Avg | 3.88 MB       | 🏆 **2.62 MB** | 3.21 MB | 47.38 MB |

## Conclusions

**rtp2httpd** shows excellent overall performance:

- **Best CPU efficiency**: Lowest CPU usage in all three scenarios. In multi-stream, only 66% of msd_lite, 16% of udpxy, and 5% of tvgate.
- **Strong multi-stream handling**: With 8 independent 4K multicast streams, both CPU and memory are the lowest, ideal for multi-channel IPTV gateways.
- **Stable at high bandwidth**: Only ~27% CPU at 400 Mbps, leaving ample headroom.
- **Reasonable memory usage**: ~4 MB with default settings, stable across scenarios and suitable for embedded devices.

Compared to udpxy's fork-per-client model, rtp2httpd uses a more efficient event-driven architecture, offering clear advantages under high concurrency. Compared to msd_lite, rtp2httpd is more CPU-efficient, especially in multi-stream scenarios.

## Running the Benchmark

See [tools/README.md](../../tools/README.md) for tools and methodology.

Quick run:

```bash
cd tools
./benchmark.sh
```

Results are saved to `benchmark_results_YYYYMMDD_HHMMSS.txt`.
