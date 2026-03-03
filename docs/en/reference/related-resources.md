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
- [Shanghai Telecom ONT Stick / ONU Bridge Mode: Internet + IPTV STB + udpxy/rtp2httpd + VoIP on OpenWrt](https://www.right.com.cn/forum/thread-8268077-1-1.html)
- [Hunan Telecom OpenWrt Dialing IPTV Complete Tutorial | Intranet Integration Multicast-to-Unicast + Unicast Playback All Settled](https://mp.weixin.qq.com/s/_hEVbrgHll_qIePXGtATTw)
- [Key Concepts You Will Encounter When Tinkering with IPTV: IGMP Snooping, IGMP Proxy, and Flooding Explained](https://mp.weixin.qq.com/s/oKS-tl1-hqgcZ_H01CTtXQ)
- [What Are FCC and FEC in IPTV? Why Are Some Sources "Much More Advanced"?](https://mp.weixin.qq.com/s/5l2Cg204YdqtWAV-RnqiYw)
- [The Final Step of IPTV Tinkering: Different Ways to Write Playlists, Explained in One Article](https://mp.weixin.qq.com/s/wZpO74_NJvlwBbI9uvEhWw)
- [Step-by-Step Guide to Zhejiang Telecom IPTV Integration: Watch TV with Peace of Mind](https://zeaurx.com/archives/iptv)

### Video Tutorials

- [Bypass Router IPTV Plugin Usage Guide](https://www.bilibili.com/video/BV1ioiKBNE8t/)
- [Multicast-to-Unicast Series Episode 2: Use rtp2httpd Plugin to Watch IPTV on All Household Devices](https://www.bilibili.com/video/BV1Zhr4B3ELy/)

## Firmware Ecosystem

The following firmware distributions have rtp2httpd built in, or offer it for direct installation from their app stores or official package repositories.

> [!IMPORTANT]
> To ensure stability, firmware distributions typically ship or list older versions of rtp2httpd. If you want the latest version, it is recommended to install rtp2httpd using the [officially supported installation methods](../guide/installation.md).

- [fnOS](https://www.fnnas.com) (rtp2httpd available in the App Center)
- [iStoreOS](https://site.istoreos.com) (rtp2httpd available in iStore)
- [cooluc's OpenWrt](https://github.com/sbwml/builder) (rtp2httpd built in)
- [AutoBuildImmortalWrt](https://github.com/wukongdaily/AutoBuildImmortalWrt) (rtp2httpd built into [store](https://github.com/wukongdaily/store), easy to build)
- [Pandora QWRT for K2P](https://www.right.com.cn/forum/thread-8346913-1-1.html) (rtp2httpd built in)

## Related Software

### IPTV Players

#### mytv-android

- Project: <https://github.com/mytv-android/mytv-android>

Android IPTV player with support for M3U playlists, FCC fast channel switching, EPG electronic program guide, time-shift playback, and more.

Currently the only player supporting rtp2httpd [video snapshots](../guide/video-snapshot.md).

#### SrcBox

- Project: <https://github.com/CGG888/SrcBox>

Windows IPTV player based on libmpv playback engine and WPF native interface. Supports M3U playlists, FCC fast channel switching, EPG electronic program guide, time-shift playback, UDP multicast optimization, and more.

#### IPTVnator (CGG888 fork)

- Project: <https://github.com/CGG888/iptvnator>

Cross-platform (Windows / macOS / Linux) IPTV player. This fork is enhanced for mainland China IPTV scenarios. Main features:

- Automatically identifies multicast/unicast sources and selects the best playback engine (mpegts.js for multicast, hls.js for unicast)
- Supports time-shift playback
- 4K/HD/SD quality strategy, channels with the same name prioritized by quality
- Smart EPG channel name matching and Chinese localization

### IPTV Subscription and Channel Tools

#### IPTV Checker

- Project: <https://github.com/CGG888/Iptv-Checker>

Docker-based IPTV unicast/multicast batch scanning and detection tool. Main features:

- Batch import multicast stream addresses, automatically detect online status, resolution, encoding, frame rate, etc.
- Filter by online/offline status, search by channel name or address
- Export as TXT or M3U format (M3U supports FCC parameters and catchup playback addresses)
- Channels with the same name prioritized by quality (multicast 4K > HD > SD > unicast)
- Version management, supports saving and loading detection results

#### iptv-tool

- Project: <https://github.com/taksssss/iptv-tool>

Docker-based comprehensive IPTV management toolbox integrating EPG program guide management, live source management, and channel logo management. Main features:

- Supports multiple formats including DIYP/Baichuan, Super Live, XMLTV, and more
- Live source aggregation (TXT/M3U), speed testing and validation, live source proxying
- Fuzzy channel logo matching, supports tvbox interface
- Channel aliases, regex matching, supports Traditional Chinese
- Scheduled data updates, caching support (Memcached/Redis)

#### IPTV-channels (Sichuan Telecom)

- Project: <https://github.com/mytv-android/IPTV-channels>

Docker-based IPTV subscription acquisition tool for Sichuan Telecom. Automatically fetches channel addresses and EPG from the IPTV intranet and generates M3U playlists with FCC, FEC, and unicast playback addresses.

#### iptv-cd-telecom (Sichuan Telecom)

- Project: <https://github.com/suzukua/iptv-cd-telecom>

Chengdu/Sichuan Telecom IPTV live source project offering both official unicast sources and multicast-to-unicast access methods. Supports time-shift playback, FCC fast channel switching, and EPG electronic program guide. Compatible with mainstream players including tvbox, KODI, APTV, and mytv-android. Provides an online playlist generation service with customizable FCC, RTSP proxy, r2h-token, and other parameters.

#### beijing-unicom-iptv-playlist (Beijing Unicom)

- Project: <https://github.com/zzzz0317/beijing-unicom-iptv-playlist>

Beijing Unicom IPTV playlist, updated automatically every day. Provides M3U playlists in multiple formats including multicast, unicast, and RTSP, with support for time-shift playback and EPG. Includes a companion online playback link generator and Python conversion tool (generator.py) for flexible customization of live sources, time-shift sources, proxy addresses, and other parameters. Supports Flask/FastAPI dynamic service deployment.

#### plsy1/iptv (Shandong Unicom)

- Project: <https://github.com/plsy1/iptv>

Shandong Unicom IPTV playlist covering multicast sources for cities across Shandong province including Jinan, Qingdao, Yantai, and Weifang. Also provides unicast sources in multiple formats (APTV, Cool 9, rtp2httpd). Includes companion tools for set-top box login authentication simulation, EPG program guide, RTSP proxy, data capture, and M3U generation.

#### Shanghai-IPTV (Shanghai Telecom)

- Project: <https://github.com/ihipop/Shanghai-IPTV>

Shanghai Telecom IPTV multicast program guide management tool based on PHP + SQLite. Supports TXT format import and M3U8 format export. Features include multiple sources, multiple resolutions (4K/HD/SD/LD), multiple EPG source mapping, UDPXY/rtp2httpd conversion, FCC fast channel switching, channel logo management, and more. Can serve online playlists via PHP's built-in web server.
