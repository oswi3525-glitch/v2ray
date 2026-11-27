# TikTunnel

Rootless VLESS VPN manager for a small group (max 3 accounts), built from **sing-box + Node.js/Fastify + SQLite**.

> **STATUS: LAB DEPLOYMENT — NOT INTERNET-READY.**
> The authorized environment is a GitHub Codespaces container behind an HTTP tunnel that requires GitHub login and terminates TLS. There is no transparent inbound TCP port and no user-owned domain/certificate. Therefore this instance is deployed and tested **locally only**. Do not import the generated subscription on a real device and do not assume it provides a working VPN. See [`reports/vps-audit.md`](reports/vps-audit.md) and [`reports/deployment.md`](reports/deployment.md).

## What is installed

| Component | Location | Notes |
|---|---|---|
| sing-box 1.14.5 (static musl, sha256 pinned) | `bin/sing-box` | VLESS inbound on `0.0.0.0:8443`, no TLS (lab) |
| Generated sing-box config | `config/sing-box.json` | chmod 600, regenerated from SQLite on account changes |
| Fastify API | `api/server.js` | bound to `127.0.0.1:3000`, admin bearer auth, rate limited |
| SQLite database | `database/tiktunnel.db` | WAL mode, accounts + audit events |
| Subscription exporter | `subscriptions/render.js` | one file per token, hashed filename, chmod 600 |
| Process scripts | `scripts/*.sh` | `setsid`/`nohup` based (no systemd, no tmux/screen) |
| Watchdog | `scripts/watchdog.sh` | checks every 20 s, auto-restarts failed components |
| Test suite | `tests/run-tests.js`, `tests/stability.js`, `tests/network-lab.js` | local, real VLESS client tests |

Everything runs as the unprivileged user (`uid 1000`). No sudo, no root, no Docker, no system config changes.

## Quick reference

```bash
cd "$HOME/TikTunnel"          # symlink to /workspaces/v2ray in this environment

./scripts/bootstrap.sh        # first time: secrets, npm install, config
./scripts/start.sh            # start sing-box + API + watchdog
./scripts/stop.sh             # stop everything
./scripts/restart.sh          # restart everything
./scripts/status.sh           # show PIDs, ports, config validity
./scripts/health-check.sh     # non-zero exit on failure
./scripts/backup.sh           # timestamped tar.gz in backups/ (chmod 600)
./scripts/restore.sh backups/<file>.tar.gz --confirm
```

## Admin API

The admin token is generated once into `config/secrets.env` (chmod 600) and is **never printed**. Read it from that file when needed:

```bash
TOKEN="$(sed -n 's/^TIKTUNNEL_ADMIN_TOKEN=//p' config/secrets.env)"
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3000/api/status
```

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/health` | none | liveness |
| GET | `/api/status` | admin | service + account overview |
| GET | `/api/users` | admin | list accounts (no UUID/token returned) |
| POST | `/api/users` | admin | create account `{ "name": "friend1", "expires_at": "2026-12-31T00:00:00Z" }` |
| PATCH | `/api/users/:id` | admin | `{ "enabled": true/false, "expires_at": "..." }` |
| DELETE | `/api/users/:id` | admin | revoke account |
| GET | `/api/sub/:token` | token in URL | subscription for one account |
| GET | `/api/metrics` | admin | RSS, uptime, account counts, recent audit events |

Create / update / delete automatically regenerate the sing-box config and restart only sing-box.

### Create an account

```bash
TOKEN="$(sed -n 's/^TIKTUNNEL_ADMIN_TOKEN=//p' config/secrets.env)"
curl -X POST http://127.0.0.1:3000/api/users \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"friend1","expires_at":"2026-12-31T00:00:00Z"}'
```

The response contains `subscription_url` — give only that URL to the friend.

### Revoke an account

```bash
curl -X DELETE http://127.0.0.1:3000/api/users/1 -H "Authorization: Bearer $TOKEN"
```

### Get a subscription

```bash
curl "http://127.0.0.1:3000/api/sub/<token>"            # base64 (default)
curl "http://127.0.0.1:3000/api/sub/<token>?raw=1"      # plain VLESS URI
node subscriptions/render.js                            # export files to subscriptions/
```

### Backup / restore

```bash
./scripts/backup.sh
./scripts/restore.sh backups/tiktunnel-YYYYmmddTHHMMSSZ.tar.gz --confirm
```

Restore stops services, snapshots current config/database/subscriptions into `backups/pre-restore-<timestamp>/`, unpacks the archive and starts services again.

## iOS / Shadowrocket

See [`IOS-SHADOWROCKET.md`](IOS-SHADOWROCKET.md). **Important:** the current subscription uses `security=none` and host `127.0.0.1`, so it will *not* work on a phone. It is kept in standard Shadowrocket-importable VLESS format for future use once a public host and TLS/REALITY are available.

## Tests

```bash
npm test                       # system + accounts + real VLESS clients + revocation
node tests/stability.js 1800   # 30-minute stability run
node tests/network-lab.js      # direct vs VPN measurements
```

Results are written to `reports/test-results.json`, `reports/runtime/*`.

## Documentation index

- [INSTALL.md](INSTALL.md) — installation from scratch
- [CONFIGURATION.md](CONFIGURATION.md) — settings, TLS/REALITY upgrade path
- [SECURITY.md](SECURITY.md) — secrets, limits, threat model
- [PERFORMANCE.md](PERFORMANCE.md) — measured numbers and tuning
- [TROUBLESHOOTING.md](TROUBLESHOOTING.md) — self-fix workflow
- [IOS-SHADOWROCKET.md](IOS-SHADOWROCKET.md) — subscription import on iOS
- `reports/` — audit, deployment, performance, network lab
