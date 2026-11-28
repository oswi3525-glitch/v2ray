# TikTunnel Control

Rootless VPN control panel: admin + up to `MAX_USERS` friends, per-user quota from **real VPN traffic**, live data/speed dashboard, Device Activity, real Network Test, and one-tap Shadowrocket import. Node/Fastify + SQLite (`node:sqlite`) + sing-box VLESS-over-WebSocket.

> **Trạng thái quan trọng:** E2E 39/39 PASS, core 22/22, app API 37/37. VLESS TCP thật 8 MiB qua port-mux (local). Endpoint public `vn-hn.cldcode.host:23952` hiện là **deployment khác DB/admin** nên UUID/token local không tồn tại ở đó — Shadowrocket sẽ báo lỗi máy chủ cho tới khi deploy đúng account lên host public. Cloudflare HTTPS trả 404 và forwarder chặn WebSocket. Xem `CONNECTIVITY_AUDIT.md`.

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
- **Network Diagnostics:** 10 hạng mục thật (DNS/TCP/TLS/TikTok CDN/WS/VLESS/Auth/Subscription/Server/Client) với trạng thái, thời gian, nguyên nhân và cách sửa; `UNKNOWN` khi không thể kiểm chứng.
- **Port mux:** `control/port-mux.js` chia HTTP (dashboard/API) và VLESS TCP trên cùng port public, đồng thời ghi lưu lượng thật theo UUID vào DB.
- **Devices:** định danh bằng `<subscription-token>.<device-id>` trong WS path; web đăng ký `platform/kind/agent_hash` (không lưu UA thô), Active/Idle/Offline/Unknown tính từ traffic thật.
- **Speed test:** 10 ping bỏ mẫu lạnh, jitter theo mẫu liên tiếp, 5 chunk đo sau chunk khởi động lấy median, đối chiếu `X-Payload-Bytes`; ≤8 MB/lần tải, ≤2 MB/lần gửi, lịch sử tối đa 100 bản ghi/user.
- **tiktokv.com:** probe thật DNS/TCP/TLS/HTTP trong Diagnostics và trang kiểm tra gói cước (`npm run test:tiktok`).
- **Full Tunnel profile:** `GET /api/friend/profile` (session) và `GET /api/sub/:token/profile` (token) trả cấu hình sing-box full-tunnel đã được kiểm tra bằng `sing-box check`: route final = proxy, tun IPv4+IPv6, DNS qua tunnel, UDP xudp. Không phải VPN hệ thống iOS — iOS cần NetworkExtension app hoặc Shadowrocket.
- **Usage summary:** `/api/friend/usage/summary` tách upload/download/overhead theo nguồn và theo ngày/tuần/tháng. Nhãn rõ "server-observed, not a carrier bill".
- **Research Lab:** `control/research.js` + `/api/admin/research/*`, giả thuyết T15KN có trạng thái bằng chứng (`unverified|testing|evidence|refuted`), đối chiếu số liệu nhà mạng nhập tay và phát hiện lệch >10%. Không giả mạo TikTok/không né cước.
- **Metadata compression:** JSON API ≥2 KB trả brotli/gzip khi client hỗ trợ; không đụng payload VPN.

## API

- **App iOS (chính thức):** xem `APP_API.md` — Bearer token (`/api/tikfl/login`, `/api/auth/refresh`), `/api/vpn/config|status|metrics`, chỉ số server-observed thật, keep-alive, và kế hoạch tắt web.
- Web/dashboard cũ & admin: xem `API.md`. Tóm tắt: `/api/auth/*`, `/api/admin/*`, `/api/friend/*`, `/api/net/*`, `/api/monitor/*`, `/api/sub/:token`.
- `GET /api` trả discovery; `GET /health` trả `api_version`, `mode`, `web_enabled`.

Web có thể tắt mà không ảnh hưởng API: `"web_enabled": false` trong `config/control.json` hoặc `TIKTUNNEL_DISABLE_WEB=1`.

## Test

```bash
npm test                              # E2E 39 checks
npm run test:core                     # 22 checks: full-tunnel profile, usage, research, compression
npm run test:app                      # 37 checks: bearer/refresh + /api/vpn/* metrics thật
npm run test:all                      # chạy cả ba suite
npm run test:tiktok                   # probe thật DNS/TCP/TLS/HTTP tới tiktokv.com
node tests/device-activity-test.js    # Active → Idle → Offline (~70s)
node tests/network-benchmark.js       # benchmark thật, ghi reports/runtime/
npm audit --audit-level=low           # 0 vulnerabilities
```

## Tài liệu

`APP_API.md` (hợp đồng API cho app iOS), `deploy/README.md` (lõi VPN ShadowTLS/Reality + script triển khai), `CONNECTIVITY_AUDIT.md` (báo cáo điều tra lỗi kết nối), `CHANGELOG.md`, `ARCHITECTURE.md`, `SECURITY_AUDIT.md`, `SHADOWROCKET_IMPORT.md`, `NETWORK_TEST.md`, `DEVICE_ACTIVITY.md`, `PERFORMANCE_REPORT.md`, `UI_UX_REPORT.md`, `API.md`, `DATABASE.md`, `INSTALL.md`, `TROUBLESHOOTING.md`, `reports/*`.
