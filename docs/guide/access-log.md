# 访问日志

rtp2httpd 可以为媒体请求写入访问日志，便于审计客户端访问了哪些频道、排查反向代理后的客户端来源，以及对接外部日志系统。

## 启用访问日志

访问日志默认关闭。只有配置 `access-log` 后才会写入日志。

### 配置文件

```ini
[global]
access-log = /var/log/rtp2httpd/access.log
log-format = $client_addr [$time_iso8601] "$service_url" $service_type "$upstream_url"
```

### 命令行

```bash
rtp2httpd --access-log /var/log/rtp2httpd/access.log \
  --log-format '$client_addr [$time_iso8601] "$service_url" $service_type "$upstream_url"'
```

OpenWrt LuCI 页面中也可以配置访问日志路径和格式。

## 默认格式

`log-format` 未配置或为空时，使用以下默认格式：

```text
$client_addr [$time_iso8601] "$service_url" $service_type "$upstream_url"
```

示例输出：

```text
192.0.2.10:53124 [2026-06-25T20:10:12+08:00] "/CCTV-1" rtp "rtp://239.0.0.1:1234"
```

## 占位符

`log-format` 使用类似 nginx 的 `$变量` 形式。支持的占位符如下：

| 占位符 | 说明 |
| --- | --- |
| `$time_iso8601` | 本地时间，ISO 8601 格式，例如 `2026-06-25T20:10:12+08:00` |
| `$time_local` | 本地时间，nginx 风格格式，例如 `25/Jun/2026:20:10:12 +0800` |
| `$msec` | Unix 时间戳，精确到毫秒，例如 `1782389412.123` |
| `$client_addr` | 状态页面显示的客户端地址 |
| `$remote_addr` | 从 `$client_addr` 拆出的客户端 IP 或地址 |
| `$remote_port` | 从 `$client_addr` 拆出的客户端端口；没有端口时输出 `-` |
| `$worker_pid` | 处理该请求的 worker 进程 PID |
| `$request` | 请求方法和 Service URL，例如 `GET /rtp/239.0.0.1:1234` |
| `$request_method` | HTTP 请求方法，例如 `GET` |
| `$service_url` | 客户端访问的 Service URL |
| `$host` | HTTP `Host` 头 |
| `$http_user_agent` | HTTP `User-Agent` 头 |
| `$http_x_forwarded_for` | HTTP `X-Forwarded-For` 头 |
| `$service_type` | 服务类型：`rtp`、`rtsp` 或 `http` |
| `$upstream_url` | 实际上游 URL |
| `$$` | 输出字面量 `$` |

未知占位符会按原样输出。空值会输出为 `-`。日志值中的引号、反斜杠、换行和控制字符会被转义，单行日志最长 8192 字节。

## 客户端地址与 X-Forwarded-For

`$client_addr` 与状态页面显示的客户端地址一致。

启用 `xff` 后，如果请求中的 `X-Forwarded-For` 被接受，`$client_addr` 会使用 `X-Forwarded-For` 中的第一个地址。这种情况下通常没有客户端端口，因此 `$remote_port` 会输出 `-`。

## 令牌隐藏

如果请求 URL 中包含 `r2h-token` 查询参数，访问日志中的 `$service_url` 和 `$upstream_url` 不会包含该参数。`$http_user_agent` 也会隐藏 `R2HTOKEN/...` 片段，避免令牌通过访问日志泄露。

## 配合 logrotate

rtp2httpd worker 会保持访问日志文件打开。轮转日志后，需要向 supervisor 进程发送 `SIGHUP`，让 worker 重新打开日志文件。

先通过配置文件或 CLI 参数启用 PID 文件：

```ini
[global]
pid-file = /var/run/rtp2httpd.pid
```

logrotate 配置示例：

```text
/var/log/rtp2httpd/access.log {
    daily
    rotate 7
    missingok
    notifempty
    compress
    create 0644 root root
    sharedscripts
    postrotate
        [ ! -s /var/run/rtp2httpd.pid ] || kill -HUP "$(cat /var/run/rtp2httpd.pid)" 2>/dev/null || true
    endscript
}
```
