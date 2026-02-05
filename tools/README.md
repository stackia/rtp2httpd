# rtp2httpd-tools

Multicast UDP replay tool for testing rtp2httpd.

## Features

- Replay UDP multicast packets from pcapng capture files
- IGMP-aware: starts sending when a process joins the multicast group, stops when all leave
- **Subnet monitoring**: monitors entire /24 subnets based on multicast addresses in the pcapng file
- **Dynamic target detection**: automatically sends packets to any joined address within monitored subnets
- **Multi-target support**: simultaneously sends to multiple joined multicast addresses
- Simulate network impairments: packet loss and reordering
- Preserves original packet timing from capture
- Adjustable playback speed for stress testing
- Continuous replay mode with incrementing RTP sequence numbers

## Requirements

- Python 3.12+
- Linux (uses `/proc/net/igmp` for IGMP monitoring)

## Installation

```bash
cd tools
uv sync
source .venv/bin/activate
```

## Usage

```bash
python main.py <pcapng_file> [options]
```

### Options

| Option                  | Description                                                       |
| ----------------------- | ----------------------------------------------------------------- |
| `-i, --interface IFACE` | Network interface for multicast (e.g., eth0)                      |
| `-v, --verbose`         | Show verbose output                                               |
| `--loss PERCENT`        | Simulate packet loss (0-100%, default: 0)                         |
| `--reorder PERCENT`     | Simulate packet reordering (0-100%, default: 0)                   |
| `--speed MULTIPLIER`    | Playback speed multiplier (e.g., 2.0 for 2x, default: 1)          |
| `--continuous`          | Continuous replay without gaps, with incrementing RTP seq numbers |

### Examples

```bash
# Basic usage - replay packets when IGMP join detected
python main.py fixtures/fec_sample.pcapng

# Verbose output
python main.py fixtures/fec_sample.pcapng -v

# Specify network interface
python main.py fixtures/fec_sample.pcapng -i eth0

# Simulate 1% packet loss
python main.py fixtures/fec_sample.pcapng --loss 1.0

# Simulate 5% packet reordering
python main.py fixtures/fec_sample.pcapng --reorder 5.0

# Simulate both loss and reordering
python main.py fixtures/fec_sample.pcapng --loss 0.5 --reorder 2.0 -v

# 2x playback speed
python main.py fixtures/fec_sample.pcapng --speed 2.0 -v

# 10x speed continuous stress test (no gaps between loops)
python main.py fixtures/fec_sample.pcapng --speed 10 --continuous -v

# Continuous replay with packet loss simulation
python main.py fixtures/fec_sample.pcapng --continuous --loss 1.0 -v
```

## Testing with rtp2httpd

1. Start the replay tool:

   ```bash
   cd tools
   python main.py fixtures/fec_sample.pcapng -v
   ```

2. Start rtp2httpd with the test M3U:

   ```bash
   ./rtp2httpd -m tools/fixtures/sample.m3u
   ```

3. Request the stream (triggers IGMP join):

   ```bash
   curl http://localhost:5140/rtp/239.81.0.196:4056 -o /dev/null
   ```

The replay tool will detect the IGMP join and start sending packets. When the curl request ends, it detects the IGMP leave and stops.

### Multiple Clients with Different Addresses

The replay tool monitors entire /24 subnets, so you can request any address in the same subnet:

```bash
# Terminal 1: Request 239.81.0.1
curl http://localhost:5140/rtp/239.81.0.1:4056 -o /dev/null

# Terminal 2: Request 239.81.0.2
curl http://localhost:5140/rtp/239.81.0.2:4056 -o /dev/null

# Terminal 3: Request 239.81.0.3
curl http://localhost:5140/rtp/239.81.0.3:4056 -o /dev/null
```

The replay tool will simultaneously send packets to all joined addresses.

## How It Works

1. **Load**: Reads pcapng file and extracts UDP packets with timestamps
2. **Subnet Detection**: Calculates /24 subnets from multicast addresses found in the pcapng file
3. **Monitor**: Polls `/proc/net/igmp` every 50ms to detect multicast group membership within monitored subnets
4. **Dynamic Targeting**: When any address in the monitored subnets is joined, replays packets to that address
5. **Multi-Target**: Supports simultaneous multicast to multiple joined addresses
6. **Replay**: Replays packets with original timing (adjusted by speed multiplier)
7. **Loop**: After completing one replay cycle, waits 3 seconds before next loop
8. **Stop**: When all groups are left, pauses until next join

## Network Impairment Simulation

### Packet Loss (`--loss`)

Randomly drops packets at the specified rate. Useful for testing:

- Stream resilience
- FEC (Forward Error Correction) effectiveness
- Client buffering behavior

### Packet Reordering (`--reorder`)

Randomly delays packets by 1-10ms, causing them to arrive out of order. Useful for testing:

- RTP reorder buffer functionality
- Jitter buffer behavior

### Speed Control (`--speed`)

Adjusts playback speed relative to original timing. Examples:

- `--speed 2.0` - 2x faster (half the delay between packets)
- `--speed 0.5` - Half speed (double the delay)
- `--speed 10` - 10x faster for stress testing

### Continuous Mode (`--continuous`)

Enables seamless looping without the 3-second gap between replay cycles:

- RTP sequence numbers are patched to increment continuously across loops
- No pause between loop iterations
- Ideal for stress testing and sustained high-throughput scenarios
- Combine with `--speed` for maximum throughput: `--speed 100 --continuous`

## Stress Test

The `stress_test.py` script runs automated performance tests on streaming servers (rtp2httpd, msd_lite, udpxy).

### What It Does

1. Starts multicast packet replay (`main.py --continuous --speed N`)
2. Launches the streaming server
3. Spawns multiple concurrent curl clients, each requesting a unique multicast address (by default)
4. Monitors CPU and memory usage (including forked child processes)
5. Reports statistics after the test

### Usage

```bash
# Test rtp2httpd (default)
python stress_test.py

# Test msd_lite
python stress_test.py --program msd_lite

# Test udpxy
python stress_test.py --program udpxy

# Test tvgate
python stress_test.py --program tvgate

# Custom parameters
python stress_test.py --duration 30 --clients 16 --speed 10

# Verbose output (show subprocess output)
python stress_test.py -v
```

### Options

| Option           | Default     | Description                                                  |
| ---------------- | ----------- | ------------------------------------------------------------ |
| `--program`      | `rtp2httpd` | Program to test: rtp2httpd, msd_lite, udpxy, tvgate          |
| `--duration`     | `10`        | Test duration in seconds                                     |
| `--clients`      | `8`         | Number of concurrent curl clients                            |
| `--speed`        | `5.0`       | Replay speed multiplier (5x ≈ 40 Mbps)                       |
| `--same-address` | -           | All clients use the same multicast address (default: unique) |
| `-v, --verbose`  | -           | Show verbose output from subprocesses                        |

### Example Output

```
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

[replay (main.py)]
  CPU:  avg=100.67%  max=102.00%
  PSS:  avg= 69.47MB max= 69.47MB
  USS:  avg= 69.47MB max= 69.47MB

[curl clients x4 (aggregated)]
  CPU:  avg=  0.00%  max=  0.00%
  PSS:  avg= 38.62MB max= 38.62MB
  USS:  avg= 38.62MB max= 38.62MB

------------------------------------------------------------
SUMMARY (rtp2httpd)
------------------------------------------------------------
  Test duration:  10s
  Clients:        4
  Replay speed:   5.0x (~40 Mbps)
  CPU average:    2.00%
  CPU peak:       2.00%
  PSS average:    3.62 MB (proportional)
  PSS peak:       3.62 MB
  USS average:    3.62 MB (private only)
  USS peak:       3.62 MB
============================================================
```

### Unique Multicast Addresses

By default, each curl client requests a unique multicast address in the same /24 subnet:

- Client 1: `239.81.0.1:4056`
- Client 2: `239.81.0.2:4056`
- Client 3: `239.81.0.3:4056`
- ...and so on

This tests the server's ability to handle multiple independent streams. Use `--same-address` to have all clients request the same address (traditional single-stream stress test).

### CPU Measurement

- Uses `top -b -n 2` for accurate CPU sampling (first sample is cumulative, second is actual usage)
- Aggregates CPU usage across parent process and all forked child processes
- More accurate than `/proc/[pid]/stat` for programs using io_uring

### Memory Measurement

Reports two memory metrics for accurate measurement with fork'd processes:

- **PSS (Proportional Set Size)**: Shared memory divided proportionally among all sharing processes. Best for capacity planning.
- **USS (Unique Set Size)**: Private memory only (Private_Clean + Private_Dirty). Represents memory freed when process exits.

Both metrics are read from `/proc/[pid]/smaps_rollup` (Linux 4.14+) and aggregated across all child processes.

## Fixtures

- `fixtures/fec_sample.pcapng` - Sample capture with RTP and FEC packets
- `fixtures/sample.m3u` - M3U playlist for rtp2httpd

## Notes

- The tool uses `IP_MULTICAST_LOOP=1` to allow local testing (sender and receiver on same machine)
- Each replay loop is followed by a 3-second pause to allow rtp2httpd to reset its reorder state (unless `--continuous` is used)
- Supports PPPoE and other encapsulations (handled by scapy)
