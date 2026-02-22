# Installation

Language: [中文](../installation.md) | [English](installation.md)

rtp2httpd supports multiple installation methods for different environments.

## OpenWrt Router Deployment

OpenWrt is the best runtime environment for rtp2httpd. After IPTV network integration (search for "OpenWrt IPTV integration" guides), once you obtain an IPTV intranet IP via DHCP, you can access the entire IPTV network without NAT traversal.

The minimum supported OpenWrt version is 21.02. On lower versions, the LuCI UI may not load. You can still edit `/etc/config/rtp2httpd` manually and restart via `/etc/init.d/rtp2httpd restart`.

### One-Command Install Script

Use the script to download and install the latest version. If rtp2httpd is already installed, rerun the script to upgrade.

```bash
uclient-fetch -q -O - https://raw.githubusercontent.com/stackia/rtp2httpd/main/scripts/install-openwrt.sh | sh
```

The script will:

- Detect CPU architecture
- Fetch the latest release from GitHub
- Download and install required packages (core + LuCI + language packs)

<details>
<summary>Use prerelease builds (click to view)</summary>

```bash
uclient-fetch -q -O - https://raw.githubusercontent.com/stackia/rtp2httpd/main/scripts/install-openwrt.sh | sh -s -- --prerelease
```

</details>

### Manual Install

If you cannot use the script, download packages for your architecture from [Releases](https://github.com/stackia/rtp2httpd/releases):

- `rtp2httpd_x.y.z-1_<arch>.ipk` - Core package
- `luci-app-rtp2httpd_x.y.z_all.ipk` - LuCI web UI
- `luci-i18n-rtp2httpd-en_x.y.z_all.ipk` - English language pack
- `luci-i18n-rtp2httpd-zh-cn_x.y.z_all.ipk` - Chinese language pack

```bash
opkg install rtp2httpd_*.ipk luci-app-rtp2httpd_*.ipk luci-i18n-rtp2httpd-*.ipk
```

## Static Binary Deployment

Download the static binary `rtp2httpd-<version>-<arch>` from [Releases](https://github.com/stackia/rtp2httpd/releases), upload it to your device, and `chmod +x`.

By default, it reads `/etc/rtp2httpd.conf`. Override with `--config` or `--noconfig`.

**Example**:

```bash
# Download binary
wget https://github.com/stackia/rtp2httpd/releases/download/vX.Y.Z/rtp2httpd-X.Y.Z-x86_64
chmod +x rtp2httpd-X.Y.Z-x86_64

# Run with config file
./rtp2httpd-X.Y.Z-x86_64 --config /path/to/rtp2httpd.conf

# Run with CLI arguments only
./rtp2httpd-X.Y.Z-x86_64 --noconfig --verbose 2 --listen 5140 --maxclients 20
```

Tip: Use the sample config [rtp2httpd.conf](../../rtp2httpd.conf) as a starting point. See [Configuration Reference](configuration.md).

## Docker Deployment

Use Docker on supported devices. **Host networking is required** to receive multicast.

### Basic Run

```bash
docker run --network=host --cap-add=NET_ADMIN --ulimit memlock=-1:-1 --rm \
  ghcr.io/stackia/rtp2httpd:latest \
  --noconfig --verbose 2 --listen 5140 --maxclients 20
```

### docker-compose

```yaml
services:
  rtp2httpd:
    image: ghcr.io/stackia/rtp2httpd:latest
    network_mode: host
    restart: unless-stopped
    cap_add:
      - NET_ADMIN
    ulimits:
      memlock:
        soft: -1
        hard: -1
    command: --noconfig --verbose 2 --listen 5140 --maxclients 20
```

> **Recommended flags**:
>
> - `cap_add: NET_ADMIN`: Allows `SO_RCVBUFFORCE` to bypass `net.core.rmem_max` for larger UDP receive buffers
> - `ulimits: memlock: -1`: Required for zero-copy (`--zerocopy-on-send`), MSG_ZEROCOPY needs locked pages

### Mount a Config File

If you want to use a config file (assume `/path/to/rtp2httpd.conf`):

```bash
docker run --network=host --cap-add=NET_ADMIN --ulimit memlock=-1:-1 --rm \
  -v /path/to/rtp2httpd.conf:/usr/local/etc/rtp2httpd.conf:ro \
  ghcr.io/stackia/rtp2httpd:latest
```

Tip: Use the sample config [rtp2httpd.conf](../../rtp2httpd.conf) as a starting point. See [Configuration Reference](configuration.md).

## OpenWrt Build From Source

If you want to compile rtp2httpd into an OpenWrt firmware image, add this repo to `feeds.conf.default`:

```text
# Use latest main branch
src-git rtp2httpd https://github.com/stackia/rtp2httpd.git
```

Or pin a version:

```text
# Use v3.1.1 code
src-git rtp2httpd https://github.com/stackia/rtp2httpd.git;v3.1.1
```

Run `./scripts/feeds update rtp2httpd` and `./scripts/feeds install rtp2httpd`.

Run `make menuconfig`, go to `LuCI -> Applications -> luci-app-rtp2httpd`, and select `*` (built-in) or `M` (as package), then save.

Run `make package/feeds/rtp2httpd/luci-app-rtp2httpd/compile -j1 V=sc` to compile `luci-app-rtp2httpd` and `rtp2httpd`.

### Firmware Maintainer Integration Guide

If you maintain third-party OpenWrt firmware and want to integrate rtp2httpd directly into your feeds (instead of `src-git`), use the provided `Makefile.versioned`:

```bash
git clone https://github.com/stackia/rtp2httpd.git
cd rtp2httpd

# Replace Makefiles with pre-generated versions (fixed version, download URL, PKG_HASH)
mv openwrt-support/rtp2httpd/Makefile.versioned openwrt-support/rtp2httpd/Makefile
mv openwrt-support/luci-app-rtp2httpd/Makefile.versioned openwrt-support/luci-app-rtp2httpd/Makefile

# Copy openwrt-support into your feeds repo
cp -r openwrt-support/* /path/to/your/feeds/
```

`Makefile.versioned` differs from the original `Makefile` by pinning the version and `PKG_HASH`, and downloading source from GitHub Releases instead of a local git repo. It is updated on main with each release.

## Traditional Build and Install

For custom builds or development.

### Dependencies

```bash
# Ubuntu/Debian
sudo apt-get install build-essential autoconf automake pkg-config curl

# Install Node.js LTS (for Web UI build)
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs
corepack enable
```

### Build Steps

```bash
# Clone repo
git clone https://github.com/stackia/rtp2httpd.git
cd rtp2httpd

# Build frontend and embed assets
pnpm --prefix web-ui install --frozen-lockfile
pnpm --prefix web-ui run build

# Generate build scripts
autoreconf -fi

# Configure and build
./configure --enable-optimization=-O3
make

# Install
sudo make install
```

### Optional Dependencies

- **curl** or **uclient-fetch** or **wget**: For external M3U playlists (HTTP/HTTPS)
- **ffmpeg**: For video snapshots

## Next Steps

- [Quick Start](quick-start.md): OpenWrt quick configuration
- [Configuration Reference](configuration.md): All configuration options
- [URL Formats](url-formats.md): Supported URL formats
