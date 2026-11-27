#!/usr/bin/env bash
# Lightweight health check. Auto-restart is opt-in via AUTO_RESTART=1.
set -u
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

fail=0
check() {
  local label="$1"; shift
  if "$@" >/dev/null 2>&1; then
    printf 'PASS %s\n' "$label"
  else
    printf 'FAIL %s\n' "$label"
    fail=$((fail + 1))
  fi
}

check 'sing-box process' bash -c 'test -n "$(pgrep -f "'"$ROOT"'/bin/sing-box run" 2>/dev/null)"'
check 'sing-box config' "$ROOT/bin/sing-box" check -c "$ROOT/config/sing-box.json"
PORT="$(node -p "require('$ROOT/config/settings.json').listen_port")"
APORT="$(node -p "require('$ROOT/config/settings.json').api_port")"
check "port $PORT listening" bash -c "python3 -c 'import socket,sys; s=socket.create_connection((\"127.0.0.1\",$PORT),1); s.close()'"
check "api $PORT health" curl -fsS -m 3 "http://127.0.0.1:${APORT}/health"
check 'sqlite readable' node -e "require('$ROOT/api/db').listUsers()"

printf '[%s] health-check failures=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$fail" >> "$ROOT/logs/health-check.log"
rotate_logs

if [ "$fail" -gt 0 ] && [ "${AUTO_RESTART:-0}" = "1" ]; then
  log_line "health-check failed ($fail); restarting"
  "$ROOT/scripts/restart.sh" >/dev/null 2>&1 || true
fi

exit "$fail"
