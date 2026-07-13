# Access Logging

rtp2httpd can write access logs for media requests. This is useful for auditing which channels clients access, identifying client sources behind a reverse proxy, and integrating with external logging systems.

## Enabling Access Logging

Access logging is disabled by default. Logs are written only after `access-log` is configured.

### Configuration File

```ini
[global]
access-log = /var/log/rtp2httpd/access.log
log-format = $client_addr [$time_iso8601] "$service_url" $service_type "$upstream_url"
```

### Command Line

```bash
rtp2httpd --access-log /var/log/rtp2httpd/access.log \
  --log-format '$client_addr [$time_iso8601] "$service_url" $service_type "$upstream_url"'
```

The OpenWrt LuCI page also supports configuring the access log path and format.

## Default Format

When `log-format` is unset or empty, this default format is used:

```text
$client_addr [$time_iso8601] "$service_url" $service_type "$upstream_url"
```

Example output:

```text
192.0.2.10:53124 [2026-06-25T20:10:12+08:00] "/CCTV-1" rtp "rtp://239.0.0.1:1234"
```

## Placeholders

`log-format` uses nginx-style `$variable` placeholders. The following placeholders are supported:

| Placeholder | Description |
| --- | --- |
| `$time_iso8601` | Local time in ISO 8601 format, for example `2026-06-25T20:10:12+08:00` |
| `$time_local` | Local time in nginx-style format, for example `25/Jun/2026:20:10:12 +0800` |
| `$msec` | Unix timestamp with millisecond precision, for example `1782389412.123` |
| `$client_addr` | Client address shown on the status page |
| `$remote_addr` | Client IP or address parsed from `$client_addr` |
| `$remote_port` | Client port parsed from `$client_addr`; outputs `-` when no port is available |
| `$worker_pid` | PID of the worker process handling the request |
| `$request` | Request method and Service URL, for example `GET /rtp/239.0.0.1:1234` |
| `$request_method` | HTTP request method, for example `GET` |
| `$service_url` | Service URL requested by the client |
| `$host` | HTTP `Host` header |
| `$http_user_agent` | HTTP `User-Agent` header |
| `$http_x_forwarded_for` | HTTP `X-Forwarded-For` header |
| `$service_type` | Service type: `rtp`, `rtsp`, or `http` |
| `$upstream_url` | Actual upstream URL |
| `$$` | Outputs a literal `$` |

Unknown placeholders are output as-is. Empty values are output as `-`. Quotes, backslashes, newlines, and control characters in log values are escaped. Each log line is limited to 8192 bytes.

## Client Address and X-Forwarded-For

`$client_addr` matches the client address shown on the status page.

After `xff` is enabled, if the request's `X-Forwarded-For` header is accepted, `$client_addr` uses the first address from `X-Forwarded-For`. In that case there is usually no client port, so `$remote_port` outputs `-`.

## Token Hiding

If the request URL contains the `r2h-token` query parameter, `$service_url` and `$upstream_url` in the access log do not include that parameter. `$http_user_agent` also hides `R2HTOKEN/...` fragments to avoid leaking tokens through access logs.

## Using logrotate

rtp2httpd workers keep the access log file open. After rotating logs, send `SIGHUP` to the supervisor process so workers reopen the log file.

First enable a PID file through the configuration file or CLI argument:

```ini
[global]
pid-file = /var/run/rtp2httpd.pid
```

Example logrotate config:

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
