# SECURITY_AUDIT.md

Ngày audit: 2026-11-27. Phạm vi: `control/server.js`, `control/db.js`, `web/*`, `config/*`. Không root/sudo; `npm audit` = 0 vulnerabilities.

## 1. Authentication

| Kiểm tra | Trạng thái | Chi tiết |
|---|---|---|
| Hash mật khẩu | PASS | bcrypt cost 12 (`bcryptjs`); requirement cho phép bcrypt hoặc Argon2id |
| Session cookie | PASS | `HttpOnly`, `SameSite=Strict`, `Max-Age` 2h (admin)/12h (friend), `Secure` khi `cookie_secure=true` |
| Session rotation | PASS | Xoá session cũ nếu cookie được gửi khi login lại; test xác nhận cookie cũ → 401 |
| Logout | PASS | Xoá session + clear cookie + yêu cầu CSRF |
| Rate limit login | PASS | 10 attempt / 5 phút / IP; khoá 5 lần thất bại / 15 phút theo `ip|username` |
| Brute force | PASS | Thử nghiệm 6 lần sai → 429; ghi `security_events` |
| Default password | PASS | Không có; startup fail nếu `ADMIN_PASSWORD` thiếu/CHANGE_ME |

## 2. Authorization (RBAC)

| Hành vi trái phép | Kết quả |
|---|---|
| Friend gọi `/api/admin/users` | 401 |
| Friend đọc account khác `/api/admin/users/:id` | 401/403 |
| Friend đổi quota | 401 (CSRF + role) |
| Friend đổi device của user khác | 404 (truy vấn `WHERE user_id = me`) |
| Friend tự cấp data | Không có endpoint; quota chỉ admin |
| Friend đổi subscription token | Không có endpoint |

`guard()` kiểm tra role trước mọi handler; mọi write admin/friend đều yêu cầu `x-csrf-token` khớp session.

## 3. API & input

- Validate username (`^[A-Za-z0-9_.-]{2,32}$`), password ≥8, quota `0..10000`, expiry phải tương lai, device id `^[A-Za-z0-9_-]{8,64}$`, mọi số speed test nằm trong khoảng cho phép.
- SQL: toàn bộ truy vấn dùng prepared statement (`node:sqlite`), không nối chuỗi từ input (ngoại trừ danh sách field cố định trong `setUserState`).
- XSS: `esc()` cho mọi dữ liệu chèn vào `innerHTML`; CSP `default-src 'self'`, `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`.
- CSRF: cookie CSRF + header; auto-refresh một lần khi 401.
- Rate limit: 180 req/phút cho `/api/*`, 120 ping, 30 download, 30 upload, 20 speedtest.
- Error handler trả `{ok:false,error}`; không trả stack trace.
- `/api/friend/me` và `/api/friend/usage` **không** trả `uuid`/`subscription_token`; chỉ `/api/friend/vpn`/`subscription` trả cấu hình của chính chủ.

## 4. VPN security

- UUID riêng từng friend, sinh lúc tạo account; revoke xoá UUID khỏi sing-box và đóng WS.
- Subscription/chỉ trả khi `accountReady`: chưa revoke, enabled, chưa exhausted, quota chưa vượt, expiry chưa tới; kiểm tra cả `used >= quota` trực tiếp.
- WS upgrade kiểm tra token + account state trước khi handle upgrade.
- Audit log dùng username/user id, **không ghi UUID đầy đủ** vào log thường.
- Không có sing-box management/API public; sing-box chỉ bind `127.0.0.1:23954`.

## 5. Hạ tầng

- User `codespace` (uid 1000), không sudo/root; không systemd.
- Secrets nằm ở `.env`/`config/secrets.env` (gitignored), không trong source; DB gitignored.
- Log sing-box level `warn`; `TIKTUNNEL_MAX_LOG_BYTES` giới hạn size.
- Backup trước khi nâng cấp: `/tmp/opencode/v2ray-upgrade-backup/` (không commit).
- Không mở port public mới.

## 6. Lỗ hổng đã xử lý trong đợt này

1. Logout thiếu CSRF → đã thêm.
2. Không rotation session → đã thêm.
3. Lockout chặn cả login đúng sau 1 lần sai (bug tự phát hiện khi test) → chỉ lock khi `n >= 5`.
4. Friend/me lộ subscription token → đã xoá.
5. Subscription chỉ dựa vào cờ `exhausted` → thêm kiểm tra quota trực tiếp.
6. Speed test/upload endpoint có thể bị lạm dụng → rate limit + bodyLimit 2 MiB + cap 8 MiB.
7. Quota `reduce`/`reset` cộng ngược → sửa trừ/về 0, tính lại `exhausted`.

## 7. Rủi ro còn lại / chưa thể kiểm thử

- **WS upgrade public trả 404** (Cloudflare) → chưa xác minh được đường VPN Internet; không phải lỗi code.
- **Không có iPhone thật**: không test được Shadowrocket nhận config, VPN connect, DNS leak, reconnect.
- `cookie_secure=false` ở local HTTP; phải bật `true` khi deploy HTTPS thật (nếu Cloudflare terminate TLS và app thấy http, cần cấu hình trust proxy hoặc set thủ công).
- Chart.js tải từ CDN `cdn.jsdelivr.net` (CSP cho phép); nếu muốn air-gapped phải self-host.
- Argon2id chưa dùng (bcrypt được requirement chấp nhận).

## 8. Kết quả test bảo mật

`npm test` 34/34 PASS, trong đó có RBAC, session rotation, security events. Brute-force/session expiry/CSRF được kiểm tra bằng script tích hợp trong E2E và script thủ công; chi tiết `reports/runtime/control-tests.json`.
