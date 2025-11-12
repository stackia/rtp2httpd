# FCC 快速换台配置指南

FCC (Fast Channel Change) 是运营商级的快速换台协议，可实现毫秒级换台响应。大多数省份的 IPTV 机顶盒都是通过 FCC 实现快速换台。

## FCC 工作原理

在换台时，先请求 FCC 服务器获取单播视频流，FCC 服务器可以立即发送视频流的 IDR 帧和初始数据，可供播放器立即解码；后续等待单播流和组播流同步后，无缝切换到组播流。

因此必须先找到组播源对应的 FCC 服务器，才可以使用。

## FCC 服务器获取方法

### 方法一：查询已知 FCC 服务器列表

可以先查看 [中国大陆 FCC 服务器列表](./cn-fcc-collection.md)，尝试能否找到自己本地可用的地址。

### 方法二：从机顶盒抓包获取

如果列表中没有你的地区，则需要从 IPTV 机顶盒抓包获取。

#### 使用 Wireshark 抓包

1. **安装 Wireshark**：在 PC 上安装 Wireshark 抓包工具

2. **连接机顶盒**：

   - 方式 1：使用网络分路器或镜像端口
   - 方式 2：将 PC 设置为机顶盒的网关进行中间人抓包

   具体方式这里不再详述，网络教程很多。

3. **找到频道清单请求，搜索关键字段**：

   - 查找 `ChannelFCCIP` 字段：FCC 服务器 IP 地址
   - 查找 `ChannelFCCPort` 字段：FCC 服务器端口号

4. **或者直接识别 FCC 协议包**：

   - 或者你也可以直接尝试播放，通过换台触发 FCC 流程，直接抓 FCC 协议包
   - 下载安装 [Wireshark FCC 协议插件](../wireshark-support/README.md)
   - 通过筛选 `fcc` 定位 FCC 协议包，记录下对端 IP 和端口

## 配置和使用 FCC

### 在 URL 中指定 FCC 服务器

```url
http://服务器地址:端口/rtp/组播地址:端口?fcc=FCC服务器IP:端口[&fcc-type=协议类型]
```

**示例**：

```url
# 电信 FCC（自动判断）
http://192.168.1.1:5140/rtp/239.253.64.120:5140?fcc=10.255.14.152:15970

# 华为 FCC（自动判断）
http://192.168.1.1:5140/rtp/239.253.64.120:5140?fcc=10.255.14.152:8027

# 手动指定华为 FCC 协议
http://192.168.1.1:5140/rtp/239.253.64.120:5140?fcc=10.255.14.152:8027&fcc-type=huawei

# 手动指定电信 FCC 协议
http://192.168.1.1:5140/rtp/239.253.64.120:5140?fcc=10.255.14.152:15970&fcc-type=telecom
```

#### fcc-type 参数说明

- **telecom** 或 不指定：使用电信/中兴/烽火 FCC 协议
- **huawei**：使用华为 FCC 协议

大多数情况使用 `telecom` 就可以工作。在一些特定网络环境下可能需要 `huawei` 协议。

### 在 M3U 中配置 FCC

如果使用 M3U 播放列表，可以在每个频道的 URL 中添加 FCC 参数：

```m3u
#EXTM3U
#EXTINF:-1,CCTV-1（电信 FCC）
http://192.168.1.1:5140/rtp/239.253.64.120:5140?fcc=10.255.14.152:15970
#EXTINF:-1,CCTV-2（华为 FCC）
http://192.168.1.1:5140/rtp/239.253.64.121:5140?fcc=10.255.14.152:8027
```

## NAT 穿透配置

### 华为 FCC 协议

华为 FCC 协议原生支持 NAT 穿透，无需额外配置端口转发即可在 NAT 后面正常工作。华为 FCC 协议只在华为 IPTV 平台下可以使用。

### 电信 FCC 协议

如果使用电信/中兴/烽火 FCC 协议，且 rtp2httpd 运行在路由器后面的设备上（如 NAS、PC 等），并且上级路由器负责接入 IPTV 网络，则需要配置端口转发，FCC 才可以正常工作。

基本上所有 IPTV 平台（包括华为）都支持电信 FCC 协议。

此外，你也需要配置 IGMP / 组播转发（`igmpproxy` / `omcproxy`），才能正常接收组播流。

#### 配置方法

请先手动指定 `--fcc-listen-port-range`：

```bash
# 命令行
rtp2httpd --fcc-listen-port-range 40000-40100

# 配置文件
[global]
fcc-listen-port-range = 40000-40100
```

然后需要在上级路由器配置端口转发，将这个端口范围（例如 `40000-40100`）转发到运行 rtp2httpd 的设备。

> **提示**：如果你的环境需要 NAT 穿透，且 FCC 服务器同时支持两种协议，建议优先使用华为 FCC 协议（端口 8027），可以省去端口转发配置。

## 测试 FCC 是否工作

1. **使用起播较快播放器**：确保播放器本身起播速度足够快，不能成为瓶颈

2. **观察换台速度**：

   - 正常启用 FCC：换台延迟 < 1s
   - 未启用 FCC：换台延迟 2-5 秒

3. **查看日志**：

   - 出现 `FCC: Unicast stream started successfully` 表示 FCC 地址有效，并且成功收到单播流。
   - 出现 `FCC: Server response timeout (80 ms), falling back to multicast` 有两种可能
     1. FCC 地址无效。
     2. 你的网络配置不正确，导致无法连接到 FCC 服务器。一般来说必须通过 DHCP/IPoE/PPPoE 获得 IPTV 内网 IP 后，并启用 rtp2httpd `--upstream-interface-fcc` 或 `--upstream-interface` 选项指定 IPTV 接口后，才能访问 FCC。请结合 ping / traceroute 等工具判断。

## 相关文档

- [URL 格式说明](url-formats.md)：FCC URL 格式
- [配置参数详解](configuration.md)：FCC 相关配置参数
