# INSTALL.md

## Prerequisites

- Ubuntu 24.04-like Linux, unprivileged user with writable home.
- Node.js ≥ 22.5 (built-in `node:sqlite`), npm, Python 3, curl, tar, openssl.
- Outbound Internet to GitHub releases / npm registry.
- No root, no sudo, no Docker, no systemd.

## Steps

1. **Audit first** — `reports/cloudcode-audit.md` documents the live checks. Do not assume Cloudcode forwards TCP 23952 or that the HTTPS subdomain forwards WS.
2. **Backup** — `./scripts/backup.sh`; the old port (8443 → 23952) and old DB are preserved in `backups/pre-cloudcode-*`.
3. **Bootstrap** — `./scripts/bootstrap.sh` generates `config/secrets.env` (chmod 600) only if missing and installs npm dependencies (`fastify`, `bcryptjs`, `ws`).
4. **sing-box** — official v1.14.5 `linux-amd64-musl` binary in `bin/sing-box`, sha256 pinned: `9cf4d31acb76696c64b4c3214854bc72a68c703482781ddd2158dbf95ab9d06a`.
5. **Config** — copy the sample with `cp .env.example config/env`, then edit `SERVER_HOST`, `SERVER_PORT`, `PROTOCOL`, `MAX_USERS`. Real environment variables override that file. `config/control.json` holds the app port, WS inbound port 23954, WS path `/vpn`, public HTTPS host and quota interval.
6. **Start** — `./scripts/start.sh` starts sing-box (loopback WS inbound), the control app on 23952 and the watchdog.
7. **First setup** — open the app, create the admin password. No default password exists. The legacy DB's 2 UUID/tokens can be imported with `node control/migrate-legacy.js` (passwords are NOT imported; admin must reset them).
8. **Verify** — `./scripts/health-check.sh` and `node tests/control-test.js`.

## Cloudcode deployment notes

- If Cloudcode requires a different internal port mapping, change `app_port` in `config/control.json` / `SERVER_PORT` in `config/env` — do not invent a new public port.
- If Cloudcode terminates TLS on the HTTPS subdomain, keep `server/render-control-config.js` plaintext WS on loopback and set `cookie_secure: true` in `config/control.json`.
- If WS forwarding is unavailable, set `vpn_mode: tcp` (sing-box binds the app port directly) and host the web panel elsewhere; this has NOT been verified in this environment.
- Persistent process recovery: watchdog + `setsid/nohup`. Systemd/cron auto-start cannot be assumed on Cloudcode; configure whatever persistence the provider actually offers.
