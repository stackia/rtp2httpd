# Configuration Reference

Language: [中文](../configuration.md) | [English](configuration.md)

rtp2httpd can be configured via command-line options or a configuration file.

## Command-Line Options

```bash
rtp2httpd [options]
```

### Network

- `-l, --listen [address:]port` - Bind listen address and port (default: *:5140)
- `-m, --maxclients <count>` - Maximum concurrent clients (default: 5)
- `-w, --workers <count>` - Worker process count (default: 1)

#### Upstream Interface Settings

- `-i, --upstream-interface <iface>` - Default upstream interface (applies to all traffic types, lowest priority)
- `-f, --upstream-interface-fcc <iface>` - FCC upstream interface (overrides `-i`)
- `-t, --upstream-interface-rtsp <iface>` - RTSP upstream interface (overrides `-i`)
- `-r, --upstream-interface-multicast <iface>` - Multicast upstream interface (overrides `-i`)
- `-y, --upstream-interface-http <iface>` - HTTP proxy upstream interface (overrides `-i`)

**Priority rules**: `upstream-interface-{fcc,rtsp,multicast,http}` > `upstream-interface` > system routing table

### Performance

- `-b, --buffer-pool-max-size <count>` - Max buffer pool size (default: 16384)
  - Each buffer is 1536 bytes; 16384 buffers use about 24MB
  - Increase for higher throughput with many clients
- `-B, --udp-rcvbuf-size <bytes>` - UDP socket receive buffer size (default: 524288 = 512KB)
  - Applies to multicast, FCC, RTSP RTP/RTCP UDP sockets
  - For a 30 Mbps 4K IPTV stream, 512KB provides ~140ms buffering
  - Increase to reduce packet loss for high-bitrate streams
  - Actual size may be limited by `net.core.rmem_max`
- `-Z, --zerocopy-on-send` - Enable zero-copy send for performance (default: off)
  - Requires kernel support for MSG_ZEROCOPY (Linux 4.14+)
  - Improves throughput and reduces CPU on supported systems
  - Not recommended if rtp2httpd is behind a reverse proxy (nginx/caddy/lucky, etc.)

### FCC Fast Channel Change

- `-P, --fcc-listen-port-range <start[-end]>` - FCC UDP listen port range (default: random port)

### Service Control

- `-c, --config <file>` - Config file path (default `/etc/rtp2httpd.conf`)
- `-C, --noconfig` - Do not read the config file

### Logging

- `-v, --verbose` - Verbosity (0=FATAL, 1=ERROR, 2=WARN, 3=INFO, 4=DEBUG)
- `-q, --quiet` - Only show fatal errors

### Security

- `-H, --hostname <hostname>` - Validate HTTP Host header
- `-X, --xff` - Enable X-Forwarded-For parsing
- `-T, --r2h-token <token>` - HTTP auth token (all requests must include the r2h-token query parameter)
- `-s, --status-page-path <path>` - Status page and API base path (default: /status)
- `-p, --player-page-path <path>` - Built-in player page path (default: /player)

### Compatibility

- `-U, --noudpxy` - Disable UDPxy compatibility mode (only services defined in `[services]` or `external-m3u` can be used)

### RTSP NAT Traversal

- `-N, --rtsp-stun-server <host:port>` - STUN server address (default: disabled)
  - If the RTSP server only supports UDP transport and the client is behind NAT, STUN may help (not guaranteed)
  - Format: `host:port` or `host` (default port 3478)
  - Examples: `stun.miwifi.com` or `stun.miwifi.com:3478`

### Other

- `-S, --video-snapshot` - Enable video snapshot feature (default: off)
- `-F, --ffmpeg-path <path>` - FFmpeg executable path (default: ffmpeg)
- `-A, --ffmpeg-args <args>` - Extra FFmpeg args (default: -hwaccel none)
- `-h, --help` - Show help

## Configuration File Format

Config file path: `/etc/rtp2httpd.conf`. Lines starting with `#` or `;` are comments.

```ini
[global]
# Verbosity: 0=FATAL 1=ERROR 2=WARN 3=INFO 4=DEBUG
verbosity = 3

# Max concurrent clients
maxclients = 20

# UDPxy compatibility
udpxy = yes

# Worker process count (default: 1)
workers = 1

# Validate HTTP Host header (default: none)
hostname = somehost.example.com

# When enabled, use X-Forwarded-For as the client address for the status page (default: no)
# Also accept X-Forwarded-Host / X-Forwarded-Proto as the playlist.m3u prefix
# Recommended only when behind a reverse proxy
xff = no

# HTTP auth token (optional, default: none)
# When set, all HTTP requests must include r2h-token query parameter matching this value
# Example:
# http://server:5140/rtp/239.253.64.120:5140?fcc=10.255.14.152:15970&r2h-token=your-secret-token
# http://server:5140/player?r2h-token=your-secret-token
r2h-token = your-secret-token-here

# Status page path (default: /status)
status-page-path = /status

# Player page path (default: /player)
player-page-path = /player

# Upstream interface configuration (optional)
#
# Simple: configure one default interface for all traffic
upstream-interface = eth0
#
# Advanced: dedicated interfaces for each traffic type
# Note: dedicated interfaces have higher priority than the default
# upstream-interface-multicast = eth0  # Multicast (RTP/UDP)
# upstream-interface-fcc = eth1        # FCC
# upstream-interface-rtsp = eth2       # RTSP
# upstream-interface-http = eth3       # HTTP proxy
#
# Mixed example: default eth0, FCC uses faster eth1
# upstream-interface = eth0
# upstream-interface-fcc = eth1
#
# Priority: upstream-interface-{multicast,fcc,rtsp,http} > upstream-interface > system routing table

# External M3U (supports file://, http://, https://)
# Note: HTTP/HTTPS requires curl
external-m3u = https://example.com/iptv.m3u
# Or a local file
external-m3u = file:///path/to/playlist.m3u

# External M3U refresh interval (seconds)
# Default 7200 (2 hours), set to 0 to disable auto-update
external-m3u-update-interval = 7200

# Periodic multicast re-join interval (seconds, default: 0 disabled)
# Set a positive value (e.g., 60) to periodically re-join multicast groups
# Compatibility workaround for:
# - IGMP snooping switches timing out without router IGMP Query
# - Misconfigured devices dropping multicast membership
# Recommended: 30-120 seconds (less than typical 260-second switch timeout)
# Note: disabled by default (0), enable only if multicast streams are interrupted
mcast-rejoin-interval = 0

# FCC media listen port range (optional, format: start-end, default: random)
fcc-listen-port-range = 40000-40100

# Max buffer pool size (default: 16384)
# Each buffer is 1536 bytes; 16384 buffers use about 24MB
# Increase for higher throughput, e.g., 32768 or higher
buffer-pool-max-size = 16384

# UDP socket receive buffer size (default: 524288 = 512KB)
# Applies to multicast, FCC, RTSP RTP/RTCP UDP sockets
# For a 30 Mbps 4K IPTV stream, 512KB provides ~140ms buffering
# Increase to reduce packet loss on high-bitrate streams
# Actual size may be limited by net.core.rmem_max
udp-rcvbuf-size = 524288

# Enable zero-copy send (default: no)
# Set yes/true/on/1 to enable
# Requires MSG_ZEROCOPY (Linux 4.14+)
# Improves throughput and reduces CPU, especially under high concurrency
# Not recommended if rtp2httpd is behind a reverse proxy (nginx/caddy/lucky, etc.)
zerocopy-on-send = no

# STUN server for RTSP NAT traversal (default: disabled)
# If the RTSP server only supports UDP and the client is behind NAT, STUN may help (not guaranteed)
# Format: host:port or host (default port 3478)
rtsp-stun-server = stun.miwifi.com

# Enable video snapshots (default: no)
# When enabled, use the `snapshot=1` query parameter to fetch real-time snapshots
video-snapshot = no

# FFmpeg executable path (default: ffmpeg, via system PATH)
# Set a full path if ffmpeg is not in PATH or you need a specific version
ffmpeg-path = /usr/bin/ffmpeg

# Extra FFmpeg args (default: -hwaccel none)
# These args are passed to ffmpeg when generating snapshots
# Common: -hwaccel none, -hwaccel auto, -hwaccel vaapi, -hwaccel qsv
ffmpeg-args = -hwaccel none

[bind]
# Listen on 5140 for all addresses
* 5140

# Listen on 8081 for a specific IP
192.168.1.1 8081

# Multiple listen addresses supported

# [services] can embed an M3U playlist starting with #EXTM3U
# Similar to external-m3u, but M3U is in the config file
[services]
#EXTM3U x-tvg-url="https://example.com/epg.xml.gz"
#EXTINF:-1 tvg-id="CCTV1" tvg-name="CCTV1" tvg-logo="https://example.com/logo/CCTV1.png" group-title="CCTV" catchup="default" catchup-source="rtsp://10.0.0.50:554/catchup?playseek={utc:YmdHMS}-{utcend:YmdHMS}",CCTV-1
rtp://239.253.64.120:5140
#EXTINF:-1 tvg-id="CCTV2" tvg-name="CCTV2" group-title="CCTV",CCTV-2
rtp://239.253.64.121:5140
```

## Configuration Priority

1. Command-line options (highest)
2. Config file
3. Built-in defaults (lowest)

## Public Access Recommendations

If you expose the service to the public internet, it is recommended to change `hostname` / `r2h-token` / `status-page-path` / `player-page-path` to improve security.

```ini
[global]
hostname = iptv.example.com
r2h-token = my-secret-token-12345
status-page-path = /my-status-page
player-page-path = /my-player
```

If possible, use a reverse proxy such as nginx / lucky / caddy and enable `xff`.

```ini
[global]
xff = yes
```

Ensure the reverse proxy forwards `X-Forwarded-For` / `X-Forwarded-Host` / `X-Forwarded-Proto`. For lucky, enable the "Wan Shi Da Ji" option. For nginx, here is an example:

```nginx
server {
    listen 80;
    server_name iptv.example.com;

    location / {
        proxy_pass http://127.0.0.1:5140;
        proxy_http_version 1.1;

        # Forward client IP and scheme headers
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Streaming optimizations
        proxy_buffering off;
    }
}
```

## Performance Tuning

Consider tuning kernel parameters. Enabling [BBR](https://blog.clash-plus.com/post/openwrt-bbr/) can improve stability and reduce startup latency on public networks.

## Related Docs

- [Quick Start](quick-start.md): Basic configuration guide
- [M3U Integration](m3u-integration.md): M3U configuration details
- [FCC Setup](fcc-setup.md): FCC-related configuration
- [Video Snapshots](video-snapshot.md): Video snapshot configuration
