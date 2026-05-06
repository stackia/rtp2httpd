# FCC IP Documentation Sync Memory

## Processing Checkpoint

last_processed_comment_date: 2026-05-05T06:17:23Z

## Document Paths

- Chinese FCC summary document: `docs/reference/cn-fcc-collection.md`
- English version: `docs/en/reference/cn-fcc-collection.md`

## FCC Address Characteristics

All FCC addresses, whether public or private, are usually usable only inside the specified
province, region, or operator network. When adding entries, include province, city, and ISP
information whenever possible.

## Common Ports and Platforms

- 8027: Huawei platform
- 15970: ZTE/FiberHome platform
- 7777: Shanghai Telecom specific
- 554: RTSP port, used by special Jiangsu Telecom channels

## Document Format

Group by province, then by ISP: China Telecom, China Unicom, China Mobile. Within the same
province and ISP, list addresses without city annotations first, then addresses with city
annotations.

```markdown
## Province

- 电信：
  - `IP:port`
  - `IP:port`（City）
```

## Classification Lessons

- Comments containing fields such as `ChannelFCCIP`, `ChannelFCCPort`, and `FCCEnable` are usually packet-capture shares and actionable.
- "部分频道不支持 FCC" for 4K or carousel channels is normal behavior, not an address failure. Do not remove addresses for that alone.
- Some FCC servers redirect to other IPs for load balancing. This is normal behavior.

## Update Log

- 2026-05-05: Processed 2 new comments. Added Zhejiang Huzhou Telecom `115.208.248.108:8027` (comment ID 4376934403, reaction added). One Chengdu CCTV13 entry (`118.123.55.74:8027`) was already documented.
- 2026-05-04: Processed 7 new comments. Added Guangdong Foshan Telecom `183.59.144.166:8027` (comment ID 4143424499). Other comments: one already documented Baoding entry with reaction added, one already documented Chengdu CCTV13 entry, one Tianjin Unicom inquiry, one Shandong Yantai inquiry/single-point non-working report with no Yantai Unicom doc entry, one Shanghai Telecom timeout note where `124.75.25.211` was confirmed working by another user, and one Shanghai Telecom rebuttal to the timeout report.
- 2026-03-16: Processed 1 new comment (ID: 4065999085). Added Hebei Baoding Telecom `192.168.72.20:8027`.
- 2026-03-15: Processed 1 new comment (ID: 4060432457). Added Sichuan Yibin Telecom `182.134.43.42:8027`.
- 2026-03-12: Processed 1 new comment (ID: 4039072693). No update: Guizhou Telecom `10.255.5.32:8027` was already documented.
- 2026-03-09: Processed 3 new comments (IDs: 3988244004, 3994879570, 4018542569), 108 total comments. No update: Shandong Weifang/Heze Unicom addresses were already documented; Zhejiang Hangzhou Telecom was troubleshooting context.
- 2026-03-08: Processed all 105 comments. Added 8 addresses: Zhejiang Wenzhou 4, Hunan Shaoyang 1, Henan Unicom 2, Hebei Telecom 1; annotated Hebei Telecom Tangshan.
- 2026-03-03: Processed 1 new comment (ID: 3988244004). Added Shandong Weifang Unicom `60.210.139.78:8027`.
