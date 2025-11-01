include $(TOPDIR)/rules.mk

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
PKG_PO_VERSION:=$(PKG_VERSION)
PKG_RELEASE:=1

LUCI_TITLE:=LuCI Support for rtp2httpd
LUCI_DEPENDS:=+rtp2httpd

PKG_MAINTAINER:=Stackie Jia <jsq2627@gmail.com>
PKG_LICENSE:=GPL-2.0-or-later

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
