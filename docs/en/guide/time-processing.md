# Time Processing Specification

This document explains in detail how rtp2httpd handles time parameters and timezone conversion in the timeshift/catch-up functionality. This mechanism applies to both RTSP proxy and HTTP proxy.

## Timeshift/Catch-up Principles

IPTV operator servers typically support timeshift/catch-up functionality, allowing users to watch live content from past time periods. This feature is implemented by adding time range parameters (such as `playseek`, `tvdr`, etc.) to the URL.

**Basic workflow**:

1. **Client request**: The client requests video for a specific time period from the upstream server.

   ```
   # RTSP upstream
   rtsp://iptv.example.com:554/channel1?playseek=20240101120000-20240101130000

   # HTTP upstream
   http://iptv.example.com/channel1?playseek=20240101120000-20240101130000
   ```

2. **Server response**: The upstream server returns video from the recorded historical content based on the time parameters

3. **Time format requirements**: Different regional IPTV operators may have different requirements for time format and timezone. Some expect UTC timezone, some expect GMT+8 timezone, some expect the format `20240101120000`, and some expect `20240101120000GMT`. Different players also have varying support for timezones and time formats. If the player format, timezone, and operator requirements do not match, catch-up playback will fail.

## The Role of rtp2httpd

As an intermediary proxy, rtp2httpd can flexibly convert time formats and timezones according to configuration, matching the time sent by the player with the time expected by the operator.

**Core features**:

- Automatically recognizes multiple time formats (Unix timestamp, yyyyMMddHHmmss, ISO 8601, etc.)
- Parses client timezone information from User-Agent header
- Intelligent timezone conversion (only for formats that require conversion)
- Supports additional time offset (to compensate for clock drift)
- Maintains output format consistent with input format

## Seek Parameter Configuration

### r2h-seek-name Parameter (Optional)

Used to specify the name of the timeshift parameter. If not specified, rtp2httpd will automatically recognize common parameter names.

#### Auto-recognized Parameter Names (By Priority)

1. `playseek` - Most common timeshift parameter
2. `tvdr` - Parameter name used by some IPTV systems

#### Usage

- **Standard parameter names**: When the upstream server uses `playseek` or `tvdr`, this parameter does not need to be specified
- **Custom parameter names**: When the upstream server uses other parameter names (such as `seek`, `timeshift`, etc.), you need to explicitly specify via `r2h-seek-name`

#### Examples

```url
# RTSP proxy: auto-recognize playseek parameter
http://192.168.1.1:5140/rtsp/iptv.example.com:554/channel1?playseek=20240101120000-20240101130000

# RTSP proxy: auto-recognize tvdr parameter
http://192.168.1.1:5140/rtsp/iptv.example.com:554/channel1?tvdr=20240101120000-20240101130000

# RTSP proxy: use custom parameter name
http://192.168.1.1:5140/rtsp/iptv.example.com:554/channel1?custom_seek=20240101120000&r2h-seek-name=custom_seek

# HTTP proxy: auto-recognize playseek parameter
http://192.168.1.1:5140/http/iptv.example.com/channel1?playseek=20240101120000-20240101130000

# HTTP proxy: use custom parameter name
http://192.168.1.1:5140/http/iptv.example.com/channel1?custom_seek=20240101120000&r2h-seek-name=custom_seek
```

### r2h-seek-offset Parameter (Optional)

When a timeshift parameter is recognized, an additional offset in seconds to add, which can be positive or negative.

#### Use Cases

- **Compensate for clock drift**: When the upstream server has a fixed offset from actual time
- **Fine-tune timeshift position**: When you need to start playback a few seconds earlier or later
- **Testing and debugging**: To verify content at different time points

#### Examples

```url
# RTSP proxy: add 1 hour (3600 seconds) to the playseek range
http://192.168.1.1:5140/rtsp/iptv.example.com:554/channel1?playseek=20240101120000-20240101130000&r2h-seek-offset=3600

# HTTP proxy: add 1 hour (3600 seconds) to the playseek range
http://192.168.1.1:5140/http/iptv.example.com/channel1?playseek=20240101120000-20240101130000&r2h-seek-offset=3600

# Subtract 30 seconds from the playseek range
http://192.168.1.1:5140/rtsp/iptv.example.com:554/channel1?playseek=20240101120000-20240101130000&r2h-seek-offset=-30
```

### r2h-start Parameter (Optional, RTSP Only)

Used to specify starting playback of an RTSP stream from a specific time point, implementing resume functionality. This parameter value will be sent as an NPT (Normal Play Time) format time point to the RTSP server in the RTSP PLAY request via the `Range: npt=<time-point>-` header. This parameter is only valid for RTSP proxy.

#### Example

```url
http://192.168.1.1:5140/rtsp/iptv.example.com:554/channel1?r2h-start=123.45
```

## Supported Time Formats

rtp2httpd supports parsing the following time formats. Only when time can be successfully parsed can timezone conversion or r2h-seek-offset second offset be applied.

### 1. yyyyMMddHHmmss Format (14 digits)

```
playseek=20240101120000-20240101130000
```

### 2. Unix Timestamp Format (Up to 10 digits)

```
playseek=1704096000-1704099600
```

### 3. yyyyMMddHHmmssGMT Format (14 digits + GMT suffix)

```
playseek=20240101120000GMT-20240101130000GMT
```

### 4. ISO 8601 Format (Contains T separator)

Supports multiple ISO 8601 variants:

```
# Without timezone (uses User-Agent timezone)
playseek=2024-01-01T12:00:00-2024-01-01T13:00:00

# With Z suffix (UTC timezone, no timezone conversion)
playseek=2024-01-01T12:00:00Z-2024-01-01T13:00:00Z

# With timezone offset (preserves original timezone, no timezone conversion)
playseek=2024-01-01T12:00:00+08:00-2024-01-01T13:00:00+08:00

# With milliseconds
playseek=2024-01-01T12:00:00.123-2024-01-01T13:00:00.456
```

**Characteristics**:

- If timezone information is included (Z or ±HH:MM), uses that timezone and ignores User-Agent timezone
- If no timezone information is included, uses the timezone from User-Agent for conversion
- Output format preserves original timezone suffix (Z, ±HH:MM, or no suffix)
- Supports millisecond precision (.sss)

## Timezone Handling Mechanism

### Timezone Recognition

The server will parse the `TZ/` marker in the User-Agent to obtain client timezone information:

#### Supported Timezone Formats

- `TZ/UTC+8` - UTC offset format (GMT+8)
- `TZ/UTC-5` - UTC offset format (GMT-5)
- `TZ/UTC` - Standard UTC timezone

#### Default Behavior

If there is no timezone information in the User-Agent, no timezone conversion is performed, only the second offset specified by `r2h-seek-offset` is applied.

> [!NOTE]
> rtp2httpd processes time parameters in the following steps:
>
> 1. **Parse time format** — Identify which format the parameter value belongs to: Unix timestamp (≤10 digits), `yyyyMMddHHmmss` (14 digits), `yyyyMMddHHmmssGMT` (14 digits + GMT suffix), ISO 8601 (contains `T` separator)
> 2. **Parse User-Agent timezone** — Search for the `TZ/` marker in the User-Agent, extract UTC offset (seconds). If no timezone information, defaults to 0 (UTC)
> 3. **Timezone conversion** — Unix timestamp and ISO 8601 with timezone formats skip conversion; `yyyyMMddHHmmss` and ISO 8601 without timezone formats apply User-Agent timezone conversion
> 4. **Apply `r2h-seek-offset`** — If this parameter is specified, apply additional second offset (can be positive or negative) to all formats
> 5. **Format output** — Maintain original format, preserve original timezone suffix (if any)
> 6. **Append to upstream URL** — Append the processed time parameter as a query parameter to the upstream request (RTSP sends DESCRIBE request, HTTP forwards to upstream server)

## Related Documentation

- [URL Format Specification](/en/guide/url-formats): RTSP/HTTP proxy URL format specification
- [Configuration Reference](/en/reference/configuration): Server configuration options
