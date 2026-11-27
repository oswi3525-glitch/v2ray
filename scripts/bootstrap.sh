#!/usr/bin/env bash
# One-time bootstrap. Never overwrites existing secrets or user data.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

cd "$ROOT"
mkdir -p node_modules bin config database subscriptions logs backups reports scripts server api tests

if [ ! -f "$ROOT/config/secrets.env" ]; then
  TOKEN="$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')"
  umask 077
  printf 'TIKTUNNEL_ADMIN_TOKEN=%s\n' "$TOKEN" > "$ROOT/config/secrets.env"
  chmod 600 "$ROOT/config/secrets.env"
  log_line "generated admin secret (not logged)"
else
  chmod 600 "$ROOT/config/secrets.env"
  log_line "existing admin secret preserved"
fi

if [ ! -d "$ROOT/node_modules/fastify" ]; then
  echo "installing npm dependencies..."
  npm install --omit=dev --no-audit --no-fund
else
  echo "npm dependencies already present"
fi

chmod 600 "$ROOT"/database/*.db "$ROOT"/database/*.db-* 2>/dev/null || true
chmod 600 "$ROOT"/subscriptions/*.txt 2>/dev/null || true
chmod 750 "$ROOT"/scripts/*.sh

node "$ROOT/server/render-config.js"
"$ROOT/bin/sing-box" check -c "$ROOT/config/sing-box.json"
echo "bootstrap OK (admin token stored in config/secrets.env, chmod 600)"
log_line "bootstrap OK"
