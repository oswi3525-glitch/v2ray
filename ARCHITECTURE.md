# ARCHITECTURE.md

## Port layout

| Component | Bind | Public? |
|---|---|---|
| Port mux (HTTP/VLESS sniffing) | `0.0.0.0:23952` | có — port public duy nhất |
| Control app (Fastify: web + API + speed endpoints) | `127.0.0.1:23950` | không |
| sing-box VLESS-WS inbound (local/test) | `127.0.0.1:23954`, path `/vpn` | không |
| sing-box VLESS-TCP inbound (public) | `127.0.0.1:23955` | không |
| Admin API | cùng Fastify, `/api/admin/*` (session + CSRF) | qua mux |

Port public duy nhất là 23952; mux chuyển HTTP tới Fastify và byte VLESS tới sing-box. Không sử dụng port public mới.

## Request flow

- `/`, `/admin`, `/friend` → SPA tĩnh (`web/index.html`, `app.js`, `style.css`), cache `no-store`.
- `/api/*` → REST: session cookie `HttpOnly`/`SameSite=Strict`, CSRF cho mọi write, RBAC admin/friend, rate limit.
- `/api/net/*` → endpoint đo tốc độ thật (xem `NETWORK_TEST.md`).
- VLESS TCP → mux gom header đến đủ 18+ byte, đọc UUID ở byte 1–17, tính độ dài header VLESS (IPv4/domain/IPv6 + addons) để **trừ phần khung VLESS** khỏi byte tính quota, chuyển tới `127.0.0.1:23955`, ghi DB mỗi 2s/lúc đóng (flush một lần). Giới hạn `mux_max_connections` mặc định 2000.
- `/vpn/<token>[.<device-id>]` (chỉ local/test) → WS upgrade tới `ws://127.0.0.1:23954/vpn`. Public forwarder chặn `Upgrade: websocket` nên không dùng cho client.

## Shadowrocket flow

1. Friend mở tab Shadowrocket → web gọi `/api/friend/import?device=<id>` (backend kiểm tra session, quota, expiry, sing-box).
2. Backend trả `uri`, `subscription_url`, `links.node`, `links.subscription`.
3. Web lưu payload và **mở deep link đồng bộ trong user gesture** (`a.click()`), không `fetch` trước khi click.
4. Người dùng xác nhận trong Shadowrocket; UI chỉ báo "đang mở/chờ xác nhận", không báo "đã thêm".

## VPN transport

- Public: VLESS TCP tới `vn-hn.cldcode.host:23952`, `security=none` — không có endpoint TLS nào forward tới app này; Cloudflare HTTPS trả 404 và forwarder chặn WS.
- Local/test: WS nội bộ (`127.0.0.1:23952` → Fastify → `23954`) hoặc VLESS TCP qua mux.
- `vpn_mode: ws` giữ cho inbound nội bộ; `public_transport: tcp` điều khiển URI công khai.
- Device id chỉ dùng được trên đường WS (nằm trong path); VLESS TCP không mang device id. Xem `CONNECTIVITY_AUDIT.md`.
- `vpn_mode: tcp` chỉ dùng khi provider có raw TCP thật.

## Database (SQLite WAL, `database/control.db`)

Migration `schema_migrations`: v1 schema gốc, v2 `devices`/`speed_tests`/`security_events` + cột device trên sessions, v3 cột traffic tích luỹ trên `devices`. Không xoá/sửa dữ liệu cũ; quota không bị reset khi upgrade.

Bảng chính: `admins`, `users`, `vpn_clients`, `subscriptions`, `traffic_usage`, `quota_history`, `connection_sessions`, `server_metrics`, `audit_logs`, `sessions`, `devices`, `speed_tests`, `security_events`.

## Quota & device enforcement

1. WS proxy đếm byte frame; mỗi 5s ghi `last_traffic_at` và delta traffic vào `devices`; khi đóng session ghi một row `traffic_usage` + cập nhật total user. Heartbeat ping/pong 30s đóng connection chết. Đăng ký danh tính thiết bị qua `POST /api/friend/devices/register` (chỉ lưu hash UA, không lưu UA thô).
2. Quota worker mỗi 10s so sánh `used = used_upload + used_download` với `quota_bytes`.
3. Vượt quota → `exhausted=1`, `enabled=0`, đóng WS, render lại sing-box (bỏ UUID), audit + quota history.
4. Device Active khi có traffic trong 60s gần nhất; Idle khi còn session nhưng hết traffic; Offline khi không session và không traffic gần; Unknown khi thiếu dữ liệu.

## Process model

`scripts/start.sh` dùng `setsid nohup`; watchdog giám sát sing-box/control và có apply-lock tránh restart race. Không systemd/root.
