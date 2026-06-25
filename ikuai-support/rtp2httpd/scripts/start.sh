#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd "$(dirname "$0")" && pwd)
PKG_DIR=$(dirname "$SCRIPT_DIR")
CONFIG_ENV="$PKG_DIR/app/.env"
RUNTIME_ENV="$PKG_DIR/app/environment"
BIN="$PKG_DIR/app/bin/rtp2httpd"
CONFIG_FILE="$PKG_DIR/app/config/rtp2httpd.conf"
PIDFILE="$PKG_DIR/app/cache/rtp2httpd.pid"
RUN_LOG="$PKG_DIR/log/run.log"

log() {
  mkdir -p "$PKG_DIR/log"
  printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$RUN_LOG"
}

# Build a log-safe command line, redacting secret flag values.
format_cmd_for_log() {
  log_line=
  skip_next=0
  for arg in "$@"; do
    if [ "$skip_next" -eq 1 ]; then
      log_line="$log_line --r2h-token [redacted]"
      skip_next=0
      continue
    fi
    case "$arg" in
    --r2h-token) skip_next=1 ;;
    *) log_line="$log_line $arg" ;;
    esac
  done
  log_line=${log_line# }
  printf '%s' "$log_line"
}

CR=$(printf '\r')

# Parse KEY=VALUE lines instead of sourcing the file, so values containing
# spaces or shell metacharacters cannot break or inject into this script.
load_env_file() {
  [ -f "$1" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    line=${line%"$CR"}
    case "$line" in
    '' | '#'*) continue ;;
    *=*) ;;
    *) continue ;;
    esac
    key=${line%%=*}
    value=${line#*=}
    case "$key" in
    '' | *[!A-Za-z0-9_]*) continue ;;
    esac
    export "$key=$value"
  done < "$1"
}

mkdir -p "$PKG_DIR/app/cache" "$PKG_DIR/app/data" "$PKG_DIR/log"
load_env_file "$CONFIG_ENV"
load_env_file "$RUNTIME_ENV"

: "${HOST_IP:=0.0.0.0}"
: "${APP_PORT_WEB:=5140}"
: "${RTP2HTTPD_VERBOSITY:=1}"
: "${RTP2HTTPD_MAXCLIENTS:=5}"
: "${RTP2HTTPD_WORKERS:=1}"
: "${RTP2HTTPD_UPSTREAM_INTERFACE:=}"
: "${RTP2HTTPD_UPSTREAM_INTERFACE_MULTICAST:=}"
: "${RTP2HTTPD_UPSTREAM_INTERFACE_FCC:=}"
: "${RTP2HTTPD_UPSTREAM_INTERFACE_RTSP:=}"
: "${RTP2HTTPD_UPSTREAM_INTERFACE_HTTP:=}"
: "${RTP2HTTPD_BUFFER_POOL_MAX_SIZE:=16384}"
: "${RTP2HTTPD_UDP_RCVBUF_SIZE:=524288}"
: "${RTP2HTTPD_MCAST_REJOIN_INTERVAL:=0}"
: "${RTP2HTTPD_FCC_LISTEN_PORT_RANGE:=}"
: "${RTP2HTTPD_ZEROCOPY_ON_SEND:=0}"
: "${RTP2HTTPD_RTSP_STUN_SERVER:=}"
: "${RTP2HTTPD_EXTERNAL_M3U:=}"
: "${RTP2HTTPD_EXTERNAL_M3U_UPDATE_INTERVAL:=7200}"
: "${RTP2HTTPD_PLAYER_PAGE_PATH:=}"
: "${APP_WEB_LOGIN_URI:=}"
: "${RTP2HTTPD_HOSTNAME:=}"
: "${RTP2HTTPD_R2H_TOKEN:=}"
: "${RTP2HTTPD_CORS_ALLOW_ORIGIN:=}"
: "${RTP2HTTPD_XFF:=0}"
: "${RTP2HTTPD_USE_RELATIVE_PATH_IN_M3U:=0}"
: "${RTP2HTTPD_HTTP_PROXY_USER_AGENT:=}"
: "${RTP2HTTPD_RTSP_USER_AGENT:=}"
: "${RTP2HTTPD_EXTRA_ARGS:=}"

if [ ! -x "$BIN" ]; then
  log "Binary is missing or not executable: $BIN"
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

# UI-managed options are passed on the command line; --config must come last
# so these values take precedence over anything in the config file.
set -- "$BIN" \
  --listen "$LISTEN" \
  --verbose "$RTP2HTTPD_VERBOSITY" \
  --maxclients "$RTP2HTTPD_MAXCLIENTS" \
  --workers "$RTP2HTTPD_WORKERS" \
  --buffer-pool-max-size "$RTP2HTTPD_BUFFER_POOL_MAX_SIZE" \
  --udp-rcvbuf-size "$RTP2HTTPD_UDP_RCVBUF_SIZE" \
  --mcast-rejoin-interval "$RTP2HTTPD_MCAST_REJOIN_INTERVAL" \
  --external-m3u-update-interval "$RTP2HTTPD_EXTERNAL_M3U_UPDATE_INTERVAL"

if [ -n "$RTP2HTTPD_UPSTREAM_INTERFACE" ]; then
  set -- "$@" --upstream-interface "$RTP2HTTPD_UPSTREAM_INTERFACE"
fi
if [ -n "$RTP2HTTPD_UPSTREAM_INTERFACE_MULTICAST" ]; then
  set -- "$@" --upstream-interface-multicast "$RTP2HTTPD_UPSTREAM_INTERFACE_MULTICAST"
fi
if [ -n "$RTP2HTTPD_UPSTREAM_INTERFACE_FCC" ]; then
  set -- "$@" --upstream-interface-fcc "$RTP2HTTPD_UPSTREAM_INTERFACE_FCC"
fi
if [ -n "$RTP2HTTPD_UPSTREAM_INTERFACE_RTSP" ]; then
  set -- "$@" --upstream-interface-rtsp "$RTP2HTTPD_UPSTREAM_INTERFACE_RTSP"
fi
if [ -n "$RTP2HTTPD_UPSTREAM_INTERFACE_HTTP" ]; then
  set -- "$@" --upstream-interface-http "$RTP2HTTPD_UPSTREAM_INTERFACE_HTTP"
fi
if [ -n "$RTP2HTTPD_FCC_LISTEN_PORT_RANGE" ]; then
  set -- "$@" --fcc-listen-port-range "$RTP2HTTPD_FCC_LISTEN_PORT_RANGE"
fi
if [ "$RTP2HTTPD_ZEROCOPY_ON_SEND" = "1" ]; then
  set -- "$@" --zerocopy-on-send
fi
if [ -n "$RTP2HTTPD_RTSP_STUN_SERVER" ]; then
  set -- "$@" --rtsp-stun-server "$RTP2HTTPD_RTSP_STUN_SERVER"
fi
if [ -n "$RTP2HTTPD_EXTERNAL_M3U" ]; then
  set -- "$@" --external-m3u "$RTP2HTTPD_EXTERNAL_M3U"
fi
if [ -n "$RTP2HTTPD_PLAYER_PAGE_PATH" ]; then
  set -- "$@" --player-page-path "$RTP2HTTPD_PLAYER_PAGE_PATH"
fi
if [ -n "$APP_WEB_LOGIN_URI" ]; then
  set -- "$@" --status-page-path "$APP_WEB_LOGIN_URI"
fi
if [ -n "$RTP2HTTPD_HOSTNAME" ]; then
  set -- "$@" --hostname "$RTP2HTTPD_HOSTNAME"
fi
if [ -n "$RTP2HTTPD_R2H_TOKEN" ]; then
  set -- "$@" --r2h-token "$RTP2HTTPD_R2H_TOKEN"
fi
if [ -n "$RTP2HTTPD_CORS_ALLOW_ORIGIN" ]; then
  set -- "$@" --cors-allow-origin "$RTP2HTTPD_CORS_ALLOW_ORIGIN"
fi
if [ "$RTP2HTTPD_XFF" = "1" ]; then
  set -- "$@" --xff
fi
if [ "$RTP2HTTPD_USE_RELATIVE_PATH_IN_M3U" = "1" ]; then
  set -- "$@" --use-relative-path-in-m3u
fi
if [ -n "$RTP2HTTPD_HTTP_PROXY_USER_AGENT" ]; then
  set -- "$@" --http-proxy-user-agent "$RTP2HTTPD_HTTP_PROXY_USER_AGENT"
fi
if [ -n "$RTP2HTTPD_RTSP_USER_AGENT" ]; then
  set -- "$@" --rtsp-user-agent "$RTP2HTTPD_RTSP_USER_AGENT"
fi

if [ -f "$CONFIG_FILE" ]; then
  set -- "$@" --config "$CONFIG_FILE"
else
  log "Config file is missing, starting without it: $CONFIG_FILE"
  set -- "$@" --noconfig
fi

if [ -n "$RTP2HTTPD_EXTRA_ARGS" ]; then
  # Intentionally split extra arguments so advanced users can pass native CLI flags.
  set -- "$@" $RTP2HTTPD_EXTRA_ARGS
fi

log "Starting rtp2httpd: $(format_cmd_for_log "$@")"
"$@" >> "$RUN_LOG" 2>&1 &
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
