# 配置参数详解

rtp2httpd 支持通过命令行参数和配置文件两种方式进行配置。

## 命令行参数

```bash
rtp2httpd [选项]
```

### 网络配置

- `-l, --listen [地址:]端口` - 绑定监听地址和端口 (默认: \*:5140)
- `-m, --maxclients <数量>` - 最大并发客户端数 (默认: 5)
- `-w, --workers <数量>` - 工作进程数 (默认: 1)

#### 上游网络接口配置

- `-i, --upstream-interface <接口>` - 默认上游接口（作用于所有流量类型，优先级最低）
- `-f, --upstream-interface-fcc <接口>` - FCC 上游接口（覆盖 `-i` 设置）
- `-t, --upstream-interface-rtsp <接口>` - RTSP 上游接口（覆盖 `-i` 设置）
- `-r, --upstream-interface-multicast <接口>` - 组播上游接口（覆盖 `-i` 设置）

**优先级规则**：`upstream-interface-{fcc,rtsp,multicast}` > `upstream-interface` > 系统路由表

### 性能优化

- `-b, --buffer-pool-max-size <数量>` - 零拷贝缓冲池最大缓冲区数量 (默认: 16384)
  - 每个缓冲区 1536 字节，16384 个约占用 24MB 内存
  - 增大此值以提高多客户端并发时的吞吐量
- `-Z, --zerocopy-on-send` - 启用零拷贝发送以提升性能 (默认: 关闭)
  - 需要内核支持 MSG_ZEROCOPY (Linux 4.14+)
  - 在支持的设备上提升吞吐量并降低 CPU 占用

### FCC 快速换台

- `-P, --fcc-listen-port-range <起始[-结束]>` - FCC UDP 监听端口范围 (默认: 随机端口)

### 服务控制

- `-d, --daemon` - 后台守护进程模式
- `-D, --nodaemon` - 前台运行模式 (默认)
- `-c, --config <文件>` - 指定配置文件路径 (默认 `/etc/rtp2httpd.conf`)
- `-C, --noconfig` - 不读取配置文件

### 日志控制

- `-v, --verbose` - 日志详细程度 (0=FATAL, 1=ERROR, 2=WARN, 3=INFO, 4=DEBUG)
- `-q, --quiet` - 仅显示致命错误

### 安全控制

- `-H, --hostname <主机名>` - 检查 HTTP Host 头的主机名
- `-T, --r2h-token <令牌>` - HTTP 请求认证令牌 (所有请求必须携带 r2h-token 查询参数)
- `-s, --status-page-path <路径>` - 状态页面与 API 根路径 (默认: /status)
- `-p, --player-page-path <路径>` - 内置播放器页面路径 (默认: /player)

### 兼容性

- `-U, --noudpxy` - 禁用 UDPxy 兼容模式 (禁用后只能使用 `[services]` 或 `external-m3u` 中定义的服务)

### 其他

- `-S, --video-snapshot` - 启用视频快照功能 (默认: 关闭)
- `-F, --ffmpeg-path <路径>` - FFmpeg 可执行文件路径 (默认: ffmpeg)
- `-A, --ffmpeg-args <参数>` - FFmpeg 额外参数 (默认: -hwaccel none)
- `-h, --help` - 显示帮助信息

## 配置文件格式

配置文件路径：`/etc/rtp2httpd.conf`，每行如果使用 `#` 或 `;` 开头表示注释。

```ini
[global]
# 日志详细程度: 0=FATAL 1=ERROR 2=WARN 3=INFO 4=DEBUG
verbosity = 3

# 最大并发客户端数
maxclients = 20

# 是否后台运行
daemonise = no

# UDPxy 兼容性
udpxy = yes

# 工作进程数（默认: 1）
workers = 1

# 检查 HTTP 请求的 Host 头 (默认：无)
hostname = somehost.example.com

# HTTP 请求认证令牌（可选，默认: 无）
# 设置后，所有 HTTP 请求必须携带 r2h-token 查询参数，且值与此配置匹配
# 例如: http://server:5140/service?r2h-token=your-secret-token
r2h-token = your-secret-token-here

# 状态页路径（默认: /status）
status-page-path = /status

# 播放器页路径（默认: /player）
player-page-path = /player

# 上游网络接口配置 (可选)
#
# 简单配置：只配置一个默认接口，所有流量类型都使用此接口
upstream-interface = eth0
#
# 高级配置：为不同流量类型配置专用接口
# 注意：专用接口配置优先级高于默认接口
# upstream-interface-multicast = eth0  # 组播流量 (RTP/UDP)
# upstream-interface-fcc = eth1        # FCC
# upstream-interface-rtsp = eth2       # RTSP
#
# 混合配置示例：默认使用 eth0，但 FCC 使用更快的 eth1
# upstream-interface = eth0
# upstream-interface-fcc = eth1
#
# 优先级：upstream-interface-{multicast,fcc,rtsp} > upstream-interface > 系统路由表

# 外部 M3U 配置（支持 file://, http://, https://）
# 注意：HTTP/HTTPS 需要安装 curl 命令
external-m3u = https://example.com/iptv.m3u
# 或使用本地文件
external-m3u = file:///path/to/playlist.m3u

# 外部 M3U 更新间隔（秒）
# 默认 86400（24 小时），设为 0 禁用自动更新
external-m3u-update-interval = 86400

# 组播周期性重新加入间隔（秒，默认: 0 禁用）
# 设置为正值（如 150）以周期性重新加入组播组
# 这是针对以下网络环境的兼容性解决方案：
# - 启用 IGMP snooping 的交换机在没有路由器 IGMP Query 时超时
# - 配置不当的网络设备会丢弃组播成员关系
# 推荐值: 30-120 秒（小于典型交换机超时 260 秒）
# 仅在遇到组播流中断时启用
mcast-rejoin-interval = 0

# FCC 监听媒体流端口范围（可选，格式: 起始-结束，默认随机端口）
fcc-listen-port-range = 40000-40100

# 零拷贝缓冲池最大缓冲区数量（默认: 16384）
# 每个缓冲区 1536 字节，16384 个约占用 24MB 内存
# 增大此值以提高多客户端并发时的吞吐量，例如设置为 32768 或更高
buffer-pool-max-size = 16384

# 启用零拷贝发送以提升性能（默认: no）
# 设为 yes/true/on/1 以启用零拷贝
# 需要内核支持 MSG_ZEROCOPY (Linux 4.14+)
# 在支持的设备上可提升吞吐量并降低 CPU 占用，特别是在高并发负载下
zerocopy-on-send = no

# 启用视频快照功能（默认: no）
# 启用后可通过 `snapshot=1` 查询参数获取视频流的实时快照
video-snapshot = no

# FFmpeg 可执行文件路径（默认: ffmpeg，使用系统 PATH）
# 如果 ffmpeg 不在 PATH 中或想使用特定版本，请指定完整路径
ffmpeg-path = /usr/bin/ffmpeg

# FFmpeg 额外参数（默认: -hwaccel none）
# 这些参数在生成快照时传递给 ffmpeg
# 常用选项: -hwaccel none, -hwaccel auto, -hwaccel vaapi, -hwaccel qsv
ffmpeg-args = -hwaccel none

[bind]
# 监听所有地址的 5140 端口
* 5140

# 监听特定 IP 的 8081 端口
192.168.1.1 8081

# 支持多个监听地址

# [services] 内可以直接编写以 #EXTM3U 开头的 m3u 节目清单
# 和 external-m3u 功能类似，只是直接把 m3u 写在了配置文件内
[services]
#EXTM3U x-tvg-url="https://example.com/epg.xml.gz"
#EXTINF:-1 tvg-id="CCTV1" tvg-name="CCTV1" tvg-logo="https://example.com/logo/CCTV1.png" group-title="央视" catchup="default" catchup-source="rtsp://10.0.0.50:554/catchup?playseek={utc:YmdHMS}-{utcend:YmdHMS}",CCTV-1
rtp://239.253.64.120:5140
#EXTINF:-1 tvg-id="CCTV2" tvg-name="CCTV2" group-title="央视",CCTV-2
rtp://239.253.64.121:5140
```

## 配置优先级

1. 命令行参数具有最高优先级
2. 配置文件参数次之
3. 内置默认值最低

## 公网访问建议

开放公网访问时，建议修改 `hostname` / `r2h-token` / `status-page-path` / `player-page-path` 以加强安全性。

如有条件，建议前置 nginx / lucky / caddy 等工具负责转发。

````ini
[global]
hostname = iptv.example.com
r2h-token = my-secret-token-12345
status-page-path = /my-status-page
player-page-path = /my-player
```

## 性能调优

建议修改内核参数，[开启 BBR](https://blog.clash-plus.com/post/openwrt-bbr/) 有助于在公网环境提高传输稳定性、降低起播延迟。

## 相关文档

- [快速上手](quick-start.md)：基本配置指南
- [M3U 播放列表集成](m3u-integration.md)：M3U 配置详解
- [FCC 快速换台配置](fcc-setup.md)：FCC 相关配置
- [视频快照配置](video-snapshot.md)：视频快照功能配置
````
