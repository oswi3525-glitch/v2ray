# CHANGELOG.md

## 2.2.0 — Connectivity fix: VLESS TCP over port mux + real diagnostics

### Added
- `control/port-mux.js`: nhận raw TCP trên port public 23952, phân loại HTTP/VLESS, giữ dashboard và VLESS trên cùng port; ghi byte thật theo UUID vào DB.
- sing-box có thêm VLESS TCP inbound `127.0.0.1:23955` cạnh WS inbound 23954.
- `control/diagnostics.js` + `GET /api/diagnostics/run`: 9 hạng mục thật, trả status/duration/cause/fix; `UNKNOWN` cho mục không chứng minh được từ server. Tab Diagnostics trên cả admin và friend.
- `CONNECTIVITY_AUDIT.md`: bằng chứng đo được về lỗi Shadowrocket.

### Changed
- Public transport = VLESS TCP (`vn-hn.cldcode.host:23952`, `security=none`) thay vì WSS; subscription URL dùng cùng endpoint public.
- Fastify chuyển sang `127.0.0.1:23950`; scripts start/stop/watchdog/health-check quản lý thêm port-mux.
- `MAX_USERS=2`; E2E chuyển sang VLESS TCP qua mux.

### Verified
- `npm test` 36/36 PASS (gồm 8 MiB VLESS TCP thật + quota delta 8388767B).
- Diagnostics: PASS 5 / FAIL 2 (ws, subscription trên endpoint public) / WARNING 1 / UNKNOWN 1 — phản ánh đúng sự thật hạ tầng.
- Benchmark: API 1.30 ms, download 655.23 Mbps, TCP server→1.1.1.1 2.26 ms, CPU 28.17%, RAM 4.49 GB.

### Blocker không sửa được trong workspace
- `vn-hn.cldcode.host:23952` là deployment **khác DB/admin** (login 401, subscription 404) → UUID local không hợp lệ ở đó.
- Forwarder Cloudcode chặn `Upgrade: websocket`; HTTPS Cloudflare trả 404; không có TLS terminate tới app. Cần deploy code+account lên đúng host public.

## 2.1.1 — Loading hang fix + notifications

### Fixed
- Boot/skeleton có thể treo vĩnh viễn: mọi API có `AbortController` timeout (9s, boot 8s), builder tab có timeout 12s, error state và boot đều có nút **Thử lại**; `web/boot-guard.js` thay spinner bằng thông báo lỗi sau 10s nếu app.js không chạy.
- `/api/monitor/latency` đổi từ 8 probe tuần tự (tối đa 24s) sang 6 probe song song (1.5s) → admin Overview không chờ dài.
- `crypto.randomUUID()` có fallback `getRandomValues` cho iOS cũ / non-secure context.
- Route quota trả 400 do biến local `gb` che hàm `gb()`, làm mất notification; đã sửa.

### Added
- Notification system thật: bảng `notifications`, migration v4, bell + badge + dropdown trên header, refresh 30s, "Đã đọc tất cả".
- Sự kiện: hết/quota thay đổi, mật khẩu đổi/reset, thiết bị VPN mới, tài khoản mới (admin). Giới hạn 200/user.
- `GET /api/notifications`, `POST /api/notifications/read`.

### Verification
- `npm test`: 36/36 PASS (thêm 2 checks notifications).

## 2.1.0 — Major UX, Network & Security upgrade

### Added
- `GET /api/friend/import`: xác thực session, kiểm tra quota/expiry/sing-box, sinh VLESS URI riêng cho account + device, trả deep link Shadowrocket dạng `shadowrocket://add/<vless-uri>` (node) và `sub://<base64(sub-url)>#remark` (subscription), kèm fallback copy/file/URL.
- Device identifier trong WS path: `/vpn/<token>.<device-id>` (an toàn với bộ parse của sing-box; `?d=` bị sing-box mã hoá thành `%3F` nên không dùng).
- `devices`, `speed_tests`, `security_events` + migration DB v2/v3; `connection_sessions.device_id`, `last_traffic_at`; `devices.upload_bytes/download_bytes`.
- `/api/friend/devices`, `/api/admin/devices`, PATCH rename device (chỉ device của chính mình).
- Network Test: `/api/net/ping`, `/api/net/download` (≤8 MiB), `/api/net/upload` (≤2 MiB), `/api/friend/speedtest`, `/api/friend/speedtests`; lịch sử tối đa 100/user.
- `/api/monitor/latency` (current/average/peak/jitter/packet loss từ TCP probe thật), `/api/admin/security`.
- Đổi mật khẩu cho friend (`/api/friend/password`).
- Redesign UI: tab-based Admin (8 tab) và Friend (6 tab), gauge SVG cho tốc độ, skeleton/empty/error state, modal xác nhận, light mode, responsive mobile-first.
- `tests/network-benchmark.js`, `tests/device-activity-test.js`.

### Changed
- Session rotation sau login (cookie cũ bị vô hiệu khi đăng nhập lại), logout yêu cầu CSRF.
- Login lockout 5 lần thất bại / 15 phút theo `ip|username`, ghi `security_events`.
- `/api/friend/me` và `/api/friend/usage` không trả `uuid`/`subscription_token`.
- Subscription endpoint chặn cả trường hợp `used >= quota` trực tiếp, không chỉ cờ `exhausted`.
- Web live polling giảm từ 2s → 5s; header CSP/Permissions-Policy siết thêm.
- Quota `reduce`/`reset` được sửa từ "cộng" sang "trừ"/"về 0"; `exhausted` được tính lại theo quota mới.

### Fixed
- Deep link cũ dùng `shadowrocket://subscribe?url=...` (không có trong handbook) và `shadowrocket://add/<base64>` (sai payload). Thay bằng cơ chế có nguồn: handbook `shadowrocket://add/{url}` và `sub://BASE64#REMARK` (đã được 3x-ui xác nhận).
- UI không báo "thành công" khi mới chỉ mở app; yêu cầu xác nhận trong Shadowrocket.
- Test MAX_USERS cứng "max 2" trong khi config là 3; test giờ lấy `envcfg.maxUsers`.

### Verification
- `npm test`: 34/34 PASS.
- `node tests/device-activity-test.js`: 7/7 PASS (traffic thật 8 MiB qua sing-box).
- `npm audit`: 0 vulnerabilities.
- Benchmark trước/sau: `PERFORMANCE_REPORT.md`.

### Không làm
- Không đổi kernel/sysctl (cần root), không tune sing-box "mù"; giữ cấu hình DNS/transport như cũ vì không có bằng chứng đo được về cải thiện.
- Không tạo dữ liệu giả, không có iPhone thật / Cloudcode WS end-to-end — xem báo cáo.
