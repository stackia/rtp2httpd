# M3U 播放列表集成

rtp2httpd 全面支持 M3U/M3U8 播放列表格式，可自动识别节目并提供转换后的播放列表，让你可以一键导入外部 m3u 频道列表，自动替换 URL，直接在 IPTV 播放器中使用。

## 配置方法

### 方法一：使用外部 M3U 文件

在配置文件中指定外部 M3U URL：

```ini
[global]
# 外部 M3U 配置（支持 file://, http://, https://）
# 注意：HTTP/HTTPS 需要安装 curl 或 uclient-fetch 或 wget 命令
external-m3u = https://example.com/iptv.m3u
# 或使用本地文件
external-m3u = file:///path/to/playlist.m3u

# 外部 M3U 更新间隔（秒）
# 默认 7200（2 小时），设为 0 禁用自动更新
external-m3u-update-interval = 7200
```

### 方法二：在配置文件中直接内联 M3U

在 `[services]` 区段直接编写 M3U 内容：

```ini
[services]
# 直接编写 M3U 内容，以 #EXTM3U 开头
#EXTM3U x-tvg-url="https://example.com/epg.xml.gz"

# 基础频道配置
#EXTINF:-1 tvg-id="CCTV1" tvg-name="CCTV1" tvg-logo="https://example.com/logo/CCTV1.png" group-title="央视",CCTV-1
rtp://239.253.64.120:5140

# 带时移回看的频道配置
#EXTINF:-1 tvg-id="CCTV2" tvg-name="CCTV2" group-title="央视" catchup="default" catchup-source="rtsp://10.0.0.50:554/catchup?playseek={utc:YmdHMS}-{utcend:YmdHMS}",CCTV-2
rtp://239.253.64.121:5140

# 简单配置（只有频道名）
#EXTINF:-1,广东卫视
rtp://239.194.10.15:1234
```

## 使用播放列表

### 方式一：使用内置播放器

配置好 M3U 后，通过浏览器访问 `http://服务器地址:端口/player` 即可使用 [内置 Web 播放器](./web-player.md)。

### 方式二：导出播放列表到其他播放器

转换后的 M3U 播放列表可通过以下 URL 访问：

```
http://服务器地址:端口/playlist.m3u
```

**示例**：

```
http://192.168.1.1:5140/playlist.m3u
```

将此 URL 添加到支持 M3U 的 IPTV 播放器（如 APTV、TiviMate 等）即可使用。

## 转换示例

### 输入 M3U

```m3u
#EXTM3U x-tvg-url="https://example.com/epg.xml.gz"

#EXTINF:-1 tvg-id="CCTV1" tvg-name="CCTV1" tvg-logo="https://example.com/logo/CCTV1.png" group-title="央视" catchup="default" catchup-source="rtsp://10.0.0.50:554/catchup?auth=loremipsum&playseek={utc:YmdHMS}-{utcend:YmdHMS}",CCTV-1
rtp://239.253.64.120:5140

#EXTINF:-1 tvg-id="CCTV2" tvg-name="CCTV2" group-title="央视",CCTV-2
rtp://239.253.64.121:5140

#EXTINF:-1 tvg-id="Other" tvg-name="其他频道",第三方频道
http://other-cdn.com/live/stream.m3u8
```

### 输出 M3U（转换后）

```m3u
#EXTM3U x-tvg-url="http://192.168.1.1:5140/epg.xml.gz"

#EXTINF:-1 tvg-id="CCTV1" tvg-name="CCTV1" tvg-logo="https://example.com/logo/CCTV1.png" group-title="央视" catchup="default" catchup-source="http://192.168.1.1:5140/CCTV-1/catchup?playseek={utc:YmdHMS}-{utcend:YmdHMS}",CCTV-1
http://192.168.1.1:5140/央视/CCTV-1

#EXTINF:-1 tvg-id="CCTV2" tvg-name="CCTV2" group-title="央视",CCTV-2
http://192.168.1.1:5140/央视/CCTV-2

#EXTINF:-1 tvg-id="Other" tvg-name="其他频道",第三方频道
http://other-cdn.com/live/stream.m3u8
```

> [!NOTE]
> - EPG 的 URL 已转换为 rtp2httpd 代理地址
> - CCTV-1 和 CCTV-2 的 URL 已转换为 rtp2httpd 代理地址
> - CCTV-1 的 catchup-source 也已转换，并保留动态占位符
> - 第三方频道的 URL 保持不变

## 使用建议

1. **HTTP/HTTPS 支持**
   - 需要系统安装 `curl` 或 `uclient-fetch` 或 `wget` 命令
   - rtp2httpd 会自动检测并使用可用的工具

2. **更新策略**
   - 默认 24 小时自动更新外部 M3U
   - 可根据源更新频率调整 `external-m3u-update-interval`
   - 设为 0 禁用自动更新（需手动重启服务更新）

3. **混合使用**
   - 可同时配置外部 M3U 和内联 M3U
   - 两者会合并到同一个转换后的播放列表中

4. **使用反向代理时开启 `xff` 选项**
   - M3U 在转换过程中，需要知道自身的完整访问地址，因此如果使用反向代理，请开启 `xff` 选项，并确保反代程序可以透传 `X-Forwarded-*` 相关头。详见 [公网访问建议](./public-access.md)。

## URL 识别与转换规则

### 支持的 URL 格式

rtp2httpd 能够识别并转换以下格式的 URL：

1. **直接协议 URL**：
   - `rtp://[source@]multicast_addr:port[?query]`
   - `rtsp://server:port/path[?query]`
   - `udp://multicast_addr:port[?query]`

2. **UDPxy 格式的 HTTP URL**：
   - `http://hostname:port/rtp/multicast_addr:port`
   - `http://hostname:port/rtsp/server:port/path`
   - 会自动把 `hostname:port` 替换为 rtp2httpd 实际的地址和端口

### 转换示例

| 原始 URL                                    | 转换后 URL                                    |
| ------------------------------------------- | --------------------------------------------- |
| `rtp://239.253.64.120:5140`                 | `http://hostname:5140/CCTV-1`                 |
| `rtsp://10.0.0.50:554/live`                 | `http://hostname:5140/CCTV-2`                 |
| `http://router:5140/rtp/239.1.1.1:1234`     | `http://hostname:5140/频道名`                 |
| `http://other-server/stream.m3u8`（第三方） | `http://other-server/stream.m3u8`（保持原样） |

**服务名称提取规则**：使用 `#EXTINF` 行中最后一个逗号后的文本作为服务名称。

```
#EXTINF:-1 tvg-id="..." tvg-name="..." group-title="...",CCTV-1
                                                          ^^^^^^
                                                        服务名称
```

## 时移回看（Catchup）支持

当 M3U 中包含 `catchup-source` 属性时，rtp2httpd 会自动创建对应的时移服务。

### 配置示例

```m3u
#EXTINF:-1 tvg-id="CCTV1" catchup="default" catchup-source="rtsp://10.0.0.50:554/catchup?playseek={utc:YmdHMS}-{utcend:YmdHMS}",CCTV-1
rtp://239.253.64.120:5140
```

### 转换结果

- **直播服务**：`http://hostname:5140/CCTV-1`
- **时移服务**：`http://hostname:5140/CCTV-1/catchup?playseek={utc:YmdHMS}-{utcend:YmdHMS}`

### 占位符处理

- **动态占位符**（包含 `{` 或 `}`）：保留在转换后的 URL 中，由播放器填充
  - 例如：`{utc:YmdHMS}`、`{utcend:YmdHMS}`
- **静态参数**：其他查询参数不会保留在转换的 m3u 中。但依然会保留在对上游的请求中。

### 不可识别 URL 的处理

如果 `catchup-source` 是第三方 HTTP URL（如 `http://other-cdn.com/catchup`），则会原样保留，不进行转换。

## 线路标签

通过在 URL 末尾添加 `$标签` 后缀，可以为频道源指定显示标签（如清晰度）。`$标签` 必须位于整个 URL 的最末尾。

只有在支持标签和频道聚合的播放器中（例如 [内置 Web 播放器](./web-player.md)）才有效果。

### 示例输入

```m3u
#EXTINF:-1 tvg-id="广东卫视" tvg-name="广东卫视" tvg-logo="https://example.com/logo/广东卫视.png" group-title="卫视",广东卫视
rtp://239.253.64.96:5140/?fcc=10.255.75.73:15970$超高清
#EXTINF:-1 tvg-id="广东卫视" tvg-name="广东卫视" tvg-logo="https://example.com/logo/广东卫视.png" group-title="卫视",广东卫视
rtp://239.253.64.200:5140/?fcc=10.255.75.73:15970$高清
#EXTINF:-1 tvg-id="广东卫视" tvg-name="广东卫视" tvg-logo="https://example.com/logo/广东卫视.png" group-title="卫视",广东卫视
rtp://239.253.64.44:5140/?fcc=10.255.75.73:15970$标清
```

### 示例输出

每个带 `$label` 的频道会生成独立的服务路径，`$label` 转换为 `/label` 子路径，同时 `$label` 保留在转换后 URL 的末尾：

```m3u
#EXTINF:-1 tvg-id="广东卫视" tvg-name="广东卫视" tvg-logo="https://example.com/logo/广东卫视.png" group-title="卫视",广东卫视
http://192.168.1.1:5140/卫视/广东卫视/超高清$超高清

#EXTINF:-1 tvg-id="广东卫视" tvg-name="广东卫视" tvg-logo="https://example.com/logo/广东卫视.png" group-title="卫视",广东卫视
http://192.168.1.1:5140/卫视/广东卫视/高清$高清

#EXTINF:-1 tvg-id="广东卫视" tvg-name="广东卫视" tvg-logo="https://example.com/logo/广东卫视.png" group-title="卫视",广东卫视
http://192.168.1.1:5140/卫视/广东卫视/标清$标清
```

## 相关文档

- [内置 Web 播放器](./web-player.md)：播放器功能、频道聚合、时间占位符
- [URL 格式说明](./url-formats.md)：了解所有支持的 URL 格式
- [配置参数详解](../reference/configuration.md)：查看完整配置选项
