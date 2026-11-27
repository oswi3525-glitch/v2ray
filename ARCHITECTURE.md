# ARCHITECTURE.md

## Port layout

| Component | Bind | Public? |
|---|---|---|
| Control app (Fastify: web + API + speed endpoints + WS proxy) | `0.0.0.0:23952` | có, qua Cloudcode primary port |
| sing-box VLESS-WS inbound | `127.0.0.1:23954`, path `/vpn` | không |
| Admin API | cùng app, `/api/admin/*` (session + CSRF) | không có port riêng |

Chỉ Node bind port public; sing-box loopback-only. Không chia sẻ port.

## Request flow

- `/`, `/admin`, `/friend` → SPA tĩnh (`web/index.html`, `app.js`, `style.css`), cache `no-store`.
- `/api/*` → REST: session cookie `HttpOnly`/`SameSite=Strict`, CSRF cho mọi write, RBAC admin/friend, rate limit.
- `/api/net/*` → endpoint đo tốc độ thật (xem `NETWORK_TEST.md`).
- `/vpn/<token>[.<device-id>]` → WebSocket upgrade. Validate token + accountReady, parse device id, mở WS tới `ws://127.0.0.1:23954/vpn`, pipe frame hai chiều, đếm byte theo user + device.

## Shadowrocket flow

1. Friend mở tab Shadowrocket → web gọi `/api/friend/import?device=<id>` (backend kiểm tra session, quota, expiry, sing-box).
2. Backend trả `uri`, `subscription_url`, `links.node`, `links.subscription`.
3. Web lưu payload và **mở deep link đồng bộ trong user gesture** (`a.click()`), không `fetch` trước khi click.
4. Người dùng xác nhận trong Shadowrocket; UI chỉ báo "đang mở/chờ xác nhận", không báo "đã thêm".

## VPN transport

- VLESS/WSS tới `app-medium-1-ac2e.cldcode.host:443`, path `/vpn/<token>[.<device-id>]`, Host/SNI = public host, TLS do Cloudflare terminate.
- Device id nối sau token bằng `.` (không dùng `?d=` vì sing-box encode `?` thành `%3F`). Token là base64url nên không chứa `.`.
- Local test dùng plain WS tới `127.0.0.1:23952`.
- `vpn_mode: tcp` chỉ dùng khi provider có raw TCP thật.

## Database (SQLite WAL, `database/control.db`)

Migration `schema_migrations`: v1 schema gốc, v2 `devices`/`speed_tests`/`security_events` + cột device trên sessions, v3 cột traffic tích luỹ trên `devices`. Không xoá/sửa dữ liệu cũ; quota không bị reset khi upgrade.

Bảng chính: `admins`, `users`, `vpn_clients`, `subscriptions`, `traffic_usage`, `quota_history`, `connection_sessions`, `server_metrics`, `audit_logs`, `sessions`, `devices`, `speed_tests`, `security_events`.

## Quota & device enforcement

1. WS proxy đếm byte; mỗi 5s ghi `last_traffic_at` và delta traffic vào `devices`; khi đóng session ghi một row `traffic_usage` + cập nhật total user.
2. Quota worker mỗi 10s so sánh `used = used_upload + used_download` với `quota_bytes`.
3. Vượt quota → `exhausted=1`, `enabled=0`, đóng WS, render lại sing-box (bỏ UUID), audit + quota history.
4. Device Active khi có traffic trong 60s gần nhất; Idle khi còn session nhưng hết traffic; Offline khi không session và không traffic gần; Unknown khi thiếu dữ liệu.

## Process model

`scripts/start.sh` dùng `setsid nohup`; watchdog giám sát sing-box/control và có apply-lock tránh restart race. Không systemd/root.
