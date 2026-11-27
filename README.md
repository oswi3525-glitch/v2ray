# TikTunnel Control

Rootless VPN control panel: admin + up to `MAX_USERS` friends, per-user quota from **real VPN traffic**, live data/speed dashboard, Device Activity, real Network Test, and one-tap Shadowrocket import. Node/Fastify + SQLite (`node:sqlite`) + sing-box VLESS-over-WebSocket.

> **Trạng thái quan trọng:** E2E 36/36 PASS, VLESS TCP thật 8 MiB qua port-mux (local). Endpoint public `vn-hn.cldcode.host:23952` hiện là **deployment khác DB/admin** nên UUID/token local không tồn tại ở đó — Shadowrocket sẽ báo lỗi máy chủ cho tới khi deploy đúng account lên host public. Cloudflare HTTPS trả 404 và forwarder chặn WebSocket. Xem `CONNECTIVITY_AUDIT.md`.

## Yêu cầu

- Node.js ≥ 22.5 (built-in `node:sqlite`), Linux x64, unprivileged user.
- Không sudo/root/Docker/systemd. sing-box binary được tải sẵn bởi `scripts/get-singbox.js`.
- RAM ~2 GB là đủ; toàn bộ chạy bằng `setsid/nohup` + watchdog.

## Cấu hình

Sao chép `.env.example` → `.env` (hoặc `config/env`); biến môi trường thật có độ ưu tiên cao nhất.

| Biến | Ý nghĩa |
|---|---|
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | Admin được seed vào SQLite lúc start (chỉ lưu bcrypt hash) |
| `SERVER_HOST` / `SERVER_PORT` | Public VLESS host / port bind nội bộ |
| `MAX_USERS` | Số friend tối đa (mặc định 3, admin không tính) |
| `TIKTUNNEL_NO_WATCHDOG` | `1` để tắt watchdog |

`config/control.json`: `app_port`, `singbox_ws_port`, `ws_path`, `public_https_host`, `vpn_mode`, `quota_check_ms`, `probe_endpoints`.

Không có màn hình setup lần đầu; đăng nhập bằng credentials trong `.env`.

## Chạy

```bash
bash scripts/start.sh      # sing-box (loopback WS), control app, watchdog
bash scripts/status.sh
bash scripts/health-check.sh
bash scripts/stop.sh
```

Startup command cho Pterodactyl/Cloudcode xem `INSTALL.md`.

## Tính năng chính

- **Notifications:** bell trên header với badge chưa đọc, dropdown và "Đã đọc tất cả" (sự kiện quota/password/device/account).
- **Admin:** Overview, User Management, Quota, Device Activity, Server Monitoring, Network Performance, Security Events, Settings.
- **Friend:** Overview (GB + tốc độ live), Data Usage, Network Test (gauge + ping/jitter/loss/down/up), Active Devices, Shadowrocket import, Account Settings.
- **Shadowrocket:** VLESS TCP trên port public 23952 (forwarder chặn WS); `GET /api/friend/import` xác thực session + quota + sing-box, trả `shadowrocket://add/<vless-uri>` và `sub://<base64(sub-url)>#remark`; copy/file/subscription làm fallback. Giữ bước xác nhận trong app.
- **Network Diagnostics:** 9 hạng mục thật (DNS/TCP/TLS/WS/VLESS/Auth/Subscription/Server/Client) với trạng thái, thời gian, nguyên nhân và cách sửa; `UNKNOWN` khi không thể kiểm chứng.
- **Port mux:** `control/port-mux.js` chia HTTP (dashboard/API) và VLESS TCP trên cùng port public, đồng thời ghi lưu lượng thật theo UUID vào DB.
- **Devices:** định danh bằng `<subscription-token>.<device-id>` trong WS path; Active/Idle/Offline/Unknown tính từ traffic thật.
- **Speed test:** endpoint truyền dữ liệu thật, có giới hạn (≤8 MB/lần tải, ≤2 MB/lần gửi), lịch sử tối đa 100 bản ghi/user.

## API

Xem `API.md`. Tóm tắt: `/api/auth/*`, `/api/admin/*`, `/api/friend/*`, `/api/net/*` (ping/download/upload), `/api/monitor/*`, `/api/sub/:token`.

## Test

```bash
npm test                              # E2E 36 checks
node tests/device-activity-test.js    # Active → Idle → Offline (~70s)
node tests/network-benchmark.js       # benchmark thật, ghi reports/runtime/
npm audit --audit-level=low           # 0 vulnerabilities
```

## Tài liệu

`CONNECTIVITY_AUDIT.md` (báo cáo điều tra lỗi kết nối), `CHANGELOG.md`, `ARCHITECTURE.md`, `SECURITY_AUDIT.md`, `SHADOWROCKET_IMPORT.md`, `NETWORK_TEST.md`, `DEVICE_ACTIVITY.md`, `PERFORMANCE_REPORT.md`, `UI_UX_REPORT.md`, `API.md`, `DATABASE.md`, `INSTALL.md`, `TROUBLESHOOTING.md`, `reports/*`.
