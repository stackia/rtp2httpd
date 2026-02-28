# 公网访问建议

如果你需要将 rtp2httpd 暴露到公网，请务必做好安全防护。

目前公网上存在大量自动化扫描器，专门探测开放的 udpxy / msd_lite 等无认证组播转单播服务，一旦被发现就会被持续盗用带宽。rtp2httpd 默认兼容 udpxy URL 格式，如果不加任何防护直接暴露，同样会被这些扫描器利用。

## 安全配置

开放公网访问时，建议修改 `hostname` / `r2h-token` / `status-page-path` / `player-page-path` 以加强安全性。

```ini
[global]
hostname = iptv.example.com
r2h-token = my-secret-token-12345
status-page-path = /my-status-page
player-page-path = /my-player
```

## 前置反向代理

如有条件，建议前置 nginx / lucky / caddy 等反向代理负责转发，并开启 rtp2httpd 的 `xff` 选项

```ini
[global]
xff = yes
```

需要确保反向代理可以透传 `X-Forwarded-For` / `X-Forwarded-Host` / `X-Forwarded-Proto` 头。

对于 lucky，开启 `万事大吉` 选项即可。

对于 nginx，以下是一个配置示例：

```nginx
server {
    listen 80;
    server_name iptv.example.com;

    location / {
        proxy_pass http://127.0.0.1:5140;
        proxy_http_version 1.1;

        # 透传客户端真实 IP 和协议信息
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;

        # 流媒体相关优化
        proxy_buffering off;
    }
}
```

## 性能调优

建议修改内核参数，[开启 BBR](https://blog.clash-plus.com/post/openwrt-bbr/) 有助于在公网环境提高传输稳定性、降低起播延迟。

## 跨运营商公网访问

> [!NOTE]
> 本节内容主要针对**中国大陆**的网络环境。其他国家和地区的 ISP 政策可能有所不同。

近年来中国大陆运营商大力整治 PCDN，对家庭宽带的上行带宽实施了越来越严格的限制。许多地区上行带宽虽然标称 30-50Mbps，但如果发生跨网上行（例如从中国移动上传到中国电信），会出现非常严格的上行限速（可能只有几 Mbps，不足以串流 4K 视频）。

此外，如果因为过往行为，被运营商判断为 PCDN 用户后，全部上行流量将会被送入流量清洗池，即使是同运营商，上行带宽也可能会被严格限制。

一条 1080p IPTV 流的码率通常在 6-10 Mbps，4K 流可达 30-40 Mbps。这意味着在 30Mbps 上行带宽下，可能只能同时支持 3-5 个 1080p 客户端，或仅 1 个 4K 客户端。

### 带宽不足时的表现

当上行带宽不足以承载所有客户端的流量时，rtp2httpd 会出现以下现象：

- **日志输出缓冲池扩容消息**：由于数据发送不出去，在内存中持续积累，rtp2httpd 会自动扩容缓冲池以尝试容纳更多待发送数据
- **状态页面显示慢客户端**：在 `/status` 页面可以看到部分客户端被标记为 `慢客户端`，表示其发送队列已积压
- **客户端缓冲池占满后丢包**：当某个客户端的缓冲积压达到上限，新到达的数据包会被丢弃，在观看端表现为频繁花屏、卡顿、重新加载

这些现象的根本原因是上行带宽受限，数据无法及时发送到客户端。

## 相关文档

- [配置参数详解](../reference/configuration.md)：完整配置选项说明
- [URL 格式说明](./url-formats.md)：认证令牌传递方式
- [性能测试报告](../reference/benchmark.md)：与其他方案的性能对比
