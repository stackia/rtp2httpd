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
- [上海电信 猫棒/光猫桥接 OpenWrt下实现 Internet+IPTV盒子+udpxy/rtp2httpd+VoIP](https://www.right.com.cn/forum/thread-8268077-1-1.html)
- [湖南电信 OpenWrt 拨号 IPTV 全流程教程 | 内网融合组播转单播 + 单播回看全搞定](https://mp.weixin.qq.com/s/_hEVbrgHll_qIePXGtATTw)
- [折腾 IPTV 时一定会遇到的几个概念：IGMP Snooping、IGMP Proxy、泛洪，到底是啥？](https://mp.weixin.qq.com/s/oKS-tl1-hqgcZ_H01CTtXQ)
- [IPTV 里的 FCC 和 FEC 到底是什么？为什么有些源“高级得多”？](https://mp.weixin.qq.com/s/5l2Cg204YdqtWAV-RnqiYw)
- [IPTV 折腾到最后一步：播放列表的几种写法，一篇讲清](https://mp.weixin.qq.com/s/wZpO74_NJvlwBbI9uvEhWw)
- [手把手教你搞定浙江电信IPTV融合：安安稳稳看电视](https://zeaurx.com/archives/iptv)

### 视频教程

- [旁路由 IPTV 插件使用篇](https://www.bilibili.com/video/BV1ioiKBNE8t/)
- [组播转单播系列第二期：借助 rtp2httpd 插件实现全家设备观看 iptv](https://www.bilibili.com/video/BV1Zhr4B3ELy/)

## 固件生态

以下固件已经内置 rtp2httpd（或者可以在应用市场、官方源直接下载安装 rtp2httpd）。

> [!IMPORTANT]
> 固件为了保证稳定性，通常内置/上架的 rtp2httpd 版本比较老。如果你希望追新，建议使用 [官方支持的安装方式](../guide/installation.md) 来安装 rtp2httpd。

- [飞牛 fnOS](https://www.fnnas.com)（应用中心已上架 rtp2httpd）
- [iStoreOS](https://site.istoreos.com)（iStore 已上架 rtp2httpd）
- [cooluc's OpenWrt](https://github.com/sbwml/builder)（已内置 rtp2httpd）
- [AutoBuildImmortalWrt](https://github.com/wukongdaily/AutoBuildImmortalWrt)（[store](https://github.com/wukongdaily/store) 已内置 rtp2httpd，轻松构建）
- [潘多拉 QWRT for K2P](https://www.right.com.cn/forum/thread-8346913-1-1.html)（已内置 rtp2httpd）

## 相关软件

### IPTV 播放器

#### 电视直播TV mytv-android

- 项目地址：<https://github.com/mytv-android/mytv-android>

Android 平台 IPTV 播放器，支持 M3U 播放列表、FCC 快速换台、EPG 电子节目单、时移回看等功能。

目前唯一支持 rtp2httpd [视频快照](../guide/video-snapshot.md) 的播放器。

#### 源匣 SrcBox

- 项目地址：<https://github.com/CGG888/SrcBox>

Windows 平台 IPTV 播放器，基于 libmpv 播放内核和 WPF 原生界面。支持 M3U 播放列表、FCC 快速切台、EPG 电子节目单、时移回看、UDP 组播优化等功能。

#### IPTVnator (CGG888 fork)

- 项目地址：<https://github.com/CGG888/iptvnator>

Windows / macOS / Linux 跨平台 IPTV 播放器，此 fork 针对中国大陆 IPTV 场景增强，主要特性：

- 自动识别组播/单播来源，选择最佳播放内核（组播用 mpegts.js，单播用 hls.js）
- 支持时移回看
- 4K/高清/标清画质策略，同名频道按质量优先排序
- EPG 频道名称智能匹配与中文化

### IPTV 订阅和频道工具

#### IPTV Checker

- 项目地址：<https://github.com/CGG888/Iptv-Checker>

基于 Docker 的 IPTV 单播/组播批量扫描检测工具。主要功能：

- 批量导入组播流地址，自动检测在线状态、分辨率、编码、帧率等信息
- 支持按在线/离线筛选，按频道名或地址搜索
- 导出为 TXT 或 M3U 格式（M3U 支持 FCC 参数、catchup 回看地址）
- 同名频道按质量优先排序（组播 4K > HD > SD > 单播）
- 版本管理，支持保存和加载检测结果

#### IPTV 工具箱 iptv-tool

- 项目地址：<https://github.com/taksssss/iptv-tool>

基于 Docker 部署的 IPTV 综合管理工具箱，集 EPG 节目单管理、直播源管理、台标管理于一体。主要功能：

- 支持 DIYP/百川、超级直播、xmltv 等多种格式
- 直播源聚合（TXT/M3U）、测速校验、直播源代理
- 台标模糊匹配，支持 tvbox 接口
- 频道别名、正则表达式匹配，支持繁体中文
- 定时更新数据、缓存支持（Memcached/Redis）

#### IPTV-channels（四川电信）

- 项目地址：<https://github.com/mytv-android/IPTV-channels>

基于 Docker 的 IPTV 订阅获取工具，针对四川电信，自动从 IPTV 内网获取节目地址和 EPG，并生成包含 FCC、FEC 和单播回看地址的 M3U 播放列表。

#### iptv-cd-telecom（四川电信）

- 项目地址：<https://github.com/suzukua/iptv-cd-telecom>

成都/四川电信 IPTV 直播源项目，提供官方单播源和组播转单播两种接入方式，支持回看时移、FCC 快速换台、EPG 电子节目单，兼容 tvbox、KODI、APTV、mytv-android 等主流播放器。提供在线播放列表生成服务，可自定义 FCC、RTSP 代理、r2h-token 等参数。

#### beijing-unicom-iptv-playlist（北京联通）

- 项目地址：<https://github.com/zzzz0317/beijing-unicom-iptv-playlist>

北京联通 IPTV 播放列表，每日自动更新。提供组播、单播、RTSP 等多种格式的 M3U 播放列表，支持时移回看和 EPG。配套在线播放链接生成器和 Python 转换工具（generator.py），可灵活自定义直播源、时移源、代理地址等参数，支持 Flask/FastAPI 动态服务部署。

#### plsy1/iptv（山东联通）

- 项目地址：<https://github.com/plsy1/iptv>

山东联通 IPTV 播放列表，覆盖济南、青岛、烟台、潍坊等山东各地市的组播源，同时提供单播源（APTV、酷九、rtp2httpd 多种格式）。配套机顶盒登录鉴权模拟、EPG 节目单、RTSP 代理、数据抓取与 M3U 生成等工具。

#### Shanghai-IPTV（上海电信）

- 项目地址：<https://github.com/ihipop/Shanghai-IPTV>

上海电信 IPTV 组播节目单管理工具，基于 PHP + SQLite，支持 TXT 格式导入和 M3U8 格式导出。支持多线路、多清晰度（4K/HD/SD/LD）、多 EPG 源映射、UDPXY/rtp2httpd 转换、FCC 快速换台、台标管理等功能，可通过 PHP 内置服务器提供在线播放列表服务。
