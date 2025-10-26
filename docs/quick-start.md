# 快速上手

## OpenWrt 一键安装（推荐）

使用一键安装脚本自动下载并安装最新版本：

```bash
curl -fsSL https://raw.githubusercontent.com/stackia/rtp2httpd/main/scripts/install-openwrt.sh | sh
```

脚本会自动：

- 检测设备的 CPU 架构
- 从 GitHub Release 获取最新版本
- 下载并安装所有必需的软件包（主程序 + LuCI 界面 + 语言包）

## 基本配置

安装完成后，在 LuCI 管理界面的 "服务" 菜单中找到 "rtp2httpd" 进行配置：

<img width="2048" height="1910" alt="Image" src="https://github.com/user-attachments/assets/4252d5c4-b575-4b5e-a66b-4cabcf4f2cd1" />

### 必需配置项

1. **启用**：勾选启用 rtp2httpd
2. **端口**：默认 5140，也可以自定义
3. **上游接口**：设置为 IPTV 网络接口

### 可选配置项

- **外部 M3U**：如有现成的 M3U 播放列表，填入此设置项后后即可使用内置 Web 播放器（[详细说明](m3u-integration.md)）
- **FCC 服务器**：如需快速换台，配置 FCC 服务器地址（[如何获取](fcc-setup.md)）
- **视频快照**：如需频道预览图功能，启用视频快照（[配置方法](video-snapshot.md)）

## 测试访问

配置完成后，可以通过以下 URL 测试访问：

```bash
# 访问 RTP 组播流
http://路由器IP:5140/rtp/239.253.64.120:5140

# 访问状态页面
http://路由器IP:5140/status

# 获取 M3U 播放列表（如已配置）
http://路由器IP:5140/playlist.m3u

# 使用内置播放器（需配置 M3U）
http://路由器IP:5140/player
```

## 使用内置播放器

如果已配置 M3U 播放列表，可直接在浏览器中访问内置播放器：

```bash
http://路由器IP:5140/player
```

内置播放器提供：

- 频道列表自动加载（来自配置的 M3U）
- 在线直播观看
- 时移回看支持（如频道支持）
- FCC 快速换台
- 响应式设计，支持移动设备

**注意**：播放器依赖浏览器的原生解码能力，部分编码格式可能无法播放。推荐使用 Chrome/Edge/Safari 等现代浏览器。

## 在其他播放器中使用

将 `http://路由器IP:5140/playlist.m3u` 添加到支持 IPTV 的播放器中即可观看。

## 查看日志

有三种方式可以查看运行日志：

1. 访问状态页面 `/status`，页面底部查看日志
2. 在 OpenWrt 后台，"状态" -> "系统日志" 查看日志
3. SSH 连接路由器后运行 `logread -e rtp2httpd`

## 下一步

- [安装方式](installation.md)：了解其他安装方式（Docker、静态二进制、编译安装）
- [M3U 播放列表集成](m3u-integration.md)：配置播放列表自动识别和转换
- [URL 格式说明](url-formats.md)：了解所有支持的 URL 格式
- [配置参数详解](configuration.md)：深入了解所有配置选项
- [FCC 快速换台配置](fcc-setup.md)：启用毫秒级换台功能
