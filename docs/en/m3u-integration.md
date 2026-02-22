# M3U Playlist Integration

Language: [中文](../m3u-integration.md) | [English](m3u-integration.md)

rtp2httpd fully supports M3U/M3U8 playlists. It detects channels and provides a converted playlist so you can import external M3U lists, automatically replace URLs, and use them directly in IPTV players.

## Core Capabilities

- **External M3U integration**: Load M3U from external URLs (`file://`, `http://`, `https://`)
- **Inline M3U config**: Write M3U content directly in the config file
- **Built-in web player**: Open `/player` in a browser
- **Smart URL conversion**: Automatically detect RTP/RTSP and convert to HTTP proxy URLs
- **Catchup support**: Full support for `catchup-source` with automatic catchup services
- **Auto-update**: External M3U can be refreshed on a schedule (default 24 hours)
- **URL preservation**: Unknown URLs (e.g., third-party HTTP streams) are kept as-is

## Configuration

### Method 1: External M3U

Specify an external M3U URL in the config file:

```ini
[global]
# External M3U (file://, http://, https://)
# Note: HTTP/HTTPS requires curl or uclient-fetch or wget
external-m3u = https://example.com/iptv.m3u
# Or a local file
external-m3u = file:///path/to/playlist.m3u

# External M3U refresh interval (seconds)
# Default 7200 (2 hours), set to 0 to disable auto-update
external-m3u-update-interval = 7200
```

### Method 2: Inline M3U in Config

Write M3U content directly under `[services]`:

```ini
[services]
# Inline M3U content, starting with #EXTM3U
#EXTM3U x-tvg-url="https://example.com/epg.xml.gz"

# Basic channel config
#EXTINF:-1 tvg-id="CCTV1" tvg-name="CCTV1" tvg-logo="https://example.com/logo/CCTV1.png" group-title="央视",CCTV-1
rtp://239.253.64.120:5140

# Channel with catchup
#EXTINF:-1 tvg-id="CCTV2" tvg-name="CCTV2" group-title="央视" catchup="default" catchup-source="rtsp://10.0.0.50:554/catchup?playseek={utc:YmdHMS}-{utcend:YmdHMS}",CCTV-2
rtp://239.253.64.121:5140

# Simple config (channel name only)
#EXTINF:-1,广东卫视
rtp://239.194.10.15:1234
```

## Using the Playlist

### Option 1: Built-in Player

After configuring M3U, open the built-in player:

```
http://server:port/player
```

**Example**:

```
http://192.168.1.1:5140/player
```

Built-in player features:

- Automatically loads the configured M3U channel list
- Supports live and catchup playback
- Supports FCC fast start
- Modern responsive UI for mobile and desktop
- Custom player path (via `player-page-path`, see [Configuration Reference](configuration.md))

**Note**: Playback depends on the browser's native decoding. Some codecs (e.g., MP2, E-AC3) may not play in certain browsers. Use recent Chrome, Edge, or Safari.

### Option 2: Use Converted Playlist in Other Players

The converted M3U playlist is available at:

```
http://server:port/playlist.m3u
```

**Example**:

```
http://192.168.1.1:5140/playlist.m3u
```

Add this URL to any M3U-capable IPTV player (e.g., APTV, TiviMate).

## Conversion Example

### Input M3U

```m3u
#EXTM3U x-tvg-url="https://example.com/epg.xml.gz"

#EXTINF:-1 tvg-id="CCTV1" tvg-name="CCTV1" tvg-logo="https://example.com/logo/CCTV1.png" group-title="央视" catchup="default" catchup-source="rtsp://10.0.0.50:554/catchup?auth=loremipsum&playseek={utc:YmdHMS}-{utcend:YmdHMS}",CCTV-1
rtp://239.253.64.120:5140

#EXTINF:-1 tvg-id="CCTV2" tvg-name="CCTV2" group-title="央视",CCTV-2
rtp://239.253.64.121:5140

#EXTINF:-1 tvg-id="Other" tvg-name="其他频道",第三方频道
http://other-cdn.com/live/stream.m3u8
```

### Output M3U (Converted)

```m3u
#EXTM3U x-tvg-url="http://192.168.1.1:5140/epg.xml.gz"

#EXTINF:-1 tvg-id="CCTV1" tvg-name="CCTV1" tvg-logo="https://example.com/logo/CCTV1.png" group-title="央视" catchup="default" catchup-source="http://192.168.1.1:5140/CCTV-1/catchup?playseek={utc:YmdHMS}-{utcend:YmdHMS}",CCTV-1
http://192.168.1.1:5140/央视/CCTV-1

#EXTINF:-1 tvg-id="CCTV2" tvg-name="CCTV2" group-title="央视",CCTV-2
http://192.168.1.1:5140/央视/CCTV-2

#EXTINF:-1 tvg-id="Other" tvg-name="其他频道",第三方频道
http://other-cdn.com/live/stream.m3u8
```

**Notes**:

- The EPG URL is converted to the rtp2httpd proxy
- CCTV-1 and CCTV-2 URLs are converted to rtp2httpd proxies
- CCTV-1 catchup-source is converted and dynamic placeholders are preserved
- Third-party channel URLs are unchanged

## Usage Tips

1. **HTTP/HTTPS support**
   - Requires `curl` or `uclient-fetch` or `wget`
   - rtp2httpd auto-detects available tools

2. **Update strategy**
   - External M3U auto-update defaults to 24 hours
   - Adjust `external-m3u-update-interval` based on source update frequency
   - Set to 0 to disable auto-update (restart service to refresh)

3. **Mixed usage**
   - External and inline M3U can both be configured
   - They are merged into a single converted playlist

4. **Enable `xff` behind a reverse proxy**
   - M3U conversion needs the full access URL. If you use a reverse proxy, enable `xff` and ensure `X-Forwarded-*` headers are passed through. See [Public Access Recommendations](configuration.md#public-access-recommendations).

## URL Detection and Conversion Rules

### Supported URL Formats

rtp2httpd recognizes and converts these URL formats:

1. **Direct protocol URLs**:
   - `rtp://[source@]multicast_addr:port[?query]`
   - `rtsp://server:port/path[?query]`
   - `udp://multicast_addr:port[?query]`

2. **UDPxy-style HTTP URLs**:
   - `http://hostname:port/rtp/multicast_addr:port`
   - `http://hostname:port/rtsp/server:port/path`
   - `hostname:port` is replaced with the actual rtp2httpd address and port

### Conversion Examples

| Original URL                                 | Converted URL                             |
| -------------------------------------------- | ----------------------------------------- |
| `rtp://239.253.64.120:5140`                  | `http://hostname:5140/CCTV-1`             |
| `rtsp://10.0.0.50:554/live`                  | `http://hostname:5140/CCTV-2`             |
| `http://router:5140/rtp/239.1.1.1:1234`      | `http://hostname:5140/频道名`              |
| `http://other-server/stream.m3u8` (3rd-party) | `http://other-server/stream.m3u8` (unchanged) |

**Service name extraction**: Uses the text after the last comma in the `#EXTINF` line.

```
#EXTINF:-1 tvg-id="..." tvg-name="..." group-title="...",CCTV-1
                                                          ^^^^^^
                                                        Service name
```

## Catchup Support

When `catchup-source` is present, rtp2httpd creates corresponding catchup services.

### Example

```m3u
#EXTINF:-1 tvg-id="CCTV1" catchup="default" catchup-source="rtsp://10.0.0.50:554/catchup?playseek={utc:YmdHMS}-{utcend:YmdHMS}",CCTV-1
rtp://239.253.64.120:5140
```

### Result

- **Live service**: `http://hostname:5140/CCTV-1`
- **Catchup service**: `http://hostname:5140/CCTV-1/catchup?playseek={utc:YmdHMS}-{utcend:YmdHMS}`

### Placeholder Handling

- **Dynamic placeholders** (contain `{` or `}`) are preserved in converted URLs for the player to fill
  - Example: `{utc:YmdHMS}`, `{utcend:YmdHMS}`
- **Static parameters**: Other query parameters are not preserved in the converted M3U, but are still used when fetching upstream content

### Unrecognized URL Handling

If `catchup-source` is a third-party HTTP URL (e.g., `http://other-cdn.com/catchup`), it is kept as-is and not converted.

## Line Labels

Append a `$label` suffix to a URL to display a source label (e.g., resolution). The `$label` must be at the very end of the URL.

This is only effective in players that support labels and channel aggregation (such as the built-in web player).

### Example Input

```m3u
#EXTINF:-1 tvg-id="广东卫视" tvg-name="广东卫视" tvg-logo="https://example.com/logo/广东卫视.png" group-title="卫视",广东卫视
rtp://239.253.64.96:5140/?fcc=10.255.75.73:15970$超高清
#EXTINF:-1 tvg-id="广东卫视" tvg-name="广东卫视" tvg-logo="https://example.com/logo/广东卫视.png" group-title="卫视",广东卫视
rtp://239.253.64.200:5140/?fcc=10.255.75.73:15970$高清
#EXTINF:-1 tvg-id="广东卫视" tvg-name="广东卫视" tvg-logo="https://example.com/logo/广东卫视.png" group-title="卫视",广东卫视
rtp://239.253.64.44:5140/?fcc=10.255.75.73:15970$标清
```

### Example Output

Each `$label` channel generates an independent service path. `$label` becomes a `/label` subpath, while `$label` remains at the end of the converted URL:

```m3u
#EXTINF:-1 tvg-id="广东卫视" tvg-name="广东卫视" tvg-logo="https://example.com/logo/广东卫视.png" group-title="卫视",广东卫视
http://192.168.1.1:5140/卫视/广东卫视/超高清$超高清

#EXTINF:-1 tvg-id="广东卫视" tvg-name="广东卫视" tvg-logo="https://example.com/logo/广东卫视.png" group-title="卫视",广东卫视
http://192.168.1.1:5140/卫视/广东卫视/高清$高清

#EXTINF:-1 tvg-id="广东卫视" tvg-name="广东卫视" tvg-logo="https://example.com/logo/广东卫视.png" group-title="卫视",广东卫视
http://192.168.1.1:5140/卫视/广东卫视/标清$标清
```

### Built-in Player Channel Aggregation

> **Note**: Channel aggregation is a **built-in web player** feature, not a server-side behavior of rtp2httpd. Whether third-party players (e.g., APTV, TiviMate) support similar aggregation depends on their own implementation. rtp2httpd only parses `$label`, generates separate service paths, and preserves `$label` in the converted M3U.

When the M3U contains multiple channels with the same group and name, the built-in player aggregates them into a single channel with multiple sources, shown once in the list. Users can switch sources (e.g., resolutions) in the source selector:

<img width="664" height="352" alt="Channel Source Selector" src="https://github.com/user-attachments/assets/1b17ac40-e0e6-4a5f-8659-2b4ba9bd7c28" />

If the source URL has a `$label` suffix, the player displays it as a label (e.g., "超高清", "高清", "标清"). Sources without `$label` are displayed with numeric labels (e.g., "Line 1", "Line 2").

## Time Placeholders Supported by the Built-in Player

The built-in web player supports the following time placeholder formats for `catchup-source` URLs:

### `${}` Format (long format)

| Placeholder                      | Description                                 | Example output            |
| -------------------------------- | ------------------------------------------- | ------------------------- |
| `${utc}`                         | Program start time (UTC, ISO8601)           | 2025-01-15T10:30:45.000Z  |
| `${utc:yyyyMMddHHmmss}`          | Program start time (UTC, custom long format)| 20250115103045            |
| `${utcend}`                      | Program end time (UTC, ISO8601)             | 2025-01-15T12:30:45.000Z  |
| `${utcend:yyyyMMddHHmmss}`       | Program end time (UTC, custom long format)  | 20250115123045            |
| `${start}`                       | Same as `${utc}`                            | 2025-01-15T10:30:45.000Z  |
| `${start:yyyyMMddHHmmss}`        | Same as `${utc:yyyyMMddHHmmss}`             | 20250115103045            |
| `${end}`                         | Same as `${utcend}`                         | 2025-01-15T12:30:45.000Z  |
| `${end:yyyyMMddHHmmss}`          | Same as `${utcend:yyyyMMddHHmmss}`          | 20250115123045            |
| `${lutc}`                        | Current time (UTC, ISO8601)                 | 2025-01-15T14:00:00.000Z  |
| `${lutc:yyyyMMddHHmmss}`         | Current time (UTC, custom long format)      | 20250115140000            |
| `${now}`                         | Same as `${lutc}`                           | 2025-01-15T14:00:00.000Z  |
| `${now:yyyyMMddHHmmss}`          | Same as `${lutc:yyyyMMddHHmmss}`            | 20250115140000            |
| `${timestamp}`                   | Current Unix timestamp (seconds)            | 1736949600                |
| `${timestamp:yyyyMMddHHmmss}`    | Same as `${lutc:yyyyMMddHHmmss}`            | 20250115140000            |
| `${(b)yyyyMMddHHmmss}`           | Program start time (local, long format)     | 20250115183045            |
| `${(e)yyyyMMddHHmmss}`           | Program end time (local, long format)       | 20250115203045            |
| `${(b)timestamp}`                | Program start Unix timestamp (seconds)      | 1736937045                |
| `${(e)timestamp}`                | Program end Unix timestamp (seconds)        | 1736944245                |
| `${yyyy}`                        | Program start year (local)                  | 2025                      |
| `${MM}`                          | Program start month 01-12 (local)           | 01                        |
| `${dd}`                          | Program start day 01-31 (local)             | 15                        |
| `${HH}`                          | Program start hour 00-23 (local)            | 18                        |
| `${mm}`                          | Program start minute 00-59 (local)          | 30                        |
| `${ss}`                          | Program start second 00-59 (local)          | 45                        |
| `${duration}`                    | Program duration (seconds)                  | 7200                      |

### `{}` Format (short format)

| Placeholder           | Description                                  | Example output            |
| --------------------- | -------------------------------------------- | ------------------------- |
| `{utc}`               | Program start time (UTC, ISO8601)            | 2025-01-15T10:30:45.000Z  |
| `{utc:YmdHMS}`        | Program start time (UTC, custom short format)| 20250115103045            |
| `{utcend}`            | Program end time (UTC, ISO8601)              | 2025-01-15T12:30:45.000Z  |
| `{utcend:YmdHMS}`     | Program end time (UTC, custom short format)  | 20250115123045            |
| `{start}`             | Same as `{utc}`                              | 2025-01-15T10:30:45.000Z  |
| `{start:YmdHMS}`      | Same as `{utc:YmdHMS}`                       | 20250115103045            |
| `{end}`               | Same as `{utcend}`                           | 2025-01-15T12:30:45.000Z  |
| `{end:YmdHMS}`        | Same as `{utcend:YmdHMS}`                    | 20250115123045            |
| `{lutc}`              | Current time (UTC, ISO8601)                  | 2025-01-15T14:00:00.000Z  |
| `{lutc:YmdHMS}`       | Current time (UTC, custom short format)      | 20250115140000            |
| `{now}`               | Same as `{lutc}`                             | 2025-01-15T14:00:00.000Z  |
| `{now:YmdHMS}`        | Same as `{lutc:YmdHMS}`                      | 20250115140000            |
| `{timestamp}`         | Current Unix timestamp (seconds)             | 1736949600                |
| `{timestamp:YmdHMS}`  | Same as `{lutc:YmdHMS}`                      | 20250115140000            |
| `{(b)YmdHMS}`         | Program start time (local, short format)     | 20250115183045            |
| `{(e)YmdHMS}`         | Program end time (local, short format)       | 20250115203045            |
| `{(b)timestamp}`      | Program start Unix timestamp (seconds)       | 1736937045                |
| `{(e)timestamp}`      | Program end Unix timestamp (seconds)         | 1736944245                |
| `{Y}`                 | Program start year (local)                   | 2025                      |
| `{m}`                 | Program start month 01-12 (local)            | 01                        |
| `{d}`                 | Program start day 01-31 (local)              | 15                        |
| `{H}`                 | Program start hour 00-23 (local)             | 18                        |
| `{M}`                 | Program start minute 00-59 (local)           | 30                        |
| `{S}`                 | Program start second 00-59 (local)           | 45                        |
| `{duration}`          | Program duration (seconds)                   | 7200                      |

### Format Reference

**Long format**: used in `${}` placeholders

- `yyyy` - 4-digit year
- `MM` - 2-digit month (01-12)
- `dd` - 2-digit day (01-31)
- `HH` - 2-digit hour (00-23)
- `mm` - 2-digit minute (00-59)
- `ss` - 2-digit second (00-59)

Example: `${utc:yyyyMMddHHmmss}` → `20250115103045`

**Short format**: used in `{}` placeholders

- `Y` - 4-digit year
- `m` - 2-digit month (01-12)
- `d` - 2-digit day (01-31)
- `H` - 2-digit hour (00-23)
- `M` - 2-digit minute (00-59)
- `S` - 2-digit second (00-59)

Example: `{utc:YmdHMS}` → `20250115103045`

## Related Docs

- [URL Formats](url-formats.md): Supported URL formats
- [Configuration Reference](configuration.md): Full configuration options
