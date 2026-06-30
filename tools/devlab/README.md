# devlab — mock IPTV upstreams for web-player development

`devlab.py` spins up self-contained upstream servers (no external network) that
rtp2httpd can proxy, so you can develop the web player against the scenarios it
needs to support:

| Scenario        | Delivery                | rtp2httpd proxy | Codecs                              |
| --------------- | ----------------------- | --------------- | ----------------------------------- |
| HLS-TS live     | HTTP `.m3u8` + `.ts`    | `/http`         | `h264-mp2`, `hevc-aac`              |
| HLS-fMP4 live   | HTTP `.m3u8` + `.m4s`   | `/http`         | `h264-aac`, `hevc-aac`              |
| HLS catchup     | HTTP TS (`playseek`)    | `/http`         | all of the above                    |
| mpegts catchup  | RTSP TS (`playseek`)    | `/rtsp`         | `h264-mp2`, `hevc-aac`              |
| mpegts live     | RTP multicast (组播)    | `/rtp` (`-r lo`)| `h264-mp2`, `hevc-ac3`, `hevc-eac3` |
| external file   | RTP multicast (looped)  | `/rtp` (`-r lo`)| whatever the `.ts` file contains    |

- `h264-mp2`  = H.264 video + MPEG-1/2 Layer II audio
- `hevc-aac`  = H.265/HEVC video + AAC audio
- `hevc-ac3`  = H.265/HEVC video + AC-3 audio   (北京卫视 4K style)
- `hevc-eac3` = H.265/HEVC video + E-AC-3 audio (北京卫视 4K style)

HLS live is offered in both segment specs: **HLS-TS** (MPEG-TS `.ts` segments)
and **HLS-fMP4** (an `init.mp4` referenced via `#EXT-X-MAP` + `.m4s` fragments).
fMP4 carries AAC audio (MP2-in-MP4 is unsupported), so fMP4 channels use AAC.

Multicast channels use groups `239.255.0.20+` on `--mcast-port` (default 5004);
rtp2httpd must be run with `-r lo` to join them on loopback.

## Debugging a user-provided .ts file

Publish any external `.ts` as a multicast live channel (stream-copied, so the
exact codecs/bitstream are relayed) — useful for reproducing a stream attached
to a bug report:

```bash
uv run python tools/devlab/devlab.py --ts-file /path/to/user-report.ts
# adds a "file <name>" channel proxied through rtp2httpd
```

## Catchup correctness is visible

Catchup video burns the **requested** `playseek` begin time into every frame
(`SEEK <yyyy-mm-dd hh-mm-ss> UTC`) plus an advancing elapsed counter. Request a
`playseek` starting at 08:30:00 and the picture shows `SEEK 2026-06-30 08-30-00
UTC` — proving the time → picture mapping end to end.

## Usage

```bash
# 1. start the upstreams (writes /tmp/r2h-devlab.conf)
uv run python tools/devlab/devlab.py

# 2. in another shell, run rtp2httpd against the generated config
./build/rtp2httpd -c /tmp/r2h-devlab.conf -r lo

# 3. open the player and pick a channel
#    http://127.0.0.1:5140/player
```

Requires `ffmpeg` on PATH (`libx264`, `libx265`, `aac`, `mp2`). Defaults: HTTP
origin `127.0.0.1:8881`, RTSP origin `127.0.0.1:8554`, rtp2httpd port `5140`.
Run `uv run python tools/devlab/devlab.py --help` for options.

## Verifying a scenario without the browser

```bash
# live codecs
ffprobe -v error -show_entries stream=codec_type,codec_name \
  "http://127.0.0.1:5140/HLS/HLS%20%28hevc-aac%29"

# catchup: extract a frame and confirm the burned SEEK time matches the request
ffmpeg -ss 9 -i "http://127.0.0.1:5140/mpegts/mpegts%20%28h264-mp2%29/catchup?playseek=20260630083000-20260630093000" \
  -frames:v 1 -y /tmp/seek.png
```

## Notes

- HEVC video and AC-3/E-AC-3 audio playback in the browser depend on the
  browser's Media Source Extensions support; Chromium on Linux usually lacks
  both even though the stream/relay is correct. Use `ffprobe`/frame extraction
  to validate the relay (the `hevc-ac3`/`hevc-eac3` channels are mainly for
  relay/transmux development and capable players/devices).
- The catchup endpoints stream TS per requested window (what the player's
  `buildCatchupSegments` expects), so playback starts immediately. An additional
  HLS-VOD catchup endpoint (`/catchup/<profile>/index.m3u8?playseek=...`) exists
  for testing the daemon's `.m3u8` rewrite directly via curl.
