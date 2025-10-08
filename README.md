# rtp2httpd - IPTV 流媒体转发服务器

rtp2httpd 是一个多媒体流转发服务器。本项目是 [oskar456/rtp2httpd](https://github.com/oskar456/rtp2httpd) 的完全重构版本，在原项目基础上加入了许多新功能，专为中国大陆 IPTV 环境设计。

rtp2httpd 支持将组播 RTP/UDP 流、RTSP 流转换为 HTTP 单播流，并实现了运营商级的 FCC（[Fast Channel Change](https://blog.csdn.net/yangzex/article/details/131328837)）快速换台协议，为 IPTV 用户提供接近原生机顶盒的观看体验。

## 🚀 核心功能特性

### 🎯 多协议支持

- **组播 RTP 转单播 HTTP**：将组播 RTP/UDP 流转换为标准 HTTP 流
- **原始 UDP 流转发**：支持非 RTP 封装的 UDP 流直接转发
- **RTSP 转 HTTP 视频流**：完整支持 RTSP/RTP 协议栈，包括 TCP 和 UDP 传输模式
  - 可以实现 IPTV RTSP 时移源的回看
  - 可以把家庭摄像机的 RTSP 流转换为 HTTP 流，方便在 IPTV 播放器中观看
- **UDPxy 兼容性**：完全兼容 UDPxy URL 格式，可无缝替换

### ⚡ FCC 快速换台技术

- **运营商级 FCC 协议**：实现毫秒级换台响应，媲美原生 IPTV 机顶盒
- **智能流缓存**：预加载关键帧，确保换台时立即提供可解码视频流
- **NAT 穿透支持**：支持 NAT-PMP 和打洞技术，适应复杂网络环境

### 📊 实时状态监控

- **Web 状态页面**：通过浏览器访问 `/status` 查看实时运行状态
- **客户端连接统计**：显示每个连接的 IP、状态、带宽使用、传输数据量
- **系统日志查看**：实时查看服务器日志，支持动态调整日志级别
- **远程管理功能**：通过 Web 界面强制断开客户端连接

### 🔧 高性能优化

- **非阻塞 IO 模型**：使用 epoll 事件驱动，高效处理大量并发连接
- **MSG_ZEROCOPY 零拷贝技术**：使用 Linux 内核 MSG_ZEROCOPY 特性，避免数据在用户态和内核态之间的拷贝
- **多核优化**：支持多 worker 进程，充分利用多核 CPU 提高最大吞吐量（默认单 worker，可配置）
- **智能批量发送**：自动积攒小包后批量发送，减少系统调用开销 90%，同时兼顾低延时
- **Buffer Pool 管理**：预分配缓冲池，避免频繁内存分配，内存总用量可控
- **高并发支持**：单个 worker 可支持 100+ 并发流媒体客户端

## 📺 演示效果

### 快速换台 + 时移回看

https://github.com/user-attachments/assets/a8c9c60f-ebc3-49a8-b374-f579f8e34d92

> **提示**：建议搭配专门针对 IPTV 直播优化的播放器使用，例如 [APTV](https://aptv.wegic.app) / [TiviMate](https://tivimate.com) / [Cloud Stream](https://apps.apple.com/us/app/cloud-stream-iptv-player/id1138002135) 等。

### 25 条 1080p 组播流同时播放

https://github.com/user-attachments/assets/fedc0c28-f9ac-4675-9b19-a8efdd062506

> 单流码率 8 Mbps。总仅占用 25% CPU 单核 (i3-N305)，消耗 4MB 内存。

### Web UI 实时状态监控

<img width="1488" height="998" alt="Image" src="https://github.com/user-attachments/assets/f6ca5aa7-55f8-4b06-9ea8-3502892e9dc1" />

## 📦 部署方式

### OpenWrt 路由器部署（推荐）

OpenWrt 是 rtp2httpd 的最佳运行环境。在完成 IPTV 网络融合后（可以搜索教程 `OpenWrt IPTV 融合`），通过 DHCP 获取到 IPTV 内网 IP，可直接访问整个 IPTV 网络，无需 NAT 穿透。

本项目支持的最低 OpenWrt 版本为 21.02，在更低版本上 LuCI 配置界面可能无法加载，但通过手动编辑 `/etc/config/rtp2httpd` 文件并运行 `/etc/init.d/rtp2httpd restart` 仍然可以使用。

支持的最低 Linux 内核版本为 4.14，因为依赖 `MSG_ZEROCOPY` 特性，低于此版本将无法运行。

#### 一键安装脚本（推荐）

使用一键安装脚本自动下载并安装最新版本：

```bash
curl -fsSL https://raw.githubusercontent.com/stackia/rtp2httpd/main/openwrt-support/install.sh | sh
```

脚本会自动：

- 检测设备的 CPU 架构
- 从 GitHub Release 获取最新版本
- 下载并安装所有必需的软件包（主程序 + LuCI 界面 + 语言包）

#### 手动安装

如果无法使用一键脚本，可以手动在 [Releases](https://github.com/stackia/rtp2httpd/releases) 页面下载对应架构的软件包：

- `rtp2httpd_x.y.z-1_<arch>.ipk` - 主程序包
- `luci-app-rtp2httpd_x.y.z_all.ipk` - LuCI Web 界面
- `luci-i18n-rtp2httpd-en_x.y.z_all.ipk` - 英文语言包
- `luci-i18n-rtp2httpd-zh-cn_x.y.z_all.ipk` - 中文语言包

```bash
opkg install rtp2httpd_*.ipk luci-app-rtp2httpd_*.ipk luci-i18n-rtp2httpd-*.ipk
```

#### LuCI 配置界面

安装完成后，在 LuCI 管理界面的 "服务" 菜单中找到 "rtp2httpd" 进行配置：

<img width="925" alt="LuCI 配置界面" src="https://github.com/user-attachments/assets/7f5dfc55-b00a-4f8f-b589-56fac0235061" />

可以在 "状态" -> "系统日志" 查看日志。或者 ssh 手动运行 `logread -e rtp2httpd` 查看日志。

### Docker 容器部署

适用于支持 Docker 的设备。**必须使用 host 网络模式**以接收组播流。

```bash
docker run --network=host --rm ghcr.io/stackia/rtp2httpd:latest \
  --noconfig --verbose 2 --listen 8080 --maxclients 20
```

### 编译安装

```bash
# 安装依赖（Ubuntu/Debian）
sudo apt-get install build-essential autoconf automake pkg-config

# 编译安装
autoreconf -fi
./configure --enable-optimization=-O3
make
sudo make install
```

## 🔗 URL 格式与协议支持

rtp2httpd 支持多种流媒体协议，通过不同的 URL 前缀进行区分：

### 组播 RTP 流转换

```url
http://服务器地址:端口/rtp/组播地址:端口[?fcc=FCC服务器:端口]
```

**示例**：

```url
http://192.168.1.1:8080/rtp/239.253.64.120:5140
http://192.168.1.1:8080/rtp/239.253.64.120:5140?fcc=10.255.14.152:15970
```

### RTSP 流代理

```url
http://服务器地址:端口/rtsp/RTSP服务器:端口/路径[?参数][&playseek=时间范围]
```

**示例**：

```url
http://192.168.1.1:8080/rtsp/192.168.1.100:554/live/stream1
http://192.168.1.1:8080/rtsp/camera.local:554/h264/ch1/main/av_stream?playseek=20240101120000-20240101130000
```

**playseek 参数格式**：

`playseek` 参数用于指定时移回看的时间范围，支持多种时间格式：

- **yyyyMMddHHmmss 格式**（14 位数字）

  - 示例：`playseek=20240101120000-20240101130000`
  - 表示从 2024 年 1 月 1 日 12:00:00 到 13:00:00
  - 会根据 User-Agent 中的时区信息自动转换为 UTC

- **Unix 时间戳格式**（10 位以内数字）

  - 示例：`playseek=1704096000-1704099600`
  - 直接使用 Unix 时间戳（秒）
  - 已经是 UTC 时间，无需时区转换

- **时间范围格式**
  - `开始时间-结束时间`：指定时间段
  - `开始时间-`：从指定时间开始到当前（开放式范围）
  - `开始时间`：等同于 `开始时间-`

#### RTSP 时区处理说明

rtp2httpd 在处理 RTSP 时移回看功能时，会根据 HTTP 请求中的 **User-Agent** 头自动识别客户端时区，确保时间参数正确转换。

时区设置只影响 RTSP 时移回看功能，对直播流无影响。

**时区识别机制**：

- 服务器会解析 User-Agent 中的 `TZ/` 标记来获取客户端时区信息
- 支持的时区格式：
  - `TZ/UTC+8` - UTC 偏移格式（东八区）
  - `TZ/UTC-5` - UTC 偏移格式（西五区）
  - `TZ/UTC` - 标准 UTC 时区
- 如果 User-Agent 中没有时区信息，默认使用 UTC 时区

**使用场景**：

当使用 `playseek` 参数进行时移回看时：

- **yyyyMMddHHmmss 格式**：客户端可以使用本地时区的时间格式（如 `20240101120000`），服务器会根据 User-Agent 中的时区信息自动转换为 UTC 时间，然后按照 `--clock-format` 配置的格式发送给 RTSP 服务器
- **Unix 时间戳格式**：直接使用 UTC 时间戳，无需时区转换，服务器会直接按照 `--clock-format` 配置的格式转换后发送给 RTSP 服务器

**示例**：

```bash
# 示例 1: 使用 yyyyMMddHHmmss 格式 + 时区
# 客户端在东八区（UTC+8），User-Agent 包含 TZ/UTC+8
# 请求 2024年1月1日 12:00:00（本地时间）的视频
curl -H "User-Agent: MyPlayer/1.0 TZ/UTC+8" \
  "http://192.168.1.1:8080/rtsp/camera.local:554/stream?playseek=20240101120000-20240101130000"
# 服务器会自动将本地时间转换为 UTC 时间（04:00:00）
# 并按照 clock-format 格式发送 RTSP Range 请求

# 示例 2: 使用 Unix 时间戳格式（无需时区）
# 请求 2024年1月1日 04:00:00 UTC 到 05:00:00 UTC 的视频
curl "http://192.168.1.1:8080/rtsp/camera.local:554/stream?playseek=1704085200-1704088800"
# Unix 时间戳已经是 UTC 时间，直接转换为 clock-format 格式发送
```

### 原始 UDP 流转发

通常在大陆 IPTV 网络应该不会用到这个模式。

```url
http://服务器地址:端口/udp/组播地址:端口
```

**示例**：

```url
http://192.168.1.1:8080/udp/239.253.64.121:5140
```

## ⚙️ 配置参数详解

### 命令行参数

```bash
rtp2httpd [选项]

网络配置：
  -l, --listen [地址:]端口        绑定监听地址和端口 (默认: *:8080)
  -m, --maxclients <数量>        最大并发客户端数 (默认: 5)
  -w, --workers <数量>           工作进程数 (默认: 1)
  --upstream-interface-unicast <接口>   用于单播流量 (FCC/RTSP) 的上游网络接口
  --upstream-interface-multicast <接口>   用于组播流量 (RTP/UDP) 的上游网络接口

性能优化：
  -b, --buffer-pool-max-size <数量> 零拷贝缓冲池最大缓冲区数量 (默认: 16384)
                                   每个缓冲区 1536 字节，16384 个约占用 24MB 内存
                                   增大此值以提高多客户端并发时的吞吐量

FCC 快速换台：
  -n, --fcc-nat-traversal <0/1/2>  FCC NAT 穿透模式
                                  0=禁用, 1=打洞 (已废弃，不要用), 2=NAT-PMP (默认: 0)

服务控制：
  -d, --daemon                   后台守护进程模式
  -D, --nodaemon                 前台运行模式 (默认)
  -c, --config <文件>            指定配置文件路径
  -C, --noconfig                 不读取配置文件

日志控制：
  -v, --verbose                  增加日志详细程度
  -q, --quiet                    仅显示致命错误
  -H, --hostname <主机名>        检查 HTTP Host 头的主机名

兼容性：
  -U, --noudpxy                  禁用 UDPxy 兼容模式 (禁用后只能使用 config 文件中定义的 URL)

其他：
  -f, --clock-format <格式>      RTSP Range 时间戳格式 (默认: yyyyMMddTHHmmssZ)
  -h, --help                     显示帮助信息
```

#### clock-format 时间格式说明

`--clock-format` 选项用于配置 RTSP 时移回看功能中 Range 头的时间戳格式。当客户端通过 `playseek` 参数请求特定时间段的视频时，服务器会将时间转换为 UTC 并按照此格式发送给 RTSP 服务器。

**支持的格式**：

- **yyyyMMddTHHmmssZ**（默认）- ISO 8601 紧凑格式

  - 示例：`20240101T120000Z`
  - 适用于大多数 RTSP 服务器

- **yyyy-MM-dd'T'HH:mm:ss'Z'** - ISO 8601 扩展格式

  - 示例：`2024-01-01T12:00:00Z`
  - 更易读的格式，部分服务器要求使用此格式

- **自定义格式** - 使用类似 strftime 的模式字符串
  - 支持常见的日期时间占位符（yyyy, MM, dd, HH, mm, ss 等）
  - 可以包含分隔符和字面字符

**使用场景**：

不同的 RTSP 服务器可能要求不同的时间格式。如果默认格式无法正常工作，可以尝试调整此选项以匹配目标 RTSP 服务器的要求。

**配置示例**：

```bash
# 使用默认格式
rtp2httpd --clock-format yyyyMMddTHHmmssZ

# 使用扩展格式
rtp2httpd --clock-format "yyyy-MM-dd'T'HH:mm:ss'Z'"
```

### 配置文件格式

配置文件路径：`/etc/rtp2httpd.conf`

```ini
[global]
# 日志详细程度: 0=致命错误 1=错误 2=警告 3=信息 4=调试
verbosity = 3

# 最大并发客户端数
maxclients = 20

# 是否后台运行
daemonise = no

# UDPxy 兼容性
udpxy = yes

# FCC NAT 穿透模式
fcc-nat-traversal = 0

# 上游网络接口 (可选)
# 用于单播流量 (FCC/RTSP) 的接口
;upstream-interface-unicast = eth1
# 用于组播流量 (RTP/UDP) 的接口
;upstream-interface-multicast = eth0

# 工作进程数（默认: 1）
workers = 1

# 零拷贝缓冲池最大缓冲区数量（默认: 16384）
# 每个缓冲区 1536 字节，16384 个约占用 24MB 内存
# 增大此值以提高多客户端并发时的吞吐量，例如设置为 32768 或更高
buffer-pool-max-size = 16384

# RTSP Range 时间戳格式（默认: yyyyMMddTHHmmssZ）
# 用于 RTSP 时移回看功能，将 playseek 参数转换为 UTC 时间时使用
# 支持的格式：
#   - yyyyMMddTHHmmssZ (默认，ISO 8601 紧凑格式)
#   - yyyy-MM-dd'T'HH:mm:ss'Z' (ISO 8601 扩展格式)
#   - 自定义格式（使用类似 strftime 的模式）
# 示例：
#   clock-format = yyyyMMddTHHmmssZ        # 输出: 20240101T120000Z
#   clock-format = yyyy-MM-dd'T'HH:mm:ss'Z' # 输出: 2024-01-01T12:00:00Z
;clock-format = yyyyMMddTHHmmssZ

[bind]
# 绑定地址和端口
* 8080
192.168.1.1 8081

[services]
# 预定义服务 (可选)
# 格式:
#   RTP/UDP 流: 服务名 MRTP 组播地址 端口
#   RAW UDP 流: 服务名 MUDP 组播地址 端口
#   RTSP 流:    服务名 RTSP RTSP_URL
# 类型: MRTP(RTP 流) MUDP(UDP 流) RTSP(RTSP 流)
cctv1    MRTP 239.253.64.120 5140
cctv2    MRTP 239.253.64.121 5140
rtsp1    RTSP rtsp://192.168.1.100:554/stream1
rtsp2    RTSP rtsp://10.0.0.50:8554/live/channel1?auth=token123
```

## 🚄 FCC 快速换台配置指南

### FCC 服务器获取方法

可以 [先看看这里](https://github.com/stackia/rtp2httpd/issues/5)，也许有网友分享过当地的 FCC 服务器地址。否则就需要从 IPTV 机顶盒抓包获取。

1. **抓包方法**：使用 Wireshark 等工具抓取当地机顶盒网络包
2. **关键字段**：查找 `ChannelFCCIP` 和 `ChannelFCCPort` 字段

### NAT 穿透

如果 rtp2httpd 并非直接运行在路由器上，而是运行在局域网内其他设备（例如 NAS、PC 等），则需要启用 NAT 穿透功能以确保 FCC 正常工作。

不使用 FCC 则不受影响。

运行在局域网内设备时，要求上级路由器启用全追锥形 NAT，并转发 IGMP 组播流（可以使用 `igmpproxy` / `omcproxy` 等组播代理工具）。如遇不可播放请尝试不同的 `--fcc-nat-traversal` 参数。

## 内核参数调优

### 开启 BBR

建议修改内核参数，[开启 BBR](https://blog.clash-plus.com/post/openwrt-bbr/) 后可以进一步降低换台延迟。

### 调整 optmem_max

- `net.core.optmem_max`：MSG_ZEROCOPY 元数据内存限制，如遇播放卡顿可尝试增大到 512KB (`net.core.optmem_max=524288`)

## 🤝 开发贡献

### 编译开发环境

```bash
# 安装开发依赖
sudo apt-get install build-essential autoconf pkg-config check

# 从源码编译
git clone https://github.com/stackia/rtp2httpd.git
cd rtp2httpd

# 生成构建脚本
autoreconf -fi

# 配置和编译
./configure
make

# 运行单元测试
make check
```

## 📄 开源许可

本项目基于 GNU General Public License v2.0 开源协议发布。

## 🙏 致谢

- 原始项目 rtp2httpd 的开发者们
- 为 FCC 协议实现提供技术支持的社区贡献者
- 所有测试和反馈用户
