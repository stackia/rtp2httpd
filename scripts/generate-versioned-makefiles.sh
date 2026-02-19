#!/bin/sh
set -e

RELEASE_VERSION=${RELEASE_VERSION:-"1.0.0-snapshot"}

# Download source tarball and compute PKG_HASH
PKG_SOURCE_URL="https://codeload.github.com/stackia/rtp2httpd/tar.gz/v${RELEASE_VERSION}"
TARBALL=$(mktemp)
trap 'rm -f "$TARBALL"' EXIT
curl -fsSL -o "$TARBALL" "$PKG_SOURCE_URL"
PKG_HASH=$(sha256sum "$TARBALL" | cut -d' ' -f1)

# Process rtp2httpd Makefile
awk -v version="$RELEASE_VERSION" -v pkg_hash="$PKG_HASH" '
  # Skip comment lines about version extraction and Makefile.versioned
  /^# Extract version from git tags/ { next }
  /^# For firmware maintainers:/ { next }
  /^# version and PKG_HASH/ { next }
  /^# See https:\/\/github.com\/stackia\/rtp2httpd/ { next }
  # Handle multi-line RELEASE_VERSION block
  /^RELEASE_VERSION:=/ {
    # Print hardcoded version instead
    print "RELEASE_VERSION:=" version
    # Skip continuation lines (ending with \)
    while (/\\$/) {
      if ((getline) <= 0) break
    }
    next
  }
  # Skip Build/Prepare block
  /^define Build\/Prepare$/ {
    while (!/^endef$/) {
      if ((getline) <= 0) break
    }
    next
  }
  # Add PKG_SOURCE lines before include $(INCLUDE_DIR)/package.mk
  /^include \$\(INCLUDE_DIR\)\/package\.mk$/ {
    print "PKG_SOURCE:=rtp2httpd-v$(RELEASE_VERSION).tar.gz"
    print "PKG_SOURCE_URL:=https://codeload.github.com/stackia/rtp2httpd/tar.gz/v$(RELEASE_VERSION)?"
    print "PKG_HASH:=" pkg_hash
    print ""
  }
  # Print all other lines
  { print }
' openwrt-support/rtp2httpd/Makefile > openwrt-support/rtp2httpd/Makefile.versioned

# Process luci-app-rtp2httpd Makefile
awk -v version="$RELEASE_VERSION" '
  # Skip comment lines about version extraction and Makefile.versioned
  /^# Extract version from git tags/ { next }
  /^# For firmware maintainers:/ { next }
  /^# version and PKG_HASH/ { next }
  /^# See https:\/\/github.com\/stackia\/rtp2httpd/ { next }
  # Handle multi-line RELEASE_VERSION block
  /^RELEASE_VERSION:=/ {
    # Print hardcoded version instead
    print "RELEASE_VERSION:=" version
    # Skip continuation lines (ending with \)
    while (/\\$/) {
      if ((getline) <= 0) break
    }
    next
  }
  # Print all other lines
  { print }
' openwrt-support/luci-app-rtp2httpd/Makefile > openwrt-support/luci-app-rtp2httpd/Makefile.versioned

echo "=== rtp2httpd/Makefile.versioned ==="
cat openwrt-support/rtp2httpd/Makefile.versioned
echo ""
echo "=== luci-app-rtp2httpd/Makefile.versioned ==="
cat openwrt-support/luci-app-rtp2httpd/Makefile.versioned
