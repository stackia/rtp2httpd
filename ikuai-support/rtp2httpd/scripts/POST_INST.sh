#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd "$(dirname "$0")" && pwd)
PKG_DIR=$(dirname "$SCRIPT_DIR")
INSTALL_LOG="$PKG_DIR/log/install.log"

mkdir -p "$PKG_DIR/log"

missing=0
for arch in aarch64 x86_64; do
  bin="$PKG_DIR/app/bin/rtp2httpd-$arch"
  if [ -f "$bin" ]; then
    chmod 755 "$bin"
  else
    printf '%s POST_INST warning: app/bin/rtp2httpd-%s is missing\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$arch" >> "$INSTALL_LOG"
    missing=1
  fi
done

if [ "$missing" -eq 1 ]; then
  exit 0
fi

printf '%s POST_INST completed\n' "$(date '+%Y-%m-%d %H:%M:%S')" >> "$INSTALL_LOG"
