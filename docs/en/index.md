---
layout: home
hero:
  name: rtp2httpd
  text: IPTV Streaming Media Forwarding Server
  tagline: Convert Multicast RTP / RTSP / HLS to HTTP Unicast Media Streams
  image:
    src: /icon.svg
    alt: rtp2httpd
  actions:
    - theme: brand
      text: Quick Start
      link: /en/guide/quick-start
    - theme: alt
      text: GitHub
      link: https://github.com/stackia/rtp2httpd
features:
  - icon: 📡
    title: Multi-Protocol Support
    details: RTP/UDP, RTSP, HTTP (HLS) to HTTP unicast, compatible with udpxy URL format
  - icon: ⚡
    title: FCC Fast Channel Change
    details: Supports ISP FCC (Fast Channel Change) protocol, millisecond-level channel switching, comparable to native set-top box experience
  - icon: 📋
    title: M3U Playlist
    details: Automatically recognize and convert RTP/RTSP addresses, support catchup time-shift sources
  - icon: 🛡️
    title: Packet Loss Recovery
    details: RTP reordering recovery, Reed-Solomon FEC forward error correction, eliminate network jitter artifacts
  - icon: 🎬
    title: Built-in Player
    details: Modern web player with EPG and time-shift support, responsive for desktop/mobile
  - icon: 📷
    title: Channel Snapshot
    details: Get real-time channel screenshots via HTTP, can be used as player channel preview
  - icon: 📊
    title: Real-time Monitoring
    details: Web status page with connection statistics, bandwidth monitoring, log viewing, remote management
  - icon: 🚀
    title: Lightweight & High Performance
    details: Pure C with zero dependencies, epoll + multi-core + zero-copy, only 340KB for x86_64
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

## Demos

### Fast Channel Change + Time-Shift Playback

<video controls preload="metadata" src="/videos/fcc-demo.mp4#t=0.001" />

> [!TIP]
> Fast channel change requires using IPTV-optimized players, such as [mytv-android](https://github.com/mytv-android/mytv-android) / [TiviMate](https://tivimate.com) / [Cloud Stream](https://apps.apple.com/us/app/cloud-stream-iptv-player/id1138002135) / built-in web player. The player in the video is TiviMate.
>
> Some common general-purpose players (such as PotPlayer / IINA) are not optimized for startup speed and will not show significant improvement.

### Built-in Web Player

<video controls preload="metadata" src="/videos/player-demo.mp4#t=0.001" />

> [!TIP]
> Requires M3U playlist configuration. Access via browser at `http://<server:port>/player` to open.
>
> Due to browser decoding limitations, some channels may not be supported (manifested as no audio or black screen).

### Real-time Status Monitoring

![Real-time Status Monitoring](../images/status-page.png)

### 25 Concurrent 1080p Multicast Streams

<video controls preload="metadata" src="/videos/multistream-demo.mp4#t=0.001" />

> [!NOTE]
> Single stream bitrate 8 Mbps. Only consumes 25% CPU single core (i3-N305), 4MB memory.
>
> For comparison with udpxy / msd_lite / tvgate, see the [Performance Benchmark Report](./reference/benchmark.md).

</div>
