# TROUBLESHOOTING.md

Follow this order; do not repeat a failed fix more than three times without changing approach.

1. **Read logs** (no secrets are written to them):

   ```bash
   tail -50 logs/api.log
   tail -50 logs/sing-box-stdout.log
   tail -50 logs/manage.log
   tail -50 logs/health-check.log
   tail -50 logs/watchdog.log
   ```

2. **Check state**: `./scripts/status.sh` and `./scripts/health-check.sh`.

3. **Validate config**: `bin/sing-box check -c config/sing-box.json`. On failure, restore the previous config from `backups/sing-box.last.json`, investigate, then re-render from DB with `node server/render-config.js`.

4. **Back up before editing**: `./scripts/backup.sh`.

5. **Apply fix**: edit only the intended file; keep secrets chmod 600.

6. **Restart and retest**: `./scripts/restart.sh && ./scripts/health-check.sh && npm test`.

7. Mark PASS only after the specific test succeeds again.

## Common symptoms

| Symptom | Likely cause | Fix |
|---|---|---|
| `sing-box failed to bind port` | another process owns 8443 | `ss -tulnp \| grep 8443`; stop the owner or change `listen_port` in settings and re-apply |
| API returns 401 | wrong/missing bearer token | read token from `config/secrets.env`; it is never printed by scripts |
| `active_user_limit_reached` | 3 active accounts exist | revoke/expire one, then retry |
| Subscription is empty | token belongs to revoked/expired/disabled user | check `GET /api/users` (admin) |
| Config valid but clients cannot connect | security is `none` + host is `127.0.0.1` (lab) or inbound not reachable | this is expected here; see audit report. On a real VPS, enable TLS/REALITY and set the public host |
| Client cannot reconnect right after a server restart | test clients cache the old outbound connection | restart the client (Shadowrocket reconnect); server-side recovery itself is verified by the stability test |
| Memory grows slowly | log files or rate-limit buckets | logs are rotated at 5 MiB; buckets are pruned; restart API to clear buckets |
| Watchdog keeps restarting services | port conflict or missing config | disable watchdog temporarily: `kill $(cat logs/watchdog.pid)`; fix root cause; run `./scripts/start.sh` |
| Cannot auto-start after reboot | platform has no systemd/cron user support | on a real VPS use a user crontab `@reboot` entry; on Codespaces it must be started manually |

## Limits that cannot be fixed in this environment

- Inbound raw TCP from the Internet is blocked by the Codespaces HTTP tunnel (GitHub auth + TLS termination). This is a platform constraint, not a configuration bug.
- No domain/certificate → no valid TLS; no transparent TCP → no REALITY validation.
- No iOS device → Shadowrocket import, Wi-Fi↔4G/5G handover and client DNS-leak tests cannot be executed.

These are reported as SKIP/BLOCKED, never as PASS.
