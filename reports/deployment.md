# Deployment Report — TikTunnel Control

Date: 2026-11-27. Rootless, no sudo, no Docker, no system config changes.

## What was deployed

| Component | Location / value | Evidence |
|---|---|---|
| sing-box 1.14.5 | `bin/sing-box`, static musl, sha256 pinned | `sing-box version`, `sing-box check` |
| sing-box inbound | VLESS over WebSocket, `127.0.0.1:23954`, path `/vpn` | `config/sing-box.json` |
| Control backend | Fastify on `0.0.0.0:23952` (web + API + WS proxy) | `/health` 200 |
| VPN transport | WSS via `app-medium-1-ac2e.cldcode.host:443` (URI), plaintext WS on loopback | URI check PASS |
| Database | `database/control.db` (migrations v1, 13 tables) | migration runner |
| Legacy data | `database/tiktunnel.db` preserved; 2 UUIDs/tokens imported | `control/migrate-legacy.js` |
| Auth | bcryptjs cost 12, DB sessions, CSRF, rate limits, security headers | security test |
| Web UI | `web/` dark mobile-first, Chart.js, setup/login/admin/friend pages | HTTP 200 for all pages |
| Process control | `scripts/*.sh`, `setsid/nohup`, watchdog with apply-lock | status/health-check PASS |

## Old → new

| Item | Old | New |
|---|---|---|
| VPN transport | raw TCP | VLESS over WebSocket (target WSS) |
| Node bind | 127.0.0.1:3000 (admin API) | 0.0.0.0:23952 (single app port) |
| sing-box bind | 0.0.0.0:8443 then 23952 | 127.0.0.1:23954 |
| Subscription | vn-hn.cldcode.host:23952, security=none | Cloudflare subdomain:443, type=ws, security=tls |
| Accounts | 3 UUID-only accounts | Admin + 2 friends with login/password/quota |
| Traffic | none | counted at WS proxy per token, stored in SQLite |

## Running state

- `sing-box run -c config/sing-box.json` — one instance
- `node control/server.js` — one instance
- `scripts/watchdog.sh` — 20 s checks, apply-lock prevents restart churn
- `scripts/health-check.sh` — all 5 checks PASS

## Test results

- `tests/control-test.js`: **PASS 24 / FAIL 0** (auth, RBAC, max-2 friends, URI format, real VLESS/WS traffic, real traffic accounting, quota exhaustion + enforcement, top-up, restart recovery).
- `tests/control-performance.js`: 1 client 1001.62 Mbit/s, 2 clients 979.69 Mbit/s (loopback path), CPU 85.71% / 92.31%.
- `tests/control-stability.js`: 120 s, 24/24 transfers OK, restart recovery PASS.
- Security probes: CSRF-less admin write → 401; friend → admin/monitor → 401; brute force → 429 after limit.

## Not completed / blocked

- Internet-facing VLESS: external TCP 23952 refused; WS upgrade on HTTPS subdomain returned Cloudflare 404.
- No Cloudcode shell/port-mapping control in this workspace.
- No iPhone/Shadowrocket device test.
- 30-minute external stability run not possible; local smoke only.

Status: **implementation complete and locally verified; public Cloudcode operation not proven.**
