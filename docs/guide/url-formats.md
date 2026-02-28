# URL 格式说明

rtp2httpd 支持多种流媒体协议，通过不同的 URL 前缀进行区分。

基本格式：`http://服务器地址:端口/路径[?参数1=值1][&参数2=值2][&参数3=值3]`

当配置了 `r2h-token（HTTP 请求认证令牌）` 时，所有 URL 都需要额外带上参数 `r2h-token=<your token>` 才能访问。

> [!TIP]
> 除了 URL 参数，也支持通过 Cookie 或者 User Agent 来传递 `r2h-token`。例如 `Cookie: r2h-token=xxx` 或 `User-Agent: R2HTOKEN/xxx`。

## 组播 RTP 转 HTTP 单播流

```url
http://服务器地址:端口/rtp/组播地址:端口[?fcc=FCC服务器:端口][&fcc-type=协议类型][&fec=FEC端口]
```

**示例**：

```url
http://192.168.1.1:5140/rtp/239.253.64.120:5140
http://192.168.1.1:5140/rtp/239.253.64.120:5140?fcc=10.255.14.152:15970
http://192.168.1.1:5140/rtp/239.253.64.120:5140?fcc=10.255.14.152:8027&fcc-type=huawei
http://192.168.1.1:5140/rtp/239.81.0.195:4056?fec=4055
```

### 参数说明

- **组播地址**：IPTV 运营商提供的组播地址
- **端口**：组播端口号
- **fcc**（可选）：FCC 快速换台服务器地址，格式为 `IP:端口`
- **fcc-type**（可选）：FCC 协议类型，可选值：
  - `telecom`：电信/中兴/烽火 FCC 协议（默认）
  - `huawei`：华为 FCC 协议
- **fec**（可选）：FEC 前向纠错端口号，用于接收 FEC 冗余数据包来恢复丢包

### 使用场景

- 将运营商 IPTV 组播流转换为 HTTP 单播流
- 在局域网内多设备共享 IPTV 流
- 配合 FCC 实现毫秒级换台
- 配合 FEC 实现丢包恢复，提高播放稳定性

## RTSP 转 HTTP

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

### 使用场景

- 将 IPTV RTSP 单播流转换为 HTTP 流
- 实现 RTSP 时移回看功能

> [!IMPORTANT]
> rtp2httpd 的 RTSP 支持仅适用于承载单路 MPEG-TS 流的场景（即 IPTV 单播/时移回看），不支持监控摄像头等其他 RTSP 用途。

### 常见问题：时移回看时，实际回看时间比节目单早了/晚了 8 小时

这是由于时区未能匹配。需要做时区转换。你可以尝试以下几种方式。

- 修改播放器 User Agent 设置，加上 `TZ/UTC+8` 或 `TZ/UTC-8`。例如 `AptvPlayer/1.3.3 TZ/UTC+8`。
- 修改播放链接，加上参数 `&r2h-seek-offset=28800` 或 `&r2h-seek-offset=-28800`

关于时移回看的参数处理（时区、偏移），详见 [时间处理说明](./time-processing.md)。

## HTTP 反向代理

```url
http://服务器地址:端口/http/上游服务器[:端口]/路径[?参数]
```

**示例**：

```url
# 代理 HLS 流（指定端口）
http://192.168.1.1:5140/http/upstream.example.com:8080/live/stream.m3u8

# 代理 HTTP 请求（省略端口，默认 80）
http://192.168.1.1:5140/http/api.example.com/video?auth=xxx&quality=hd
```

### 参数说明

- **上游服务器**：目标 HTTP 服务器地址
- **端口**（可选）：目标服务器端口，默认 80
- **路径**：请求路径，包括查询参数

### 使用场景

- 代理上游 HLS/DASH 流媒体，统一认证和访问控制
- 为不支持直接访问的 IPTV 内网服务提供 HTTP 反向代理

### 时移回看支持

HTTP 代理同样支持 `r2h-seek-name`、`r2h-seek-offset` 参数和 User-Agent 时区转换，处理方式与 RTSP 代理一致。

```url
# 自动识别 playseek 参数并进行时区转换
http://192.168.1.1:5140/http/iptv.example.com/channel1?playseek=20240101120000-20240101130000

# 使用自定义参数名 + 时间偏移
http://192.168.1.1:5140/http/iptv.example.com/channel1?catchup=20240101120000&r2h-seek-name=catchup&r2h-seek-offset=3600
```

详见 [时间处理说明](./time-processing.md)。

### 注意事项

- 仅支持 HTTP 上游（不支持 HTTPS）
- 可通过 `upstream-interface-http` 配置指定上游网络接口
- 如果被代理的目标 URL 是 m3u 类型，其中所有 `http://` URL 会被自动改写为经过 rtp2httpd 代理后的地址（为了保证 HLS 流能被正确代理）

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

详见 [M3U 播放列表集成](./m3u-integration.md)。

## 内置 Web 播放器

```url
http://服务器地址:端口/player
```

**示例**：

```url
http://192.168.1.1:5140/player
```

访问[内置 Web 播放器](./web-player.md)，可以在网页端播放已配置的 M3U 频道列表。

播放器页面路径可以通过配置项 `player-page-path` 自定义。设置为 `/` 可以实现不带任何路径直接访问。

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

状态页面路径可以通过配置项 `status-page-path` 自定义。设置为 `/` 可以实现不带任何路径直接访问。

## udpxy 兼容模式

rtp2httpd 完全兼容 udpxy URL 格式，可以无缝替换 udpxy / msd_lite 等组播转单播服务。

### udpxy 格式

```url
http://服务器地址:端口/udp/组播地址:端口
http://服务器地址:端口/rtp/组播地址:端口
```

**示例**：

```url
http://192.168.1.1:5140/udp/239.253.64.120:5140
http://192.168.1.1:5140/rtp/239.253.64.120:5140
```

udpxy 兼容模式默认启用，可以通过配置参数 `udpxy = no` 禁用。禁用后仅支持通过 m3u 提供服务。

> [!TIP]
> 使用 `/udp/` 和 `/rtp/` 没有任何差别，选择任意一种即可。

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

详见 [视频快照配置](./video-snapshot.md)。

## 相关文档

- [M3U 播放列表集成](./m3u-integration.md)：播放列表配置
- [FCC 快速换台配置](./fcc-setup.md)：启用毫秒级换台
- [视频快照配置](./video-snapshot.md)：频道预览图功能
- [配置参数详解](../reference/configuration.md)：查看完整配置选项
