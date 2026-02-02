# rtp2httpd-tools

Multicast UDP replay tool for testing rtp2httpd.

## Features

- Replay UDP multicast packets from pcapng capture files
- IGMP-aware: starts sending when a process joins the multicast group, stops when all leave
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
   ./rtp2httpd -m tools/fixtures/fec_sample.m3u
   ```

3. Request the stream (triggers IGMP join):

   ```bash
   curl http://localhost:5140/rtp/239.81.0.196:4056 -o /dev/null
   ```

The replay tool will detect the IGMP join and start sending packets. When the curl request ends, it detects the IGMP leave and stops.

## How It Works

1. **Load**: Reads pcapng file and extracts UDP packets with timestamps
2. **Monitor**: Polls `/proc/net/igmp` every 50ms to detect multicast group membership
3. **Replay**: When a group is joined, replays packets with original timing
4. **Loop**: After completing one replay cycle, waits 3 seconds before next loop
5. **Stop**: When all groups are left, pauses until next join

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

## Fixtures

- `fixtures/fec_sample.pcapng` - Sample capture with RTP and FEC packets
- `fixtures/fec_sample.m3u` - M3U playlist for rtp2httpd

## Notes

- The tool uses `IP_MULTICAST_LOOP=1` to allow local testing (sender and receiver on same machine)
- Each replay loop is followed by a 3-second pause to allow rtp2httpd to reset its reorder state (unless `--continuous` is used)
- Supports PPPoE and other encapsulations (handled by scapy)
