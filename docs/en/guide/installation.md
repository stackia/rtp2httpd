# Installation

rtp2httpd supports multiple installation methods to suit different usage scenarios.

## OpenWrt Router Deployment

OpenWrt is the best runtime environment for rtp2httpd. In mainland China, you usually need to complete IPTV network integration first (you can search for tutorials like `OpenWrt IPTV integration`), obtain IPTV internal network IP via DHCP, before you can access the ISP's IPTV multicast network.

See [Quick Start](/en/guide/quick-start) for details.

## Static Binary Deployment

Download the static binary file `rtp2httpd-<version>-<arch>` for your architecture from the [Releases](https://github.com/stackia/rtp2httpd/releases) page, upload to your device, `chmod +x` and run.

By default, it reads configuration from `/etc/rtp2httpd.conf`. You can override with `--config` or `--noconfig` parameters.

**Example**:

```bash
# Get your CPU architecture
uname -m

# Download binary file
wget https://github.com/stackia/rtp2httpd/releases/download/vX.Y.Z/rtp2httpd-X.Y.Z-x86_64
chmod +x rtp2httpd-X.Y.Z-x86_64

# Run with config file
./rtp2httpd-X.Y.Z-x86_64 --config /path/to/rtp2httpd.conf

# Run with command-line parameters only
./rtp2httpd-X.Y.Z-x86_64 --noconfig --verbose 2 --listen 5140 --maxclients 20
```

> [!TIP]
> You can use this example file [rtp2httpd.conf](https://github.com/stackia/rtp2httpd/blob/main/rtp2httpd.conf) as a base to modify your configuration. See [Configuration Reference](/en/reference/configuration) for details.

## Docker Container Deployment

Suitable for Docker-capable devices. **Requires host network mode** to properly receive multicast streams.

### Basic Startup

```bash
docker run --network=host --cap-add=NET_ADMIN --ulimit memlock=-1:-1 --rm \
  ghcr.io/stackia/rtp2httpd:latest \
  --noconfig --verbose 2 --listen 5140 --maxclients 20
```

### Using docker-compose

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

> [!NOTE]
> **About recommended parameters**:
>
> - `cap_add: NET_ADMIN`: Allows bypassing the kernel parameter `net.core.rmem_max` limit via `SO_RCVBUFFORCE`, setting a larger UDP receive buffer
> - `ulimits: memlock: -1`: Required when zero-copy is enabled (`--zerocopy-on-send`), MSG_ZEROCOPY needs to lock memory pages

### Mount Configuration File

If you need to use a configuration file (assuming config file is at `/path/to/rtp2httpd.conf`):

```bash
docker run --network=host --cap-add=NET_ADMIN --ulimit memlock=-1:-1 --rm \
  -v /path/to/rtp2httpd.conf:/usr/local/etc/rtp2httpd.conf:ro \
  ghcr.io/stackia/rtp2httpd:latest
```

> [!TIP]
> You can use this example file [rtp2httpd.conf](https://github.com/stackia/rtp2httpd/blob/main/rtp2httpd.conf) as a base to modify your configuration. See [Configuration Reference](/en/reference/configuration) for details.

## OpenWrt Compile Integration

If you want to compile rtp2httpd directly into your firmware via OpenWrt source build, you can add this repository directly to `feeds.conf.default`:

```text
# Use latest code from main branch
src-git rtp2httpd https://github.com/stackia/rtp2httpd.git
```

Or specify a version:

```text
# Use v3.10.1 code
src-git rtp2httpd https://github.com/stackia/rtp2httpd.git;v3.10.1
```

Run `./scripts/feeds update rtp2httpd` and `./scripts/feeds install rtp2httpd` to update the feed.

Run `make menuconfig`, find `LuCI -> Applications -> luci-app-rtp2httpd`, select it as `*` (compile into firmware) or `M` (compile as ipk/apk package), save and exit.

Run `make package/feeds/rtp2httpd/luci-app-rtp2httpd/compile -j1 V=sc` to compile `luci-app-rtp2httpd` and `rtp2httpd` packages separately.

### Firmware Maintainer Integration Guide

If you maintain a third-party OpenWrt firmware and want to integrate rtp2httpd directly into your feeds repository (rather than via `src-git` reference), you can use the `Makefile.versioned` provided by this project:

```bash
git clone https://github.com/stackia/rtp2httpd.git
cd rtp2httpd

# Replace original Makefile with pre-generated one (includes fixed version number, source download URL and PKG_HASH)
mv openwrt-support/rtp2httpd/Makefile.versioned openwrt-support/rtp2httpd/Makefile
mv openwrt-support/luci-app-rtp2httpd/Makefile.versioned openwrt-support/luci-app-rtp2httpd/Makefile

# Copy openwrt-support directory contents to your feeds repository
cp -r openwrt-support/* /path/to/your/feeds/
```

The difference between `Makefile.versioned` and the original `Makefile` is: version number is fixed, `PKG_HASH` is filled, builds download source package from GitHub Release, no local git repository needed. Every time rtp2httpd releases a new version, the `Makefile.versioned` in the main branch is automatically updated.

## Traditional Compile Installation

Suitable for scenarios requiring custom compilation or development debugging.

### Install Dependencies

```bash
# Ubuntu/Debian
sudo apt-get install build-essential autoconf automake pkg-config curl

# Install Node.js LTS (for building Web UI)
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs
corepack enable
```

### Compile Steps

```bash
# Clone repository
git clone https://github.com/stackia/rtp2httpd.git
cd rtp2httpd

# Build Web UI and embed static resources
pnpm install --frozen-lockfile
pnpm run web-ui:build

# Generate build scripts
autoreconf -fi

# Configure and compile
./configure --enable-optimization=-O3
make

# Install
sudo make install
```

## Next Steps

- [Quick Start](/en/guide/quick-start): OpenWrt quick configuration guide
- [Configuration Reference](/en/reference/configuration): Learn all configuration options
- [URL Format Guide](/en/guide/url-formats): Learn all supported URL formats
- [M3U Playlist Integration](/en/guide/m3u-integration): Configure playlist
- [FCC Fast Channel Change Setup](/en/guide/fcc-setup): Enable millisecond-level channel switching
