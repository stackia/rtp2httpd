# rtp2httpd - IPTV 流媒体转发服务器

rtp2httpd 是一个多媒体流转发服务器。本项目是 [oskar456/rtp2httpd](https://github.com/oskar456/rtp2httpd) 的完全重构版本，在原项目基础上加入了许多新功能，专为中国大陆 IPTV 环境设计。

rtp2httpd 支持将组播 RTP/UDP 流、RTSP 流转换为 HTTP 单播流，并实现了运营商级的 FCC（[Fast Channel Change](https://blog.csdn.net/yangzex/article/details/131328837)）快速换台协议，为 IPTV 用户提供接近原生机顶盒的观看体验。

## 核心功能特性

### 多协议支持

- **组播 RTP/UDP 转单播 HTTP**：将组播 RTP/UDP 流转换为标准 HTTP 流
- **UDPxy 兼容性**：完全兼容 UDPxy URL 格式，可以作为 `udpxy` 和 `msd_lite` 的无缝替代
- **RTSP 转 HTTP 视频流**：完整支持 RTSP/RTP 协议栈，包括 TCP 和 UDP 传输模式
  - 可以实现 IPTV RTSP 时移源的回看
  - 可以把家庭摄像机的 RTSP 流转换为 HTTP 流，方便在 IPTV 播放器中观看
- **M3U 播放列表集成**：支持 M3U/M3U8 格式，自动识别并转换节目地址，提供标准化的播放列表
  - 支持外部 M3U URL
  - 智能识别 RTP/RTSP URL 并转换为 HTTP 代理格式
  - 自动处理 catchup-source 时移回看地址
  - 通过 `/playlist.m3u` 访问转换后的播放列表
- **频道快照**：支持通过 HTTP 请求快速获取频道的快照图片，降低播放端解码压力

### FCC 快速换台技术

- **支持运营商 FCC 协议**：搭配运营商 FCC 服务器，实现毫秒级换台响应，媲美原生 IPTV 机顶盒
- **快速解码**：FCC 保证了换台时迅速提供 IDR 帧，可供播放器立即解码

### 实时状态监控

- **Web 状态页面**：通过浏览器访问 `/status` 查看实时运行状态
- **客户端连接统计**：显示每个连接的 IP、状态、带宽使用、传输数据量
- **系统日志查看**：实时查看服务器日志，支持动态调整日志级别
- **远程管理功能**：通过 Web 界面强制断开客户端连接

### 高性能优化

- **非阻塞 IO 模型**：使用 epoll 事件驱动，高效处理大量并发连接
- **多核优化**：支持多 worker 进程，充分利用多核 CPU 提高最大吞吐量
- **零拷贝技术**：支持 Linux 内核 MSG_ZEROCOPY 特性，避免数据在用户态和内核态之间的拷贝
- **智能批量发送**：自动积攒小包后批量发送，减少系统调用开销 90%，同时兼顾低延时
- **Buffer Pool 管理**：预分配缓冲池，避免频繁内存分配，多客户端根据负载动态共享
- **高并发支持**：单个 worker 可支持 100+ 并发流媒体客户端

## 演示效果

### 快速换台 + 时移回看

https://github.com/user-attachments/assets/a8c9c60f-ebc3-49a8-b374-f579f8e34d92

> **提示**：快速换台需要使用针对 IPTV 优化的播放器，例如 [mytv-android](https://github.com/mytv-android/mytv-android) / [TiviMate](https://tivimate.com) / [Cloud Stream](https://apps.apple.com/us/app/cloud-stream-iptv-player/id1138002135) 等（视频中的播放器是 TiviMate）。
> 常见普通播放器，例如 PotPlayer / IINA 等，没有专门优化起播速度，FCC 效果不明显。

### 内置全功能播放器

https://github.com/user-attachments/assets/d676b8c1-7017-48a1-814c-caab0054b361

> 内置基于 Web 的现代化播放器界面，支持直播和时移回看，支持 EPG 电子节目单、FCC 快速起播。
> 需要配置 M3U 播放列表后使用，通过浏览器访问 `/player` 即可打开。
> 受限于浏览器解码能力，个别频道可能不支持。

### 实时状态监控

<img width="2586" height="1814" alt="Image" src="https://github.com/user-attachments/assets/8838ee26-aa97-4d31-8031-afe8998a7fba" />

### 25 条 1080p 组播流同时播放

https://github.com/user-attachments/assets/fedc0c28-f9ac-4675-9b19-a8efdd062506

> 单流码率 8 Mbps。总仅占用 25% CPU 单核 (i3-N305)，消耗 4MB 内存。

## 快速开始

### OpenWrt 一键安装/更新

```bash
curl -fsSL https://raw.githubusercontent.com/stackia/rtp2httpd/main/scripts/install-openwrt.sh | sh
```

安装完成后，在 LuCI 管理界面的 "服务" 菜单中找到 "rtp2httpd" 进行配置。

### 其他平台

rtp2httpd 支持多种部署方式：

- **静态二进制文件**：适用于任何 Linux 系统
- **Docker 容器**：容器化部署
- **编译安装**：从源代码编译

详见 [安装指南](docs/installation.md)。

## 文档

- **[快速上手](docs/quick-start.md)**：OpenWrt 快速配置指南
- **[安装方式](docs/installation.md)**：各种平台的安装指南
- **[URL 格式说明](docs/url-formats.md)**：支持的 URL 格式和协议
- **[M3U 播放列表集成](docs/m3u-integration.md)**：M3U 配置和使用
- **[配置参数详解](docs/configuration.md)**：完整配置选项说明
- **[FCC 快速换台配置](docs/fcc-setup.md)**：启用毫秒级换台功能
- **[视频快照配置](docs/video-snapshot.md)**：频道预览图功能配置

## 开源许可

本项目基于 GNU General Public License v2.0 开源协议发布。这意味着：

- ✅ 可以部署在商业环境中（如企业内部使用）
- ✅ 可以基于它提供收费的 IPTV 转码服务
- ✅ 可以销售包含此软件的硬件设备
- ⚠️ 如果修改代码，必须公开修改后的源代码
- ⚠️ 如果分发二进制文件，必须同时提供源代码
- ⚠️ 不能将其闭源后再销售

## 致谢

- 原始项目 rtp2httpd 的开发者们
- 为 FCC 协议实现提供技术支持的社区贡献者
- 所有测试和反馈用户
