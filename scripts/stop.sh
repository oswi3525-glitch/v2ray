#!/usr/bin/env bash
# Stop all TikTunnel components (only processes owned by this user).
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

stop_by_pidfile() {
  local f="$1" p
  p="$(read_pid "$f" || true)"
  if [ -n "$p" ]; then
    kill "$p" 2>/dev/null || true
    for _ in $(seq 1 20); do
      alive "$p" || break
      sleep 0.1
    done
    alive "$p" && kill -9 "$p" 2>/dev/null || true
  fi
  rm -f "$f"
}

if [ "${TIKTUNNEL_NO_WATCHDOG:-0}" != "1" ]; then
  stop_by_pidfile "$WD_PID"
fi
stop_by_pidfile "$API_PID"
stop_by_pidfile "$SB_PID"

for p in $(sb_pids); do kill "$p" 2>/dev/null || true; done
for p in $(api_pids); do kill "$p" 2>/dev/null || true; done

log_line "all components stopped"
echo "TikTunnel stopped"
