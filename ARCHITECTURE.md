# ARCHITECTURE.md

## Port layout

| Component | Bind | Public? |
|---|---|---|
| Control app (Fastify: web + API + WS proxy) | `0.0.0.0:23952` | yes, via Cloudcode primary port |
| sing-box VLESS-WS inbound | `127.0.0.1:23954`, path `/vpn` | no |
| Admin API | same app, `/api/admin/*`, bearer of session cookie + CSRF | no separate port |

Only the Node process binds the public application port; sing-box is loopback-only. There is no port sharing.

## Request flow

- `/`, `/admin`, `/friend` → static web panel.
- `/api/*` → REST API (Fastify) with session cookie, CSRF for writes, RBAC, rate limits.
- `/vpn/<subscription-token>` → WebSocket upgrade. The app validates the token and user state, opens a WebSocket to `ws://127.0.0.1:23954/vpn`, and pipes binary frames in both directions while counting bytes per user.

## VPN transport

- Target: Shadowrocket connects with VLESS over WSS to `app-medium-1-ac2e.cldcode.host:443`, path `/vpn/<token>`, SNI = that hostname. TLS is terminated by Cloudflare; the app never accepts TLS itself and never uses a fake certificate.
- Local verification uses plain WS to `127.0.0.1:23952` because there is no working public tunnel here.
- `vpn_mode: tcp` is available in `config/control.json` for a provider that offers true raw TCP forwarding on 23952; then sing-box binds that port and the web panel must be hosted separately.

## Quota enforcement

1. WS proxy increments up/down bytes per connection; on close it writes one `traffic_usage` row and updates the user's totals.
2. Every 10 s the quota worker compares `used_upload + used_download` with `quota_bytes`.
3. When exceeded: set `exhausted=1`, `enabled=0`, close all active WS connections for that user, remove UUID from the sing-box config and restart sing-box, write audit + quota history.
4. Admin can add quota and re-enable; UUID is restored.

Expected overshoot: roughly one quota-worker interval (10 s) of traffic plus in-flight frames; no hard kernel-level cap is claimed.

## Data and process model

SQLite WAL in `database/control.db`; migrations in `control/db.js`; legacy `database/tiktunnel.db` preserved. Processes started with `setsid nohup` and supervised by `scripts/watchdog.sh` with an apply-lock to avoid restart races.
