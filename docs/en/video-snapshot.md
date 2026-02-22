# Video Snapshots (Previews)

Language: [中文](../video-snapshot.md) | [English](video-snapshot.md)

rtp2httpd supports generating video snapshots with FFmpeg. If your player integrates this feature, channel preview images load very quickly.

## Features

- **Fast generation**: With FCC, snapshots usually return within 0.3s
- **Keyframe extraction**: Captures I-frames for conversion
- **JPEG output**: Standard JPEG, widely compatible
- **Lower client load**: Players can show previews without decoding the stream

## FFmpeg

### Install FFmpeg

Snapshots require FFmpeg for decoding. Install FFmpeg manually.

**Important**: Do not use OpenWrt's official `ffmpeg` package. It lacks h264/hevc codecs and cannot decode IPTV streams.

#### Recommended: Static Build

Download a static build from [johnvansickle.com](https://johnvansickle.com/ffmpeg/):

```bash
# Download FFmpeg (amd64 example)
cd /tmp
wget https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz
tar xf ffmpeg-release-amd64-static.tar.xz

# Copy into system path
sudo cp ffmpeg-*-static/ffmpeg /usr/local/bin/
sudo chmod +x /usr/local/bin/ffmpeg

# Configure rtp2httpd to use this FFmpeg
# In config file:
# ffmpeg-path = /usr/local/bin/ffmpeg
```

## Enable Video Snapshots

Snapshots are disabled by default and must be enabled manually.

This feature has higher hardware requirements. Only enable it on capable x86 devices.

### Command line

```bash
rtp2httpd --video-snapshot --ffmpeg-path /usr/bin/ffmpeg --ffmpeg-args "-hwaccel none"
```

### Config file

```ini
[global]
# Enable video snapshots
video-snapshot = yes

# FFmpeg executable path (optional, default: ffmpeg)
ffmpeg-path = /usr/bin/ffmpeg

# Extra FFmpeg args (optional, default: -hwaccel none)
ffmpeg-args = -hwaccel none
```

## Request Snapshots

There are three ways to request snapshots:

### Method 1: URL query

Add `snapshot=1` to any stream URL:

```url
http://192.168.1.1:5140/rtp/239.253.64.120:5140?snapshot=1
http://192.168.1.1:5140/CCTV-1?snapshot=1
```

### Method 2: Accept header

```bash
curl -H "Accept: image/jpeg" http://192.168.1.1:5140/rtp/239.253.64.120:5140
```

### Method 3: Custom header

```bash
curl -H "X-Request-Snapshot: 1" http://192.168.1.1:5140/rtp/239.253.64.120:5140
```

### ffmpeg-path

Specify the FFmpeg executable path.

- **Default**: `ffmpeg` (from system PATH)
- **Use cases**:
  - FFmpeg is not in PATH
  - You need a specific FFmpeg version
  - You use a custom build

**Example**:

```ini
[global]
ffmpeg-path = /usr/local/bin/ffmpeg
```

### ffmpeg-args

Extra arguments passed to FFmpeg, mainly for hardware acceleration.

- **Default**: `-hwaccel none` (best compatibility)
- **Common options**:
  - `-hwaccel none`: Disable hardware acceleration
  - `-hwaccel auto`: Auto-detect hardware acceleration
  - `-hwaccel vaapi`: VA-API (Intel GPU)
  - `-hwaccel v4l2m2m`: V4L2 (embedded SoC)
  - `-hwaccel qsv`: Intel Quick Sync Video

**Examples**:

```ini
[global]
# VA-API (Intel GPU)
ffmpeg-args = -hwaccel vaapi

# Or auto-detect
ffmpeg-args = -hwaccel auto
```

## Hardware Acceleration

### Intel GPU (VA-API)

If your device has an Intel iGPU, use VA-API:

```ini
[global]
video-snapshot = yes
ffmpeg-args = -hwaccel vaapi
```

For prebuilt FFmpeg for Intel GPU, see: [rtp2httpd#37](https://github.com/stackia/rtp2httpd/issues/37)

### Embedded Devices (V4L2)

Some embedded SoCs support V4L2 acceleration:

```ini
[global]
video-snapshot = yes
ffmpeg-args = -hwaccel v4l2m2m
```

### Performance Tips

- On low-CPU devices without hardware acceleration, snapshot generation can be CPU intensive
- Start with `-hwaccel none` to verify functionality
- If stable, enable hardware acceleration to reduce CPU usage

## Response Time

- **With FCC**: typically within 0.3s (fast keyframe retrieval)
- **Without FCC**: up to ~1s (wait for next IDR frame)

Most operator multicast streams send one IDR per second, so without FCC you may wait up to 1 second.

## Player Integration Tips

If you develop a player, consider this integration:

1. **Request snapshots with a custom header**:

   ```http
   GET /rtp/239.253.64.120:5140 HTTP/1.1
   X-Request-Snapshot: 1
   ```

2. **Handle Content-Type**:

   - If `Content-Type: image/jpeg`: render the JPEG
   - Otherwise: server does not support snapshots, decode the media stream

3. **Compatibility**: This approach works with rtp2httpd and other servers that do not support snapshots.

## Troubleshooting

### Snapshot requests return video instead of images

Possible causes:

1. **video-snapshot not enabled**: Check config or CLI
2. **FFmpeg unavailable**: Verify FFmpeg installation
3. **FFmpeg decode failure**: Check rtp2httpd logs

### FFmpeg decode failures

Possible causes:

1. **Missing codecs**: OpenWrt FFmpeg lacks h264/hevc codecs
2. **No hardware acceleration**: Try `-hwaccel none`
3. **Hardware busy**: Some decoders have limits; too many concurrent requests can fail

### High CPU usage

- High CPU usage without hardware acceleration is expected
- Mitigation:
  1. Enable hardware acceleration (if supported)
  2. Reduce concurrent snapshot requests
  3. Lower preview concurrency in the player

## Related Docs

- [URL Formats](url-formats.md): Snapshot URL format
- [Configuration Reference](configuration.md): Snapshot configuration
- [FCC Setup](fcc-setup.md): Faster snapshots with FCC
