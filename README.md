# TikTunnel Control

Rootless VPN control panel: **Admin + up to 2 friends**, per-user quota from real traffic, VLESS-over-WebSocket via sing-box, Node/Fastify backend, SQLite database.

> **STATUS: Implemented and verified locally. Public Cloudcode path NOT verified.**
> `vn-hn.cldcode.host:23952` returned TCP connection refused from the earlier workspace and the HTTPS subdomain returned Cloudflare 404 to a WS upgrade. Do not import the subscription on a real device until the Cloudcode/Pterodactyl port mapping is confirmed. See `reports/cloudcode-audit.md`.

## Environment requirements

- Pterodactyl on Cloudcode, Node.js 24, Linux x64, 2 GB RAM, 10 GB disk.
- No sudo, no compiler, no Docker, no systemd.
- Only the prebuilt `linux-amd64(-musl)` sing-box release is downloaded; no build step.

## Configuration / environment

Real environment variables **override** `config/env`. Copy the sample and edit only what the panel does not already provide:

```bash
cp .env.example config/env
```

| Variable | Meaning |
|---|---|
| `SERVER_HOST` | Public VLESS hostname, currently `vn-hn.cldcode.host` |
| `SERVER_PORT` | Port the app must **bind inside the container** |
| `PROTOCOL` | `vless` |
| `MAX_USERS` | 3 (Admin + 2 friends) |
| `ADMIN_USERNAME` | Admin login name; seeded into SQLite at startup |
| `ADMIN_PASSWORD` | Admin password (≥8 chars, not `CHANGE_ME…`); stored only as a bcrypt hash |
| `SINGBOX_VERSION` | Optional release pin; default comes from `config/control.json` → `singbox_version` (`1.14.5`) |
| `TIKTUNNEL_MAX_LOG_BYTES` | Log rotation size, default 5 MiB |
| `TIKTUNNEL_NO_WATCHDOG` | Set `1` to disable the watchdog |

**How to get the real `SERVER_PORT`:** open the Pterodactyl panel → your server → **Allocations** and use the allocated TCP port (often exposed to the container as `PORT`). If Cloudcode forwards public TCP 23952 to a different internal port, set `SERVER_PORT` to that **internal** port; the public port remains the one Cloudcode allocated. Never guess the number.

There is no first-run admin setup screen: the web UI always shows only the login form. Admin credentials come from `ADMIN_USERNAME` / `ADMIN_PASSWORD` in `.env` and are synced into SQLite at every startup (only a bcrypt hash is stored). Change them in `.env` and restart to take effect. If they are missing or still the placeholder, startup fails with a clear message — no default password is used.

A separate admin API token is generated once into `config/secrets.env` (chmod 600) by `scripts/bootstrap.sh`. It is never printed.

## Startup Command (Pterodactyl)

One line, no `find -exec`, no `chmod`, no direct `./scripts/...`:

```sh
cd /home/container && git fetch --all && git reset --hard origin/main && if ! cmp -s package-lock.json node_modules/.package-lock.json; then npm ci --omit=dev --no-audit --no-fund; fi && node scripts/get-singbox.js && if [ ! -f config/secrets.env ]; then bash scripts/bootstrap.sh; fi && bash scripts/start.sh
```

`scripts/start.sh` also calls `node scripts/get-singbox.js` itself if `bin/sing-box` is missing or fails `sing-box version`, so it will not crash with `No such file or directory`.

## sing-box version

Default version lives in `config/control.json`:

```json
"singbox_version": "1.14.5"
```

To change it, either edit that field or set `SINGBOX_VERSION=v1.15.0` in the panel environment. `scripts/get-singbox.js` resolves the matching GitHub release, selects the `linux-x64` asset by regex (preferring the static musl build), extracts it with system `tar`, marks it executable, removes the temporary archive, and verifies with `sing-box version`. On network/API failure it exits non-zero with a clear message.

## Local management

```bash
bash scripts/start.sh
bash scripts/stop.sh
bash scripts/restart.sh
bash scripts/status.sh
bash scripts/health-check.sh
bash scripts/backup.sh
```

## Tests (offline)

```bash
node tests/control-test.js
```

The test suite uses only loopback HTTP/WebSocket and local sockets; it needs no Internet access.

## Docs and reports

`INSTALL.md`, `ARCHITECTURE.md`, `SECURITY.md`, `API.md`, `DATABASE.md`, `SHADOWROCKET.md`, `PERFORMANCE.md`, `TROUBLESHOOTING.md`, and `reports/*`.
