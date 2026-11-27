# API.md

Base URL: same origin as the web panel (`http://127.0.0.1:23952` locally; Cloudcode HTTPS subdomain in production).

Auth: session cookie `tiktunnel_session` (HttpOnly). All mutating admin requests also require header `x-csrf-token` with the value returned by login. Friend endpoints require a friend session.

## Authentication

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/auth/login` | none | `{username,password}` → `{role,csrf}` |
| POST | `/api/auth/logout` | session | end session |
| GET | `/api/auth/me` | session | `{role,csrf,username}` |

## Admin

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/admin/overview` | server/VPN/account summary |
| GET | `/api/admin/users` | all friends incl. UUID, token, quota, usage |
| POST | `/api/admin/users` | create friend (max `MAX_USERS`, default 3): `{username,display_name,password,quota_gb,expires_at?}` |
| GET | `/api/admin/users/:id` | one friend + traffic history |
| PATCH | `/api/admin/users/:id` | `{display_name,enabled,expires_at,uuid}` |
| DELETE | `/api/admin/users/:id` | revoke friend and VPN access |
| POST | `/api/admin/users/:id/quota` | `{action:set|add|reduce|reset,gb}` — `set` replaces, `add`/`reduce` adjust by `gb`, `reset` sets quota to 0 (unlimited); `exhausted` is recomputed |
| POST | `/api/admin/users/:id/disable` | disable + close connections |
| POST | `/api/admin/users/:id/enable` | enable (clears exhausted) |
| POST | `/api/admin/users/:id/password` | `{password}` reset friend password |
| POST | `/api/admin/password` | `{password}` change admin password |
| GET | `/api/admin/audit` | audit log |

## Friend

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/friend/me` | own account only |
| GET | `/api/friend/usage` | own traffic + history |
| GET | `/api/friend/vpn` | own VLESS URI and active state |
| GET | `/api/friend/live` | live in-flight usage + current up/down speed (bytes/s) + remaining bytes; poll every 2 s |
| GET | `/api/friend/subscription` | own subscription URL/token |
| GET | `/api/sub/:token?raw=1` | public-by-token subscription (base64 default, raw if `raw=1`) |

## Monitoring

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/monitor/server` | CPU, RAM, disk, process state |
| GET | `/api/monitor/network` | interface counters + TCP connect probes; explicitly not client-side latency |
| GET | `/api/monitor/performance` | stored metric history |

Errors use `{ok:false,error:<code>}` with 400/401/403/404/409/429. A `401 unauthorized` on a write is retried once by the web UI after refreshing the CSRF token from `/api/auth/me`. Account creation returns specific codes: `invalid_username`, `invalid_password`, `invalid_quota`, `invalid_expiry`, `username_taken`, `friend_limit_reached`. `GET /health` is public.

Static assets are served with `Cache-Control: no-store` and a version query (`?v=<package version>`); the UI also has a **Clear cache** button that reloads the current page with a cache-busting query.
