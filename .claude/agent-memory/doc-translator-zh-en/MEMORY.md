# Translation Memory for rtp2httpd Documentation

## Terminology Conventions

### Preserved Product/Technical Names
- rtp2httpd, udpxy, msd_lite, VLC, FFmpeg, APTV, TiviMate, Wireshark
- FCC (Fast Channel Change) - always expand on first use as "FCC (Fast Channel Change)"
- FEC (Forward Error Correction) - always expand on first use
- RTP, RTSP, HTTP, HTTPS, UDP, IGMP, HLS, DASH, M3U, M3U8
- IPTV, EPG, MPEG-TS, MP2, E-AC3
- GOP (Group of Pictures) - keep as-is
- PCDN (Peer Content Delivery Network) - keep as-is
- BBR (Bottleneck Bandwidth and RTT) - keep as-is
- VA-API, V4L2, QSV - hardware acceleration names

### Standard Translations
- 组播 → multicast
- 单播 → unicast
- 快速换台 → fast channel change / channel switching
- 时移回看 → time-shifted playback / time-shift / timeshift / catch-up
- 电子节目单 → EPG (Electronic Program Guide)
- 频道 → channel
- 线路/源 → source
- 播放列表 → playlist
- 上游服务器 → upstream server
- 反向代理 → reverse proxy
- 机顶盒 → set-top box
- 抓包 → capture packets / packet capture
- 起播 → start playback / playback start
- 帧间压缩 → inter-frame compression
- 关键帧 / IDR 帧 → keyframe / IDR frame
- P 帧 / B 帧 → P-frame / B-frame
- NAT 穿透 → NAT traversal
- 端口转发 → port forwarding
- 慢客户端 → slow clients
- 缓冲池 → buffer pool
- 丢包 → packet loss
- 花屏 → artifacts
- 卡顿 → stuttering

### China-specific Terms
- 运营商 → operator / IPTV operator / ISP (context dependent: 电信 → China Telecom / Telecom, 联通 → China Unicom, 移动 → China Mobile)
- 华为 → Huawei
- 中兴 → ZTE
- 烽火 → FiberHome
- 央视 → Keep as "央视" in M3U examples (preserves original channel group data)
- 卫视 → Satellite (as group name in examples)
- Province/city names → Use standard English pinyin (浙江 → Zhejiang, 杭州 → Hangzhou, 上海 → Shanghai)
- fnOS / 飞牛 fnOS → fnOS (keep as-is)

## VitePress Syntax Preserved

- Container syntax: `::: tip`, `::: warning`, `::: danger`, `::: info`, `::: details`
- Callouts: `> [!TIP]`, `> [!NOTE]`, `> [!IMPORTANT]`, `> [!WARNING]`
- Translate content inside but keep syntax intact

## Code and Technical Elements

### Never Translate
- Code blocks (fenced or inline)
- Configuration parameter names (e.g., `r2h-token`, `external-m3u`, `player-page-path`)
- URL components (protocols, query parameters)
- IP addresses, ports
- File paths

### Translate Comments
- Chinese comments in config examples → English
- Keep structure/syntax identical

## Document Structure Notes

- Heading hierarchy must match Chinese version exactly
- Section order must be preserved
- Example format and structure must mirror the original
- Tables: translate headers and content, keep markdown table structure

## Translation Completeness

### Completed Files (2026-03-01)
Reference documents:
- `/docs/reference/configuration.md` → `/docs/en/reference/configuration.md` ✓
- `/docs/reference/cn-fcc-collection.md` → `/docs/en/reference/cn-fcc-collection.md` ✓
- `/docs/reference/benchmark.md` → `/docs/en/reference/benchmark.md` ✓
- `/docs/reference/related-resources.md` → `/docs/en/reference/related-resources.md` ✓

Guide documents:
- `/docs/guide/fcc-setup.md` → `/docs/en/guide/fcc-setup.md` ✓
- `/docs/guide/public-access.md` → `/docs/en/guide/public-access.md` ✓
- `/docs/guide/time-processing.md` → `/docs/en/guide/time-processing.md` ✓
- `/docs/guide/video-snapshot.md` → `/docs/en/guide/video-snapshot.md` ✓

### Patterns Observed
- Configuration file examples: Translate comments but keep parameter names and M3U metadata (tvg-id, group-title) intact
- FCC collection document: Retain Chinese ISP names with English translations in parentheses on first use
- Benchmark tables: Use emoji trophy (🏆) to mark best performers, preserve table formatting exactly
- Tutorial links: Keep Chinese tutorial URLs unchanged (content is Chinese)
- VitePress callouts: Use `> [!IMPORTANT]`, `> [!NOTE]`, `> [!TIP]`, `> [!WARNING]`, `> [!CAUTION]` format
- Code blocks with comments: Translate Chinese comments to English, preserve all code/config syntax
- All internal doc links: Add `/en/` prefix (e.g., `/guide/quick-start` → `/en/guide/quick-start`)
- GitHub issue/PR links: Keep unchanged (external links)
- johnvansickle.com FFmpeg downloads: Keep URLs unchanged
