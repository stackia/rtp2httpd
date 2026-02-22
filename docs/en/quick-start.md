# Quick Start

Language: [中文](../quick-start.md) | [English](quick-start.md)

## One-Command OpenWrt Install (Recommended)

Use the install script to download and install the latest version:

```bash
uclient-fetch -q -O - https://raw.githubusercontent.com/stackia/rtp2httpd/main/scripts/install-openwrt.sh | sh
```

The script will:

- Detect CPU architecture
- Fetch the latest release from GitHub
- Download and install required packages (core + LuCI + language packs)

## Basic Configuration

After install, open LuCI and find "rtp2httpd" under the "Services" menu:

<img width="2048" height="1910" alt="Image" src="https://github.com/user-attachments/assets/4252d5c4-b575-4b5e-a66b-4cabcf4f2cd1" />

### Required Settings

1. **Enable**: Check to enable rtp2httpd
2. **Port**: Default 5140, can be customized
3. **Upstream interface**: Set to the IPTV network interface

### Optional Settings

- **External M3U**: If you have an M3U playlist, set it to use the built-in web player ([details](m3u-integration.md))
- **FCC server**: Configure FCC for fast channel change ([how to obtain](fcc-setup.md))
- **Video snapshots**: Enable channel preview snapshots ([setup](video-snapshot.md))

## Test Access

After configuration, test with these URLs:

```bash
# Access an RTP multicast stream
http://router-ip:5140/rtp/239.253.64.120:5140

# Status page
http://router-ip:5140/status

# M3U playlist (if configured)
http://router-ip:5140/playlist.m3u

# Built-in player (requires M3U)
http://router-ip:5140/player
```

## Use the Built-in Player

If M3U is configured, open the built-in player in a browser:

```bash
http://router-ip:5140/player
```

The built-in player provides:

- Auto-loaded channel list (from configured M3U)
- Live playback
- Catchup playback (if the channel supports it)
- FCC fast channel change
- Responsive UI for mobile devices

**Note**: Playback depends on browser decoding. Some codecs may not play. Use modern Chrome/Edge/Safari.

## Use in Other Players

Add `http://router-ip:5140/playlist.m3u` to any IPTV player.

## View Logs

You can check logs in three ways:

1. Visit `/status` and view logs at the bottom
2. OpenWrt LuCI: "Status" -> "System Log"
3. SSH into the router and run `logread -e rtp2httpd`

## Next Steps

- [Installation](installation.md): Docker, static binary, source builds
- [M3U Integration](m3u-integration.md): Playlist detection and conversion
- [URL Formats](url-formats.md): Supported URL formats
- [Configuration Reference](configuration.md): All config options
- [FCC Setup](fcc-setup.md): Enable millisecond-level channel switching
