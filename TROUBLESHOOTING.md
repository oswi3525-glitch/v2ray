# TROUBLESHOOTING.md

Follow this order; never reapply the same failed fix three times without changing approach.

1. Read `logs/api.log`, `logs/sing-box-stdout.log`, `logs/watchdog.log`, `logs/manage.log`, `logs/health-check.log`. No UUID/token/password is written there.
2. `./scripts/status.sh` and `./scripts/health-check.sh`.
3. `bin/sing-box check -c config/sing-box.json`. On failure restore `backups/sing-box.last.json`, fix, re-render with `node server/render-control-config.js`.
4. `./scripts/backup.sh` before edits.
5. `./scripts/restart.sh`, then rerun the specific test (`node tests/control-test.js`).

## Symptoms

| Symptom | Cause / fix |
|---|---|
| Login page keeps loading / cannot log in as admin | `ADMIN_USERNAME`/`ADMIN_PASSWORD` missing or placeholder in `.env`; startup fails with an explicit message. Set real values and restart; credentials are synced from `.env` at every start |
| Friend cannot log in | password not set on imported account (legacy users have no password) — admin must use **Reset password** |
| Friend login blocked after attempts | rate limit 10/5 min; wait or use another IP |
| Admin POST returns 401 | missing `x-csrf-token`; log in again to get a fresh CSRF token |
| Friend API returns 401 | friend session expired (12 h) or admin endpoint attempted |
| WS proxy drops immediately | subscription token missing/exhausted/revoked or `config/control.json` `vpn_mode` not `ws`; check `/api/friend/vpn` |
| VLESS client gets EOF | ensure client path equals `/vpn/<token>` from `/api/friend/subscription`; queue buffers were added for upstreamopen races |
| Quota not enforced yet | worker interval is 10 s; check `audit_logs` for `quota_exhausted`, then re-enable/top up |
| Public URL returns Cloudflare 404 | Cloudcode tunnel not forwarding `/vpn` or the app port; platform-side fix required |
| TCP 23952 refused | Cloudcode port mapping not active; no local fix is possible without platform access |
| Watchdog restart churn | `logs/applying.lock` should suppress checks during config changes; verify lock is removed after a failed apply |

## Limits that cannot be fixed here

- No Cloudcode shell/port mapping control from this workspace.
- Public TCP/WS path not verified.
- No iOS device for Shadowrocket tests.
- 30-minute external stability test not run; local smoke only.
