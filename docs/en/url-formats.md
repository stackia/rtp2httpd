# URL Formats and Protocol Support

Language: [中文](../url-formats.md) | [English](url-formats.md)

rtp2httpd supports multiple streaming protocols, distinguished by URL prefixes.

Basic format: `http://server:port/path[?param1=value1][&param2=value2][&param3=value3]`

If `r2h-token` (HTTP auth token) is configured, all URLs must include `r2h-token=<your token>`.

> In addition to URL parameters, `r2h-token` can be passed via Cookie or User-Agent. For example `Cookie: r2h-token=xxx` or `User-Agent: R2HTOKEN/xxx`.

## Multicast RTP to HTTP

```url
http://server:port/rtp/multicast:port[?fcc=FCC:port][&fcc-type=protocol][&fec=FEC-port]
```

**Examples**:

```url
http://192.168.1.1:5140/rtp/239.253.64.120:5140
http://192.168.1.1:5140/rtp/239.253.64.120:5140?fcc=10.255.14.152:15970
http://192.168.1.1:5140/rtp/239.253.64.120:5140?fcc=10.255.14.152:8027&fcc-type=huawei
http://192.168.1.1:5140/rtp/239.81.0.195:4056?fec=4055
```

### Parameters

- **Multicast address**: Multicast address provided by the IPTV operator
- **Port**: Multicast port
- **fcc** (optional): FCC server address, format `IP:port`
- **fcc-type** (optional): FCC protocol type
  - `telecom`: Telecom/ZTE/FiberHome (default)
  - `huawei`: Huawei
- **fec** (optional): FEC port to receive redundant packets for recovery

### Use cases

- Convert operator multicast streams to HTTP unicast
- Share IPTV streams across LAN devices
- Millisecond-level channel switching with FCC
- FEC-based packet loss recovery

## RTSP Proxy

```url
http://server:port/rtsp/rtsp-server:port/path[?params]
```

**Examples**:

```url
# Live stream
http://192.168.1.1:5140/rtsp/iptv.example.com:554/channel1

# Catchup (playseek)
http://192.168.1.1:5140/rtsp/iptv.example.com:554/channel1?playseek=20240101120000-20240101130000

# Catchup (tvdr)
http://192.168.1.1:5140/rtsp/iptv.example.com:554/channel1?tvdr=20240101120000GMT-20240101130000GMT

# Custom seek param + offset
http://192.168.1.1:5140/rtsp/iptv.example.com:554/channel1?seek=20240101120000&r2h-seek-name=seek&r2h-seek-offset=3600
```

### Use cases

- Convert IPTV RTSP unicast to HTTP
- Enable RTSP catchup playback

### FAQ: Catchup playback is 8 hours early/late

This is usually a timezone mismatch. Try these options:

- Change the player User-Agent to include `TZ/UTC+8` or `TZ/UTC-8`, e.g. `AptvPlayer/1.3.3 TZ/UTC+8`.
- Add `&r2h-seek-offset=28800` or `&r2h-seek-offset=-28800`

See [RTSP Time Handling and Timezone Conversion](rtsp-time-processing.md) for details.

## HTTP Proxy

```url
http://server:port/http/upstream[:port]/path[?params]
```

**Examples**:

```url
# Proxy HLS (explicit port)
http://192.168.1.1:5140/http/upstream.example.com:8080/live/stream.m3u8

# Proxy HTTP request (default port 80)
http://192.168.1.1:5140/http/api.example.com/video?auth=xxx&quality=hd
```

### Parameters

- **Upstream server**: Target HTTP server
- **Port** (optional): Target port, default 80
- **Path**: Request path including query params

### Use cases

- Proxy upstream HLS/DASH streams with unified auth
- Provide HTTP access for intranet-only services
- Bypass firewall restrictions with rtp2httpd

### Notes

- Only HTTP upstream is supported (no HTTPS)
- You can bind an upstream interface via `upstream-interface-http`
- If the proxied URL is an m3u file, all `http://` URLs inside it will be rewritten to go through rtp2httpd

## M3U Playlist Access

```url
http://server:port/playlist.m3u
```

**Example**:

```url
http://192.168.1.1:5140/playlist.m3u
```

This returns the converted M3U playlist containing channels from the config file and external M3U. URLs are rewritten to the rtp2httpd address/port and channel names replace original IPs, query params, and auth info.

### Use cases

- Import community M3U channel lists with one URL
- Hide source IPs and auth info
- Auto-update channel info

See [M3U Integration](m3u-integration.md).

## Built-in Web Player

```url
http://server:port/player
```

**Example**:

```url
http://192.168.1.1:5140/player
```

Open the built-in web player to watch the configured M3U list.

The player path can be customized with `player-page-path`. Set it to `/` to serve the player at the root.

## Status Page

```url
http://server:port/status
```

**Example**:

```url
http://192.168.1.1:5140/status
```

The web status page provides:

- Live client connection stats
- Per-connection IP, state, bandwidth, transferred data
- System logs
- Remote management (force disconnect, etc.)

The status path can be customized with `status-page-path`. Set it to `/` to serve at the root.

## UDPxy Compatibility Mode

rtp2httpd is fully compatible with UDPxy URLs, making it a drop-in replacement.

### UDPxy format

```url
http://server:port/udp/multicast:port
```

**Example**:

```url
http://192.168.1.1:5140/udp/239.253.64.120:5140
```

UDPxy compatibility is enabled by default. Set `udpxy = no` to disable. When disabled, only services from M3U are available.

## Video Snapshots

Add `snapshot=1` to any stream URL, or send `Accept: image/jpeg` or `X-Request-Snapshot: 1` to fetch a JPEG snapshot.

**Examples**:

```url
# Method 1: URL param
http://192.168.1.1:5140/rtp/239.253.64.120:5140?snapshot=1

# Method 2: HTTP header
curl -H "Accept: image/jpeg" http://192.168.1.1:5140/rtp/239.253.64.120:5140

# Method 3: custom header
curl -H "X-Request-Snapshot: 1" http://192.168.1.1:5140/rtp/239.253.64.120:5140
```

See [Video Snapshot Configuration](video-snapshot.md).

## Related Docs

- [M3U Integration](m3u-integration.md): Playlist configuration
- [FCC Setup](fcc-setup.md): Enable millisecond-level channel switching
- [Video Snapshots](video-snapshot.md): Channel preview snapshots
- [Configuration Reference](configuration.md): Full configuration options
