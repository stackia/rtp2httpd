# M3U 播放列表集成

rtp2httpd 全面支持 M3U/M3U8 播放列表格式，可自动识别节目并提供转换后的播放列表，让你可以一键导入外部 m3u 频道列表，自动替换 URL，直接在 IPTV 播放器中使用。

## 核心能力

- **外部 M3U 集成**：支持从外部 URL 加载 M3U 播放列表（支持 `file://`、`http://`、`https://` 协议）
- **内联 M3U 配置**：直接在配置文件中编写 M3U 内容，无需外部文件
- **内置 Web 播放器**：浏览器访问 `/player` 即可使用功能完整的在线播放器
- **智能识别转换**：自动识别 RTP/RTSP 流地址，转换为 HTTP 代理格式
- **时移回看支持**：完整支持 catchup-source 属性，自动创建时移服务
- **自动更新机制**：外部 M3U 支持定时自动更新（默认 24 小时）
- **URL 保留策略**：无法识别的 URL（如第三方 HTTP 流）会原样保留在转换后的播放列表中

## 配置方法

### 方法一：使用外部 M3U 文件

在配置文件中指定外部 M3U URL：

```ini
[global]
# 外部 M3U 配置（支持 file://, http://, https://）
# 注意：HTTP/HTTPS 需要安装 curl 命令
external-m3u = https://example.com/iptv.m3u
# 或使用本地文件
external-m3u = file:///path/to/playlist.m3u

# 外部 M3U 更新间隔（秒）
# 默认 86400（24 小时），设为 0 禁用自动更新
external-m3u-update-interval = 86400
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

## 使用播放列表

### 方式一：使用内置播放器

配置好 M3U 后，可以直接在浏览器中访问内置播放器：

```
http://服务器地址:端口/player
```

**示例**：

```
http://192.168.1.1:5140/player
```

内置播放器特性：

- 自动加载配置的 M3U 频道列表
- 支持直播和时移回看
- 支持 FCC 快速起播
- 现代化响应式界面，支持移动设备
- 自定义播放器访问路径（通过 `player-page-path` 配置，详见[配置参数详解](configuration.md)）

**注意**：播放器依赖浏览器的原生解码能力，部分编码格式（如 MP2、E-AC3）可能在某些浏览器中无法播放。推荐使用最新版本的 Chrome、Edge 或 Safari。

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
#EXTM3U x-tvg-url="https://example.com/epg.xml.gz"

#EXTINF:-1 tvg-id="CCTV1" tvg-name="CCTV1" tvg-logo="https://example.com/logo/CCTV1.png" group-title="央视" catchup="default" catchup-source="http://192.168.1.1:5140/CCTV-1/catchup?playseek={utc:YmdHMS}-{utcend:YmdHMS}",CCTV-1
http://192.168.1.1:5140/CCTV-1

#EXTINF:-1 tvg-id="CCTV2" tvg-name="CCTV2" group-title="央视",CCTV-2
http://192.168.1.1:5140/CCTV-2

#EXTINF:-1 tvg-id="Other" tvg-name="其他频道",第三方频道
http://other-cdn.com/live/stream.m3u8
```

**注意**：

- CCTV-1 和 CCTV-2 的 URL 已转换为 rtp2httpd 代理地址
- CCTV-1 的 catchup-source 也已转换，并保留动态占位符
- 第三方频道的 URL 保持不变

## 使用建议

1. **HTTP/HTTPS 支持**

   - 需要系统安装 `curl` 命令
   - OpenWrt 用户：`opkg install curl`

2. **更新策略**

   - 默认 24 小时自动更新外部 M3U
   - 可根据源更新频率调整 `external-m3u-update-interval`
   - 设为 0 禁用自动更新（需手动重启服务更新）

3. **混合使用**

   - 可同时配置外部 M3U 和内联 M3U
   - 两者会合并到同一个转换后的播放列表中

## 相关文档

- [URL 格式说明](url-formats.md)：了解所有支持的 URL 格式
- [配置参数详解](configuration.md)：查看完整配置选项
