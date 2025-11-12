# URL 格式与协议支持

rtp2httpd 支持多种流媒体协议，通过不同的 URL 前缀进行区分。

## 组播 RTP 流转换

```url
http://服务器地址:端口/rtp/组播地址:端口[?fcc=FCC服务器:端口][&fcc-type=协议类型]
```

**示例**：

```url
http://192.168.1.1:5140/rtp/239.253.64.120:5140
http://192.168.1.1:5140/rtp/239.253.64.120:5140?fcc=10.255.14.152:15970
http://192.168.1.1:5140/rtp/239.253.64.120:5140?fcc=10.255.14.152:8027&fcc-type=huawei
```

### 参数说明

- **组播地址**：IPTV 运营商提供的组播地址
- **端口**：组播端口号
- **fcc**（可选）：FCC 快速换台服务器地址，格式为 `IP:端口`
- **fcc-type**（可选）：FCC 协议类型，可选值：
  - `telecom`：电信/中兴/烽火 FCC 协议（默认）
  - `huawei`：华为 FCC 协议

### 使用场景

- 将运营商 IPTV 组播流转换为 HTTP 单播流
- 在局域网内多设备共享 IPTV 流
- 配合 FCC 实现毫秒级换台

## RTSP 流代理

```url
http://服务器地址:端口/rtsp/RTSP服务器:端口/路径[?参数]
```

**示例**：

```url
# 直播流
http://192.168.1.1:5140/rtsp/iptv.example.com:554/channel1

# 时移回看（使用 playseek 参数）
http://192.168.1.1:5140/rtsp/iptv.example.com:554/channel1?playseek=20240101120000-20240101130000

# 时移回看（使用 tvdr 参数）
http://192.168.1.1:5140/rtsp/iptv.example.com:554/channel1?tvdr=20240101120000GMT-20240101130000GMT

# 自定义时移参数名 + 时间偏移
http://192.168.1.1:5140/rtsp/iptv.example.com:554/channel1?seek=20240101120000&r2h-seek-name=seek&r2h-seek-offset=3600
```

### 常见问题：时移回看时，实际回看时间比节目单早了/晚了 8 小时

这是由于时区未能匹配。需要做时区转换。你可以尝试以下几种方式。

- 修改播放器 User Agent 设置，加上 `TZ/UTC+8` 或 `TZ/UTC-8`。例如 `AptvPlayer/1.3.3 TZ/UTC+8`。
- 修改播放链接，加上参数 `&r2h-seek-offset=28800` 或 `&r2h-seek-offset=-28800`

关于时移回看的参数处理（时区、偏移），详见 [RTSP 时间处理与时区转换](rtsp-time-processing.md)。

### 使用场景

- 将 IPTV RTSP 单播流转换为 HTTP 流
- 实现 RTSP 时移回看功能

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
