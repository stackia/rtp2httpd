# Related Tutorials and Software

This page aggregates community-contributed IPTV setup tutorials, companion tools, and player software to help users quickly find needed resources.

> [!NOTE]
> The following resources are contributed and maintained by community users and are not part of the rtp2httpd project itself. For issues, please contact the respective project maintainers.

## IPTV Setup Tutorials

If you are new to setting up IPTV multicast forwarding services and unfamiliar with related networking concepts (DHCP authentication, routing, multicast, firewalls), you can refer to the following tutorials:

- [Zhejiang Hangzhou Telecom IPTV Intranet Integration Tutorial: Watch IPTV on Any Device in Your LAN](https://baiyun.me/zhejiang-hangzhou-telecom-iptv)
- [Automatically Capture IPTV Unicast Addresses for Time-shift Playback](https://www.bandwh.com/net/2571.html)
- [K2P Using rtp2httpd to Flash OpenWrt for Single-line Dual-network Integration to Perfectly Watch IPTV - Simple Detailed Guide](https://www.right.com.cn/forum/thread-8457970-1-1.html)
- [Chongqing Telecom IPTV Intranet Integration Packet Capture rtp2httpd](https://www.right.com.cn/forum/thread-8457356-1-1.html)
- [Zhejiang Telecom IPTV Multicast to Unicast rtp2httpd to Remove Screen Artifacts](https://www.right.com.cn/forum/thread-8452510-1-1.html)
- [Using Rtp2httpd Cool 9 Zhejiang Telecom IPTV Unicast Playback](https://www.right.com.cn/forum/thread-8453715-1-1.html)
- [Hunan Telecom OpenWrt Dialing IPTV Complete Tutorial | Intranet Integration Multicast-to-Unicast + Unicast Playback All Settled](https://mp.weixin.qq.com/s/_hEVbrgHll_qIePXGtATTw)

### Video Tutorials

- [Bypass Router IPTV Plugin Usage Guide](https://www.bilibili.com/video/BV1ioiKBNE8t/)
- [Multicast-to-Unicast Series Episode 2: Use rtp2httpd Plugin to Watch IPTV on All Household Devices](https://www.bilibili.com/video/BV1Zhr4B3ELy/)

## Related Software

### IPTV Players

#### mytv-android

- Project: <https://github.com/mytv-android/mytv-android>

Android IPTV player with support for FCC fast channel switching, EPG electronic program guide, time-shift playback, and more.

#### IPTV-Player

- Project: <https://github.com/CGG888/IPTV-Player>

Windows IPTV player based on libmpv playback engine and WPF interface. Supports M3U playlists, EPG electronic program guide, time-shift playback, FCC fast channel switching, UDP multicast optimization, and more.

#### iptvnator

- Project: <https://github.com/CGG888/iptvnator>

Windows IPTV player enhanced for mainland China IPTV scenarios. Main features:

- Automatically identifies multicast/unicast sources and selects the best playback engine (mpegts.js for multicast, hls.js for unicast)
- Supports XMLTV-based time-shift playback with a default 7-day time-shift window
- 4K/HD/SD quality strategy, channels with the same name prioritized by quality
- Smart EPG channel name matching and Chinese localization

### IPTV Subscription and Channel Tools

#### IPTV-channels

- Project: <https://github.com/mytv-android/IPTV-channels>

Docker-based IPTV subscription acquisition tool (Sichuan Telecom), automatically generates M3U playlists with FCC, FEC, and unicast playback addresses.

#### Iptv-Checker

- Project: <https://github.com/CGG888/Iptv-Checker>

Docker-based IPTV unicast/multicast batch scanning and detection tool. Main features:

- Batch import multicast stream addresses, automatically detect online status, resolution, encoding, frame rate, etc.
- Filter by online/offline status, search by channel name or address
- Export as TXT or M3U format (M3U supports FCC parameters and catchup playback addresses)
- Channels with the same name prioritized by quality (multicast 4K > HD > SD > unicast)
- Version management, supports saving and loading detection results
