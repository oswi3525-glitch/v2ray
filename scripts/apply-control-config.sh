#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

cd "$ROOT"
trap 'rm -f "$APPLY_LOCK"' EXIT
touch "$APPLY_LOCK"
cp -f "$ROOT/config/sing-box.json" "$ROOT/backups/sing-box.last.json" 2>/dev/null || true
node "$ROOT/server/render-control-config.js" >/dev/null
"$ROOT/bin/sing-box" check -c "$ROOT/config/sing-box.json" >/dev/null

p="$(read_pid "$SB_PID" || true)"
if [ -n "$p" ]; then
  kill "$p" 2>/dev/null || true
  for _ in $(seq 1 20); do alive "$p" || break; sleep 0.1; done
  alive "$p" && kill -9 "$p" 2>/dev/null || true
fi
rm -f "$SB_PID"
for x in $(sb_pids); do kill "$x" 2>/dev/null || true; done

setsid nohup "$ROOT/bin/sing-box" run -c "$ROOT/config/sing-box.json" \
  >> "$ROOT/logs/sing-box-stdout.log" 2>&1 < /dev/null &
echo $! > "$SB_PID"

port="$(node -p "require('$ROOT/config/control.json').singbox_ws_port")"
wait_port "$port" || { echo "sing-box restart failed"; exit 1; }
log_line "control config applied"
echo "control config applied"
