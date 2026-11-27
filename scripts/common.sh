#!/usr/bin/env bash
# Shared helpers. Sourced by all management scripts.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export ROOT
if [ -f "$ROOT/.env" ]; then
  set -a
  . "$ROOT/.env"
  set +a
fi
PID_DIR="$ROOT/logs"
SB_PID="$PID_DIR/sing-box.pid"
API_PID="$PID_DIR/api.pid"
WD_PID="$PID_DIR/watchdog.pid"
APPLY_LOCK="$PID_DIR/applying.lock"
MAX_LOG_BYTES="${TIKTUNNEL_MAX_LOG_BYTES:-5242880}"

mkdir -p "$ROOT/logs" "$ROOT/backups" "$ROOT/database" "$ROOT/subscriptions" "$ROOT/config"

alive() {
  local pid="${1:-}"
  [ -n "$pid" ] && [ "$pid" -gt 1 ] 2>/dev/null && kill -0 "$pid" 2>/dev/null
}

read_pid() {
  local f="$1"
  [ -f "$f" ] || return 1
  local p
  p="$(tr -cd '0-9' < "$f")"
  alive "$p" && printf '%s' "$p"
}

sb_pids() {
  pgrep -f "$ROOT/bin/sing-box run" 2>/dev/null || true
}

api_pids() {
  pgrep -f "node $ROOT/control/server.js" 2>/dev/null || true
}

rotate_logs() {
  local f
  for f in "$ROOT"/logs/*.log; do
    [ -f "$f" ] || continue
    local sz
    sz="$(stat -c %s "$f" 2>/dev/null || echo 0)"
    if [ "$sz" -gt "$MAX_LOG_BYTES" ]; then
      tail -c "$MAX_LOG_BYTES" "$f" > "$f.1" && : > "$f"
    fi
  done
}

port_listening() {
  local port="$1"
  python3 - "$port" <<'PY'
import socket, sys
p = int(sys.argv[1])
try:
    with socket.create_connection(("127.0.0.1", p), timeout=1):
        pass
    sys.exit(0)
except Exception:
    sys.exit(1)
PY
}

wait_port() {
  local port="$1" tries="${2:-40}"
  local i=0
  while [ "$i" -lt "$tries" ]; do
    port_listening "$port" && return 0
    sleep 0.25
    i=$((i + 1))
  done
  return 1
}

log_line() {
  printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$ROOT/logs/manage.log"
  rotate_logs
}
