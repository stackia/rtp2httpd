# 安装方式

rtp2httpd 支持多种安装方式，适应不同的使用场景。

## OpenWrt 路由器部署

OpenWrt 是 rtp2httpd 的最佳运行环境。在中国大陆，通常需要先完成 IPTV 网络融合（可以搜索教程 `OpenWrt IPTV 融合`），通过 DHCP 获取到 IPTV 内网 IP，才能访问运营商的 IPTV 组播网络。

详见 [快速上手](./quick-start.md)。

## 固件内置

以下固件/平台已经内置 rtp2httpd（或者可以在应用市场、官方源直接下载安装 rtp2httpd）。

> [!IMPORTANT]
> 为了保证稳定性，通常内置/上架的 rtp2httpd 版本落后于官方最新版。如果你希望追新，建议使用其他方式来安装。

- [飞牛 fnOS](https://www.fnnas.com)：应用中心已上架 rtp2httpd，与飞牛桌面、统一网关、FN Connect 深度集成
- [iStoreOS](https://site.istoreos.com)：iStore 已上架 rtp2httpd
- [爱快 iKuai](https://www.ikuai8.com)：应用市场已上架 rtp2httpd
- [懒猫微服](https://lazycat.cloud)：应用商店已上架 rtp2httpd
- [cooluc's OpenWrt](https://github.com/sbwml/builder)：已内置 rtp2httpd
- [ImmortalWrt](https://github.com/immortalwrt/immortalwrt)：已加入官方源
- [AutoBuildImmortalWrt](https://github.com/wukongdaily/AutoBuildImmortalWrt)：[store](https://github.com/wukongdaily/store) 已内置 rtp2httpd，轻松构建
- [潘多拉 QWRT for K2P](https://www.right.com.cn/forum/forum.php?mod=viewthread&tid=8346913&fromuid=402348)：已内置 rtp2httpd

## 静态二进制文件部署

从 [Releases](https://github.com/stackia/rtp2httpd/releases) 页面下载对应架构的静态二进制文件 `rtp2httpd-<版本号>-<架构>`，上传到设备并 `chmod +x` 后即可运行。

默认从 `/etc/rtp2httpd.conf` 读取配置文件。可用 `--config` 或 `--noconfig` 参数覆盖。

**示例**：

```bash
# 获取自己的 CPU 架构
uname -m

# 下载二进制文件
wget https://github.com/stackia/rtp2httpd/releases/download/vX.Y.Z/rtp2httpd-X.Y.Z-x86_64
chmod +x rtp2httpd-X.Y.Z-x86_64

# 使用配置文件运行
./rtp2httpd-X.Y.Z-x86_64 --config /path/to/rtp2httpd.conf

# 仅使用命令行参数运行
./rtp2httpd-X.Y.Z-x86_64 --noconfig --verbose 2 --listen 5140 --maxclients 20
```

> [!TIP]
> 你可以使用这个示例文件 [rtp2httpd.conf](https://github.com/stackia/rtp2httpd/blob/main/rtp2httpd.conf) 作为基础来修改配置。具体说明见 [配置参数详解](../reference/configuration.md)。

另外 rtp2httpd 目前已不支持自身以守护进程方式运行。对于 Debian/Ubuntu 系统，您可以在 `/etc/systemd/system/rtp2httpd.service` 内添加以下内容以创建 systemd 服务单元。其他使用 systemd 作为服务管理器的操作系统也可以参考以下配置进行配置。

```text
[Unit]
Description=rtp2httpd - Multicast RTP/RTSP to Unicast HTTP stream converter
Documentation=https://github.com/stackia/rtp2httpd
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=60
StartLimitBurst=10

[Service]
Type=simple
# ExecStart 中的路径需与实际安装位置一致，可用 `command -v rtp2httpd` 或 `which rtp2httpd` 确认。
# ExecStart=/usr/local/bin/rtp2httpd --config /etc/rtp2httpd.conf
ExecStart=/opt/rtp2httpd/rtp2httpd --config /opt/rtp2httpd/rtp2httpd.conf
ExecReload=/bin/kill -HUP $MAINPID
Restart=always
RestartSec=3s
# 建议以非 root 专用用户运行，可通过 `useradd --system --no-create-home --shell /usr/sbin/nologin rtp2httpd` 创建用户
User=rtp2httpd
Group=rtp2httpd
AmbientCapabilities=CAP_NET_ADMIN CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_ADMIN CAP_NET_BIND_SERVICE
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

文件创建完成后使用以下指令启动 rtp2httpd 服务。

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now rtp2httpd
sudo systemctl status rtp2httpd
```

## Docker 容器部署

适用于支持 Docker 的设备。**需要使用 host 网络模式**以正确接收组播流。

### 基本启动方式

```bash
docker run --network=host --cap-add=NET_ADMIN --rm \
  ghcr.io/stackia/rtp2httpd:latest \
  --noconfig --verbose 2 --listen 5140 --maxclients 20
```

### 使用 docker-compose

```yaml
services:
  rtp2httpd:
    image: ghcr.io/stackia/rtp2httpd:latest
    network_mode: host
    restart: always
    cap_add:
      - NET_ADMIN
    command: --noconfig --verbose 2 --listen 5140 --maxclients 20
```

> [!NOTE]
> **关于推荐参数**：
>
> - `cap_add: NET_ADMIN`：允许通过 `SO_RCVBUFFORCE` 绕过内核参数 `net.core.rmem_max` 限制，设置更大的 UDP 接收缓冲区

### 挂载配置文件

如果需要使用配置文件（假设配置文件位于 `/path/to/rtp2httpd.conf`）：

```bash
docker run --network=host --cap-add=NET_ADMIN --rm \
  -v /path/to/rtp2httpd.conf:/usr/local/etc/rtp2httpd.conf:ro \
  ghcr.io/stackia/rtp2httpd:latest
```

> [!TIP]
> 你可以使用这个示例文件 [rtp2httpd.conf](https://github.com/stackia/rtp2httpd/blob/main/rtp2httpd.conf) 作为基础来修改配置。具体说明见 [配置参数详解](../reference/configuration.md)。

## OpenWrt 编译安装

如果你希望通过 OpenWrt 源码构建直接把 rtp2httpd 编译到固件里，可以把本仓库直接加入 `feeds.conf.default`：

```text
# 使用 main 分支最新代码
src-git rtp2httpd https://github.com/stackia/rtp2httpd.git
```

或者指定版本号：

```text
# 使用 v3.10.1 版本代码
src-git rtp2httpd https://github.com/stackia/rtp2httpd.git;v3.10.1
```

运行 `./scripts/feeds update rtp2httpd` 和 `./scripts/feeds install rtp2httpd` 更新 feed。

运行 `make menuconfig`，找到 `LuCI -> Applications -> luci-app-rtp2httpd`，将其勾选为 `*` (编译到固件) 或 `M` (编译成 ipk/apk 包)，保存退出。

运行 `make package/feeds/rtp2httpd/luci-app-rtp2httpd/compile -j1 V=sc` 可单独编译 `luci-app-rtp2httpd` 和 `rtp2httpd` 两个包。

### 固件维护者集成指南

如果你维护第三方 OpenWrt 固件，希望直接将 rtp2httpd 集成到你的 feeds 仓库中（而非通过 `src-git` 引用），可以使用本项目提供的 `Makefile.versioned`：

```bash
git clone https://github.com/stackia/rtp2httpd.git
cd rtp2httpd

# 用预生成的 Makefile 替换原始 Makefile（已包含固定版本号、源码下载地址和 PKG_HASH）
mv openwrt-support/rtp2httpd/Makefile.versioned openwrt-support/rtp2httpd/Makefile
mv openwrt-support/luci-app-rtp2httpd/Makefile.versioned openwrt-support/luci-app-rtp2httpd/Makefile

# 将 openwrt-support 目录内容复制到你的 feeds 仓库
cp -r openwrt-support/* /path/to/your/feeds/
```

`Makefile.versioned` 与原始 `Makefile` 的区别在于：版本号已固定、`PKG_HASH` 已填充、构建时会从 GitHub Release 下载源码包，无需本地 git 仓库。每次 rtp2httpd 发布新版本时，main 分支 `Makefile.versioned` 都会自动更新。

## 传统编译安装

适用于需要自定义编译或开发调试的场景。

### 安装依赖

```bash
# Ubuntu/Debian
sudo apt-get install build-essential cmake pkg-config curl

# 安装 Node.js LTS（用于构建 Web UI）
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs
corepack enable
```

### 编译步骤

```bash
# 克隆仓库
git clone https://github.com/stackia/rtp2httpd.git
cd rtp2httpd

# 构建 Web UI 并嵌入静态资源
pnpm install --frozen-lockfile
pnpm run web-ui:build

# 配置和编译
cmake -B build -DCMAKE_BUILD_TYPE=Release -DENABLE_AGGRESSIVE_OPT=ON
cmake --build build -j$(getconf _NPROCESSORS_ONLN)

# 安装
sudo cmake --install build
```

## 下一步

- [快速上手](./quick-start.md)：OpenWrt 快速配置指南
- [配置参数详解](../reference/configuration.md)：了解所有配置选项
- [URL 格式说明](./url-formats.md)：了解所有支持的 URL 格式
- [M3U 播放列表集成](./m3u-integration.md)：配置播放列表
- [FCC 快速换台配置](./fcc-setup.md)：启用毫秒级换台功能
