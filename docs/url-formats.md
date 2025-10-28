# URL 格式与协议支持

rtp2httpd 支持多种流媒体协议，通过不同的 URL 前缀进行区分。

## 组播 RTP 流转换

```url
http://服务器地址:端口/rtp/组播地址:端口[?fcc=FCC服务器:端口]
```

**示例**：

```url
http://192.168.1.1:5140/rtp/239.253.64.120:5140
http://192.168.1.1:5140/rtp/239.253.64.120:5140?fcc=10.255.14.152:15970
```

### 参数说明

- **组播地址**：IPTV 运营商提供的组播地址
- **端口**：组播端口号
- **fcc**（可选）：FCC 快速换台服务器地址，格式为 `IP:端口`

### 使用场景

- 将运营商 IPTV 组播流转换为 HTTP 单播流
- 在局域网内多设备共享 IPTV 流
- 配合 FCC 实现毫秒级换台

## M3U 播放列表访问

```url
http://服务器地址:端口/playlist.m3u
```

**示例**：

```url
http://192.168.1.1:5140/playlist.m3u
```

获取转换后的 M3U 播放列表，包含所有通过配置文件和外部 M3U 定义的频道，并将 URL 转换成 rtp2httpd 监听的地址和端口，并使用频道名替换原始 IP、查询参数、认证信息。

### 使用场景

- 一键导入别人维护的 m3u 频道源
- 隐藏频道源 IP、认证信息
- 自动更新频道信息

详见 [M3U 播放列表集成](m3u-integration.md)。

## RTSP 流代理

```url
http://服务器地址:端口/rtsp/RTSP服务器:端口/路径[?参数][&playseek=时间范围]
```

**示例**：

```url
http://192.168.1.1:5140/rtsp/192.168.1.100:554/live/stream1
http://192.168.1.1:5140/rtsp/camera.local:554/h264/ch1/main/av_stream?playseek=20240101120000-20240101130000
```

### playseek 参数格式

`playseek` 参数用于指定时移回看的时间范围，支持多种时间格式：

#### yyyyMMddHHmmss 格式（14 位数字）

- 示例：`playseek=20240101120000-20240101130000`
- 表示从 2024 年 1 月 1 日 12:00:00 到 13:00:00
- 会根据 User-Agent 中的时区信息自动转换为 UTC

#### Unix 时间戳格式（10 位以内数字）

- 示例：`playseek=1704096000-1704099600`
- 直接使用 Unix 时间戳（秒）
- 已经是 UTC 时间，无需时区转换

#### 时间范围格式

- `开始时间-结束时间`：指定时间段
- `开始时间-`：从指定时间开始到当前（开放式范围）
- `开始时间`：等同于 `开始时间-`

### RTSP 时区处理说明

rtp2httpd 在处理 RTSP 时移回看功能时，会根据 HTTP 请求中的 **User-Agent** 头自动识别客户端时区，确保时间参数正确转换。

时区设置只影响 RTSP 时移回看功能，对直播流无影响。

#### 时区识别机制

- 服务器会解析 User-Agent 中的 `TZ/` 标记来获取客户端时区信息
- 支持的时区格式：
  - `TZ/UTC+8` - UTC 偏移格式（东八区）
  - `TZ/UTC-5` - UTC 偏移格式（西五区）
  - `TZ/UTC` - 标准 UTC 时区
- 如果 User-Agent 中没有时区信息，默认使用 UTC 时区

#### 使用场景

当使用 `playseek` 参数进行时移回看时：

- **yyyyMMddHHmmss 格式**：客户端可以使用本地时区的时间格式（如 `20240101120000`），服务器会根据 User-Agent 中的时区信息自动转换为 UTC 时间，然后在 RTSP DESCRIBE 请求中将转换后的 UTC 时间作为 `playseek` 查询参数附加到 URL 上（保持 yyyyMMddHHmmss 格式）
- **Unix 时间戳格式**：直接使用 UTC 时间戳，无需时区转换，服务器会直接在 RTSP DESCRIBE 请求中将时间戳作为 `playseek` 查询参数附加到 URL 上（保持时间戳格式）

#### 示例

```bash
# 示例 1: 使用 yyyyMMddHHmmss 格式 + 时区
# 客户端在东八区（UTC+8），User-Agent 包含 TZ/UTC+8
# 请求 2024年1月1日 12:00:00（本地时间）的视频
curl -H "User-Agent: MyPlayer/1.0 TZ/UTC+8" \
  "http://192.168.1.1:5140/rtsp/camera.local:554/stream?playseek=20240101120000-20240101130000"
# 服务器会自动将本地时间转换为 UTC 时间（04:00:00）
# RTSP DESCRIBE 请求: DESCRIBE rtsp://camera.local:554/stream?playseek=20240101040000-20240101050000

# 示例 2: 使用 Unix 时间戳格式（无需时区）
# 请求 2024年1月1日 04:00:00 UTC 到 05:00:00 UTC 的视频
curl "http://192.168.1.1:5140/rtsp/camera.local:554/stream?playseek=1704085200-1704088800"
# Unix 时间戳已经是 UTC 时间，直接附加到 RTSP URL
# RTSP DESCRIBE 请求: DESCRIBE rtsp://camera.local:554/stream?playseek=1704085200-1704088800
```

### 使用场景

- 将 IPTV RTSP 时移源转换为 HTTP 流
- 实现时移回看功能

## 状态页面

```url
http://服务器地址:端口/status
```

**示例**：

```url
http://192.168.1.1:5140/status
```

访问 Web 状态页面，查看：

- 实时客户端连接统计
- 每个连接的 IP、状态、带宽使用、传输数据量
- 系统日志查看
- 远程管理功能（强制断开连接等）

状态页面路径可以通过配置参数 `status-page-path` 自定义。

## 视频快照

在任意流媒体 URL 后添加 `snapshot=1` 参数，或在 HTTP 请求头中添加 `Accept: image/jpeg` 或 `X-Request-Snapshot: 1`，即可获取视频流的 JPEG 快照。

**示例**：

```url
# 方式 1：URL 参数
http://192.168.1.1:5140/rtp/239.253.64.120:5140?snapshot=1

# 方式 2：HTTP 请求头
curl -H "Accept: image/jpeg" http://192.168.1.1:5140/rtp/239.253.64.120:5140

# 方式 3：自定义请求头
curl -H "X-Request-Snapshot: 1" http://192.168.1.1:5140/rtp/239.253.64.120:5140
```

详见 [视频快照配置](video-snapshot.md)。

## UDPxy 兼容模式

rtp2httpd 完全兼容 UDPxy URL 格式，可以无缝替换 UDPxy。

### UDPxy 格式

```url
http://服务器地址:端口/udp/组播地址:端口
```

**示例**：

```url
http://192.168.1.1:5140/udp/239.253.64.120:5140
```

UDPxy 兼容模式默认启用，可以通过配置参数 `udpxy = no` 禁用。禁用后仅支持通过 m3u 提供服务。

## 相关文档

- [M3U 播放列表集成](m3u-integration.md)：播放列表配置
- [FCC 快速换台配置](fcc-setup.md)：启用毫秒级换台
- [视频快照配置](video-snapshot.md)：频道预览图功能
- [配置参数详解](configuration.md)：查看完整配置选项
