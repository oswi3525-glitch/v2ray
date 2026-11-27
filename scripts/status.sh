#!/usr/bin/env bash
set -u
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

SB="$(read_pid "$SB_PID" || true)"
API="$(read_pid "$API_PID" || true)"
WD="$(read_pid "$WD_PID" || true)"
PORT="$(node -p "require('$ROOT/config/control.json').singbox_ws_port" 2>/dev/null || echo '?')"
APORT="$(node -p "require('$ROOT/config/runtime.js').serverPort" 2>/dev/null || echo '?')"

printf 'TikTunnel status\n'
printf '  sing-box : %s\n' "${SB:-stopped}"
printf '  api      : %s\n' "${API:-stopped}"
printf '  watchdog : %s\n' "${WD:-stopped}"
printf '  port %s   : %s\n' "$PORT" "$(port_listening "$PORT" && echo listening || echo closed)"
printf '  api %s : %s\n' "$APORT" "$(curl -fsS -m 2 "http://127.0.0.1:${APORT}/health" >/dev/null 2>&1 && echo ok || echo unreachable)"
printf '  config   : '; "$ROOT/bin/sing-box" check -c "$ROOT/config/sing-box.json" >/dev/null 2>&1 && echo valid || echo invalid
printf '  sing-box process count (expected 1): %s\n' "$(sb_pids | wc -l)"
printf '  api process count (expected 1): %s\n' "$(api_pids | wc -l)"
