# devlab — mock IPTV upstreams for web-player development

`devlab.py` spins up self-contained upstream servers (no external network) that
rtp2httpd can proxy, so you can develop the web player against the scenarios it
needs to support:

| Scenario           | Delivery                  | rtp2httpd proxy | Codecs                              |
| ------------------ | ------------------------- | --------------- | ----------------------------------- |
| HLS-TS live        | HTTP `.m3u8` + `.ts`      | `/http`         | `h264-mp2`, `hevc-aac`              |
| HLS-fMP4 live      | HTTP `.m3u8` + `.m4s`     | `/http`         | `h264-aac`, `hevc-aac`              |
| HLS catchup        | HTTP HLS VOD (`playseek`) | `/http`         | all of the above                    |
| mpegts (RTSP)      | RTSP TS live + catchup    | `/rtsp`         | `h264-mp2`, `hevc-aac`              |
| mpegts (multicast) | RTP multicast live        | `/rtp`          | `h264-mp2`, `hevc-ac3`, `hevc-eac3` |
| mpegts (scan)      | RTP multicast live        | `/rtp`          | 1080i / 1080p / 2160p (see below)   |
| external file      | RTP multicast (looped)    | `/rtp`          | whatever the `.ts` file contains    |

- `h264-mp2`  = H.264 video + MPEG-1/2 Layer II audio
- `hevc-aac`  = H.265/HEVC video + AAC audio
- `hevc-ac3`  = H.265/HEVC video + AC-3 audio
- `hevc-eac3` = H.265/HEVC video + E-AC-3 audio

HLS live is offered in both segment specs: **HLS-TS** (MPEG-TS `.ts` segments)
and **HLS-fMP4** (an `init.mp4` referenced via `#EXT-X-MAP` + `.m4s` fragments).
fMP4 carries AAC audio (MP2-in-MP4 is unsupported), so fMP4 channels use AAC.

**HLS catchup** is a real HLS VOD: each `playseek` window returns an
`index.m3u8` (`#EXT-X-PLAYLIST-TYPE:VOD`) listing fixed-duration `.ts` slices.
The playlist is produced instantly; each slice is encoded lazily on first
request with that slice's absolute wall-clock time burned in, so even a
multi-hour window is time-correct without pre-encoding the whole thing.

The generated channel list names RTSP MPEG-TS channels as `mpegts (RTSP)` and
multicast MPEG-TS channels as `mpegts (multicast)`, matching the separate
`RTSP_PROFILES` and `MCAST_PROFILES` sets in `devlab.py`.

Multicast channels use groups `239.255.0.20+` on `--mcast-port` (default 5004).
ffmpeg sends them via the OS default multicast route, and rtp2httpd joins them
without an explicit upstream interface.

## Interlace-scan channels (`mpegts (scan)`)

Channels for the web player's automatic deinterlacing (`MCAST_SCAN_CHANNELS`):

- **mcast 1080i-tff (h264-mp2)** — true interlaced TFF H.264: testsrc2 generated
  at 50 fps, `tinterlace=interleave_top` weaves adjacent frames into the fields
  of one 25 fps frame, so the moving pattern combs on every motion. The player's
  heuristic detector must activate on this channel, the combing must disappear,
  and the field-order vote must pick TFF.
- **mcast 1080i-bff (h264-mp2)** — same content weaved bottom-field-first
  (`interleave_bottom`). The detector must activate and the field-order vote
  must pick BFF; a TFF misdetection shows as juddery back-and-forth motion.
- **mcast 1080p-combed (h264-mp2)** — same weaved TFF content but encoded and
  flagged as progressive (no `fieldorder`, no interlaced encoder flags), so the
  codec-metadata hint stays silent. Only the heuristic comb detector can
  activate deinterlacing — this validates the heuristic path end to end.
- **mcast 1080p (h264-mp2)** — progressive control at the resolution gate; the
  detector must NOT activate (no false positive).
- **mcast 2160p (hevc-aac)** — above-1080 control; deinterlacing is gated off
  regardless of content (browser HEVC support permitting, see Notes).

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
# The script prints the rtp2httpd command.

# 2. in another shell, run rtp2httpd against the generated config
./build/rtp2httpd -c /tmp/r2h-devlab.conf

# 3. open the player and pick a channel
#    http://127.0.0.1:5140/player
```

Requires `ffmpeg` on PATH with `drawtext`, `libx264`, `libx265`, `aac`, and
`mp2`. On macOS with Homebrew, install a full build:

```bash
brew install ffmpeg-full
```

Verify `drawtext` before starting the lab:

```bash
ffmpeg -hide_banner -filters | grep drawtext
```

Defaults: HTTP origin `127.0.0.1:8881`, RTSP origin `127.0.0.1:8554`,
rtp2httpd port `5140`. Run `uv run python tools/devlab/devlab.py --help` for
options.

## Verifying a scenario without the browser

```bash
# live codecs
ffprobe -v error -show_entries stream=codec_type,codec_name \
  "http://127.0.0.1:5140/HLS/HLS%20%28hevc-aac%29"

# catchup: extract a frame and confirm the burned SEEK time matches the request
ffmpeg -ss 9 -i "http://127.0.0.1:5140/mpegts%20%28RTSP%29/mpegts%20%28RTSP%29%20%28h264-mp2%29/catchup?playseek=20260630083000-20260630093000" \
  -frames:v 1 -y /tmp/seek.png
```

## Notes

- HEVC video and AC-3/E-AC-3 audio playback in the browser depend on the
  browser's Media Source Extensions support; Chromium on Linux usually lacks
  both even though the stream/relay is correct. Use `ffprobe`/frame extraction
  to validate the relay (the `hevc-ac3`/`hevc-eac3` channels are mainly for
  relay/transmux development and capable players/devices).
- HLS catchup is an HLS VOD (`m3u8` + `.ts` slices); the player expands
  `catchup-source` per window via `buildCatchupSegments` and the loader detects
  the nested playlist (HLS mode). mpegts/RTSP catchup instead streams continuous
  TS per window.
