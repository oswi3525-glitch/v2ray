# APP_API.md — TikTunnel API cho client iOS (`tiktunnlvpn`)

Tài liệu này là hợp đồng giữa control server (`tiktunnel-control`) và app iOS. Web dashboard đang được đưa về chế độ optional; **API là sản phẩm chính**. Mọi chỉ số ở đây đều lấy từ dữ liệu thật trên server, không giả lập.

## 1. Endpoint & bảo mật

- Base: `http://vn-hn.cldcode.host:23952` (hiện tại là HTTP thường, **không có TLS**). Không log token lên device/log. Nên đặt reverse proxy TLS trước public port trong production.
- Auth: `Authorization: Bearer <access_token>` (khuyến nghị) hoặc cookie `tiktunnel_session` + `x-csrf-token` (tương thích web cũ).
- Khi dùng Bearer: **không cần CSRF**. Server lưu `sha256(token)`, không lưu token plaintext.
- Mọi response `/api/*` đều có `Cache-Control: no-store`. JSON ≥ 2KB được nén `br`/`gzip` nếu client gửi `Accept-Encoding`.

Khám phá nhanh:

```
GET /health          -> { ok, service, api_version:1, mode, web_enabled, uptime_s }
GET /api             -> { ok, api_version:1, auth:["bearer","cookie"], transport, web_enabled, endpoints{...} }
```

## 2. Đăng nhập / token

### `POST /api/tikfl/login` (dùng cho app)

Request: `{ "username": "...", "password": "..." }`

Response `200`:

```json
{
  "ok": true,
  "role": "friend",
  "csrf": null,
  "token": "<access_token>",
  "access_token": "<access_token>",
  "refresh_token": "<refresh_token>",
  "expires_in": 3600,
  "user": { "username": "friend1", "display_name": "Friend 1", "role": "friend" }
}
```

`LoginResponse.swift` đọc được cả `token` lẫn `access_token`; `expires_in` là số giây. Cookie vẫn được set để tương thích, nhưng app không cần dùng.

### `POST /api/auth/refresh`

Request: `{ "refresh_token": "..." }`. Response `200` trả bộ token mới (`token`, `access_token`, `refresh_token`, `expires_in`, `role`, `user`). Refresh token chỉ dùng **1 lần**; token cũ bị vô hiệu. Access token cũ **vẫn có giá trị đến hạn** (rotate không đứng xuất hiện người dùng).

### `GET /api/auth/me` (Bearer)

Response: `{ ok, role, username, display_name, csrf:null, expires_in, user:{...} }`.

### `POST /api/auth/logout` (Bearer)

Thu hồi access token ngay; token dùng sau đó trả `401`.

`POST /api/auth/login` vẫn giữ nguyên cho web (không trả token).

Mã lỗi: `invalid_credentials` (401), `invalid_input` (400), `too_many_attempts` (429, lockout 15 phút sau 5 lần sai), `invalid_refresh`/`account_unavailable` (401), `rate_limited` (429), `unauthorized` (401), `forbidden` (403).

Rate limit: login 10/5p per IP+user, refresh 60/phút, API chung 180/phút, ping 120/phút.

## 3. Endpoint cho VPN/app

Tất cả require Bearer hoặc cookie role `friend`.

### `GET /api/vpn/config`

Trả cấu hình để app tạo NetworkExtension. Ví dụ rút gọn:

```json
{
  "ok": true,
  "ready": true,
  "server_ready": true,
  "account_ready": true,
  "config_ready": true,
  "uri": "vless://<uuid>@vn-hn.cldcode.host:23952?encryption=none&type=tcp&security=none#Friend%201",
  "subscription_url": "/api/sub/<token>",
  "experimental_uri": null,
  "config": {
    "uuid": "<uuid>", "address": "vn-hn.cldcode.host", "port": 23952,
    "network": "tcp", "security": "none", "sni": "", "host": "", "path": "", "flow": "",
    "name": "Friend 1", "mtu": 1400
  },
  "full_tunnel": { "inbounds": [...], "outbounds": [...], "route": {...}, "dns": {...} },
  "profile_meta": { "profile": "tiktunnel-full-tunnel", "applies_to": "...", ... },
  "mode": "tcp"
}
```

- `uri` là nguồn sự thật; `config` là bản đã parse để điền `TunnelConfiguration`.
- `full_tunnel` là profile sing-box cho desktop/Android/macOS. **iOS dùng app NetworkExtension riêng**, không nạp file này; dùng `uri`/`config`.
- `server_ready` = tiến trình sing-box còn sống; `account_ready` = tài khoản còn hạn/mở/quota; `ready` = cả hai + có URI.

### `GET /api/vpn/status`

```json
{
  "ok": true,
  "server_ready": true, "account_ready": true, "config_ready": true,
  "tunnel_active": false, "last_traffic_at": null, "transport_observed": null,
  "used_bytes": 0, "remaining_bytes": 1073741824,
  "mode": "tcp", "public_endpoint": "vn-hn.cldcode.host:23952",
  "server_time": "2026-11-28T..."
}
```

`transport_observed` là `tcp` khi có traffic thật gần đây nhưng không có websocket, `ws` khi có websocket mở, `null` khi không có dữ liệu.

### `GET /api/vpn/metrics` (chỉ số thật)

```json
{
  "ok": true, "generated_at": "...", "scope": "server_observed",
  "active": true, "tunnel_open": false, "last_traffic_at": "...",
  "used_upload": 1234, "used_download": 5678, "used_bytes": 6912,
  "overhead_bytes": 96, "quota_bytes": 1073741824, "remaining_bytes": 1073773312,
  "up_bps": 683, "down_bps": 1365, "total_bps": 2048,
  "rate_window_ms": 6000, "rate_source": "traffic_usage",
  "sessions": [ { "id": 1, "started_at": "...", "upload_bytes": ..., "status": "..." } ],
  "speedtests": [ ... ],
  "server": { "api_latency_ms": 1.23, "reachable": true, "mode": "tcp" },
  "note": "..."
}
```

Ý nghĩa chỉ số:

| Trường | Nguồn thật | Ghi chú |
|---|---|---|
| `used_upload`, `used_download`, `used_bytes` | `SUM(traffic_usage)` | **Được quy đổi quota**, trung hòa với app. |
| `overhead_bytes` | VLESS header được đếm riêng | Không tính vào byte người dùng. |
| `up_bps`, `down_bps`, `total_bps` | `traffic_usage` trong cửa sổ 6 giây | Không giả lập, cập nhật mỗi ~2s (chu kỳ flush). |
| `active` | Có traffic trong **60s gần nhất** | Không phải "đã bấm Connect". |
| `tunnel_open` | WebSocket đang mở | Với public TCP luôn `false`; dùng `active` để hiển thị. |
| `last_traffic_at` | `last_seen`/WS traffic gần nhất | `null` nếu chưa từng có traffic. |
| `sessions` | `connection_sessions` | Lịch sử phiên có bytes thật. |
| `server.api_latency_ms` | Trung bình `onResponse` 200 request gần nhất | Chỉ đo API, không đo băng thông VPN. |

**Server KHÔNG thể đo được** (đừng hiển thị như thể có): CPU/RAM của tiến trình tunnel trên iOS, packet loss/retransmit của NetworkExtension, hóa đơn của Viettel/TikTok, "đã reconnect thành công" nếu chưa có byte nào đi qua. Các giá trị đó phải lấy từ `TunnelMetrics` trên device hoặc ghi rõ là không có sẵn.

### Endpoint đã có, dùng được ngay

| Endpoint | Dùng cho Swift model |
|---|---|
| `GET /api/friend/me` | `FriendMe`, `FriendUser` (quota, exhausted, used bytes) |
| `GET /api/friend/live` | `FriendLive` (`active`, `used_bytes`, `remaining_bytes`, `up_bps`, `down_bps`) |
| `GET /api/friend/usage/summary` | tổng hợp ngày/tuần/tháng theo source |
| `GET /api/friend/import?device=<id>` | `ImportResponse` (URI, subscription, links, fallback) |
| `GET /api/friend/profile?device=<id>` | full-tunnel sing-box JSON |
| `GET /api/friend/speedtests?limit=&offset=` | `SpeedtestsResponse` |
| `GET /api/net/ping` | đo RTT API (`{ ok, t, ip }`) |
| `GET /api/net/download?bytes=...`, `POST /api/net/upload` | speed test thật (tối đa 8MB/2MB) |
| `POST /api/friend/devices/register` | đăng ký device; Bearer không cần CSRF |
| `GET /api/notifications` | thông báo quota/device mới |

## 4. Gợi ý cho app (hiệu năng & đúng dữ liệu)

- Dùng Bearer cho mọi request; lưu token trong Keychain, không UserDefaults. refresh khi `401 invalid_refresh`/hết hạn.
- Giữ HTTP keep-alive (server `keepAliveTimeout=72s`, `connectionTimeout=30s`). Không mở connection mới cho mỗi poll.
- Poll: `/api/friend/live` mỗi 1s là được; `/api/vpn/metrics` mỗi 5–10s là đủ vì cửa sổ tốc độ 6s. `/api/net/ping` mỗi 10 tick như hiện tại.
- Chọn URI `mode=tcp` (`/api/vpn/config.uri`) cho public port 23952: không TLS, không WebSocket — **nhanh nhất**. Chỉ dùng WS khi có reverse proxy TLS. Không bật `permessage-deflate`.
- Không tự quy đổi byte giữa server và carrier; dùng `used_bytes` server làm số liệu quota, hiển thị số liệu carrier ở mục riêng nếu có.
- Không coi `tunnel_active=false` là "mất kết nối" nếu app vừa connect nhưng chưa có traffic; hiển thị trạng thái local của NetworkExtension cho phần đó.

## 5. Chuẩn bị bỏ web

- Mặc định web vẫn bật. Tắt bằng một trong hai cách:
  - `config/control.json`: `"web_enabled": false`
  - env: `TIKTUNNEL_DISABLE_WEB=1`
- Khi tắt, `/`, `/admin`, `/friend`, `/style.css`, `/app.js`, ... trả `404 { ok:false, error:"web_disabled" }`.
- `/health`, `/api`, `/api/*` và VLESS port mux **không bị ảnh hưởng**. Admin API vẫn chạy để quản lý account.
- Khi app đã ổn định, có thể xóa thư mục `web/` và các route static trong `control/server.js`; không cần đổi API.

## 6. Tương thích với code hiện tại của repo app

`APIClient.swift` + `Models.swift` đọc trực tiếp các field snake_case ở trên qua `JSONDecoder.convertFromSnakeCase`. `AuthService.restoreSession()` gọi `/api/auth/me` với Bearer → trả `role`, `expires_in`, `csrf:null` (app bỏ qua csrf rỗng). Các bước fallback cookie cũ vẫn hoạt động song song.

Test hợp đồng: `npm run test:app` (cần `npm test` chạy trước để có credential mẫu). Kết quả ghi tại `reports/runtime/app-api-tests.json`.
