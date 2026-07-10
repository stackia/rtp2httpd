---
layout: home
hero:
  name: rtp2httpd
  text: IPTV Streaming Media Forwarding Server
  tagline: Convert Multicast RTP / RTSP / HLS to HTTP Unicast Media Streams
  image:
    src: /icon.png
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
    details: Automatic RTP/RTSP address recognition and conversion, with catchup time-shift support
  - icon: 🛡️
    title: Packet Loss Recovery
    details: RTP reordering recovery, Reed-Solomon FEC forward error correction, eliminates network jitter artifacts
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
    details: Pure C with zero dependencies, epoll + multi-core + zero-copy, only 368KB for x86_64
---

<div class="demo-section">
  <div class="demo-section__heading">
    <span class="demo-section__eyebrow">Live showcase</span>
    <h2>Demos</h2>
  </div>

  <div class="demo-grid">
    <article class="demo-card">
      <header class="demo-card__header">
        <span class="demo-card__index">01</span>
        <h3>Fast Channel Change + Time-Shift Playback</h3>
      </header>
      <div class="demo-card__media">
        <video controls muted playsinline preload="metadata" src="https://github.com/user-attachments/assets/ca1a332f-d6e7-4a1e-be88-92bef67758b3"></video>
      </div>
      <aside class="demo-callout">
        <span class="demo-callout__label">Tip</span>
        <p>Fast channel change requires using IPTV-optimized players, such as <a href="https://github.com/mytv-android/mytv-android" target="_blank" rel="noreferrer">mytv-android</a> / <a href="https://tivimate.com" target="_blank" rel="noreferrer">TiviMate</a> / <a href="https://apps.apple.com/us/app/cloud-stream-iptv-player/id1138002135" target="_blank" rel="noreferrer">Cloud Stream</a> / built-in web player. The player in the video is mytv-android.</p>
        <p>Some common general-purpose players (such as PotPlayer / IINA) are not optimized for startup speed and will not show significant improvement.</p>
      </aside>
    </article>
    <article class="demo-card demo-card--cyan">
      <header class="demo-card__header">
        <span class="demo-card__index">02</span>
        <h3>Built-in Web Player</h3>
      </header>
      <div class="demo-card__media">
        <video controls muted playsinline preload="metadata" src="https://github.com/user-attachments/assets/b32f134d-87ac-46d0-90fe-50ffa410069a"></video>
      </div>
      <aside class="demo-callout">
        <span class="demo-callout__label">Tip</span>
        <p>Requires M3U playlist configuration. Access via browser at <code>http://&lt;server:port&gt;/player</code> to open.</p>
        <p>Due to browser decoding limitations, some channels may not be supported (manifested as no audio or black screen).</p>
      </aside>
    </article>
    <article class="demo-card demo-card--emerald">
      <header class="demo-card__header">
        <span class="demo-card__index">03</span>
        <h3>Real-time Status Monitoring</h3>
      </header>
      <div class="demo-card__media">
        <img src="../images/web-dashboard-en.png" alt="Real-time Status Monitoring" loading="lazy" />
      </div>
    </article>
    <article class="demo-card demo-card--amber">
      <header class="demo-card__header">
        <span class="demo-card__index">04</span>
        <h3>25 Concurrent 1080p Multicast Streams</h3>
      </header>
      <div class="demo-card__media">
        <video controls muted playsinline preload="metadata" src="https://github.com/user-attachments/assets/9d531ab6-6c35-4c50-802a-71f88b6b22c5"></video>
      </div>
      <aside class="demo-callout">
        <span class="demo-callout__label">Performance</span>
        <p>Single stream bitrate 8 Mbps. Total CPU usage only 25% of a single core (i3-N305), 4MB memory.</p>
        <p>For comparison with udpxy / msd_lite / tvgate, see the <a href="/en/reference/benchmark">Performance Benchmark</a>.</p>
      </aside>
    </article>
  </div>
</div>
