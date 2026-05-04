# Time Processing

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

### r2h-seek-mode Parameter (Optional, RTSP Only)

Controls whether the RTSP proxy enables the "near-realtime" branch (see "RTSP Recent Seek Handling" below). This parameter only affects the RTSP proxy.

#### Values

- `passthrough` (default, equivalent to omitting the parameter): the seek parameter is always passed through to the upstream as a URL query parameter
- `range[(<TZ>[/<seconds>])]`: when the window condition is satisfied, switch to the `Range: clock=...Z-` header instead; if not satisfied, fall back to passthrough

The contents inside `range(...)` can be omitted, and are parsed by the following rules:

- `range`, `range()` — defaults: TZ falls back to UA `TZ/`, then to UTC if absent; window is 3600 seconds
- `range(UTC+8)`, `range(UTC-5)`, `range(UTC)` — explicitly specify the timezone, window defaults to 3600 seconds
- `range(7200)` — explicitly specify the window (in seconds), TZ falls back (as above)
- `range(UTC+8/7200)` — specify both TZ and window
- `range(/7200)` — TZ falls back, window is explicit

The window must be in the range `[1, 86400]` seconds. Unrecognized values are logged at warn level and treated as `passthrough`; they do not fail the request.

> [!IMPORTANT]
> The TZ inside `range(...)` **only takes effect on the clock= path**: it is used both to decide whether the start time falls inside the window, and to convert the client time into the UTC `Range: clock=...Z` timestamp sent upstream. When the start time falls outside the window and the request falls back to passthrough, the behavior is exactly the same as if `r2h-seek-mode` was not set — the TZ from `range()` will **not** be used to rewrite the passthrough string. This makes `r2h-seek-mode=range(...)` a purely additive optimization that never makes an otherwise-working passthrough query worse.

#### Examples

```url
# Explicitly enable the RTSP near-realtime optimization, parse times in UTC+8, window of 1 hour
http://192.168.1.1:5140/rtsp/iptv.example.com:554/channel1?playseek=20240101120000&r2h-seek-mode=range(UTC%2B8/3600)

# Specify only the window; the timezone falls back to the UA TZ/ marker or UTC
http://192.168.1.1:5140/rtsp/iptv.example.com:554/channel1?playseek=20240101120000&r2h-seek-mode=range(7200)
```

### r2h-start Parameter (Optional, RTSP Only)

Used to specify starting playback of an RTSP stream from a specific time point, implementing resume functionality. This parameter value will be sent as an NPT (Normal Play Time) format time point to the RTSP server in the RTSP PLAY request via the `Range: npt=<time-point>-` header. This parameter is only valid for RTSP proxy.

If the same RTSP request also includes `r2h-seek-mode=range(...)` and the seek start time falls within the window, `r2h-start` will be ignored and the seek start time will be used to generate a `Range: clock=` header instead.

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

The `GMT` suffix marks the value as carrying its own timezone, with semantics equivalent to the ISO 8601 `Z` suffix: the value is always interpreted as UTC, and **any** external timezone configuration (User-Agent `TZ/UTC±N`, `r2h-seek-mode=range(<TZ>)`) is ignored. `r2h-seek-offset` still applies (it is a user-declared time shift, not a timezone override).

### 4. Compact ISO 8601 Format (yyyyMMddTHHmmss)

Compact ISO 8601 format without hyphen and colon separators:

```
# Without timezone (uses User-Agent timezone)
playseek=20240101T120000-20240101T130000

# With Z suffix (UTC timezone)
playseek=20240101T120000Z-20240101T130000Z

# With timezone offset
playseek=20240101T200000+08:00-20240101T210000+08:00
```

### 5. ISO 8601 Format (yyyy-MM-ddTHH:mm:ss)

Full ISO 8601 format, supporting multiple variants:

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

**Common characteristics of ISO 8601 formats** (applies to formats 4 and 5):

- If timezone information is included (Z or ±HH:MM), uses that timezone and ignores User-Agent timezone
- If no timezone information is included, uses the timezone from User-Agent for conversion
- Output format preserves original timezone suffix (Z, ±HH:MM, or no suffix)
- Full format (format 5) supports millisecond precision (.sss)

## Timezone Handling Mechanism

### RTSP Recent Seek Handling

For the RTSP proxy, in addition to passing seek parameters to the upstream as URL query parameters (same as HTTP proxy), a "near-realtime" branch is also supported. The seek parameters here include `playseek`, `tvdr`, and any custom parameter specified via `r2h-seek-name`:

- This branch is **disabled** by default and must be explicitly enabled via `r2h-seek-mode=range(...)` (see "r2h-seek-mode Parameter" above)
- When enabled, if the seek start time satisfies "current time − start time < window seconds", rtp2httpd will no longer pass the seek parameter through to the upstream RTSP URL
- This branch only uses the seek start time; the end time is ignored
- The RTSP `PLAY` request will send `Range: clock=<yyyyMMddTHHmmssZ>-`
- The timezone of the start time is resolved in the following fallback order: explicit `range(<TZ>/...)` declaration → UA `TZ/UTC+N` → UTC. This fallback chain only applies to inputs **without an embedded timezone**: 14-digit `yyyyMMddHHmmss` and ISO 8601 without a `Z`/`±HH:MM` suffix. Inputs **with an embedded timezone** (`yyyyMMddHHmmssGMT`, ISO 8601 with a `Z` or `±HH:MM` suffix) use the timezone from the input itself; both `range(<TZ>)` and the UA `TZ/` marker are ignored.
- When the seek start time is exactly at the window boundary (i.e. `now − begin == window`), this branch is not triggered and the parameter is passed through as a normal URL parameter
- If the seek value cannot be parsed, the original pass-through behavior is preserved
- `r2h-seek-offset` affects both the window check and the final `clock=` time written out — once the offset-adjusted time falls outside the window, the request falls back to passthrough as well

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
> 1. **Parse time format** — Identify which format the parameter value belongs to: Unix timestamp (≤10 digits), `yyyyMMddHHmmss` (14 digits), `yyyyMMddHHmmssGMT` (14 digits + GMT suffix), compact ISO 8601 (`yyyyMMddTHHmmss`), full ISO 8601 (`yyyy-MM-ddTHH:mm:ss`)
> 2. **Parse User-Agent timezone** — Search for the `TZ/` marker in the User-Agent, extract UTC offset (seconds). If no timezone information, defaults to 0 (UTC)
> 3. **Timezone conversion** — Formats with an embedded timezone (Unix timestamp, `yyyyMMddHHmmssGMT`, ISO 8601 with `Z`/`±HH:MM`) skip conversion; formats without an embedded timezone (`yyyyMMddHHmmss` and ISO 8601 without a timezone suffix) have the User-Agent timezone conversion applied
> 4. **Apply `r2h-seek-offset`** — If this parameter is specified, apply additional second offset (can be positive or negative) to all formats
> 5. **Format output** — Maintain original format, preserve original timezone suffix (if any)
> 6. **Append to upstream URL** — Append the processed time parameter as a query parameter to the upstream request (RTSP sends DESCRIBE request, HTTP forwards to upstream server)

## Related Documentation

- [URL Formats](/en/guide/url-formats): RTSP/HTTP proxy URL format
- [Configuration Reference](/en/reference/configuration): Server configuration options
