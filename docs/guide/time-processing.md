# 时间处理说明

本文档说明 rtp2httpd 如何处理「时移回看」（catchup）请求里的时间和时区。RTSP 和 HTTP 代理都适用，但 **Range Seek 模式** 是 RTSP 专属的。

## 时移回看的两种模式

IPTV 上游服务器通常支持「时移回看」——回放过去时段的直播内容。客户端通过在 URL 中加上时间范围参数（最常见的是 `playseek`、`tvdr`）告诉服务器要看哪一段：

```
http://192.168.1.1:5140/rtsp/iptv.example.com:554/channel1?playseek=20240101120000-20240101130000
```

rtp2httpd 在向上游转发时支持两种处理方式：

### 模式 1：Playseek 透传（默认）

把客户端的 seek 参数原样作为 URL 查询转发给上游服务器（必要时按时区做格式调整）。

**适用范围**：HTTP 代理 + RTSP 代理，所有支持时移的运营商都能用。

**局限**：上游会按客户端给的「结束时间」播完后关闭流。如果想把后续的实时直播无缝拼上，客户端必须**再发起一次新请求**——中间会有几百毫秒到几秒的间断，可能造成播放卡顿或音视频不同步。

### 模式 2：RTSP Range Seek（可选，需显式启用）

利用 RTSP 协议自带的 `Range: clock=...` 头让上游从指定时间开始播放，**并在追到当前时间时自动无缝拼到实时直播流**——全程一次连接、无需重连。

启用方式：在 URL 里加 `r2h-seek-mode=range(...)`：

```
http://192.168.1.1:5140/rtsp/iptv.example.com:554/channel1?playseek=20240101120000&r2h-seek-mode=range(UTC%2B8)
```

**优势**：从时移段过渡到直播实时段是一次连续播放，无间断。

**限制**：

1. **不是所有 RTSP 服务器都支持**——这是默认关闭、需要显式启用的根本原因。一旦命中 Range Seek 路径，rtp2httpd 会无条件向上游发送 `Range: clock=...` 头；上游如果不识别，请求会失败而不是自动回退
2. **rtp2httpd 自身有客户端窗口**（默认 1 小时，可通过 `r2h-seek-mode=range(<TZ>/<秒>)` 调整）：仅当起始时间落在窗口内才走 Range Seek，否则按 Playseek 透传处理。把窗口配置得不超过上游服务器实际支持的范围（通常 1–3 小时，因运营商而异），可避免命中上游不支持的过老回看请求

> [!TIP]
> 在 rtp2httpd 客户端窗口外，行为与从未启用 Range Seek **完全一致**（按 Playseek 透传）。窗口内则会发起带 `Range: clock=` 头的 RTSP 请求——只有在确认上游支持 RTSP `Range` 头时才建议启用，并把窗口设置得不超过上游实际支持的回看长度。

> [!NOTE]
> Range Seek 模式只看 seek 的**起始时间**——结束时间被忽略，由实时拼接接管。

## Seek 参数

### r2h-seek-name（可选）

指定时移参数的名称。不指定时按以下顺序自动识别：`playseek` → `tvdr`（不区分大小写）。

如果上游使用别的参数名（如 `seek`、`timeshift`），显式指定：

```
?custom_seek=20240101120000-20240101130000&r2h-seek-name=custom_seek
```

### r2h-seek-offset（可选）

对识别出的时移时间额外加 / 减若干秒，可正可负。常用于补偿上游服务器的时钟偏差，或整体提前 / 延后开始时间。

```
# playseek 范围整体后移 1 小时（3600 秒）
?playseek=20240101120000-20240101130000&r2h-seek-offset=3600

# 提前 30 秒
?playseek=20240101120000&r2h-seek-offset=-30
```

> [!IMPORTANT]
> `r2h-seek-offset` 是「人为时间平移」，不是时区修正。它**总是**叠加到最终结果上，即使输入时间已经自带时区（如 ISO 8601 `Z` 后缀、`yyyyMMddHHmmssGMT`），仍然生效。
>
> 在 Range Seek 模式下，offset 也会进入窗口判定——offset 后的时间一旦落出窗口，同样回退为透传。

### r2h-seek-mode（可选，仅 RTSP）

控制是否启用「Range Seek 模式」（参见上方[两种模式说明](#时移回看的两种模式)）。

| 取值                                           | 行为                                                          |
| ---------------------------------------------- | ------------------------------------------------------------- |
| 不传 / `passthrough`                           | 默认。使用 Playseek 透传                                      |
| `range` / `range()`                            | 启用 Range Seek，时区从 UA `TZ/` 推导（无则 UTC），窗口默认 1 小时 |
| `range(UTC+8)` / `range(UTC-5)` / `range(UTC)` | 显式指定时区，窗口默认 1 小时                                 |
| `range(7200)`                                  | 自动推导时区，窗口 7200 秒                                    |
| `range(UTC+8/7200)`                            | 同时显式指定时区与窗口                                        |
| `range(/7200)`                                 | 自动推导时区 + 显式窗口                                       |

窗口取值范围 1–86400 秒。无法识别的值会按 `passthrough` 处理（不会让请求失败）。

> [!IMPORTANT]
> `range()` 里指定的时区**只在 Range Seek 模式中生效**——用来判断时间是否在窗口内、以及生成 `Range: clock=` 头里的 UTC 时间。一旦回退到 Playseek 透传，行为与不传 `r2h-seek-mode` 时**字节级完全相同**，`range(<TZ>)` 不会去改写透传字符串。

### r2h-start（可选，仅 RTSP）

从指定的 NPT 时间点（秒）开始播放，常用于续播：

```
?r2h-start=123.45
```

在 RTSP `PLAY` 请求中以 `Range: npt=<时间>-` 头发送给上游。如果同一请求又带了 `r2h-seek-mode=range(...)` 且命中 Range Seek 模式，`r2h-start` 会被忽略，由 seek 起始时间生成 `Range: clock=` 头。

## 支持的时间格式

rtp2httpd 能识别下面的时间格式。**输出格式始终与输入保持一致**（保留 `Z`、`±HH:MM`、`GMT` 等后缀）。

| 格式                                | 示例                          | 是否自带时区     |
| ----------------------------------- | ----------------------------- | ---------------- |
| Unix 时间戳（≤10 位数字）           | `1704096000`                  | 是（UTC）        |
| 14 位 `yyyyMMddHHmmss`              | `20240101120000`              | 否               |
| 14 位 + `GMT` 后缀                  | `20240101120000GMT`           | 是（UTC）        |
| 紧凑 ISO 8601                       | `20240101T120000`             | 否               |
| 紧凑 ISO 8601 + `Z`                 | `20240101T120000Z`            | 是（UTC）        |
| 紧凑 ISO 8601 + `±HH:MM`            | `20240101T200000+08:00`       | 是               |
| 完整 ISO 8601                       | `2024-01-01T12:00:00`         | 否               |
| 完整 ISO 8601 + `Z` / `±HH:MM`      | `2024-01-01T12:00:00Z`        | 是               |
| 完整 ISO 8601 + 毫秒                | `2024-01-01T12:00:00.123Z`    | 视后缀而定       |

「自带时区」的格式 rtp2httpd 不会再去推导时区——任何外部时区配置（UA `TZ/...`、`r2h-seek-mode=range(<TZ>)`）都被忽略，但 `r2h-seek-offset` 仍然会叠加。「不自带时区」的格式按下文「时区推导」处理。

> [!NOTE]
> `yyyyMMddHHmmssGMT` 的 `GMT` 后缀语义与 ISO 8601 的 `Z` 等价——都视为「自带 UTC 时区」。

## 时区推导

仅适用于「不自带时区」的格式（14 位 `yyyyMMddHHmmss`、不带 `Z`/`±HH:MM` 的 ISO 8601）。

### 默认（Playseek 透传）

rtp2httpd 从 User-Agent 头里查找 `TZ/` 标记获取客户端时区：

```
TZ/UTC      → UTC
TZ/UTC+8    → 东八区
TZ/UTC-5    → 西五区
```

UA 里没有 `TZ/` 标记时，按 UTC 处理（不做时区转换）。

### Range Seek 模式

启用 `r2h-seek-mode=range(...)` 时，**仅 Range Seek 路径**按下面的优先级取时区：

1. `range(UTC+N)` 显式声明
2. UA `TZ/UTC+N`
3. UTC

回退到 Playseek 透传时，时区推导回到上面「默认」一节的规则——`range()` 里的时区不参与。

## 相关文档

- [URL 格式说明](./url-formats.md)：RTSP / HTTP 代理 URL 格式说明
- [配置参数详解](../reference/configuration.md)：服务器配置选项
