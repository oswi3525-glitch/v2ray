#!/usr/bin/env bash
# Restore from a backup archive. Requires explicit --confirm to overwrite.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

ARCHIVE="${1:-}"
[ "${2:-}" = "--confirm" ] || { echo "usage: restore.sh <archive.tar.gz> --confirm"; exit 2; }
[ -f "$ARCHIVE" ] || { echo "archive not found"; exit 2; }

"$ROOT/scripts/stop.sh" >/dev/null
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$ROOT/backups/pre-restore-$STAMP"
cp -a "$ROOT/config" "$ROOT/database" "$ROOT/subscriptions" "$ROOT/backups/pre-restore-$STAMP/" 2>/dev/null || true
tar -xzf "$ARCHIVE" -C "$ROOT"
chmod 600 "$ROOT/config/secrets.env" 2>/dev/null || true
"$ROOT/scripts/start.sh"
echo "restore complete; pre-restore snapshot: backups/pre-restore-$STAMP"
log_line "restore complete"
