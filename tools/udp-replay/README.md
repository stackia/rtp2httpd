# UDP replay

Multicast UDP replay tool for testing rtp2httpd.

## Features

- Replay UDP multicast packets from pcapng capture files
- IGMP-aware on Linux: starts sending when a process joins the multicast group, stops when all leave
- Direct replay mode on macOS and other systems without `/proc/net/igmp`
- Subnet monitoring: monitors entire /24 subnets based on multicast addresses in the pcapng file
- Dynamic target detection: automatically sends packets to any joined address within monitored subnets
- Multi-target support: simultaneously sends to multiple joined multicast addresses
- Simulate network impairments: packet loss and reordering
- Preserves original packet timing from capture
- Adjustable playback speed for stress testing
- Continuous replay mode with incrementing RTP sequence numbers

## Requirements

- Python 3.14+
- [uv](https://docs.astral.sh/uv/)
- Linux or macOS
- Linux is required for IGMP-aware monitoring via `/proc/net/igmp`; macOS uses direct replay

## Usage

```bash
uv run python tools/udp-replay/udp_replay.py <pcapng_file> [options]
```

## Options

| Option                  | Description                                                       |
| ----------------------- | ----------------------------------------------------------------- |
| `-i, --interface IFACE` | Linux-only multicast interface override; omit for OS default route |
| `--direct`              | Replay immediately to captured multicast destinations             |
| `-v, --verbose`         | Show verbose output                                               |
| `--loss PERCENT`        | Simulate packet loss (0-100%, default: 0)                         |
| `--reorder PERCENT`     | Simulate packet reordering (0-100%, default: 0)                   |
| `--speed MULTIPLIER`    | Playback speed multiplier, for example `2.0` for 2x (default: 1)  |
| `--continuous`          | Continuous replay without gaps, with incrementing RTP seq numbers |

## Examples

```bash
# Basic usage - replay packets when IGMP join is detected
uv run python tools/udp-replay/udp_replay.py tools/fixtures/fec_sample.pcapng

# Verbose output
uv run python tools/udp-replay/udp_replay.py tools/fixtures/fec_sample.pcapng -v

# Specify network interface
uv run python tools/udp-replay/udp_replay.py tools/fixtures/fec_sample.pcapng -i eth0

# Direct replay over the OS default multicast route (default on macOS)
uv run python tools/udp-replay/udp_replay.py tools/fixtures/fec_sample.pcapng --direct

# Simulate 1% packet loss
uv run python tools/udp-replay/udp_replay.py tools/fixtures/fec_sample.pcapng --loss 1.0

# Simulate 5% packet reordering
uv run python tools/udp-replay/udp_replay.py tools/fixtures/fec_sample.pcapng --reorder 5.0

# Simulate both loss and reordering
uv run python tools/udp-replay/udp_replay.py tools/fixtures/fec_sample.pcapng --loss 0.5 --reorder 2.0 -v

# 2x playback speed
uv run python tools/udp-replay/udp_replay.py tools/fixtures/fec_sample.pcapng --speed 2.0 -v

# 10x speed continuous stress test, with no gaps between loops
uv run python tools/udp-replay/udp_replay.py tools/fixtures/fec_sample.pcapng --speed 10 --continuous -v

# Continuous replay with packet loss simulation
uv run python tools/udp-replay/udp_replay.py tools/fixtures/fec_sample.pcapng --continuous --loss 1.0 -v
```

## Testing with rtp2httpd

1. Start the replay tool:

   ```bash
   uv run python tools/udp-replay/udp_replay.py tools/fixtures/fec_sample.pcapng -v
   ```

   On macOS, or when you do not want to wait for IGMP detection:

   ```bash
   uv run python tools/udp-replay/udp_replay.py tools/fixtures/fec_sample.pcapng --direct -v
   ```

2. Start rtp2httpd with the test M3U:

   ```bash
   ./build/rtp2httpd -v 4 -C -M file://tools/fixtures/sample.m3u
   ```

3. Request the stream to trigger an IGMP join:

   ```bash
   curl http://localhost:5140/rtp/239.81.0.195:4056 -o /dev/null
   ```

On Linux in IGMP-aware mode, the replay tool detects the IGMP join and starts
sending packets. When the curl request ends, it detects the IGMP leave and
stops. In direct mode, replay starts immediately and sends via the OS default
multicast route, matching devlab.

## Multiple clients with different addresses

In Linux IGMP-aware mode, the replay tool monitors entire /24 subnets, so you can request any address in the same
subnet:

```bash
# Terminal 1: Request 239.81.0.1
curl http://localhost:5140/rtp/239.81.0.1:4056 -o /dev/null

# Terminal 2: Request 239.81.0.2
curl http://localhost:5140/rtp/239.81.0.2:4056 -o /dev/null

# Terminal 3: Request 239.81.0.3
curl http://localhost:5140/rtp/239.81.0.3:4056 -o /dev/null
```

The replay tool sends packets to all joined addresses at the same time.

## How it works

1. Load: reads the pcapng file and extracts UDP packets with timestamps.
2. Subnet detection: calculates /24 subnets from multicast addresses found in the pcapng file.
3. Monitor: on Linux, polls `/proc/net/igmp` every 50 ms to detect multicast group membership within monitored subnets.
4. Direct mode: on macOS or with `--direct`, skips IGMP monitoring and replays to the captured multicast destinations.
5. Dynamic targeting: when any address in the monitored subnets is joined, replays packets to that address.
6. Multi-target replay: supports simultaneous multicast to multiple joined addresses.
7. Replay: sends packets with original timing, adjusted by the speed multiplier.
8. Loop: after completing one replay cycle, waits 3 seconds before the next loop unless `--continuous` is used.
9. Stop: when all groups are left in IGMP-aware mode, pauses until the next join.

## Network impairment simulation

### Packet loss (`--loss`)

Randomly drops packets at the specified rate. Useful for testing stream resilience, FEC effectiveness, and client buffering behavior.

### Packet reordering (`--reorder`)

Randomly delays packets by 1-10 ms, causing them to arrive out of order. Useful for testing RTP reorder buffer and jitter buffer behavior.

### Speed control (`--speed`)

Adjusts playback speed relative to original timing:

- `--speed 2.0`: 2x faster, with half the delay between packets
- `--speed 0.5`: half speed, with double the delay
- `--speed 10`: 10x faster for stress testing

### Continuous mode (`--continuous`)

Enables seamless looping without the 3-second gap between replay cycles:

- RTP sequence numbers are patched to increment continuously across loops
- No pause between loop iterations
- Ideal for stress testing and sustained high-throughput scenarios
- Combine with `--speed` for maximum throughput, for example `--speed 100 --continuous`

## Fixtures

- `tools/fixtures/fec_sample.pcapng`: sample capture with RTP and FEC packets
- `tools/fixtures/sample.m3u`: M3U playlist for rtp2httpd

## Notes

- By default the sender does not bind a multicast interface; the OS multicast route selects the outbound interface.
- The tool uses `IP_MULTICAST_LOOP=1` to allow local testing with the sender and receiver on the same machine.
- Each replay loop is followed by a 3-second pause to allow rtp2httpd to reset its reorder state unless `--continuous` is used.
- PPPoE and other encapsulations are handled by scapy.
