# DATABASE.md

SQLite file: `database/control.db` (WAL). Migration v1 is applied by `control/db.js` on first start; table `schema_migrations` records versions. The legacy `database/tiktunnel.db` is preserved and its UUID/tokens are imported once by `control/migrate-legacy.js` (no passwords imported).

| Table | Purpose / key fields |
|---|---|
| `schema_migrations` | applied migration versions |
| `admins` | id, username, bcrypt hash, timestamps |
| `users` | id, username, password_hash (nullable until admin sets it), enabled, exhausted, created/expires/revoked, quota_bytes, used_upload, used_download, last_connection, last_seen |
| `vpn_clients` | user_id FK, uuid UNIQUE, transport, revoked_at |
| `subscriptions` | user_id FK, token UNIQUE, path (`/vpn/<token>`), revoked_at |
| `traffic_usage` | user_id FK, ts, upload/download/total bytes, source (`ws-proxy`) |
| `quota_history` | user_id FK, action, delta, quota_before/after, actor, note |
| `connection_sessions` | user_id FK, start/end, bytes up/down, status, remote |
| `server_metrics` | ts, cpu_pct, ram, net counters, active_vpn, api latency |
| `settings` | key/value (e.g. `legacy_import_done`) |
| `audit_logs` | ts, actor, action, target, detail (no full UUID/token) |
| `sessions` | random id, user_id, role, csrf, expiry |

Foreign keys are ON. Quota changes, account changes and VPN state changes run inside `BEGIN/COMMIT` transactions. Indexes exist on traffic(user_id,ts), sessions(expiry), audit(ts), metrics(ts).

## Operations

```bash
./scripts/backup.sh
./scripts/restore.sh backups/<archive>.tar.gz --confirm
```

Backup archives are chmod 600 and include `control/`, `web/`, both DBs and config files. Restore snapshots the current state into `backups/pre-restore-*` before unpacking.
