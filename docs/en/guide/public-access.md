# Public Access Recommendations

If you need to expose rtp2httpd to the public internet, please ensure proper security measures are in place.

There are currently a large number of automated scanners on the public internet that specifically probe for open udpxy/msd_lite and other unauthenticated multicast-to-unicast services. Once discovered, they will continuously abuse bandwidth. rtp2httpd is compatible with udpxy URL format by default. If exposed without any protection, it will also be exploited by these scanners.

## Security Configuration

When exposing to public internet access, it is recommended to modify `hostname` / `r2h-token` / `status-page-path` / `player-page-path` to enhance security.

```ini
[global]
hostname = iptv.example.com
r2h-token = my-secret-token-12345
status-page-path = /my-status-page
player-page-path = /my-player
```

## Reverse Proxy

If possible, it is recommended to use a reverse proxy such as nginx/lucky/caddy for forwarding, and enable rtp2httpd's `xff` option:

```ini
[global]
xff = yes
```

Ensure that the reverse proxy can pass through `X-Forwarded-For` / `X-Forwarded-Host` / `X-Forwarded-Proto` headers.

For lucky, simply enable the `万事大吉` (All-in-One) option.

For nginx, here is a configuration example:

```nginx
server {
    listen 80;
    server_name iptv.example.com;

    location / {
        proxy_pass http://127.0.0.1:5140;
        proxy_http_version 1.1;

        # Pass through client real IP and protocol information
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Streaming media optimization
        proxy_buffering off;
    }
}
```

## Performance Tuning

It is recommended to modify kernel parameters and [enable BBR](https://blog.clash-plus.com/post/openwrt-bbr/) to help improve transmission stability and reduce startup latency in public network environments.

## Cross-ISP Public Access

> [!NOTE]
> This section mainly addresses the network environment in **mainland China**. ISP policies in other countries and regions may differ.

In recent years, ISPs in mainland China have been cracking down on PCDN, implementing increasingly strict limits on home broadband upload bandwidth. Although many regions have nominal upload bandwidth of 30-50Mbps, if cross-ISP uploads occur (for example, uploading from China Mobile to China Telecom), very strict upload throttling may occur (possibly only a few Mbps, insufficient for streaming 4K video).

In addition, if your past behavior has led the ISP to identify you as a PCDN user, all upload traffic will be sent to a traffic scrubbing pool. Even with the same ISP, upload bandwidth may be severely restricted.

A 1080p IPTV stream typically has a bitrate of 6-10 Mbps, while 4K streams can reach 30-40 Mbps. This means that with 30Mbps upload bandwidth, you may only be able to support 3-5 concurrent 1080p clients, or only 1 concurrent 4K client.

### Symptoms of Insufficient Bandwidth

When upload bandwidth is insufficient to carry all client traffic, rtp2httpd will exhibit the following phenomena:

- **Log outputs buffer pool expansion messages**: Because data cannot be sent out, it continuously accumulates in memory. rtp2httpd will automatically expand the buffer pool to try to accommodate more pending data
- **Status page shows slow clients**: On the `/status` page, some clients may be marked as `slow clients`, indicating their send queue is backed up
- **Packet loss after client buffer pool is full**: When a client's buffer backlog reaches the limit, newly arrived data packets will be dropped. On the viewing end, this manifests as frequent artifacts, stuttering, and reloading

The root cause of these phenomena is limited upload bandwidth, preventing data from being sent to clients in a timely manner.

## Related Documentation

- [Configuration Reference](/en/reference/configuration): Complete configuration options
- [URL Format Specification](/en/guide/url-formats): Authentication token passing methods
- [Benchmark Report](/en/reference/benchmark): Performance comparison with other solutions
