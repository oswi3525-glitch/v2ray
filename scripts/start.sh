#!/usr/bin/env bash
# Start all TikTunnel components. Refuses to create duplicate processes.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

cd "$ROOT"
rotate_logs

start_singbox() {
  if [ -n "$(sb_pids)" ]; then
    echo "sing-box already running; skipping (no duplicate allowed)"
    return 0
  fi
  [ -f "$ROOT/config/sing-box.json" ] || node "$ROOT/server/render-config.js"
  "$ROOT/bin/sing-box" check -c "$ROOT/config/sing-box.json" >/dev/null
  setsid nohup "$ROOT/bin/sing-box" run -c "$ROOT/config/sing-box.json" \
    >> "$ROOT/logs/sing-box-stdout.log" 2>&1 < /dev/null &
  echo $! > "$SB_PID"
  wait_port "$(node -p "require('$ROOT/config/settings.json').listen_port")" || {
    echo "sing-box failed to bind port"; return 1
  }
  echo "sing-box started (pid $(cat "$SB_PID"))"
  log_line "sing-box started"
}

start_api() {
  if [ -n "$(api_pids)" ]; then
    echo "api already running; skipping"
    return 0
  fi
  setsid nohup node "$ROOT/api/server.js" >> "$ROOT/logs/api.log" 2>&1 < /dev/null &
  echo $! > "$API_PID"
  local port
  port="$(node -p "require('$ROOT/config/settings.json').api_port")"
  for _ in $(seq 1 40); do
    if curl -fsS -m 1 "http://127.0.0.1:${port}/health" >/dev/null 2>&1; then
      echo "api started (pid $(cat "$API_PID"))"
      log_line "api started"
      return 0
    fi
    sleep 0.25
  done
  echo "api failed health check"; return 1
}

start_watchdog() {
  [ "${TIKTUNNEL_NO_WATCHDOG:-0}" = "1" ] && return 0
  if [ -f "$WD_PID" ] && alive "$(cat "$WD_PID")"; then
    echo "watchdog already running"
    return 0
  fi
  setsid nohup bash "$ROOT/scripts/watchdog.sh" >> "$ROOT/logs/watchdog.log" 2>&1 < /dev/null &
  echo $! > "$WD_PID"
  echo "watchdog started (pid $(cat "$WD_PID"))"
  log_line "watchdog started"
}

start_singbox
start_api
start_watchdog
echo "TikTunnel start complete"
