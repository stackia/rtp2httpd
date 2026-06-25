# Configuration Reference

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

- `-l, --listen [address:]port|/path/to/rtp2httpd.sock` - Bind a TCP listen address/port, or listen on a Unix domain socket (default: \*:5140)
- `-m, --maxclients <number>` - Maximum concurrent clients (default: 5)
- `-w, --workers <number>` - Number of worker processes (default: 1)

`--listen` can be specified multiple times to listen on multiple TCP addresses/ports or Unix sockets:

```bash
rtp2httpd --listen 5140 --listen 192.168.1.1:8081 --listen '[::1]:5140' --listen /var/run/rtp2httpd.sock
```

Unix socket listen paths must be absolute and must not contain whitespace. At startup, if the same path already contains a socket file, rtp2httpd first probes whether the socket is still in use: if another process is listening on that path, startup is rejected; only confirmed stale socket files are removed automatically. If the path is a regular file, directory, or symbolic link, startup is rejected to avoid deleting user data. When any Unix socket listener is enabled, `zerocopy-on-send` is disabled globally.

#### Upstream Network Interface Configuration

- `-i, --upstream-interface <interface>` - Default upstream interface (applies to all traffic types, lowest priority)
- `-f, --upstream-interface-fcc <interface>` - FCC upstream interface (overrides `-i`)
- `-t, --upstream-interface-rtsp <interface>` - RTSP upstream interface (overrides `-i`)
- `-r, --upstream-interface-multicast <interface>` - Multicast upstream interface (overrides `-i`)
- `-y, --upstream-interface-http <interface>` - HTTP proxy upstream interface (overrides `-i`)

**Priority order**: `upstream-interface-{fcc,rtsp,multicast,http}` > `upstream-interface` > system routing table

> [!TIP]
> In addition to global configuration, you can specify upstream interfaces per request using the `r2h-ifname` and `r2h-ifname-fcc` URL parameters. See [URL Formats](/en/guide/url-formats) for details.
> [!TIP]
> On FreeBSD, specifying upstream interfaces is not supported except for multicast.

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
- `--access-log <path>` - Write access logs to the specified file (default: disabled)
- `--log-format <format>` - Access log format using nginx-style `$variable` placeholders. See [Access Logging](/en/guide/access-log)

### Security Control

- `-H, --hostname <hostname>` - Check HTTP Host header hostname
- `-X, --xff` - Enable X-Forwarded-For parsing
- `-T, --r2h-token <token>` - HTTP request authentication token (all requests must include r2h-token query parameter)
- `-O, --cors-allow-origin <value>` - Set CORS Access-Control-Allow-Origin header (default: disabled)
  - Set to `*` to allow all origins, or specify a domain (e.g., `https://example.com`)
- `-s, --status-page-path <path>` - Status page and API root path (default: /status)
- `-p, --player-page-path <path>` - Built-in player page path (default: /player)
- `--app-path-prefix <path>` - Public access prefix for all HTTP resources (default: none)
- `--use-relative-path-in-m3u` - Use root-relative URLs when generating playlist.m3u or rewriting M3U through the HTTP proxy (default: disabled)

### Compatibility

- `-U, --noudpxy` - Disable UDPxy compatibility mode (when disabled, only services defined in `[services]` or `external-m3u` can be used)

### HTTP Proxy Options

- `-g, --http-proxy-user-agent <value>` - User-Agent header for upstream HTTP requests (default: forward client User-Agent)
  - Applies to requests proxied to upstream HTTP servers via the `/http/...` path
  - When configured, replaces the client User-Agent that would otherwise be forwarded upstream

### RTSP Options

- `-u, --rtsp-user-agent <value>` - User-Agent header for upstream RTSP requests (default: `rtp2httpd/<version>`)
  - Applies to upstream RTSP requests such as OPTIONS, DESCRIBE, SETUP, PLAY, TEARDOWN, and GET_PARAMETER
  - Some upstream RTSP servers validate or require a specific User-Agent; use this option for compatibility

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

# Access log file path (empty or unset means disabled)
access-log = /var/log/rtp2httpd/access.log

# Access log format (optional, nginx-style $variables)
# Default: $client_addr [$time_iso8601] "$service_url" $service_type "$upstream_url"
log-format = $client_addr [$time_iso8601] "$service_url" $service_type "$upstream_url"

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

# Status page app path (default: /status; mounted under app-path-prefix when configured)
status-page-path = /status

# Player page app path (default: /player; mounted under app-path-prefix when configured)
player-page-path = /player

# Public access prefix for all HTTP resources (default: none)
# After this is set, the status page, player, static assets,
# playlist.m3u, epg.xml, and stream URLs are all served under this
# prefix, for example /app/rtp2httpd/player.
app-path-prefix = /app/rtp2httpd

# Use root-relative paths in M3U output (default: no)
# When enabled, playlist.m3u and M3U rewritten through the HTTP proxy
# omit the http://host prefix and keep only paths starting with / or app-path-prefix,
# for example /app/rtp2httpd/rtp/...
use-relative-path-in-m3u = no

# Upstream network interface configuration (optional)
#
# Simple configuration: Configure only one default interface for all traffic types
upstream-interface = eth0
#
# Advanced configuration: Configure dedicated interfaces for different traffic types
# Note: Dedicated interface configuration has higher priority than default interface.
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
# On FreeBSD, only multicast interface configuration is supported

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
# Note: Does not support IPv6
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

# Override the User-Agent for upstream HTTP proxy requests (default: no override)
# When set, this replaces the client User-Agent sent to upstream servers for /http/ requests
http-proxy-user-agent = rtp2httpd-http-proxy/1.0

# User-Agent for upstream RTSP requests (default: rtp2httpd/<version>)
# Configure this when an upstream RTSP server requires a specific User-Agent for compatibility
rtsp-user-agent = rtp2httpd/custom

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

# Listen on an IPv6 address (brackets optional)
2001:db8::1 5140

# Listen on a Unix domain socket (path must be absolute)
/var/run/rtp2httpd.sock

# Multiple listen addresses are supported

# The [services] section can contain M3U playlists starting with #EXTM3U
# Similar to external-m3u functionality, but the M3U content is written directly in the config file
[services]
#EXTM3U x-tvg-url="https://example.com/epg.xml.gz"
#EXTINF:-1 tvg-id="CCTV1" tvg-name="CCTV1" tvg-logo="https://example.com/logo/CCTV1.png" group-title="CCTV" catchup="default" catchup-source="rtsp://10.0.0.50:554/catchup?playseek={utc:YmdHMS}-{utcend:YmdHMS}",CCTV-1
rtp://239.253.64.120:5140
#EXTINF:-1 tvg-id="CCTV2" tvg-name="CCTV2" group-title="CCTV",CCTV-2
rtp://239.253.64.121:5140
```

For how to enable access logging, configure placeholders, and use logrotate, see [Access Logging](/en/guide/access-log).

## Runtime Configuration Management

rtp2httpd supports configuration hot reload: after editing the configuration file, trigger a reload via signal or the status page to apply changes without restarting the entire process. rtp2httpd uses a supervisor + worker multi-process architecture. Signals must be sent to the **supervisor process** (the main `rtp2httpd` process, not worker child processes).

### Signal Reference

| Signal | Action |
| --- | --- |
| `SIGHUP` | Hot reload configuration: re-read and apply settings from the config file |
| `SIGUSR1` | Restart all worker processes |

**Examples** (replace `12345` with the supervisor process PID):

```bash
# Hot reload configuration
kill -HUP 12345

# Restart all workers
kill -USR1 12345
```

### SIGHUP Hot Reload Behavior

- Re-reads configuration from the config file (default `/etc/rtp2httpd.conf`, or the path specified via `--config`)
- If `[bind]` listen addresses change, the supervisor sends `SIGTERM` to all workers and respawns them to apply the new listen addresses
- If the `workers` count changes, the supervisor automatically adds or removes worker processes
- For other configuration changes, the supervisor forwards `SIGHUP` to each worker, which applies them at runtime
- Workers reopen the [access log](/en/guide/access-log) file during reload, which helps with logrotate
- If the config file fails to parse, the old configuration is kept and existing connections are not interrupted

> [!NOTE]
> When started with `--noconfig`, there is no config file to reload. In that case, `SIGHUP` only triggers M3U/EPG reload.

### SIGUSR1 Worker Restart

Sending `SIGUSR1` to the supervisor terminates all worker processes, which the supervisor then automatically respawns. Use this when you need to refresh worker state without modifying the configuration file. Active client connections will be interrupted.

### Via the Status Page

The [status page](/en/guide/url-formats#status-page) provides equivalent management functions without manually looking up the PID:

- **Reload Config**: equivalent to `SIGHUP` (API: `POST <status-page-path>/api/reload-config`)
- **Restart Workers**: equivalent to `SIGUSR1` (API: `POST <status-page-path>/api/restart-workers`)
