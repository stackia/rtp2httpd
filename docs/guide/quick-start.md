# 快速上手

## OpenWrt 一键安装/更新（推荐）

运行以下命令，自动下载并安装最新版本：

```bash
uclient-fetch -q -O - https://raw.githubusercontent.com/stackia/rtp2httpd/main/scripts/install-openwrt.sh | sh
```

脚本会自动：

- 检测设备的 CPU 架构
- 从 GitHub Release 获取最新版本
- 下载并安装所有必需的软件包（主程序 + LuCI 界面 + 语言包）
- 如果此前已经安装过，运行此脚本，将会卸载旧版，重新安装最新版

> [!TIP]
> 如果无法使用一键脚本，可以手动在 [Releases](https://github.com/stackia/rtp2httpd/releases) 页面下载对应架构的软件包：
>
> - `rtp2httpd_<版本号>_<架构>.ipk` - 主程序包
> - `luci-app-rtp2httpd_<版本号>_all.ipk` - LuCI Web 界面
> - `luci-i18n-rtp2httpd-zh-cn_<版本号>_all.ipk` - 中文语言包
>
> ```bash
> # 如果不知道自己的架构，可以用这条命令获取架构
> cat /etc/openwrt_release | grep ARCH
>
> # 手动将 ipk 上传至设备并安装
> opkg install rtp2httpd_*.ipk luci-app-rtp2httpd_*.ipk luci-i18n-rtp2httpd-*.ipk
> ```

## 基本配置

安装完成后，在 LuCI 管理界面的 "服务" 菜单中找到 "rtp2httpd" 进行配置：

![LuCI 配置界面](../images/luci-config.png)

> [!WARNING]
> 每次更新版本后如果 LuCI 出现工作异常，需要 **Ctrl+F5 刷新** 或 **清空浏览器缓存** 或 **使用无痕模式访问** 解决。

> [!IMPORTANT]
> 如果安装后，LuCI 未出现 rtp2httpd 入口，说明你的 LuCI 版本过低，无法支持 JS-based LuCI 插件。请考虑更新固件，或者手动编辑和维护 `/etc/config/rtp2httpd`（需要将 disabled 设为 0），使用 `/etc/init.d/rtp2httpd restart` 重启服务。
>
> 有一些热心网友开发了 Lua 版本 luci-app-rtp2httpd，在这种情况下可以尝试使用（非 rtp2httpd 官方维护）
>
> - <https://www.right.com.cn/forum/thread-8461513-1-1.html>
> - <https://github.com/jarod360/rtp2httpd/releases>


### 必需配置项

1. **基本设置 - 启用**：勾选启用 rtp2httpd
2. **基本设置 - 端口**：默认 5140，也可以自定义
3. **网络与性能 - 上游接口**：设置为 IPTV 网络接口

### 可选配置项

- **播放器与 M3U - 外部 M3U**：如有现成的 M3U 播放列表，填入此设置项后后即可使用 [内置 Web 播放器](./web-player.md)（[M3U 播放列表集成](./m3u-integration.md)）
- **FCC 服务器**：如需快速换台，需要在节目 URL 带上 FCC 服务器地址（[FCC 快速换台配置](./fcc-setup.md)）

## 测试访问

配置完成后，可以通过以下 URL 测试访问：

```bash
# 访问 RTP 组播流
http://路由器IP:5140/rtp/239.253.64.120:5140

# 访问状态页面
http://路由器IP:5140/status

# 获取 M3U 播放列表（如已配置）
http://路由器IP:5140/playlist.m3u
```

## 使用内置播放器

如果已配置 M3U 播放列表，可直接在浏览器中访问 `http://路由器IP:5140/player` 打开 [内置 Web 播放器](./web-player.md)。

## 在其他播放器中使用

将 `http://路由器IP:5140/playlist.m3u` 添加到支持 IPTV 的播放器中即可观看。

## 查看日志

有三种方式可以查看运行日志：

1. 访问状态页面 `/status`，页面底部查看日志
2. 在 OpenWrt 后台，"状态" -> "系统日志" 查看日志
3. SSH 连接路由器后运行 `logread -e rtp2httpd`

## 下一步

- [内置 Web 播放器](./web-player.md)：播放器功能、兼容性说明
- [安装方式](./installation.md)：了解其他安装方式（Docker、静态二进制、编译安装）
- [M3U 播放列表集成](./m3u-integration.md)：配置播放列表自动识别和转换
- [URL 格式说明](./url-formats.md)：了解所有支持的 URL 格式
- [配置参数详解](../reference/configuration.md)：深入了解所有配置选项
- [FCC 快速换台配置](./fcc-setup.md)：启用毫秒级换台功能
