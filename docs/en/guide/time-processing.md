# Time Processing

This document explains how rtp2httpd handles the time and timezone in time-shifted playback (catch-up) requests. It applies to both RTSP and HTTP proxies, but **Range Seek mode** is RTSP-only.

## Two Modes for Time-Shifted Playback

IPTV upstream servers usually support time-shifted playback — replaying live content from a past time period. The client tells the server which segment it wants by adding a time-range parameter to the URL (most commonly `playseek` or `tvdr`):

```
http://192.168.1.1:5140/rtsp/iptv.example.com:554/channel1?playseek=20240101120000-20240101130000
```

When forwarding to upstream, rtp2httpd supports two ways of handling this:

### Mode 1: Playseek Passthrough (default)

The client's seek parameter is forwarded to the upstream server as a URL query, untouched (with format adjustments for timezone if needed).

**Where it applies**: HTTP proxy + RTSP proxy. Works with every operator that supports time-shifting.

**Limitation**: Upstream finishes playback at the "end time" the client supplied and then closes the stream. To stitch the live stream onto the end seamlessly, the client must **issue a brand-new request** — there will be a gap of a few hundred milliseconds to several seconds in between, which can cause stuttering or audio/video desync.

### Mode 2: RTSP Range Seek (opt-in)

Uses RTSP's built-in `Range: clock=...` header to make the upstream start playback at the specified time, **and seamlessly stitches into the live stream once playback catches up to "now"** — one connection from start to finish, no reconnection needed.

To enable, add `r2h-seek-mode=range(...)` to the URL:

```
http://192.168.1.1:5140/rtsp/iptv.example.com:554/channel1?playseek=20240101120000&r2h-seek-mode=range(UTC%2B8)
```

**Advantage**: The transition from the time-shifted segment to live playback is one continuous stream, with no gap.

**Limitations**:

1. **Not every RTSP server supports it** — this is the fundamental reason it is off by default and must be opted into. Once the Range Seek path engages, rtp2httpd unconditionally sends the `Range: clock=...` header upstream; if upstream doesn't recognize it, the request fails rather than falling back automatically
2. **rtp2httpd has its own client-side window** (default 1 hour, adjustable via `r2h-seek-mode=range(<TZ>/<seconds>)`): only start times within the window go through Range Seek; everything else uses Playseek passthrough. Sizing the window so it doesn't exceed what the upstream actually supports (typically 1–3 hours, varies by operator) avoids hitting upstream with seeks too far in the past

> [!TIP]
> Outside rtp2httpd's client-side window, behavior is **identical** to never enabling Range Seek (Playseek passthrough). Inside the window, an RTSP request with a `Range: clock=` header is issued — only enable this when the upstream is known to support RTSP `Range` headers, and size the window to stay within the upstream's actual catch-up coverage.

> [!NOTE]
> Range Seek mode only looks at the **start time** of the seek — the end time is ignored, since live stitching takes over from there.

## Seek Parameters

### r2h-seek-name (optional)

Specifies the name of the time-shift parameter. When omitted, rtp2httpd auto-detects in this order: `playseek` → `tvdr` (case-insensitive).

If your upstream uses a different parameter name (e.g. `seek`, `timeshift`), specify it explicitly:

```
?custom_seek=20240101120000-20240101130000&r2h-seek-name=custom_seek
```

### r2h-seek-offset (optional)

Adds or subtracts a number of seconds to the recognized time-shift time, positive or negative. Commonly used to compensate for clock drift on the upstream server, or to shift the start time earlier/later as a whole.

```
# Shift the entire playseek range later by 1 hour (3600 seconds)
?playseek=20240101120000-20240101130000&r2h-seek-offset=3600

# Shift earlier by 30 seconds
?playseek=20240101120000&r2h-seek-offset=-30
```

> [!IMPORTANT]
> `r2h-seek-offset` is a "manual time shift", not a timezone correction. It is **always** applied to the final result, even when the input time already carries its own timezone (e.g. ISO 8601 `Z` suffix, `yyyyMMddHHmmssGMT`).
>
> In Range Seek mode the offset also enters the window check — once the offset-adjusted time falls outside the window, it likewise falls back to passthrough.

### r2h-seek-mode (optional, RTSP only)

Controls whether "Range Seek mode" is enabled (see [Two Modes for Time-Shifted Playback](#two-modes-for-time-shifted-playback) above).

| Value                                          | Behavior                                                                  |
| ---------------------------------------------- | ------------------------------------------------------------------------- |
| omitted / `passthrough`                        | Default. Use Playseek passthrough                                         |
| `range` / `range()`                            | Enable Range Seek; TZ derived from UA `TZ/` (UTC if absent), window 1 hour |
| `range(UTC+8)` / `range(UTC-5)` / `range(UTC)` | Explicit timezone, window defaults to 1 hour                              |
| `range(7200)`                                  | TZ auto-derived, window 7200 seconds                                      |
| `range(UTC+8/7200)`                            | Explicit TZ and explicit window                                           |
| `range(/7200)`                                 | TZ auto-derived + explicit window                                         |

Window must be in 1–86400 seconds. Unrecognized values are treated as `passthrough` (the request never fails).

> [!IMPORTANT]
> The timezone specified inside `range()` **only takes effect in Range Seek mode** — it is used to decide whether the time falls inside the window and to generate the UTC time in the `Range: clock=` header. Once it falls back to Playseek passthrough, the behavior is **byte-for-byte identical** to not passing `r2h-seek-mode`; the `range(<TZ>)` does not rewrite the passthrough string.

### r2h-start (optional, RTSP only)

Start playback from a specified NPT time point (in seconds), commonly used for resume playback:

```
?r2h-start=123.45
```

Sent to upstream as a `Range: npt=<time>-` header in the RTSP `PLAY` request. If the same request also carries `r2h-seek-mode=range(...)` and Range Seek mode is engaged, `r2h-start` is ignored, and the seek start time generates the `Range: clock=` header instead.

## Supported Time Formats

rtp2httpd recognizes the time formats below. **Output format always matches the input** (preserves `Z`, `±HH:MM`, `GMT`, and similar suffixes).

| Format                              | Example                       | Self-contained TZ |
| ----------------------------------- | ----------------------------- | ----------------- |
| Unix timestamp (≤10 digits)         | `1704096000`                  | Yes (UTC)         |
| 14-digit `yyyyMMddHHmmss`           | `20240101120000`              | No                |
| 14-digit + `GMT` suffix             | `20240101120000GMT`           | Yes (UTC)         |
| Compact ISO 8601                    | `20240101T120000`             | No                |
| Compact ISO 8601 + `Z`              | `20240101T120000Z`            | Yes (UTC)         |
| Compact ISO 8601 + `±HH:MM`         | `20240101T200000+08:00`       | Yes               |
| Full ISO 8601                       | `2024-01-01T12:00:00`         | No                |
| Full ISO 8601 + `Z` / `±HH:MM`      | `2024-01-01T12:00:00Z`        | Yes               |
| Full ISO 8601 + milliseconds        | `2024-01-01T12:00:00.123Z`    | Depends on suffix |

For "self-contained TZ" formats rtp2httpd skips timezone derivation — any external timezone configuration (UA `TZ/...`, `r2h-seek-mode=range(<TZ>)`) is ignored, but `r2h-seek-offset` still applies. For "no TZ" formats, see "Timezone Derivation" below.

> [!NOTE]
> The `GMT` suffix in `yyyyMMddHHmmssGMT` is semantically equivalent to ISO 8601's `Z` — both are treated as "self-contained UTC".

## Timezone Derivation

Only applies to formats that don't carry their own timezone (14-digit `yyyyMMddHHmmss`, ISO 8601 without `Z`/`±HH:MM`).

### Default (Playseek passthrough)

rtp2httpd looks for the `TZ/` marker in the User-Agent header to obtain the client's timezone:

```
TZ/UTC      → UTC
TZ/UTC+8    → UTC+8
TZ/UTC-5    → UTC-5
```

When there's no `TZ/` marker in the UA, UTC is used (no timezone conversion is applied).

### Range Seek mode

When `r2h-seek-mode=range(...)` is enabled, the **Range Seek path only** picks the timezone in this priority order:

1. `range(UTC+N)` explicit declaration
2. UA `TZ/UTC+N`
3. UTC

When the request falls back to Playseek passthrough, timezone derivation reverts to the rules under "Default" above — the timezone inside `range()` does not participate.

## Related Documentation

- [URL Formats](/en/guide/url-formats): RTSP / HTTP proxy URL format
- [Configuration Reference](/en/reference/configuration): Server configuration options
