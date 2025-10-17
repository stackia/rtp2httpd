# FCC 协议 Wireshark 分析器使用说明

这是一个用于分析 FCC (Fast Channel Change) 协议的 Wireshark Lua dissector。

## 快速开始

### 1. 安装插件

将 [fcc_dissector.lua](./fcc_dissector.lua) 文件复制到 Wireshark 插件目录：

**Linux / macOS:**

```bash
mkdir -p ~/.local/lib/wireshark/plugins/
cp fcc_dissector.lua ~/.local/lib/wireshark/plugins/
```

**Windows:**

```text
%APPDATA%\Wireshark\plugins\
```

### 2. 重新加载插件

- 重启 Wireshark，或
- 在 Wireshark 中选择 `Analyze` -> `Reload Lua Plugins` (Ctrl+Shift+L)

### 3. 开始捕获

Dissector 会自动识别以下情况的 FCC 协议包：

- UDP 端口 8027/15970 的流量（默认 FCC 服务器端口）
- 符合 FCC 协议特征的 RTCP 包（自动启发式检测）

## 支持的消息类型

| FMT | 消息类型          | 说明                     |
| --- | ----------------- | ------------------------ |
| 2   | Client Request    | 客户端请求 FCC 服务      |
| 3   | Server Response   | 服务器响应（包含流参数） |
| 4   | Sync Notification | 同步通知（可加入组播）   |
| 5   | Termination       | 终止消息                 |

## 过滤器示例

```text
# 显示所有 FCC 协议包
fcc

# 只显示客户端请求
fcc.fmt == 2

# 只显示服务器响应
fcc.fmt == 3

# 只显示成功的响应
fcc.resp.result == 0

# 只显示服务器重定向消息
fcc.resp.action == 3

# 显示特定组播地址的请求
fcc.req.mcast_ip == 239.1.1.1
```

## 字段说明

### 通用字段

- `fcc.version`: RTCP 版本
- `fcc.fmt`: 反馈消息类型
- `fcc.media_ssrc`: 媒体源地址（显示为 IP）

### 客户端请求字段

- `fcc.req.client_port`: 客户端端口
- `fcc.req.mcast_port`: 组播端口
- `fcc.req.mcast_ip`: 组播地址
- `fcc.req.stb_id`: 机顶盒 ID

### 服务器响应字段

- `fcc.resp.result`: 结果代码（0=成功，1=错误）
- `fcc.resp.action`: 动作代码（2=启动单播，3=重定向）
- `fcc.resp.signal_port`: 信令端口
- `fcc.resp.media_port`: 媒体端口
- `fcc.resp.new_ip`: 新服务器地址
- `fcc.resp.speed`: 突发速率（自动显示为 Mbps/Kbps）
- `fcc.resp.speed_after_sync`: 同步后速率

### 终止消息字段

- `fcc.term.stop_bit`: 停止位（0=正常，1=强制）
- `fcc.term.seqn`: 首个组播包序列号

## 自定义端口

如果你的 FCC 服务器使用非标准端口，可以编辑 `fcc_dissector.lua` 文件：

```lua
-- 找到这一行并修改端口号
udp_port:add(8027, fcc_proto)  -- 改为你的端口
```

或者使用 Wireshark 的 "Decode As" 功能：

1. 右键点击一个 UDP 包
2. 选择 `Decode As...`
3. 添加你的端口号，协议选择 `FCC`

## 故障排除

**Q: 看不到 FCC 协议？**

- 确认插件文件在正确的目录
- 检查 Wireshark 日志：`Help` -> `About Wireshark` -> `Folders` -> `Personal Lua Plugins`
- 确认数据包端口是 8027/15970 或符合 FCC 协议特征

**Q: 如何查看插件是否加载成功？**

- 打开 `Help` -> `About Wireshark` -> `Plugins` 标签
- 搜索 "fcc" 或 "Fast Channel Change"

**Q: 字段显示不全？**

- 确认数据包完整（未被截断）
- 检查数据包长度是否符合协议要求
