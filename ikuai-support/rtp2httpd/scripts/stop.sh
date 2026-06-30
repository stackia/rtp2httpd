#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd "$(dirname "$0")" && pwd)
PKG_DIR=$(dirname "$SCRIPT_DIR")
BIN_DIR="$PKG_DIR/app/bin"
PIDFILE="$PKG_DIR/app/cache/rtp2httpd.pid"
RUN_LOG="$PKG_DIR/log/run.log"

log() {
  mkdir -p "$PKG_DIR/log"
  printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$RUN_LOG"
}

select_binary() {
  machine=$(uname -m 2>/dev/null || true)

  case "$machine" in
  aarch64 | arm64) bin="$BIN_DIR/rtp2httpd-aarch64" ;;
  x86_64 | amd64) bin="$BIN_DIR/rtp2httpd-x86_64" ;;
  *)
    log "Unsupported platform architecture: ${machine:-unknown}"
    return 1
    ;;
  esac

  if [ ! -x "$bin" ]; then
    log "Binary is missing or not executable: $bin"
    return 1
  fi

  printf '%s' "$bin"
}

pid_belongs_to_us() {
  pid=$1

  if [ ! -d "/proc/$pid" ]; then
    return 1
  fi

  if [ -r "/proc/$pid/exe" ]; then
    exe=$(readlink -f "/proc/$pid/exe" 2>/dev/null || readlink "/proc/$pid/exe" 2>/dev/null || true)
    if [ -n "$exe" ] && [ "$exe" = "$BIN" ]; then
      return 0
    fi
  fi

  if [ -r "/proc/$pid/cmdline" ]; then
    cmdline=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)
    case "$cmdline" in
    "$BIN "* | "$BIN") return 0 ;;
    esac
  fi

  return 1
}

if [ ! -f "$PIDFILE" ]; then
  log "rtp2httpd is not running: pid file missing"
  exit 0
fi

PID=$(cat "$PIDFILE" 2>/dev/null || true)
if [ -z "$PID" ] || ! kill -0 "$PID" 2>/dev/null; then
  rm -f "$PIDFILE"
  log "rtp2httpd is not running: stale pid file removed"
  exit 0
fi

BIN=$(select_binary) || exit 1

if [ -d "/proc/$PID" ] && ! pid_belongs_to_us "$PID"; then
  rm -f "$PIDFILE"
  log "rtp2httpd is not running: pid file points to unrelated process (pid=$PID)"
  exit 0
fi

log "Stopping rtp2httpd, pid=$PID"
kill "$PID" 2>/dev/null || true

COUNT=0
while kill -0 "$PID" 2>/dev/null; do
  COUNT=$((COUNT + 1))
  if [ "$COUNT" -ge 10 ]; then
    log "rtp2httpd did not stop after TERM, sending KILL"
    kill -9 "$PID" 2>/dev/null || true
    break
  fi
  sleep 1
done

rm -f "$PIDFILE"
log "rtp2httpd stopped"
