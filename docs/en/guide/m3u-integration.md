# M3U Playlist Integration

rtp2httpd provides comprehensive support for M3U/M3U8 playlist formats. It can automatically recognize programs and provide converted playlists, allowing you to import external M3U channel lists with one click, automatically replace URLs, and use them directly in IPTV players.

## Configuration Methods

### Method 1: Use External M3U File

Specify an external M3U URL in the configuration file:

```ini
[global]
# External M3U configuration (supports file://, http://, https://)
# Note: HTTP/HTTPS requires curl, uclient-fetch, or wget command to be installed
external-m3u = https://example.com/iptv.m3u
# Or use local file
external-m3u = file:///path/to/playlist.m3u

# External M3U update interval (seconds)
# Default 7200 (2 hours), set to 0 to disable auto-update
external-m3u-update-interval = 7200
```

### Method 2: Inline M3U Directly in Configuration File

Write M3U content directly in the `[services]` section:

```ini
[services]
# Write M3U content directly, starting with #EXTM3U
#EXTM3U x-tvg-url="https://example.com/epg.xml.gz"

# Basic channel configuration
#EXTINF:-1 tvg-id="CCTV1" tvg-name="CCTV1" tvg-logo="https://example.com/logo/CCTV1.png" group-title="CCTV",CCTV-1
rtp://239.253.64.120:5140

# Channel configuration with time-shift playback
#EXTINF:-1 tvg-id="CCTV2" tvg-name="CCTV2" group-title="CCTV" catchup="default" catchup-source="rtsp://10.0.0.50:554/catchup?playseek={utc:YmdHMS}-{utcend:YmdHMS}",CCTV-2
rtp://239.253.64.121:5140

# Simple configuration (channel name only)
#EXTINF:-1,Guangdong TV
rtp://239.194.10.15:1234
```

## Using the Playlist

### Method 1: Use Built-in Player

After configuring M3U, access the [built-in web player](/en/guide/web-player) by visiting `http://server:port/player` in your browser.

### Method 2: Export Playlist to Other Players

The converted M3U playlist can be accessed via the following URL:

```
http://server:port/playlist.m3u
```

**Example**:

```
http://192.168.1.1:5140/playlist.m3u
```

Add this URL to any M3U-compatible IPTV player (such as APTV, TiviMate, etc.) to use it.

## Conversion Example

### Input M3U

```m3u
#EXTM3U x-tvg-url="https://example.com/epg.xml.gz"

#EXTINF:-1 tvg-id="CCTV1" tvg-name="CCTV1" tvg-logo="https://example.com/logo/CCTV1.png" group-title="CCTV" catchup="default" catchup-source="rtsp://10.0.0.50:554/catchup?auth=loremipsum&playseek={utc:YmdHMS}-{utcend:YmdHMS}",CCTV-1
rtp://239.253.64.120:5140

#EXTINF:-1 tvg-id="CCTV2" tvg-name="CCTV2" group-title="CCTV",CCTV-2
rtp://239.253.64.121:5140

#EXTINF:-1 tvg-id="Other" tvg-name="Other Channel",Third-party Channel
http://other-cdn.com/live/stream.m3u8
```

### Output M3U (After Conversion)

```m3u
#EXTM3U x-tvg-url="http://192.168.1.1:5140/epg.xml.gz"

#EXTINF:-1 tvg-id="CCTV1" tvg-name="CCTV1" tvg-logo="https://example.com/logo/CCTV1.png" group-title="CCTV" catchup="default" catchup-source="http://192.168.1.1:5140/CCTV-1/catchup?playseek={utc:YmdHMS}-{utcend:YmdHMS}",CCTV-1
http://192.168.1.1:5140/CCTV/CCTV-1

#EXTINF:-1 tvg-id="CCTV2" tvg-name="CCTV2" group-title="CCTV",CCTV-2
http://192.168.1.1:5140/CCTV/CCTV-2

#EXTINF:-1 tvg-id="Other" tvg-name="Other Channel",Third-party Channel
http://other-cdn.com/live/stream.m3u8
```

> [!NOTE]
> - EPG URL has been converted to rtp2httpd proxy address
> - CCTV-1 and CCTV-2 URLs have been converted to rtp2httpd proxy addresses
> - CCTV-1's catchup-source has also been converted, preserving dynamic placeholders
> - Third-party channel URL remains unchanged

## Best Practices

1. **HTTP/HTTPS Support**
   - Requires `curl`, `uclient-fetch`, or `wget` command installed on the system
   - rtp2httpd will automatically detect and use available tools

2. **Update Strategy**
   - External M3U is auto-updated every 24 hours by default
   - Adjust `external-m3u-update-interval` based on source update frequency
   - Set to 0 to disable auto-update (requires manual service restart to update)

3. **Mixed Usage**
   - External M3U and inline M3U can be configured simultaneously
   - Both will be merged into the same converted playlist

4. **Enable `xff` When Using Reverse Proxy**
   - During M3U conversion, rtp2httpd needs to know its full access address. Therefore, if using a reverse proxy, enable the `xff` option and ensure the proxy can pass through `X-Forwarded-*` headers. See [Public Access Guide](/en/guide/public-access) for details.

## URL Recognition and Conversion Rules

### Supported URL Formats

rtp2httpd can recognize and convert the following URL formats:

1. **Direct Protocol URLs**:
   - `rtp://[source@]multicast_addr:port[?query]`
   - `rtsp://server:port/path[?query]`
   - `udp://multicast_addr:port[?query]`

2. **UDPxy-style HTTP URLs**:
   - `http://hostname:port/rtp/multicast_addr:port`
   - `http://hostname:port/rtsp/server:port/path`
   - The `hostname:port` will be automatically replaced with rtp2httpd's actual address and port

### Conversion Examples

| Original URL                                | Converted URL                             |
| ------------------------------------------- | ----------------------------------------- |
| `rtp://239.253.64.120:5140`                 | `http://hostname:5140/CCTV-1`             |
| `rtsp://10.0.0.50:554/live`                 | `http://hostname:5140/CCTV-2`             |
| `http://router:5140/rtp/239.1.1.1:1234`     | `http://hostname:5140/ChannelName`        |
| `http://other-server/stream.m3u8` (3rd party) | `http://other-server/stream.m3u8` (unchanged) |

**Service Name Extraction Rule**: Use the text after the last comma in the `#EXTINF` line as the service name.

```
#EXTINF:-1 tvg-id="..." tvg-name="..." group-title="...",CCTV-1
                                                          ^^^^^^
                                                       Service Name
```

## Time-Shifted Playback (Catchup) Support

When M3U includes the `catchup-source` attribute, rtp2httpd automatically creates corresponding time-shift services.

### Configuration Example

```m3u
#EXTINF:-1 tvg-id="CCTV1" catchup="default" catchup-source="rtsp://10.0.0.50:554/catchup?playseek={utc:YmdHMS}-{utcend:YmdHMS}",CCTV-1
rtp://239.253.64.120:5140
```

### Conversion Result

- **Live Service**: `http://hostname:5140/CCTV-1`
- **Time-shift Service**: `http://hostname:5140/CCTV-1/catchup?playseek={utc:YmdHMS}-{utcend:YmdHMS}`

### Placeholder Handling

- **Dynamic Placeholders** (containing `{` or `}`): Preserved in the converted URL, to be filled by the player
  - For example: `{utc:YmdHMS}`, `{utcend:YmdHMS}`
- **Static Parameters**: Other query parameters will not be preserved in the converted M3U, but will still be included in requests to the upstream.

### Handling of Unrecognizable URLs

If `catchup-source` is a third-party HTTP URL (such as `http://other-cdn.com/catchup`), it will be preserved as-is without conversion.

## Source Labels

By adding a `$label` suffix at the very end of a URL, you can specify a display label for the channel source (such as quality level). The `$label` must be at the absolute end of the entire URL.

This feature is only effective in players that support labels and channel aggregation (such as the [built-in web player](/en/guide/web-player)).

### Example Input

```m3u
#EXTINF:-1 tvg-id="Guangdong TV" tvg-name="Guangdong TV" tvg-logo="https://example.com/logo/GuangdongTV.png" group-title="Satellite",Guangdong TV
rtp://239.253.64.96:5140/?fcc=10.255.75.73:15970$UHD
#EXTINF:-1 tvg-id="Guangdong TV" tvg-name="Guangdong TV" tvg-logo="https://example.com/logo/GuangdongTV.png" group-title="Satellite",Guangdong TV
rtp://239.253.64.200:5140/?fcc=10.255.75.73:15970$HD
#EXTINF:-1 tvg-id="Guangdong TV" tvg-name="Guangdong TV" tvg-logo="https://example.com/logo/GuangdongTV.png" group-title="Satellite",Guangdong TV
rtp://239.253.64.44:5140/?fcc=10.255.75.73:15970$SD
```

### Example Output

Each channel with a `$label` generates an independent service path, with `$label` converted to a `/label` subpath, and `$label` also preserved at the end of the converted URL:

```m3u
#EXTINF:-1 tvg-id="Guangdong TV" tvg-name="Guangdong TV" tvg-logo="https://example.com/logo/GuangdongTV.png" group-title="Satellite",Guangdong TV
http://192.168.1.1:5140/Satellite/Guangdong TV/UHD$UHD

#EXTINF:-1 tvg-id="Guangdong TV" tvg-name="Guangdong TV" tvg-logo="https://example.com/logo/GuangdongTV.png" group-title="Satellite",Guangdong TV
http://192.168.1.1:5140/Satellite/Guangdong TV/HD$HD

#EXTINF:-1 tvg-id="Guangdong TV" tvg-name="Guangdong TV" tvg-logo="https://example.com/logo/GuangdongTV.png" group-title="Satellite",Guangdong TV
http://192.168.1.1:5140/Satellite/Guangdong TV/SD$SD
```

## Related Documentation

- [Built-in Web Player](/en/guide/web-player): Player features, channel aggregation, time placeholders
- [URL Format Reference](/en/guide/url-formats): Learn about all supported URL formats
- [Configuration Reference](/en/reference/configuration): View complete configuration options
