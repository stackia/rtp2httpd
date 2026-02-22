# <img src="./icon.svg" width="24" height="24"> rtp2httpd - IPTV Streaming Relay Server

Language: [中文](README.md) | [English](README.en.md)

rtp2httpd is a multimedia stream relay server. This project is a complete rewrite of [oskar456/rtp2httpd](https://github.com/oskar456/rtp2httpd), adding many new features and tailored for Mainland China IPTV environments.

rtp2httpd converts multicast RTP/UDP and RTSP streams to HTTP unicast, and implements carrier-grade FCC ([Fast Channel Change](https://blog.csdn.net/yangzex/article/details/131328837)) for near-instant channel switching. It can act as a seamless replacement for `udpxy` and `msd_lite`, delivering an experience close to native set-top boxes.

## ✨ Core Features

### 📡 Multi-Protocol Support

- **RTP->HTTP**: Convert multicast RTP/UDP streams to standard HTTP streams
- **RTSP->HTTP**: Convert RTSP to HTTP video streams with a full RTSP/RTP stack and UDP NAT traversal (STUN)
  - Enables catchup playback for IPTV RTSP time-shift sources
- **HTTP->HTTP**: Full reverse proxy to relay IPTV intranet HLS sources to LAN/WAN
- **UDPxy Compatibility**: Fully compatible with UDPxy URL formats
- **M3U Playlist Integration**: Supports M3U/M3U8 with automatic URL detection and conversion
  - Supports external M3U URLs
  - Smart detection for RTP/RTSP URLs and conversion to HTTP proxy format
  - Automatic handling of catchup-source time-shift URLs
  - Access the converted playlist via `http://<server:port>/playlist.m3u`
- **Loss/Jitter Resilience**: Out-of-order recovery and FEC forward error correction
  - Reorders out-of-order RTP packets to reduce artifacts caused by jitter
  - Reed-Solomon FEC redundancy for mild packet loss (requires upstream multicast FEC)
- **Channel Snapshots**: Fetch channel snapshots via HTTP to reduce decoder load on clients

### ⚡ FCC Fast Channel Change

- **Carrier FCC Protocol Support**: Works with carrier FCC servers for millisecond-level channel switching
- **Fast Decode**: FCC ensures IDR frames are delivered quickly for instant playback

### 📊 Real-Time Status Monitoring

- **Web Status Page**: Visit `http://<server:port>/status` for live server stats
- **Client Connection Stats**: IP, state, bandwidth usage, and transfer volumes per connection
- **Live Logs**: Real-time log view with dynamic log level control
- **Remote Management**: Force disconnect clients from the web UI

### 🎬 Built-in Player

- **Browser Playback**: Modern embedded web player with responsive desktop/mobile UI
- **Fast Startup**: Works with FCC for fast start and fast channel switching
- **Time-Shift & Catchup**: Supports EPG and catchup playback (requires RTSP catchup source)
- **Zero Overhead**: Pure web frontend, no decoding/transcoding load on rtp2httpd

### 🚀 Performance Optimizations

- **Non-blocking IO**: epoll-based event model for high concurrency
- **Multi-core Scaling**: Multiple worker processes to utilize multi-core CPUs
- **Buffer Pooling**: Pre-allocated pools, dynamic sharing across clients to avoid slow-client stalls
- **Zero-copy**: Supports Linux MSG_ZEROCOPY to avoid user/kernel copies
- **Lightweight**: Pure C with minimal dependencies, runs well on embedded devices
  - Binary size is about 340KB (x86_64) with all web assets embedded
- See the **[Performance Benchmark](docs/en/benchmark.md)** (vs msd_lite, udpxy, tvgate)

## 📹 Demos

### Fast Channel Change + Catchup

https://github.com/user-attachments/assets/a8c9c60f-ebc3-49a8-b374-f579f8e34d92

> **Tip**: Fast channel change works best with IPTV-optimized players such as [mytv-android](https://github.com/mytv-android/mytv-android) / [TiviMate](https://tivimate.com) / [Cloud Stream](https://apps.apple.com/us/app/cloud-stream-iptv-player/id1138002135). The demo uses TiviMate.
> General players like PotPlayer / IINA are not optimized for fast start, so FCC benefits are limited.

### Built-in Player

https://github.com/user-attachments/assets/d676b8c1-7017-48a1-814c-caab0054b361

> Configure an M3U playlist and open `http://<server:port>/player` in a browser.
> Browser decoding limits apply (Chrome cannot play AC3 audio for Beijing TV 4K, iOS cannot play MP2 audio for HD/SD channels).

### Real-Time Status Monitoring

<img width="2586" height="1814" alt="Image" src="https://github.com/user-attachments/assets/8838ee26-aa97-4d31-8031-afe8998a7fba" />

### 25 x 1080p Multicast Streams Playing Simultaneously

https://github.com/user-attachments/assets/fedc0c28-f9ac-4675-9b19-a8efdd062506

> Single stream bitrate: 8 Mbps. Total CPU usage is 25% of a single core (i3-N305) with 4MB memory usage.

## 🚀 Quick Start

### One-Command OpenWrt Install/Update

```bash
uclient-fetch -q -O - https://raw.githubusercontent.com/stackia/rtp2httpd/main/scripts/install-openwrt.sh | sh
```

After installation, find "rtp2httpd" under the "Services" menu in the LuCI admin UI to configure it.

If LuCI behaves oddly after an update, **Ctrl+F5 refresh** or **clear browser cache** or **use incognito mode**.

If the LuCI entry does not appear after install, your LuCI version may be too old to support JS-based LuCI apps. Consider updating your firmware. Alternatively, edit `/etc/config/rtp2httpd` manually (set `disabled` to 0) and restart via `/etc/init.d/rtp2httpd restart`.

> Some community members have also developed a Lua version of luci-app-rtp2httpd
>
> - <https://www.right.com.cn/forum/thread-8461513-1-1.html>
> - <https://github.com/jarod360/rtp2httpd/releases>

### Other Platforms

rtp2httpd supports multiple deployment options:

- **Static binary**: Runs on any Linux system
- **Docker container**: Containerized deployment
- **Build from source**: Compile from source, or include as an OpenWrt feed

See the [Installation Guide](docs/en/installation.md).

## 📖 Documentation

- **[Quick Start](docs/en/quick-start.md)**: OpenWrt quick configuration
- **[Installation](docs/en/installation.md)**: Installation options
- **[URL Formats](docs/en/url-formats.md)**: Supported URL formats and protocols
- **[M3U Integration](docs/en/m3u-integration.md)**: M3U configuration and usage
- **[Configuration Reference](docs/en/configuration.md)**: Full configuration options
- **[FCC Setup](docs/en/fcc-setup.md)**: Enable millisecond-level fast channel change
- **[Video Snapshots](docs/en/video-snapshot.md)**: Channel preview configuration

If you are new to IPTV multicast relay services and related network topics (DHCP auth, routing, multicast, firewalls), these guides are also helpful:

- [Zhejiang Hangzhou Telecom IPTV Intranet Integration Guide](https://baiyun.me/zhejiang-hangzhou-telecom-iptv)
- [Auto-fetch IPTV unicast addresses for time-shift playback](https://www.bandwh.com/net/2571.html)
- [K2P OpenWrt IPTV full guide with rtp2httpd](https://www.right.com.cn/forum/thread-8457970-1-1.html)
- [Chongqing Telecom IPTV rtp2httpd capture guide](https://www.right.com.cn/forum/thread-8457356-1-1.html)
- [Zhejiang Telecom IPTV multicast to unicast, rtp2httpd](https://www.right.com.cn/forum/thread-8452510-1-1.html)
- [Rtp2httpd on Cool 9 Zhejiang Telecom IPTV](https://www.right.com.cn/forum/thread-8453715-1-1.html)
- [Hunan Telecom OpenWrt IPTV end-to-end guide](https://mp.weixin.qq.com/s/_hEVbrgHll_qIePXGtATTw)
- [📺 Bypass Router IPTV Plugin Guide](https://www.bilibili.com/video/BV1ioiKBNE8t/)
- [📺 Multicast to unicast series part 2](https://www.bilibili.com/video/BV1Zhr4B3ELy/)

## 📄 License

This project is released under the GNU General Public License v2.0. This means:

- ✅ You can deploy in commercial environments (e.g., internal enterprise use)
- ✅ You can offer paid IPTV relay services based on it
- ✅ You can use it in paid IPTV consulting services
- ✅ You can sell hardware devices that include this software
- ⚠️ If you modify the code, you must publish the modified source code
- ⚠️ If you distribute binaries, you must also provide the source code
- ⚠️ You cannot close-source it and sell it

## 🙏 Acknowledgements

- The developers of the original project [oskar456/rtp2httpd](https://github.com/oskar456/rtp2httpd)
- Professionals who shared FCC protocol details publicly
- All users who tested and provided feedback
