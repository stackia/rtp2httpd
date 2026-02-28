# Video Snapshot Configuration

rtp2httpd supports using FFmpeg to generate snapshot functionality for video streams. If a player integrates this feature, it will achieve extremely fast channel preview image loading speed.

> [!IMPORTANT]
> This feature requires player support. Currently, the only known player that supports rtp2httpd video snapshots is [mytv-android](https://github.com/mytv-android/mytv-android).

## Features

- **Fast generation**: When used with FCC, snapshots are typically returned within 0.3 seconds
- **Automatic keyframe extraction**: Captures I-frames from video stream for transcoding
- **JPEG format**: Returns standard JPEG images with good compatibility
- **Reduces player load**: No need for the player to decode video stream to display preview images

## FFmpeg

### Installing FFmpeg

The video snapshot feature depends on FFmpeg for decoding capabilities. Please install FFmpeg manually first.

> [!CAUTION]
> Do not use the `ffmpeg` package from OpenWrt official repositories. It has stripped h264/hevc codecs, which will prevent video stream decoding.

> [!TIP]
> For fnOS, FFmpeg with hardware acceleration is generally built-in and can be used directly.

#### Recommended Method: Download Static Compiled Version

Download statically compiled FFmpeg from [johnvansickle.com](https://johnvansickle.com/ffmpeg/) (note that this version does not support hardware decoding):

```bash
# Download FFmpeg (using amd64 as example)
cd /tmp
wget https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz
tar xf ffmpeg-release-amd64-static.tar.xz

# Copy to system directory
sudo cp ffmpeg-*-static/ffmpeg /usr/local/bin/
sudo chmod +x /usr/local/bin/ffmpeg

# Configure rtp2httpd to use this FFmpeg
# Set in configuration file:
# ffmpeg-path = /usr/local/bin/ffmpeg
```

## Enabling Video Snapshot

The video snapshot feature is disabled by default and needs to be manually enabled.

This feature has certain hardware requirements. Only consider enabling it on powerful x86 devices.

### Command Line Method

```bash
rtp2httpd --video-snapshot --ffmpeg-path /usr/bin/ffmpeg --ffmpeg-args "-hwaccel none"
```

### Configuration File Method

```ini
[global]
# Enable video snapshot feature
video-snapshot = yes

# FFmpeg executable path (optional, default: ffmpeg)
ffmpeg-path = /usr/bin/ffmpeg

# FFmpeg additional arguments (optional, default: -hwaccel none)
ffmpeg-args = -hwaccel none
```

### ffmpeg-path Parameter

Specifies the path to the FFmpeg executable.

- **Default value**: `ffmpeg` (uses ffmpeg from system PATH)
- **Use cases**:
  - FFmpeg is not in system PATH
  - Need to use a specific version of FFmpeg
  - Using custom compiled FFmpeg

**Example**:

```ini
[global]
ffmpeg-path = /usr/local/bin/ffmpeg
```

### ffmpeg-args Parameter

Specifies additional arguments to pass to FFmpeg, mainly for hardware acceleration configuration.

- **Default value**: `-hwaccel none` (disable hardware acceleration, best compatibility)
- **Common options**:
  - `-hwaccel none`: Disable hardware acceleration
  - `-hwaccel auto`: Auto-detect and use hardware acceleration
  - `-hwaccel vaapi`: Use VA-API hardware acceleration (Intel GPU)
  - `-hwaccel v4l2m2m`: Use V4L2 hardware acceleration (embedded SoC)
  - `-hwaccel qsv`: Use Intel Quick Sync Video acceleration

**Example**:

```ini
[global]
# Use VA-API hardware acceleration (Intel GPU)
ffmpeg-args = -hwaccel vaapi

# Or use auto-detection
ffmpeg-args = -hwaccel auto
```

## Hardware Acceleration Configuration

### Intel GPU (VA-API)

If your device has an Intel integrated GPU, you can use VA-API hardware acceleration:

```ini
[global]
video-snapshot = yes
ffmpeg-args = -hwaccel vaapi
```

For precompiled FFmpeg for Intel GPU, please refer to: [rtp2httpd#37](https://github.com/stackia/rtp2httpd/issues/37)

### Embedded Devices (V4L2)

Some embedded SoCs support V4L2 hardware acceleration:

```ini
[global]
video-snapshot = yes
ffmpeg-args = -hwaccel v4l2m2m
```

### Performance Tips

- On devices with low CPU performance, without hardware acceleration support, generating snapshots may produce high CPU usage
- It is recommended to first test with `-hwaccel none` to verify the feature works properly
- After confirming it works, try enabling hardware acceleration to reduce CPU usage

## Response Time

- **Using FCC**: Snapshots are typically returned within 0.3 seconds (fast keyframe acquisition)
- **Not using FCC**: Maximum of about 1 second to return (waiting for next IDR frame)

Most operator multicast streams send one IDR frame per second, so without FCC, you may need to wait up to 1 second.

## Player Integration Recommendations

If you are a player developer, it is recommended to integrate the preview image feature as follows:

1. **Include a custom request header when requesting snapshot**:

   ```http
   GET /rtp/239.253.64.120:5140 HTTP/1.1
   X-Request-Snapshot: 1
   ```

2. **Determine handling based on response Content-Type**:

   - If response is `Content-Type: image/jpeg`: Render JPEG image directly
   - If response is another type: Server does not support snapshot, attempt to decode media stream

3. **Compatibility**: This method can be compatible with both rtp2httpd and other streaming servers that do not support snapshots

In addition to `X-Request-Snapshot: 1`, there are two other request methods to obtain snapshots:

### URL Query Parameter

Add `snapshot=1` parameter after any streaming URL:

```url
http://192.168.1.1:5140/rtp/239.253.64.120:5140?snapshot=1
http://192.168.1.1:5140/CCTV-1?snapshot=1
```

### Accept Request Header

```bash
curl -H "Accept: image/jpeg" http://192.168.1.1:5140/rtp/239.253.64.120:5140
```

## Troubleshooting

### Snapshot Request Returns Video Stream Instead of Image

Possible causes:

1. **video-snapshot not enabled**: Check configuration file or command line parameters
2. **FFmpeg unavailable**: Check if FFmpeg is installed correctly
3. **FFmpeg decoding failed**: Check rtp2httpd logs

### FFmpeg Decoding Failed

Possible causes:

1. **Missing codecs**: OpenWrt official repository FFmpeg lacks h264/hevc codecs
2. **Hardware acceleration not supported**: Try using `-hwaccel none` instead
3. **Hardware busy**: Some hardware decoders have limits on concurrent media stream decoding. Too many concurrent requests may cause hardware busy errors.

### High CPU Usage

- High CPU usage after disabling hardware acceleration is normal
- Solutions:
  1. Use hardware acceleration (if device supports it)
  2. Reduce the number of clients simultaneously requesting snapshots
  3. Lower preview image request concurrency in player settings

## Related Documentation

- [URL Format Specification](/en/guide/url-formats): Snapshot URL format
- [Configuration Reference](/en/reference/configuration): Video snapshot related configuration
- [FCC Fast Channel Change Configuration](/en/guide/fcc-setup): Achieve faster snapshot speed with FCC
