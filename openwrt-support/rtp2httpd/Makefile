include $(TOPDIR)/rules.mk

PKG_NAME:=rtp2httpd
PKG_VERSION:=1.0.0
PKG_RELEASE:=1
PKG_MAINTAINER:=Stackie Jia <jsq2627@gmail.com>

PKG_BUILD_DIR:=$(BUILD_DIR)/rtp2httpd-$(PKG_VERSION)
PKG_FIXUP:=autoreconf

include $(INCLUDE_DIR)/package.mk

define Package/rtp2httpd
  SECTION:=net
  CATEGORY:=Network
	TITLE:=Convert multicast RTP/UDP IPTV streams into HTTP streams with FCC support
  URL:=https://github.com/stackia/rtp2httpd
endef

define Package/rtp2httpd/description
  rtp2httpd converts multicast RTP/UDP media into http stream.
	It acts as a tiny HTTP server. When client connect,
	pre-configured multicast RTP service is choosen by URL.
	Program then join pre-configured multicast address and translate
	incoming RTP data to HTTP stream.
endef

define Build/Configure
  $(call Build/Configure/Default,--with-linux-headers=$(LINUX_DIR))
endef

define Package/rtp2httpd/install
        $(INSTALL_DIR) $(1)/usr/sbin
        $(INSTALL_BIN) $(PKG_BUILD_DIR)/brctl/brctl $(1)/usr/sbin/
endef

$(eval $(call BuildPackage,rtp2httpd))
