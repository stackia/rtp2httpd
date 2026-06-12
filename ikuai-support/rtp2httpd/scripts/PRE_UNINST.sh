#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd "$(dirname "$0")" && pwd)
PKG_DIR=$(dirname "$SCRIPT_DIR")
INSTALL_LOG="$PKG_DIR/log/install.log"

mkdir -p "$PKG_DIR/log"

if [ -x "$SCRIPT_DIR/stop.sh" ]; then
  "$SCRIPT_DIR/stop.sh" || true
fi

printf '%s PRE_UNINST completed\n' "$(date '+%Y-%m-%d %H:%M:%S')" >> "$INSTALL_LOG"
