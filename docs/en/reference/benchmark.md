# Performance Benchmark Report

Performance comparison of **rtp2httpd**, **[msd_lite](https://github.com/rozhuk-im/msd_lite)**, **[udpxy](https://github.com/pcherenkov/udpxy)**, and **[tvgate](https://github.com/qist/tvgate)** — four multicast-to-unicast conversion programs.

## Test Environment

- **Platform**: Ubuntu 24.04 on Apple M3 Max (Parallels Desktop virtual machine)
- **Architecture**: aarch64 (all programs compiled natively as arm64 binaries)
- **Kernel**: Linux 6.8.0-90-generic
- **Test duration**: 10 seconds per test
- **Measurement methodology**:
  - CPU: Sampled using `top -b -n 2`
  - Memory: USS (Unique Set Size) read from `/proc/[pid]/smaps_rollup`
  - For processes with forked children, CPU and memory are summed across all parent and child processes
- **Tested versions**:
  - rtp2httpd: v3.8.3
  - msd_lite: commit 79a6c62 (2025-05-02)
  - udpxy: commit 56fc563 (2026-01-26)
  - tvgate: v2.1.8

## Test Scenarios

| Test                  | Description                                                                               |
| --------------------- | ----------------------------------------------------------------------------------------- |
| **Multi-stream test** | 8 clients, each requesting different multicast addresses, ~40 Mbps per stream (simulating 4K IPTV bitrate) |
| **Single-stream test** | 8 clients, all requesting the same multicast address, ~40 Mbps per stream                |
| **High-bandwidth test** | 1 client, single stream ~400 Mbps                                                        |

## Test Results Summary

### CPU Usage (%)

| Test Scenario              | rtp2httpd     | msd_lite | udpxy   | tvgate  |
| -------------------------- | ------------- | -------- | ------- | ------- |
| Multi-stream (8 different addresses) | 🏆 **17.00%** | 25.80%   | 106.00% | 331.00% |
| Single-stream (8 same address)       | 🏆 **14.00%** | 14.20%   | 85.00%  | 51.45%  |
| High-bandwidth (400 Mbps)            | 🏆 **26.73%** | 39.50%   | 30.85%  | 89.53%  |

### Memory Usage (MB)

| Test Scenario              | rtp2httpd   | msd_lite    | udpxy | tvgate |
| -------------------------- | ----------- | ----------- | ----- | ------ |
| Multi-stream (8 different addresses) | 🏆 **4.50** | 10.25       | 12.53 | 182.00 |
| Single-stream (8 same address)       | 4.88        | 🏆 **2.62** | 12.53 | 33.25  |
| High-bandwidth (400 Mbps)            | 3.88        | 🏆 **2.62** | 3.21  | 47.38  |

## Detailed Test Results

### Test 1: Multi-stream Scenario (8 clients, different addresses, ~40 Mbps each)

Each client requests a different multicast address (239.81.0.1-8), testing the server's ability to handle multiple independent streams.

| Metric   | rtp2httpd      | msd_lite | udpxy    | tvgate    |
| -------- | -------------- | -------- | -------- | --------- |
| CPU Avg  | 🏆 **17.00%**  | 25.80%   | 106.00%  | 331.00%   |
| CPU Peak | 🏆 **18.00%**  | 30.00%   | 116.00%  | 332.00%   |
| Mem Avg  | 🏆 **4.50 MB** | 10.25 MB | 12.53 MB | 182.00 MB |

### Test 2: Single-stream Scenario (8 clients, same address, ~40 Mbps)

All 8 clients request the same multicast address, testing the server's multicast reuse efficiency.

| Metric   | rtp2httpd     | msd_lite       | udpxy    | tvgate   |
| -------- | ------------- | -------------- | -------- | -------- |
| CPU Avg  | 🏆 **14.00%** | 14.20%         | 85.00%   | 51.45%   |
| CPU Peak | 18.00%        | 🏆 **15.00%**  | 108.00%  | 52.90%   |
| Mem Avg  | 4.88 MB       | 🏆 **2.62 MB** | 12.53 MB | 33.25 MB |

### Test 3: High-bandwidth Scenario (1 client, ~400 Mbps)

Single client receiving a high-bandwidth stream (50x speed playback ≈ 400 Mbps).

| Metric   | rtp2httpd     | msd_lite       | udpxy   | tvgate   |
| -------- | ------------- | -------------- | ------- | -------- |
| CPU Avg  | 🏆 **26.73%** | 39.50%         | 30.85%  | 89.53%   |
| CPU Peak | 🏆 **29.40%** | 40.00%         | 46.00%  | 96.00%   |
| Mem Avg  | 3.88 MB       | 🏆 **2.62 MB** | 3.21 MB | 47.38 MB |

## Conclusions

**rtp2httpd** demonstrates excellent overall performance in the benchmark tests:

- **Highest CPU efficiency**: Achieved the lowest CPU usage across all three test scenarios. In the multi-stream scenario, it used only 66% of msd_lite's CPU, 16% of udpxy's, and 5% of tvgate's
- **Outstanding multi-stream processing capability**: When simultaneously handling 8 independent 4K multicast streams, both CPU and memory usage were the lowest, making it ideal for multi-channel IPTV gateway scenarios
- **Stable high-bandwidth performance**: At 400 Mbps high bitrate, CPU usage was only 27%, leaving ample performance headroom
- **Reasonable memory footprint**: Approximately 4 MB memory usage (with all default parameters), stable across all scenarios, suitable for resource-constrained embedded devices

Compared to udpxy's fork-per-client model, rtp2httpd uses a more efficient event-driven architecture, showing significant advantages in high-concurrency scenarios. Compared to msd_lite, rtp2httpd excels in CPU efficiency, especially in multi-stream concurrent scenarios.

## Running the Benchmark

See [tools/README.md](https://github.com/stackia/rtp2httpd/blob/main/tools/README.md) for testing tools and methodology.

Quick run:

```bash
cd tools
./benchmark.sh
```

Test results are saved to `benchmark_results_YYYYMMDD_HHMMSS.txt`.
