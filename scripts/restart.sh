#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
TIKTUNNEL_NO_WATCHDOG=1 "$ROOT/scripts/stop.sh" >/dev/null
"$ROOT/scripts/start.sh"
