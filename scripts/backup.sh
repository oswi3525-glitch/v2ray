#!/usr/bin/env bash
# Encrypted-at-rest by filesystem permissions: archive is chmod 600.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

TS="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$ROOT/backups/tiktunnel-$TS.tar.gz"
umask 077
tar -czf "$OUT" \
  -C "$ROOT" \
  config/settings.json \
  config/env \
  config/runtime.js \
  config/control.json \
  config/secrets.env \
  control \
  web \
  config/sing-box.json \
  database/tiktunnel.db \
  database/control.db \
  subscriptions \
  scripts \
  server \
  api \
  package.json
chmod 600 "$OUT"
echo "backup created: $OUT"
log_line "backup created"
