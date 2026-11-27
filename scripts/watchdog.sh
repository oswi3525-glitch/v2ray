#!/usr/bin/env bash
# Background watchdog: checks every 20s. Requires 2 consecutive failures before
# acting, and never acts during an expected config change (apply lock).
set -u
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

PORT="$(node -p "require('$ROOT/config/control.json').singbox_ws_port")"
APORT="$(node -p "require('$ROOT/config/runtime.js').serverPort")"
SB_FAIL=0
API_FAIL=0

restart_singbox_only() {
  local p
  p="$(read_pid "$SB_PID" || true)"
  if [ -n "$p" ]; then
    kill "$p" 2>/dev/null || true
    for _ in $(seq 1 20); do alive "$p" || break; sleep 0.1; done
    alive "$p" && kill -9 "$p" 2>/dev/null || true
  fi
  rm -f "$SB_PID"
  for x in $(sb_pids); do kill "$x" 2>/dev/null || true; done
  "$ROOT/bin/sing-box" check -c "$ROOT/config/sing-box.json" >/dev/null 2>&1 || return 1
  setsid nohup "$ROOT/bin/sing-box" run -c "$ROOT/config/sing-box.json" \
    >> "$ROOT/logs/sing-box-stdout.log" 2>&1 < /dev/null &
  echo $! > "$SB_PID"
  wait_port "$PORT" 40
}

while true; do
  sleep 20
  rotate_logs
  [ -f "$APPLY_LOCK" ] && { SB_FAIL=0; API_FAIL=0; continue; }

  if [ -z "$(sb_pids)" ] || ! port_listening "$PORT"; then
    SB_FAIL=$((SB_FAIL + 1))
  else
    SB_FAIL=0
  fi

  if ! curl -fsS -m 2 "http://127.0.0.1:${APORT}/health" >/dev/null 2>&1; then
    API_FAIL=$((API_FAIL + 1))
  else
    API_FAIL=0
  fi

  if [ "$SB_FAIL" -ge 2 ]; then
    printf '[%s] watchdog: sing-box down (%s checks), restarting\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$SB_FAIL" >> "$ROOT/logs/watchdog.log"
    if restart_singbox_only; then
      printf '[%s] watchdog: sing-box recovered\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$ROOT/logs/watchdog.log"
    fi
    SB_FAIL=0
  fi

  if [ "$API_FAIL" -ge 2 ]; then
    printf '[%s] watchdog: api down (%s checks), restarting\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$API_FAIL" >> "$ROOT/logs/watchdog.log"
    setsid nohup node "$ROOT/control/server.js" >> "$ROOT/logs/api.log" 2>&1 < /dev/null &
    echo $! > "$API_PID"
    API_FAIL=0
  fi
done
