# <img src="./icon.svg" width="24" height="24"> rtp2httpd - IPTV 流媒体转发服务器

[>> 访问官方文档网站 <<](https://rtp2httpd.com)

[>> English Documentation <<](https://rtp2httpd.com/en/)

rtp2httpd 是一个多媒体流转发服务器。本项目基于 [oskar456/rtp2httpd](https://github.com/oskar456/rtp2httpd) 做了完全重写，在原项目基础上加入了许多新功能，专为中国大陆 IPTV 环境设计。

rtp2httpd 支持将组播 RTP/UDP 流、RTSP 流转换为 HTTP 单播流，并实现了运营商级的 FCC（[Fast Channel Change](https://blog.csdn.net/yangzex/article/details/131328837)）快速换台协议，可以作为 `udpxy` 和 `msd_lite` 的无缝替代，为 IPTV 用户提供接近原生机顶盒的观看体验。

## ✨ 核心功能特性

### 📡 多协议支持

- **RTP->HTTP**：将组播 RTP/UDP 流转换为标准 HTTP 流
- **RTSP->HTTP**：RTSP 转为 HTTP 视频流，完整支持 RTSP/RTP 协议栈，支持 UDP NAT 穿透 (STUN)
  - 可以实现 IPTV RTSP 时移源的回看
- **HTTP->HTTP**：实现了完整反向代理，可以将 IPTV 内网 HLS 源代理到局域网、公网，方便观看
- **udpxy 兼容性**：完全兼容 udpxy URL 格式
- **M3U 播放列表集成**：支持 M3U/M3U8 格式，自动识别并转换节目地址，提供标准化的播放列表
  - 支持外部 M3U URL
  - 智能识别 RTP/RTSP URL 并转换为 HTTP 代理格式
  - 自动处理 catchup-source 时移回看地址
  - 通过 `http://<server:port>/playlist.m3u` 访问转换后的播放列表
- **抗丢包抗抖动**：支持乱序恢复、FEC 前向纠错技术，保证播放质量
  - 自动纠正乱序到达的 RTP 包，消除网络抖动导致的花屏
  - 支持 Reed-Solomon FEC 冗余恢复，可抵抗轻度丢包（需组播上游支持 FEC）
- **频道快照**：支持通过 HTTP 请求快速获取频道的快照图片，降低播放端解码压力

### ⚡ FCC 快速换台技术

- **支持运营商 FCC 协议**：搭配运营商 FCC 服务器，实现毫秒级换台响应，媲美原生 IPTV 机顶盒
- **快速解码**：FCC 保证了换台时迅速提供 IDR 帧，可供播放器立即解码

### 📊 实时状态监控

- **Web 状态页面**：通过浏览器访问 `http://<server:port>/status` 查看实时运行状态
- **客户端连接统计**：显示每个连接的 IP、状态、带宽使用、传输数据量
- **系统日志查看**：实时查看服务器日志，支持动态调整日志级别
- **远程管理功能**：通过 Web 界面强制断开客户端连接

### 🎬 内置播放器

- **浏览器直接使用**：内置基于 Web 的现代化播放器界面，可以在浏览器直接打开播放，桌面/移动端 UI 自适应
- **快速起播**：搭配 FCC 可实现快速起播、快速换台
- **支持时移和回看**：支持 EPG 电子节目单，支持时移和回看（需要有 RTSP 回看源）
- **零开销**：纯 Web 前端实现，对 rtp2httpd 运行几乎没有资源占用（无解码转码开销）

### 🚀 高性能优化

- **非阻塞 IO 模型**：使用 epoll 事件驱动，高效处理大量并发连接
- **多核优化**：支持多 worker 进程，充分利用多核 CPU 提高最大吞吐量
- **缓冲池优化**：预分配缓冲池，避免频繁内存分配，多客户端根据负载动态共享，避免慢客户端吃满资源
- **零拷贝技术**：支持 Linux 内核 MSG_ZEROCOPY 特性，避免数据在用户态和内核态之间的拷贝
- **轻量化**：使用纯 C 语言编写，零依赖，小巧简洁，适合运行在各种嵌入式设备上（路由器、光猫、NAS 等）
  - 程序大小仅 340KB (x86_64)，并内置了 Web 播放器所有前端资源
- 查看 **[性能测试报告](https://rtp2httpd.com/reference/benchmark)**（与 msd_lite、udpxy、tvgate 的性能对比）

## 📹 演示效果

### 快速换台 + 时移回看

https://github.com/user-attachments/assets/a8c9c60f-ebc3-49a8-b374-f579f8e34d92

> [!TIP]
> 快速换台需要使用针对 IPTV 优化的播放器，例如 [mytv-android](https://github.com/mytv-android/mytv-android) / [TiviMate](https://tivimate.com) / [Cloud Stream](https://apps.apple.com/us/app/cloud-stream-iptv-player/id1138002135) 等（视频中的播放器是 TiviMate）。
> 常见普通播放器，例如 PotPlayer / IINA 等，没有专门优化起播速度，FCC 效果不明显。

### 内置播放器

https://github.com/user-attachments/assets/d676b8c1-7017-48a1-814c-caab0054b361

> [!TIP]
> 需要配置 M3U 播放列表后使用，通过浏览器访问 `http://<server:port>/player` 即可打开。
> 受限于浏览器解码能力，一些频道可能不支持（表现为无音频、画面黑屏）。

### 实时状态监控

<img width="2586" height="1814" alt="Image" src="https://github.com/user-attachments/assets/8838ee26-aa97-4d31-8031-afe8998a7fba" />

### 25 条 1080p 组播流同时播放

https://github.com/user-attachments/assets/fedc0c28-f9ac-4675-9b19-a8efdd062506

> [!NOTE]
> 单流码率 8 Mbps。总仅占用 25% CPU 单核 (i3-N305)，消耗 4MB 内存。

## 📖 文档

- **[快速上手](https://rtp2httpd.com/guide/quick-start)**：OpenWrt 快速配置指南
- **[安装方式](https://rtp2httpd.com/guide/installation)**：各种平台的安装指南

如果是首次搭建 IPTV 组播转发服务，对相关网络知识比较陌生（DHCP 鉴权、路由、组播、防火墙），推荐先看 [搭建教程](https://rtp2httpd.com/reference/related-resources#iptv-搭建教程)。

## 📄 开源许可

本项目基于 GNU General Public License v2.0 开源协议发布。这意味着：

- ✅ 可以部署在商业环境中（如企业内部使用）
- ✅ 可以基于它提供收费的 IPTV 转码服务
- ✅ 可以在有偿 IPTV 咨询服务中使用本软件
- ✅ 可以销售包含此软件的硬件设备
- ⚠️ 如果修改代码，必须公开修改后的源代码
- ⚠️ 如果分发二进制文件，必须同时提供源代码
- ⚠️ 不能将其闭源后再销售

## 🙏 致谢

- 原始项目 [oskar456/rtp2httpd](https://github.com/oskar456/rtp2httpd) 的开发者们
- 愿意在互联网上公开 FCC 协议细节的业内人士
- 所有测试和反馈用户
