#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd "$(dirname "$0")" && pwd)
PKG_DIR=$(dirname "$SCRIPT_DIR")
PIDFILE="$PKG_DIR/app/cache/rtp2httpd.pid"
RUN_LOG="$PKG_DIR/log/run.log"

log() {
  mkdir -p "$PKG_DIR/log"
  printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$RUN_LOG"
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
