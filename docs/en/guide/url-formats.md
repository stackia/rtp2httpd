# URL Format

rtp2httpd supports multiple streaming protocols, distinguished by different URL prefixes.

Basic format: `http://server:port/path[?param1=value1][&param2=value2][&param3=value3]`

When `r2h-token` (HTTP request authentication token) is configured, all URLs must include the `r2h-token=<your token>` parameter to be accessible.

> [!TIP]
> In addition to URL parameters, `r2h-token` can also be passed via Cookie or User-Agent. For example, `Cookie: r2h-token=xxx` or `User-Agent: R2HTOKEN/xxx`.

## Multicast RTP to HTTP Unicast Stream

```url
http://server:port/rtp/multicast_address:port[?fcc=FCC_server:port][&fcc-type=protocol_type][&fec=FEC_port]
```

**Examples**:

```url
http://192.168.1.1:5140/rtp/239.253.64.120:5140
http://192.168.1.1:5140/rtp/239.253.64.120:5140?fcc=10.255.14.152:15970
http://192.168.1.1:5140/rtp/239.253.64.120:5140?fcc=10.255.14.152:8027&fcc-type=huawei
http://192.168.1.1:5140/rtp/239.81.0.195:4056?fec=4055
```

### Parameters

- **multicast_address**: Multicast address provided by the IPTV operator
- **port**: Multicast port number
- **fcc** (optional): FCC (Fast Channel Change) server address, format: `IP:port`
- **fcc-type** (optional): FCC protocol type, options:
  - `telecom`: Telecom/ZTE/Fiberhome FCC protocol (default)
  - `huawei`: Huawei FCC protocol
- **fec** (optional): FEC (Forward Error Correction) port number, used to receive FEC redundant packets for packet loss recovery

### Use Cases

- Convert IPTV operator multicast streams to HTTP unicast streams
- Share IPTV streams across multiple devices on LAN
- Enable millisecond-level channel switching with FCC
- Improve playback stability with FEC packet loss recovery

## RTSP to HTTP

```url
http://server:port/rtsp/RTSP_server:port/path[?params]
```

**Examples**:

```url
# Live stream
http://192.168.1.1:5140/rtsp/iptv.example.com:554/channel1

# Time-shifted playback (using playseek parameter)
http://192.168.1.1:5140/rtsp/iptv.example.com:554/channel1?playseek=20240101120000-20240101130000

# Time-shifted playback (using tvdr parameter)
http://192.168.1.1:5140/rtsp/iptv.example.com:554/channel1?tvdr=20240101120000GMT-20240101130000GMT

# Custom time-shift parameter name + time offset
http://192.168.1.1:5140/rtsp/iptv.example.com:554/channel1?seek=20240101120000&r2h-seek-name=seek&r2h-seek-offset=3600
```

### Use Cases

- Convert IPTV RTSP unicast streams to HTTP streams
- Enable RTSP time-shifted playback

> [!IMPORTANT]
> rtp2httpd's RTSP support is designed specifically for single MPEG-TS stream scenarios (i.e., IPTV unicast/time-shifted playback). It does not support surveillance cameras or other RTSP use cases.

### Common Issue: Time-Shifted Playback is 8 Hours Earlier/Later Than EPG

This is caused by timezone mismatch. You need to perform timezone conversion. Try the following methods:

- Modify the player's User-Agent setting by adding `TZ/UTC+8` or `TZ/UTC-8`. For example, `AptvPlayer/1.3.3 TZ/UTC+8`.
- Modify the playback URL by adding the parameter `&r2h-seek-offset=28800` or `&r2h-seek-offset=-28800`

For detailed information on time-shift parameter handling (timezone, offset), see [Time Processing Guide](/en/guide/time-processing).

## HTTP Reverse Proxy

```url
http://server:port/http/upstream_server[:port]/path[?params]
```

**Examples**:

```url
# Proxy HLS stream (with port specified)
http://192.168.1.1:5140/http/upstream.example.com:8080/live/stream.m3u8

# Proxy HTTP request (port omitted, defaults to 80)
http://192.168.1.1:5140/http/api.example.com/video?auth=xxx&quality=hd
```

### Parameters

- **upstream_server**: Target HTTP server address
- **port** (optional): Target server port, defaults to 80
- **path**: Request path, including query parameters

### Use Cases

- Proxy upstream HLS/DASH streams with unified authentication and access control
- Provide HTTP reverse proxy for IPTV intranet services that don't support direct access

### Time-Shifted Playback Support

HTTP proxy also supports the `r2h-seek-name` and `r2h-seek-offset` parameters, as well as User-Agent timezone conversion. The handling is the same as RTSP proxy.

```url
# Auto-detect playseek parameter and perform timezone conversion
http://192.168.1.1:5140/http/iptv.example.com/channel1?playseek=20240101120000-20240101130000

# Use custom parameter name + time offset
http://192.168.1.1:5140/http/iptv.example.com/channel1?catchup=20240101120000&r2h-seek-name=catchup&r2h-seek-offset=3600
```

See [Time Processing Guide](/en/guide/time-processing) for details.

### Notes

- Only supports HTTP upstream (HTTPS is not supported)
- Can be configured to use a specific network interface via `upstream-interface-http`
- If the proxied target URL is an m3u file, all `http://` URLs in it will be automatically rewritten to go through the rtp2httpd proxy (to ensure HLS streams are correctly proxied)

## M3U Playlist Access

```url
http://server:port/playlist.m3u
```

**Example**:

```url
http://192.168.1.1:5140/playlist.m3u8
```

Get the converted M3U playlist, which includes all channels defined through the configuration file and external M3U. URLs are converted to use rtp2httpd's listening address and port, and channel names replace original IPs, query parameters, and authentication information.

### Use Cases

- Import M3U channel lists maintained by others with one click
- Hide channel source IPs and authentication information
- Automatically update channel information

See [M3U Playlist Integration](/en/guide/m3u-integration) for details.

## Built-in Web Player

```url
http://server:port/player
```

**Example**:

```url
http://192.168.1.1:5140/player
```

Access the [built-in web player](/en/guide/web-player) to play configured M3U channel lists in your browser.

The player page path can be customized via the `player-page-path` configuration option. Setting it to `/` enables direct access without any path.

## Status Page

```url
http://server:port/status
```

**Example**:

```url
http://192.168.1.1:5140/status
```

Access the web status page to view:

- Real-time client connection statistics
- IP, status, bandwidth usage, and data transferred for each connection
- System log viewer
- Remote management functions (force disconnect, etc.)

The status page path can be customized via the `status-page-path` configuration option. Setting it to `/` enables direct access without any path.

## udpxy Compatibility Mode

rtp2httpd is fully compatible with udpxy URL format and can seamlessly replace udpxy / msd_lite and other multicast-to-unicast services.

### udpxy Format

```url
http://server:port/udp/multicast_address:port
http://server:port/rtp/multicast_address:port
```

**Examples**:

```url
http://192.168.1.1:5140/udp/239.253.64.120:5140
http://192.168.1.1:5140/rtp/239.253.64.120:5140
```

udpxy compatibility mode is enabled by default. It can be disabled by setting `udpxy = no` in the configuration. When disabled, only M3U-based service is available.

> [!TIP]
> There is no difference between using `/udp/` and `/rtp/`. You can choose either one.

## Video Snapshot

Add the `snapshot=1` parameter to any streaming URL, or add `Accept: image/jpeg` or `X-Request-Snapshot: 1` to the HTTP request headers, to get a JPEG snapshot of the video stream.

**Examples**:

```url
# Method 1: URL parameter
http://192.168.1.1:5140/rtp/239.253.64.120:5140?snapshot=1

# Method 2: HTTP request header
curl -H "Accept: image/jpeg" http://192.168.1.1:5140/rtp/239.253.64.120:5140

# Method 3: Custom request header
curl -H "X-Request-Snapshot: 1" http://192.168.1.1:5140/rtp/239.253.64.120:5140
```

See [Video Snapshot Configuration](/en/guide/video-snapshot) for details.

## Related Documentation

- [M3U Playlist Integration](/en/guide/m3u-integration): Playlist configuration
- [FCC Fast Channel Change Setup](/en/guide/fcc-setup): Enable millisecond-level channel switching
- [Video Snapshot Configuration](/en/guide/video-snapshot): Channel preview image functionality
- [Configuration Reference](/en/reference/configuration): View complete configuration options
