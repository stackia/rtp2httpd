#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd "$(dirname "$0")" && pwd)
PKG_DIR=$(dirname "$SCRIPT_DIR")
CONFIG_ENV="$PKG_DIR/app/.env"
RUNTIME_ENV="$PKG_DIR/app/environment"
BIN="$PKG_DIR/app/bin/rtp2httpd"
PIDFILE="$PKG_DIR/app/cache/rtp2httpd.pid"
RUN_LOG="$PKG_DIR/log/run.log"

log() {
  printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$RUN_LOG"
}

load_env_file() {
  if [ -f "$1" ]; then
    set -a
    . "$1"
    set +a
  fi
}

mkdir -p "$PKG_DIR/app/cache" "$PKG_DIR/app/data" "$PKG_DIR/log"
load_env_file "$CONFIG_ENV"
load_env_file "$RUNTIME_ENV"

: "${HOST_IP:=0.0.0.0}"
: "${APP_PORT_WEB:=5140}"
: "${RTP2HTTPD_CONFIG:=app/config/rtp2httpd.conf}"
: "${RTP2HTTPD_MAXCLIENTS:=20}"
: "${RTP2HTTPD_WORKERS:=1}"
: "${RTP2HTTPD_VERBOSITY:=2}"
: "${RTP2HTTPD_EXTRA_ARGS:=}"

case "$RTP2HTTPD_CONFIG" in
  /*) CONFIG_FILE="$RTP2HTTPD_CONFIG" ;;
  *) CONFIG_FILE="$PKG_DIR/$RTP2HTTPD_CONFIG" ;;
esac

if [ ! -x "$BIN" ]; then
  log "Binary is missing or not executable: $BIN"
  exit 1
fi

if [ ! -f "$CONFIG_FILE" ]; then
  log "Config file is missing: $CONFIG_FILE"
  exit 1
fi

if [ -f "$PIDFILE" ]; then
  OLD_PID=$(cat "$PIDFILE" 2>/dev/null || true)
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    log "rtp2httpd is already running, pid=$OLD_PID"
    exit 0
  fi
  rm -f "$PIDFILE"
fi

if [ "$HOST_IP" = "*" ] || [ "$HOST_IP" = "0.0.0.0" ]; then
  LISTEN="$APP_PORT_WEB"
else
  LISTEN="$HOST_IP:$APP_PORT_WEB"
fi

export HOME="$PKG_DIR/app/data"

set -- "$BIN" \
  --config "$CONFIG_FILE" \
  --listen "$LISTEN" \
  --maxclients "$RTP2HTTPD_MAXCLIENTS" \
  --workers "$RTP2HTTPD_WORKERS" \
  --verbose "$RTP2HTTPD_VERBOSITY"

if [ -n "$RTP2HTTPD_EXTRA_ARGS" ]; then
  # Intentionally split extra arguments so advanced users can pass native CLI flags.
  set -- "$@" $RTP2HTTPD_EXTRA_ARGS
fi

log "Starting rtp2httpd: $*"
nohup "$@" >> "$RUN_LOG" 2>&1 &
PID=$!
printf '%s\n' "$PID" > "$PIDFILE"

sleep 1
if kill -0 "$PID" 2>/dev/null; then
  log "rtp2httpd started, pid=$PID"
  exit 0
fi

rm -f "$PIDFILE"
log "rtp2httpd failed to start"
exit 1
