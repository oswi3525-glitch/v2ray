#!/usr/bin/env bash
# Start all TikTunnel components. Refuses to create duplicate processes.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

cd "$ROOT"
rotate_logs

ensure_singbox() {
  if [ -x "$ROOT/bin/sing-box" ] && "$ROOT/bin/sing-box" version >/dev/null 2>&1; then
    return 0
  fi
  echo "sing-box binary missing or unusable; downloading prebuilt release..."
  node "$ROOT/scripts/get-singbox.js" || {
    echo "FATAL: unable to obtain sing-box; check network and SINGBOX_VERSION"
    return 1
  }
  [ -x "$ROOT/bin/sing-box" ] && "$ROOT/bin/sing-box" version >/dev/null 2>&1 || {
    echo "FATAL: sing-box still unusable after download"
    return 1
  }
}

start_singbox() {
  if [ -n "$(sb_pids)" ]; then
    echo "sing-box already running; skipping (no duplicate allowed)"
    return 0
  fi
  node "$ROOT/server/render-control-config.js" >/dev/null
  "$ROOT/bin/sing-box" check -c "$ROOT/config/sing-box.json" >/dev/null
  setsid nohup "$ROOT/bin/sing-box" run -c "$ROOT/config/sing-box.json" \
    >> "$ROOT/logs/sing-box-stdout.log" 2>&1 < /dev/null &
  echo $! > "$SB_PID"
  wait_port "$(node -p "require('$ROOT/config/control.json').singbox_ws_port")" || {
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
  setsid nohup node "$ROOT/control/server.js" >> "$ROOT/logs/api.log" 2>&1 < /dev/null &
  echo $! > "$API_PID"
  local port
  port="$(node -p "require('$ROOT/config/control.json').app_internal_port || 23950")"
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

start_mux() {
  if [ -n "$(mux_pids)" ]; then
    echo "port-mux already running; skipping"
    return 0
  fi
  setsid nohup node "$ROOT/control/port-mux.js" >> "$ROOT/logs/port-mux.log" 2>&1 < /dev/null &
  echo $! > "$MUX_PID"
  local port
  port="$(node -p "require('$ROOT/config/control.json').app_port")"
  for _ in $(seq 1 40); do
    if curl -fsS -m 1 "http://127.0.0.1:${port}/health" >/dev/null 2>&1; then
      echo "port-mux started (pid $(cat "$MUX_PID")) on public $port"
      log_line "port-mux started"
      return 0
    fi
    sleep 0.25
  done
  echo "port-mux failed health check"; return 1
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

ensure_singbox
start_singbox
start_api
start_mux
start_watchdog
echo "TikTunnel start complete"
