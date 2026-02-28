# Configuration Parameters

rtp2httpd supports configuration via both command-line arguments and configuration files.

> [!TIP]
>
> 1. Command-line arguments have the highest priority
> 2. Configuration file parameters come next
> 3. Built-in default values have the lowest priority

## Command-Line Arguments

```bash
rtp2httpd [options]
```

### Network Configuration

- `-l, --listen [address:]port` - Bind address and port (default: \*:5140)
- `-m, --maxclients <number>` - Maximum concurrent clients (default: 5)
- `-w, --workers <number>` - Number of worker processes (default: 1)

#### Upstream Network Interface Configuration

- `-i, --upstream-interface <interface>` - Default upstream interface (applies to all traffic types, lowest priority)
- `-f, --upstream-interface-fcc <interface>` - FCC upstream interface (overrides `-i`)
- `-t, --upstream-interface-rtsp <interface>` - RTSP upstream interface (overrides `-i`)
- `-r, --upstream-interface-multicast <interface>` - Multicast upstream interface (overrides `-i`)
- `-y, --upstream-interface-http <interface>` - HTTP proxy upstream interface (overrides `-i`)

**Priority order**: `upstream-interface-{fcc,rtsp,multicast,http}` > `upstream-interface` > system routing table

### Performance Optimization

- `-b, --buffer-pool-max-size <number>` - Maximum number of buffers in buffer pool (default: 16384)
  - Each buffer is 1536 bytes, 16384 buffers use approximately 24MB memory
  - Increase this value to improve throughput with multiple concurrent clients
- `-B, --udp-rcvbuf-size <bytes>` - UDP socket receive buffer size (default: 524288 = 512KB)
  - Applies to all UDP sockets for multicast, FCC, and RTSP RTP/RTCP
  - For 30 Mbps 4K IPTV streams, 512KB provides approximately 140ms of buffering
  - Increase this value to reduce packet loss for high-bandwidth streams
  - Actual buffer size may be limited by kernel parameter `net.core.rmem_max`
- `-Z, --zerocopy-on-send` - Enable zero-copy send to improve performance (default: disabled)
  - Requires kernel support for MSG_ZEROCOPY (Linux 4.14+)
  - Improves throughput and reduces CPU usage on supported devices
  - Not recommended if rtp2httpd is behind a reverse proxy (nginx/caddy/lucky, etc.)

### FCC (Fast Channel Change)

- `-P, --fcc-listen-port-range <start[-end]>` - FCC UDP listening port range (default: random ports)

### Service Control

- `-c, --config <file>` - Specify configuration file path (default: `/etc/rtp2httpd.conf`)
- `-C, --noconfig` - Do not read any configuration file (avoid reading the default `/etc/rtp2httpd.conf`)

### Logging Control

- `-v, --verbose` - Logging verbosity (0=FATAL, 1=ERROR, 2=WARN, 3=INFO, 4=DEBUG)
- `-q, --quiet` - Show only fatal errors

### Security Control

- `-H, --hostname <hostname>` - Check HTTP Host header hostname
- `-X, --xff` - Enable X-Forwarded-For parsing
- `-T, --r2h-token <token>` - HTTP request authentication token (all requests must include r2h-token query parameter)
- `-O, --cors-allow-origin <value>` - Set CORS Access-Control-Allow-Origin header (default: disabled)
  - Set to `*` to allow all origins, or specify a domain (e.g., `https://example.com`)
- `-s, --status-page-path <path>` - Status page and API root path (default: /status)
- `-p, --player-page-path <path>` - Built-in player page path (default: /player)

### Compatibility

- `-U, --noudpxy` - Disable UDPxy compatibility mode (when disabled, only services defined in `[services]` or `external-m3u` can be used)

### RTSP NAT Traversal

- `-N, --rtsp-stun-server <host:port>` - STUN server address (default: disabled)
  - When an RTSP server only supports UDP transport and the client is behind NAT, STUN can be used to attempt NAT traversal (not guaranteed to succeed)
  - Format: `host:port` or `host` (default port: 3478)
  - Example: `stun.miwifi.com` or `stun.miwifi.com:3478`

### Other Options

- `-S, --video-snapshot` - Enable video snapshot feature (default: disabled)
- `-F, --ffmpeg-path <path>` - Path to FFmpeg executable (default: ffmpeg)
- `-A, --ffmpeg-args <args>` - Additional FFmpeg arguments (default: -hwaccel none)
- `-h, --help` - Show help information

## Configuration File Format

Configuration file path: `/etc/rtp2httpd.conf`. Lines starting with `#` or `;` are treated as comments.

```ini
[global]
# Logging verbosity: 0=FATAL 1=ERROR 2=WARN 3=INFO 4=DEBUG
verbosity = 3

# Maximum concurrent clients
maxclients = 20

# UDPxy compatibility
udpxy = yes

# Number of worker processes (default: 1)
workers = 1

# Check HTTP Host header (default: none)
hostname = somehost.example.com

# When enabled, use HTTP X-Forwarded-For header as client address for display on the status page (default: no)
# Also accept X-Forwarded-Host / X-Forwarded-Proto headers as address prefix in playlist.m3u
# Recommended to enable only when using a reverse proxy
xff = no

# HTTP request authentication token (optional, default: none)
# When set, all HTTP requests must include the r2h-token query parameter matching this value
# Example:
# http://server:5140/rtp/239.253.64.120:5140?fcc=10.255.14.152:15970&r2h-token=your-secret-token
# http://server:5140/player?r2h-token=your-secret-token
r2h-token = your-secret-token-here

# Status page path (default: /status)
status-page-path = /status

# Player page path (default: /player)
player-page-path = /player

# Upstream network interface configuration (optional)
#
# Simple configuration: Configure only one default interface for all traffic types
upstream-interface = eth0
#
# Advanced configuration: Configure dedicated interfaces for different traffic types
# Note: Dedicated interface configuration has higher priority than default interface
# upstream-interface-multicast = eth0  # Multicast traffic (RTP/UDP)
# upstream-interface-fcc = eth1        # FCC
# upstream-interface-rtsp = eth2       # RTSP
# upstream-interface-http = eth3       # HTTP proxy
#
# Hybrid configuration example: Use eth0 by default, but use faster eth1 for FCC
# upstream-interface = eth0
# upstream-interface-fcc = eth1
#
# Priority: upstream-interface-{multicast,fcc,rtsp,http} > upstream-interface > system routing table

# External M3U configuration (supports file://, http://, https://)
# Note: HTTP/HTTPS requires curl, uclient-fetch, or wget command installed
external-m3u = https://example.com/iptv.m3u
# Or use a local file
external-m3u = file:///path/to/playlist.m3u

# External M3U update interval (seconds)
# Default: 7200 (2 hours), set to 0 to disable automatic updates
external-m3u-update-interval = 7200

# Multicast periodic rejoin interval (seconds, default: 0 disabled)
# Set to a positive value (e.g., 60) to periodically rejoin multicast groups
# This is a compatibility workaround for the following network environments:
# - Switches with IGMP snooping enabled timeout without router IGMP queries
# - Misconfigured network devices that drop multicast memberships
# Recommended value: 30-120 seconds (less than typical switch timeout of 260 seconds)
# Note: Disabled by default (0), only enable when experiencing multicast stream interruptions
mcast-rejoin-interval = 0

# FCC media stream listening port range (optional, format: start-end, default: random ports)
fcc-listen-port-range = 40000-40100

# Maximum number of buffers in buffer pool (default: 16384)
# Each buffer is 1536 bytes, 16384 buffers use approximately 24MB memory
# Increase this value to improve throughput with multiple concurrent clients, e.g., 32768 or higher
buffer-pool-max-size = 16384

# UDP socket receive buffer size (default: 524288 = 512KB)
# Applies to all UDP sockets for multicast, FCC, and RTSP RTP/RTCP
# For 30 Mbps 4K IPTV streams, 512KB provides approximately 140ms of buffering
# Increase this value to reduce packet loss for high-bandwidth streams
# Actual buffer size may be limited by kernel parameter net.core.rmem_max
udp-rcvbuf-size = 524288

# Enable zero-copy send to improve performance (default: no)
# Set to yes/true/on/1 to enable zero-copy
# Requires kernel support for MSG_ZEROCOPY (Linux 4.14+)
# Can improve throughput and reduce CPU usage on supported devices, especially under high concurrent loads
# Not recommended if rtp2httpd is behind a reverse proxy (nginx/caddy/lucky, etc.)
zerocopy-on-send = no

# STUN server for RTSP NAT traversal (default: disabled)
# When an RTSP server only supports UDP transport and the client is behind NAT, STUN can be used to attempt NAT traversal (not guaranteed to succeed)
# Format: host:port or host (default port: 3478)
rtsp-stun-server = stun.miwifi.com

# CORS cross-origin request configuration (default: disabled)
# When set, CORS is enabled
# Set to * to allow all origins, or specify a specific domain
;cors-allow-origin = *

# Enable video snapshot feature (default: no)
# When enabled, you can get real-time snapshots of video streams via the `snapshot=1` query parameter
video-snapshot = no

# Path to FFmpeg executable (default: ffmpeg, uses system PATH)
# If ffmpeg is not in PATH or you want to use a specific version, specify the full path
ffmpeg-path = /usr/bin/ffmpeg

# Additional FFmpeg arguments (default: -hwaccel none)
# These arguments are passed to ffmpeg when generating snapshots
# Common options: -hwaccel none, -hwaccel auto, -hwaccel vaapi, -hwaccel qsv
ffmpeg-args = -hwaccel none

[bind]
# Listen on all addresses, port 5140
* 5140

# Listen on specific IP, port 8081
192.168.1.1 8081

# Multiple listen addresses are supported

# The [services] section can contain M3U playlists starting with #EXTM3U
# Similar to external-m3u functionality, but the M3U content is written directly in the config file
[services]
#EXTM3U x-tvg-url="https://example.com/epg.xml.gz"
#EXTINF:-1 tvg-id="CCTV1" tvg-name="CCTV1" tvg-logo="https://example.com/logo/CCTV1.png" group-title="央视" catchup="default" catchup-source="rtsp://10.0.0.50:554/catchup?playseek={utc:YmdHMS}-{utcend:YmdHMS}",CCTV-1
rtp://239.253.64.120:5140
#EXTINF:-1 tvg-id="CCTV2" tvg-name="CCTV2" group-title="央视",CCTV-2
rtp://239.253.64.121:5140
```
