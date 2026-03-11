---
layout: home
hero:
  name: rtp2httpd
  text: IPTV 转发服务器
  tagline: 将组播 RTP / RTSP / HLS 转为 HTTP 单播媒体流
  image:
    src: /icon.svg
    alt: rtp2httpd
  actions:
    - theme: brand
      text: 快速上手
      link: /guide/quick-start
    - theme: alt
      text: GitHub
      link: https://github.com/stackia/rtp2httpd
features:
  - icon: 📡
    title: 多协议支持
    details: RTP/UDP、RTSP、HTTP (HLS) 转 HTTP 单播，兼容 udpxy URL 格式
  - icon: ⚡
    title: FCC 快速换台
    details: 支持运营商 FCC 协议，毫秒级换台响应，媲美原生机顶盒体验
  - icon: 📋
    title: M3U 播放列表
    details: 自动识别并转换 RTP/RTSP 地址，支持 catchup 时移回看源
  - icon: 🛡️
    title: 抗丢包纠错
    details: RTP 乱序恢复、Reed-Solomon FEC 前向纠错，消除网络抖动花屏
  - icon: 🎬
    title: 内置播放器
    details: 现代化 Web 播放器，支持 EPG 和时移回看，桌面/移动端自适应
  - icon: 📷
    title: 频道快照
    details: 通过 HTTP 获取频道实时截图，可作为播放器频道预览图
  - icon: 📊
    title: 实时监控
    details: Web 状态页面，连接统计、带宽监控、日志查看、远程管理
  - icon: 🚀
    title: 轻量高性能
    details: 纯 C 零依赖，epoll + 多核 + 零拷贝，x86_64 仅 340KB
---

<style>
.demo-section {
  max-width: 960px;
  margin: 0 auto;
  padding: 0 24px;
}
.demo-section h2 {
  font-size: 28px;
  font-weight: 700;
  text-align: center;
  margin-bottom: 48px;
  letter-spacing: -0.02em;
}
.demo-section h3 {
  font-size: 20px;
  font-weight: 600;
  margin-top: 48px;
  margin-bottom: 16px;
}
.demo-section video {
  width: 100%;
  border-radius: 8px;
  border: 1px solid var(--vp-c-divider);
}
</style>

<div class="demo-section">

## 效果演示

### 快速换台 + 时移回看

<video controls preload="metadata" src="https://github.com/user-attachments/assets/a8c9c60f-ebc3-49a8-b374-f579f8e34d92" />

> [!TIP]
> 快速换台需要搭配使用针对 IPTV 优化的播放器，例如 [mytv-android](https://github.com/mytv-android/mytv-android) / [TiviMate](https://tivimate.com) / [Cloud Stream](https://apps.apple.com/us/app/cloud-stream-iptv-player/id1138002135) / 内置 Web 播放器等。视频中的播放器是 TiviMate。
>
> 一些常见的万能播放器（如 PotPlayer / IINA）没有针对起播速度做优化，不会有明显效果。

### 内置 Web 播放器

<video controls preload="metadata" src="https://github.com/user-attachments/assets/d676b8c1-7017-48a1-814c-caab0054b361" />

> [!TIP]
> 需要配置 M3U 播放列表后使用，通过浏览器访问 `http://<server:port>/player` 即可打开。
>
> 受限于浏览器解码能力，一些频道可能不支持（表现为无音频、画面黑屏）。

### 实时状态监控

![实时状态监控](./images/status-page.png)

### 25 条 1080p 组播流同时播放

<video controls preload="metadata" src="https://github.com/user-attachments/assets/fedc0c28-f9ac-4675-9b19-a8efdd062506" />

> [!NOTE]
> 单流码率 8 Mbps。总仅占用 25% CPU 单核 (i3-N305)，消耗 4MB 内存。
>
> 与 udpxy / msd_lite / tvgate 的对比，详见 [性能测试报告](./reference/benchmark.md)。

</div>
