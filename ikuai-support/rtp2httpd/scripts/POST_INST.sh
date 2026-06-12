#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd "$(dirname "$0")" && pwd)
PKG_DIR=$(dirname "$SCRIPT_DIR")
INSTALL_LOG="$PKG_DIR/log/install.log"

mkdir -p "$PKG_DIR/log"

if [ -f "$PKG_DIR/app/bin/rtp2httpd" ]; then
  chmod 755 "$PKG_DIR/app/bin/rtp2httpd"
else
  printf '%s POST_INST warning: app/bin/rtp2httpd is missing\n' "$(date '+%Y-%m-%d %H:%M:%S')" >> "$INSTALL_LOG"
  exit 0
fi

printf '%s POST_INST completed\n' "$(date '+%Y-%m-%d %H:%M:%S')" >> "$INSTALL_LOG"
