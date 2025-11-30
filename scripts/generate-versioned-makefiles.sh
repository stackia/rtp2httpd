#!/bin/sh
set -e

RELEASE_VERSION=${RELEASE_VERSION:-"1.0.0-snapshot"}

# Process rtp2httpd Makefile
awk -v version="$RELEASE_VERSION" '
  # Skip comment line
  /^# Extract version from git tags/ { next }
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
    print "PKG_HASH:=skip"
    print ""
  }
  # Print all other lines
  { print }
' openwrt-support/rtp2httpd/Makefile > openwrt-support/rtp2httpd/Makefile.versioned

# Process luci-app-rtp2httpd Makefile
awk -v version="$RELEASE_VERSION" '
  # Skip comment line
  /^# Extract version from git tags/ { next }
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
