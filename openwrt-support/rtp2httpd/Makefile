include $(TOPDIR)/rules.mk

PKG_NAME:=rtp2httpd

# Extract version from git tags only if current commit is tagged and clean
RELEASE_VERSION:=$(if $(DUMP),unknown,$(shell \
	cd $(CURDIR)/../.. 2>/dev/null && \
	if git describe --tags --exact-match --match 'v*' 2>/dev/null >/dev/null && \
	   git diff --quiet 2>/dev/null && \
	   git diff --cached --quiet 2>/dev/null; then \
		git describe --tags --exact-match --match 'v*' 2>/dev/null | sed 's/^v//'; \
	else \
		echo "$$(date +%Y%m%d)"; \
	fi))

PKG_VERSION:=$(shell echo "$(RELEASE_VERSION)" | sed 's/-\([a-z]*\)\.\([0-9]*\)/_\1\2/g')
PKG_RELEASE:=1
PKG_MAINTAINER:=Stackie Jia <jsq2627@gmail.com>
PKG_LICENSE:=GPL-2.0-or-later
PKG_LICENSE_FILES:=LICENSE

PKG_FIXUP:=autoreconf

include $(INCLUDE_DIR)/package.mk

# Export RELEASE_VERSION to autoreconf and configure
export RELEASE_VERSION

define Build/Prepare
	mkdir -p $(PKG_BUILD_DIR)
	$(CP) $(CURDIR)/../../* $(PKG_BUILD_DIR)/
endef

define Package/rtp2httpd
	SECTION:=net
	CATEGORY:=Network
	TITLE:=Multicast RTP/RTSP to Unicast HTTP stream converter, optimized for China IPTV
	URL:=https://github.com/stackia/rtp2httpd
endef

define Package/rtp2httpd/description
	rtp2httpd converts RTP/UDP/RTSP media into http stream.
	It acts as a tiny HTTP server. When client connect,
	pre-configured multicast RTP service is choosen by URL.
	Program then join pre-configured multicast address and translate
	incoming RTP data to HTTP stream.
endef

CONFIGURE_ARGS += \
	--enable-optimization=-O3

define Package/rtp2httpd/conffiles
/etc/config/rtp2httpd
/etc/rtp2httpd.conf
endef

define Package/rtp2httpd/install
	$(INSTALL_DIR) $(1)/etc/init.d $(1)/etc/config $(1)/usr/bin
	$(INSTALL_CONF) ./files/rtp2httpd.conf $(1)/etc/config/rtp2httpd
	$(INSTALL_CONF) $(PKG_BUILD_DIR)/rtp2httpd.conf $(1)/etc
	$(INSTALL_BIN) ./files/rtp2httpd.init $(1)/etc/init.d/rtp2httpd
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/src/rtp2httpd $(1)/usr/bin
endef

$(eval $(call BuildPackage,rtp2httpd))
