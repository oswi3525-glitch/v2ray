# TikTunnel Control

Rootless VPN control panel: **Admin + up to 2 friends**, per-user quota from real traffic, VLESS-over-WebSocket via sing-box, Node/Fastify backend, SQLite database.

> **STATUS: Implemented and verified locally. Public Cloudcode path NOT verified.**
> `vn-hn.cldcode.host:23952` returns TCP connection refused from this workspace and the HTTPS subdomain returned Cloudflare 404 to a WS upgrade. There is no Cloudcode shell here. Do not import the subscription on a real device or claim the VPN works until the Cloudcode port mapping is confirmed. See `reports/cloudcode-audit.md`.

## Architecture

```
Internet -> Cloudflare HTTPS subdomain (TLS terminated at Cloudflare)
         -> Cloudcode primary app port 23952
         -> Node/Fastify :23952   (/ , /admin , /friend , /api , /vpn/<token>)
         -> sing-box VLESS-WS :127.0.0.1:23954 (path /vpn)
         -> direct outbound
```

Node and sing-box never share a port. TLS is not faked; the app speaks plain WS only on loopback.

## Quick start

```bash
cd "$HOME/TikTunnel"
./scripts/bootstrap.sh
./scripts/start.sh
./scripts/status.sh
./scripts/health-check.sh
```

Open `http://127.0.0.1:23952/` → **Create Administrator** (first run only) → Admin dashboard → create up to 2 friends, set quota, reset password, copy UUID/VLESS/subscription.

## Management

```bash
./scripts/stop.sh ; ./scripts/restart.sh
./scripts/backup.sh
./scripts/restore.sh backups/<file>.tar.gz --confirm
node control/migrate-legacy.js     # one-time import of old UUID/tokens (kept old DB)
```

## Tests

```bash
node tests/control-test.js          # 24 PASS / 0 FAIL in last run
node tests/control-performance.js
node tests/control-stability.js 120
```

## Docs and reports

`INSTALL.md`, `ARCHITECTURE.md`, `SECURITY.md`, `API.md`, `DATABASE.md`, `SHADOWROCKET.md`, `PERFORMANCE.md`, `TROUBLESHOOTING.md`, and `reports/*`.
