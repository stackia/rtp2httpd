# FCC 快速换台配置

FCC (Fast Channel Change) 是运营商级的快速换台协议，可实现毫秒级换台响应。中国大多数省份的 IPTV 机顶盒都是通过 FCC 实现快速换台。

## FCC 工作原理

### 为什么纯组播起播慢？

视频编码（如 H.264/H.265）采用帧间压缩，只有关键帧（IDR 帧）才包含完整的画面信息，后续帧（P 帧、B 帧）都依赖关键帧进行解码。组播流是持续不断发送的，当播放器中途加入时，收到的第一个包大概率不是关键帧，播放器必须等到下一个关键帧到达才能开始解码。关键帧的间隔（GOP）通常为 1-5 秒，因此纯组播换台时会有明显的等待时间。

### FCC 如何实现快速起播？

FCC 服务器缓存了各频道最近的关键帧。当播放器换台时：

1. rtp2httpd 向 FCC 服务器发起单播请求
2. FCC 服务器立即回传缓存的关键帧及后续数据，播放器无需等待即可开始解码
3. 与此同时，rtp2httpd 也加入了对应频道的组播组
4. 当单播流和组播流的数据同步后，rtp2httpd 无缝切换到组播流，断开单播连接

整个过程对播放器透明，保证播放器收到的第一帧是可立即解码出画面的 IDR 帧。

因此必须先找到组播源对应的 FCC 服务器，才可以使用。

## FCC 服务器获取方法

### 方法一：查询已知 FCC 服务器列表

可以先查看 [各地 FCC 地址汇总](../reference/cn-fcc-collection.md)，尝试能否找到自己本地可用的地址。

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
   - 下载安装 [Wireshark FCC 协议插件](https://github.com/stackia/rtp2httpd/blob/main/wireshark-support/README.md)
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

> [!IMPORTANT]
> 只有当 rtp2httpd 运行在 NAT 设备之后（例如 NAS、二级路由），才需要进行 NAT 穿透配置。如果 rtp2httpd 所在设备/容器拥有直接的 IPTV 网络访问能力（可以直接获得 IPTV 内网 IP），则无需做任何 NAT 穿透配置。

### 华为 FCC 协议

华为 FCC 协议原生支持 NAT 穿透，无需额外配置端口转发即可在 NAT 后面正常工作。华为 FCC 协议只在华为 IPTV 平台下可以使用。

### 电信 FCC 协议

如果使用电信/中兴/烽火 FCC 协议，则需要配置端口转发，FCC 才可以正常工作。

基本上所有 IPTV 平台（包括华为）都支持电信 FCC 协议。

此外，你也需要在上级路由器配置 IGMP / 组播转发（`igmpproxy` / `omcproxy`），才能正常接收组播流。

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

> [!TIP]
> 如果你的环境需要 NAT 穿透，且 FCC 服务器同时支持两种协议，建议优先使用华为 FCC 协议（端口 8027），可以省去端口转发配置。

## 测试 FCC 是否工作

1. **使用起播较快播放器**：确保播放器本身起播速度足够快，不能成为瓶颈，例如 [内置 Web 播放器](./web-player.md)。

2. **观察换台速度**：

   - 正常启用 FCC：换台延迟 < 1s
   - 未启用 FCC：换台延迟 2-5 秒

3. **查看日志**：

   - 出现 `FCC: Unicast stream started successfully` 表示 FCC 地址有效，并且成功收到单播流。
   - 出现 `FCC: Server response timeout (80 ms), falling back to multicast` 有两种可能
     1. FCC 地址无效。
     2. 你的网络配置不正确，导致无法连接到 FCC 服务器。一般来说必须通过 DHCP/IPoE/PPPoE 获得 IPTV 内网 IP 后，并启用 rtp2httpd `--upstream-interface-fcc` 或 `--upstream-interface` 选项指定 IPTV 接口后，才能访问 FCC。请结合 ping / traceroute 等工具判断。

## 相关文档

- [各地 FCC 地址汇总](../reference/cn-fcc-collection.md)：中国各省 FCC 服务器地址
- [URL 格式说明](./url-formats.md)：FCC URL 格式
- [配置参数详解](../reference/configuration.md)：FCC 相关配置参数
