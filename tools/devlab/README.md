# devlab — mock IPTV upstreams for web-player development

`devlab.py` spins up self-contained upstream servers (no external network) that
rtp2httpd can proxy, so you can develop the web player against the scenarios it
needs to support:

| Scenario        | Delivery            | rtp2httpd proxy | Codecs                    |
| --------------- | ------------------- | --------------- | ------------------------- |
| HLS live        | HTTP `.m3u8` + TS   | `/http`         | `h264-mp2`, `hevc-aac`    |
| HLS catchup     | HTTP TS (`playseek`)| `/http`         | `h264-mp2`, `hevc-aac`    |
| mpegts catchup  | RTSP TS (`playseek`)| `/rtsp`         | `h264-mp2`, `hevc-aac`    |

(Plain multicast mpegts live is already covered without this lab — see the
`build-run` skill.)

- `h264-mp2` = H.264 video + MPEG-1/2 Layer II audio
- `hevc-aac` = H.265/HEVC video + AAC audio

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

- HEVC video playback in the browser depends on the browser's Media Source
  Extensions HEVC support; Chromium on Linux often lacks it even though the
  stream/relay is correct. Use `ffprobe`/frame extraction to validate the relay.
- The catchup endpoints stream TS per requested window (what the player's
  `buildCatchupSegments` expects), so playback starts immediately. An additional
  HLS-VOD catchup endpoint (`/catchup/<profile>/index.m3u8?playseek=...`) exists
  for testing the daemon's `.m3u8` rewrite directly via curl.
