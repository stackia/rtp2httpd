# Multicast benchmark data — 2026-09-06

The Chinese report is [docs/reference/benchmark.md](../../../../docs/reference/benchmark.md); the English translation is [docs/en/reference/benchmark.md](../../../../docs/en/reference/benchmark.md).

- `shared64/`: five repetitions of one 20 Mbps channel with 64 clients, including the pre-optimization baseline. Warmup: 5 seconds; sampling: 20 seconds.
- `additional/`: three repetitions each of eight distinct 40 Mbps channels, eight clients on one 40 Mbps channel, and one 400 Mbps channel. Warmup: 5 seconds; sampling: 10 seconds.
- `build-environment.json`: compiler, build settings, vendor source revisions, and TVGate release archive digest. TVGate was run with `GOMAXPROCS=1`.

Every directory contains the original `trials.jsonl` (including failures), `metadata.json` (including binary and harness SHA-256 values), and `summary.json`. Summary means use **valid samples only**, with valid/total counts. Do not interpret missing values as zero usage, or compare CPU from failed delivery as equivalent work.

The benchmark harness is `tools/stress-test/benchmark.py` at commit `9d0f59aa95449e4d4ccfa362251bae4d2716c211`. Runtime C sources are from `530dc980e92db6b6ea98b6ca223dffe1a0345b5c`. The Web UI was rebuilt before creating the tested binary. Absolute paths in recorded commands refer to isolated build directories on the test VM; use `--binary NAME=PATH` to select equivalent local binaries.

There are 25 main trials and 36 additional trials. The 64-client optimized and baseline rtp2httpd measurements both passed all five trials. All TVGate samples failed sequence continuity; several udpxy samples and some 400 Mbps samples from other programs also recorded kernel UDP drops. The report records these limitations explicitly.

Commands, generated configuration rules, affinity, synthetic payload construction, validation, and exit behavior are documented in [the harness README](../../README.md). The measurements represent server-process CPU on Linux loopback, not total machine CPU, physical-NIC capacity, or a video decoding test.
