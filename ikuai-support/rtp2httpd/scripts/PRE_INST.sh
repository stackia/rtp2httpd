#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd "$(dirname "$0")" && pwd)
PKG_DIR=$(dirname "$SCRIPT_DIR")
INSTALL_LOG="$PKG_DIR/log/install.log"

mkdir -p "$PKG_DIR/app/bin" "$PKG_DIR/app/cache" "$PKG_DIR/app/config" "$PKG_DIR/app/data" "$PKG_DIR/log"

if [ -f "$PKG_DIR/app/bin/rtp2httpd" ]; then
  chmod 755 "$PKG_DIR/app/bin/rtp2httpd"
fi

printf '%s PRE_INST completed\n' "$(date '+%Y-%m-%d %H:%M:%S')" >> "$INSTALL_LOG"
