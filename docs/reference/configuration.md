# 配置参数详解

rtp2httpd 支持通过命令行参数和配置文件两种方式进行配置。

> [!TIP]
>
> 1. 命令行参数具有最高优先级
> 2. 配置文件参数次之
> 3. 内置默认值最低

## 命令行参数

```bash
rtp2httpd [选项]
```

### 网络配置

- `-l, --listen [地址:]端口|/path/to/rtp2httpd.sock` - 绑定 TCP 监听地址/端口，或监听 Unix domain socket (默认: \*:5140)
- `-m, --maxclients <数量>` - 最大并发客户端数 (默认: 5)
- `-w, --workers <数量>` - 工作进程数 (默认: 1)

`--listen` 可以重复指定，用于同时监听多个 TCP 地址/端口或 Unix socket：

```bash
rtp2httpd --listen 5140 --listen 192.168.1.1:8081 --listen '[::1]:5140' --listen /var/run/rtp2httpd.sock
```

Unix socket 监听路径必须是绝对路径，且路径中不能包含空白字符。启动时如果同路径已存在 socket 文件，rtp2httpd 会先探测该 socket 是否仍在使用：如果已有进程正在监听该路径，则拒绝启动；只有确认是残留 socket 文件时才会自动清理。如果同路径是普通文件、目录或符号链接，则会拒绝启动以避免误删数据。启用任意 Unix socket 监听时，`zerocopy-on-send` 会被全局关闭。

#### 上游网络接口配置

- `-i, --upstream-interface <接口>` - 默认上游接口（作用于所有流量类型，优先级最低）
- `-f, --upstream-interface-fcc <接口>` - FCC 上游接口（覆盖 `-i` 设置）
- `-t, --upstream-interface-rtsp <接口>` - RTSP 上游接口（覆盖 `-i` 设置）
- `-r, --upstream-interface-multicast <接口>` - 组播上游接口（覆盖 `-i` 设置）
- `-y, --upstream-interface-http <接口>` - HTTP 代理上游接口（覆盖 `-i` 设置）

**优先级规则**：`upstream-interface-{fcc,rtsp,multicast,http}` > `upstream-interface` > 系统路由表

> [!TIP]
> 除了全局配置外，还可以在每个请求的 URL 中通过 `r2h-ifname` 和 `r2h-ifname-fcc` 参数指定上游接口，详见 [URL 格式说明](../guide/url-formats.md)。
> [!TIP]
> FreeBSD 系统下不支持指定除组播外的接口。

### 性能优化

- `-b, --buffer-pool-max-size <数量>` - 缓冲池最大缓冲区数量 (默认: 16384)
  - 每个缓冲区 1536 字节，16384 个约占用 24MB 内存
  - 增大此值以提高多客户端并发时的吞吐量
- `-B, --udp-rcvbuf-size <字节>` - UDP socket 接收缓冲区大小 (默认: 524288 = 512KB)
  - 作用于组播、FCC、RTSP RTP/RTCP 所有 UDP socket
  - 对于 30 Mbps 的 4K IPTV 流，512KB 可提供约 140ms 的缓冲
  - 增大此值以减少高带宽流的丢包
  - 实际缓冲区大小可能受内核参数 `net.core.rmem_max` 限制
- `-Z, --zerocopy-on-send` - 启用零拷贝发送以提升性能 (默认: 关闭)
  - 需要内核支持 MSG_ZEROCOPY (Linux 4.14+)
  - 在支持的设备上提升吞吐量并降低 CPU 占用
  - 如果你的 rtp2httpd 位于反向代理之后 (nginx/caddy/lucky 等)，不建议开启这个选项

### FCC 快速换台

- `-P, --fcc-listen-port-range <起始[-结束]>` - FCC UDP 监听端口范围 (默认: 随机端口)

### 服务控制

- `-c, --config <文件>` - 指定配置文件路径 (默认 `/etc/rtp2httpd.conf`)
- `-C, --noconfig` - 不读取任何配置文件（避免读到默认的 `/etc/rtp2httpd.conf`）

### 日志控制

- `-v, --verbose` - 日志详细程度 (0=FATAL, 1=ERROR, 2=WARN, 3=INFO, 4=DEBUG)
- `-q, --quiet` - 仅显示致命错误
- `--access-log <路径>` - 将访问日志写入指定文件 (默认: 禁用)
- `--log-format <格式>` - 访问日志格式，使用类似 nginx 的 `$变量` 占位符，详见 [访问日志](../guide/access-log.md)

### 安全控制

- `-H, --hostname <主机名>` - 检查 HTTP Host 头的主机名
- `-X, --xff` - 启用 X-Forwarded-For 解析
- `-T, --r2h-token <令牌>` - HTTP 请求认证令牌 (所有请求必须携带 r2h-token 查询参数)
- `-O, --cors-allow-origin <值>` - 设置 CORS Access-Control-Allow-Origin 头 (默认: 禁用)
  - 设为 `*` 允许所有来源，或指定具体域名（如 `https://example.com`）
- `-s, --status-page-path <路径>` - 状态页面与 API 根路径 (默认: /status)
- `-p, --player-page-path <路径>` - 内置播放器页面路径 (默认: /player)
- `--app-path-prefix <路径>` - 所有 HTTP 资源的公开访问前缀 (默认: 无)
- `--use-relative-path-in-m3u` - 生成 playlist.m3u 或 HTTP 代理改写 M3U 时使用站点根相对 URL (默认: 关闭)

### 兼容性

- `-U, --noudpxy` - 禁用 UDPxy 兼容模式 (禁用后只能使用 `[services]` 或 `external-m3u` 中定义的服务)

### HTTP 代理相关

- `-g, --http-proxy-user-agent <值>` - 向 HTTP 上游请求时的 User-Agent 头 (默认: 透传客户端 User-Agent)
  - 作用于通过 `/http/...` 路径代理到上游 HTTP 服务器的请求
  - 配置后会替换原本透传给上游的客户端 User-Agent

### RTSP 相关

- `-u, --rtsp-user-agent <值>` - 向 RTSP 上游请求时的 User-Agent 头 (默认: `rtp2httpd/<version>`)
  - 作用于 OPTIONS、DESCRIBE、SETUP、PLAY、TEARDOWN、GET_PARAMETER 等上游 RTSP 请求
  - 某些上游 RTSP 服务器会校验或依赖特定 User-Agent，可通过此参数进行兼容

- `-N, --rtsp-stun-server <host:port>` - STUN 服务器地址 (默认: 禁用)
  - 当 RTSP 服务器仅支持 UDP 传输且客户端位于 NAT 后时，可尝试使用 STUN 进行 NAT 穿透（不保证成功）
  - 格式：`host:port` 或 `host`（默认端口 3478）
  - 示例：`stun.miwifi.com` 或 `stun.miwifi.com:3478`

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

# 访问日志文件路径（留空或不配置时禁用）
access-log = /var/log/rtp2httpd/access.log

# 访问日志格式（可选，nginx 风格 $变量）
# 默认: $client_addr [$time_iso8601] "$service_url" $service_type "$upstream_url"
log-format = $client_addr [$time_iso8601] "$service_url" $service_type "$upstream_url"

# 最大并发客户端数
maxclients = 20

# UDPxy 兼容性
udpxy = yes

# 工作进程数（默认: 1）
workers = 1

# 检查 HTTP 请求的 Host 头 (默认：无)
hostname = somehost.example.com

# 启用后，将使用 HTTP X-Forwarded-For 头作为客户端地址，用于显示在状态面板上 (默认：no)
# 并接受 X-Forwarded-Host / X-Forwarded-Proto 头作为 playlist.m3u 中的地址前缀
# 建议仅在使用反向代理时启用
xff = no

# HTTP 请求认证令牌（可选，默认: 无）
# 设置后，所有 HTTP 请求必须携带 r2h-token 查询参数，且值与此配置匹配
# 例如:
# http://server:5140/rtp/239.253.64.120:5140?fcc=10.255.14.152:15970&r2h-token=your-secret-token
# http://server:5140/player?r2h-token=your-secret-token
r2h-token = your-secret-token-here

# 状态页应用内路径（默认: /status；配置 app-path-prefix 时会挂载在该前缀下）
status-page-path = /status

# 播放器页应用内路径（默认: /player；配置 app-path-prefix 时会挂载在该前缀下）
player-page-path = /player

# 所有 HTTP 资源的公开访问前缀（默认: 无）
# 设置后，状态页、播放器、静态资源、playlist.m3u、epg.xml 和流媒体 URL
# 都会在此前缀下提供，例如 /app/rtp2httpd/player。
app-path-prefix = /app/rtp2httpd

# M3U 输出使用站点根相对路径（默认: no）
# 开启后，playlist.m3u 和 HTTP 代理改写后的 M3U 中不会包含 http://host 前缀，
# 只保留 / 或 app-path-prefix 开头的路径，例如 /app/rtp2httpd/rtp/...
use-relative-path-in-m3u = no

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
# upstream-interface-http = eth3       # HTTP 代理
#
# 混合配置示例：默认使用 eth0，但 FCC 使用更快的 eth1
# upstream-interface = eth0
# upstream-interface-fcc = eth1
#
# 优先级：upstream-interface-{multicast,fcc,rtsp,http} > upstream-interface > 系统路由表
# 对于 FreeBSD 系统，仅支持设置组播接口

# 外部 M3U 配置（支持 file://, http://, https://）
# 注意：HTTP/HTTPS 需要安装 curl 或 uclient-fetch 或 wget 命令
external-m3u = https://example.com/iptv.m3u
# 或使用本地文件
external-m3u = file:///path/to/playlist.m3u

# 外部 M3U 更新间隔（秒）
# 默认 7200（2 小时），设为 0 禁用自动更新
external-m3u-update-interval = 7200

# 组播周期性重新加入间隔（秒，默认: 0 禁用）
# 设置为正值（如 60）以周期性重新加入组播组
# 这是针对以下网络环境的兼容性解决方案：
# - 启用 IGMP snooping 的交换机在没有路由器 IGMP Query 时超时
# - 配置不当的网络设备会丢弃组播成员关系
# 推荐值: 30-120 秒（小于典型交换机超时 260 秒）
# 注意：默认禁用（0），仅在遇到组播流中断时才需要启用
# 注意：不支持 IPv6
mcast-rejoin-interval = 0

# FCC 监听媒体流端口范围（可选，格式: 起始-结束，默认随机端口）
fcc-listen-port-range = 40000-40100

# 缓冲池最大缓冲区数量（默认: 16384）
# 每个缓冲区 1536 字节，16384 个约占用 24MB 内存
# 增大此值以提高多客户端并发时的吞吐量，例如设置为 32768 或更高
buffer-pool-max-size = 16384

# UDP socket 接收缓冲区大小（默认: 524288 = 512KB）
# 作用于组播、FCC、RTSP RTP/RTCP 所有 UDP socket
# 对于 30 Mbps 的 4K IPTV 流，512KB 可提供约 140ms 的缓冲
# 增大此值以减少高带宽流的丢包
# 实际缓冲区大小可能受内核参数 net.core.rmem_max 限制
udp-rcvbuf-size = 524288

# 启用零拷贝发送以提升性能（默认: no）
# 设为 yes/true/on/1 以启用零拷贝
# 需要内核支持 MSG_ZEROCOPY (Linux 4.14+)
# 在支持的设备上可提升吞吐量并降低 CPU 占用，特别是在高并发负载下
# 如果你的 rtp2httpd 位于反向代理之后 (nginx/caddy/lucky 等)，不建议开启这个选项
zerocopy-on-send = no

# 覆盖上游 HTTP 代理请求的 User-Agent（默认: 不覆盖）
# 设置后将替换发送给 /http/ 上游服务器的客户端 User-Agent
http-proxy-user-agent = rtp2httpd-http-proxy/1.0

# 上游 RTSP 请求的 User-Agent（默认: rtp2httpd/<version>）
# 当上游 RTSP 服务器要求特定 User-Agent 时可配置此项
rtsp-user-agent = rtp2httpd/custom

# STUN 服务器用于 RTSP NAT 穿透（默认: 禁用）
# 当 RTSP 服务器仅支持 UDP 传输且客户端位于 NAT 后时，可尝试使用 STUN 进行 NAT 穿透（不保证成功）
# 格式: host:port 或 host（默认端口 3478）
rtsp-stun-server = stun.miwifi.com

# CORS 跨域请求配置（默认: 禁用）
# 设置后启用 CORS
# 设为 * 允许所有域名，或指定具体域名
;cors-allow-origin = *

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

# 监听 IPv6 地址（可省略方括号）
2001:db8::1 5140

# 监听 Unix domain socket（路径必须是绝对路径）
/var/run/rtp2httpd.sock

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

访问日志的启用方式、格式占位符和 logrotate 配置见 [访问日志](../guide/access-log.md)。

## 运行时配置管理

rtp2httpd 支持配置热重载：修改配置文件后，通过发送信号或状态页面触发重载，即可应用变更，无需重启整个进程。rtp2httpd 采用 supervisor + worker 多进程架构，信号应发送给 **supervisor 进程**（即主 `rtp2httpd` 进程，而非 worker 子进程）。

### 信号说明

| 信号 | 作用 |
| --- | --- |
| `SIGHUP` | 热重载配置：从配置文件重新读取并应用 |
| `SIGUSR1` | 重启所有工作进程 |

**示例**（将 `12345` 替换为 supervisor 进程的 PID）：

```bash
# 热重载配置
kill -HUP 12345

# 重启所有工作进程
kill -USR1 12345
```

### SIGHUP 热重载行为

- 从配置文件（默认 `/etc/rtp2httpd.conf`，或通过 `--config` 指定的路径）重新读取配置
- 若 `[bind]` 监听地址发生变化，supervisor 会向所有工作进程发送 `SIGTERM` 并重新拉起，以应用新的监听地址
- 若 `workers` 数量发生变化，supervisor 会自动增减工作进程
- 其他配置变更会转发 `SIGHUP` 给各工作进程，由工作进程在运行时应用
- 工作进程会在重载时重新打开 [访问日志](../guide/access-log.md) 文件，便于配合 logrotate
- 若配置文件解析失败，保留旧配置，不会中断现有连接

> [!NOTE]
> 使用 `--noconfig` 启动时，没有配置文件可供重载；此时 `SIGHUP` 仅触发 M3U/EPG 的重新加载。

### SIGUSR1 重启工作进程

向 supervisor 发送 `SIGUSR1` 后，所有工作进程会被终止并由 supervisor 自动重新拉起。适用于需要刷新工作进程状态、但不修改配置文件的场景。进行中的客户端连接会被中断。

### 通过状态页面操作

[状态页面](../guide/url-formats.md#状态页面) 提供了等效的管理功能，无需手动查找 PID：

- **重载配置**：对应 `SIGHUP`（API：`POST <status-page-path>/api/reload-config`）
- **重启工作进程**：对应 `SIGUSR1`（API：`POST <status-page-path>/api/restart-workers`）
