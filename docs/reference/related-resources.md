# 相关教程和软件

本页汇总了社区提供的 IPTV 搭建教程、配套工具和播放器软件，方便用户快速找到所需资源。

> [!NOTE]
> 以下资源均由社区用户贡献和维护，不属于 rtp2httpd 项目本身。如有问题请联系对应项目的维护者。

## IPTV 搭建教程

如果是首次搭建 IPTV 组播转发服务，对相关网络知识比较陌生（DHCP 鉴权、路由、组播、防火墙），可以参考以下教程：

- [浙江杭州电信 IPTV 内网融合教程：在局域网任意设备观看 IPTV](https://baiyun.me/zhejiang-hangzhou-telecom-iptv)
- [自动抓取IPTV单播地址，实现时移回看](https://www.bandwh.com/net/2571.html)
- [K2P 利用 rtp2httpd 刷 openwrt 单线复用双网融合完美解决看 IPTV 超简单详细](https://www.right.com.cn/forum/thread-8457970-1-1.html)
- [重庆电信 IPTV 内网融合 抓包 rtp2httpd](https://www.right.com.cn/forum/thread-8457356-1-1.html)
- [浙江 电信 IPTV 组播 转单播 rtp2httpd 去花屏](https://www.right.com.cn/forum/thread-8452510-1-1.html)
- [使用 Rtp2httpd 酷 9 浙江 电信 IPTV 单播 回看](https://www.right.com.cn/forum/thread-8453715-1-1.html)
- [湖南电信 OpenWrt 拨号 IPTV 全流程教程 | 内网融合组播转单播 + 单播回看全搞定](https://mp.weixin.qq.com/s/_hEVbrgHll_qIePXGtATTw)

### 视频教程

- [旁路由 IPTV 插件使用篇](https://www.bilibili.com/video/BV1ioiKBNE8t/)
- [组播转单播系列第二期：借助 rtp2httpd 插件实现全家设备观看 iptv](https://www.bilibili.com/video/BV1Zhr4B3ELy/)

## 相关软件

### IPTV 播放器

#### mytv-android

- 项目地址：<https://github.com/mytv-android/mytv-android>

Android 平台 IPTV 播放器，支持 FCC 快速换台、EPG 电子节目单、时移回看等功能。

#### IPTV-Player

- 项目地址：<https://github.com/CGG888/IPTV-Player>

Windows 平台 IPTV 播放器，基于 libmpv 播放内核和 WPF 界面。支持 M3U 播放列表、EPG 电子节目单、时移回看、FCC 快速切台、UDP 组播优化等功能。

#### iptvnator

- 项目地址：<https://github.com/CGG888/iptvnator>

Windows 平台 IPTV 播放器，针对中国大陆 IPTV 场景增强。主要特性：

- 自动识别组播/单播来源，选择最佳播放内核（组播用 mpegts.js，单播用 hls.js）
- 支持基于 XMLTV 的时移回看，默认 7 天时移窗口
- 4K/高清/标清画质策略，同名频道按质量优先排序
- EPG 频道名称智能匹配与中文化

### IPTV 订阅和频道工具

#### IPTV-channels

- 项目地址：<https://github.com/mytv-android/IPTV-channels>

基于 Docker 的 IPTV 订阅获取工具（四川电信），可自动生成包含 FCC、FEC 和单播回看地址的 M3U 播放列表。

#### Iptv-Checker

- 项目地址：<https://github.com/CGG888/Iptv-Checker>

基于 Docker 的 IPTV 单播/组播批量扫描检测工具。主要功能：

- 批量导入组播流地址，自动检测在线状态、分辨率、编码、帧率等信息
- 支持按在线/离线筛选，按频道名或地址搜索
- 导出为 TXT 或 M3U 格式（M3U 支持 FCC 参数、catchup 回看地址）
- 同名频道按质量优先排序（组播 4K > HD > SD > 单播）
- 版本管理，支持保存和加载检测结果
