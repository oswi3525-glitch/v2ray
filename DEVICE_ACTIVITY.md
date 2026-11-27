# DEVICE_ACTIVITY.md

## Mục tiêu

Ghi nhận thiết bị **thực sự dùng VPN**, không phải thiết bị chỉ đăng nhập web. Không suy đoán model/IMEI/thông tin nhạy cảm; không tạo bản ghi giả.

## 1. Định danh thiết bị

- Web tạo `device_id` ngẫu nhiên (`crypto.randomUUID()`, 32+16 hex) lưu trong `localStorage`, gửi qua `?device=<id>` cho `/api/friend/import`, `/api/friend/vpn`, `/api/friend/export`, `/api/sub/:token`.
- Backend đưa device id vào **WS path**: `/vpn/<subscription-token>.<device-id>`. Dùng `.` làm separator vì token là base64url (không chứa `.`), và sing-box mã hoá `?` thành `%3F` nên không dùng query string.
- Khi upgrade, Node tách token và device id, `upsertDevice()` (chỉ tạo khi có session thật), lưu `device_id` vào `connection_sessions`.
- Device name mặc định `''` (UI hiện "Chưa đặt tên"); người dùng tự đặt qua `PATCH /api/friend/devices/:id`. Không tự đoán tên thiết bị.

## 2. Trạng thái

| Trạng thái | Điều kiện |
|---|---|
| **Active** | Có traffic được ghi nhận trong 60 giây gần nhất (`deviceLastTraffic` hoặc `devices.last_traffic_at`) |
| **Idle** | Không có traffic gần nhưng vẫn còn session mở (`connection_sessions.ts_end IS NULL`) |
| **Offline** | Không session mở và không traffic gần, nhưng đã từng thấy |
| **Unknown** | Không đủ dữ liệu xác minh |

Traffic được ghi vào `devices.upload_bytes/download_bytes` theo delta thực từ frame WS (cập nhật mỗi 5s và lúc đóng), tránh đếm trùng với `connection_sessions`.

## 3. Dữ liệu lưu

`devices`: `id`, `user_id`, `name`, `first_seen`, `last_seen`, `last_traffic_at`, `upload_bytes`, `download_bytes`.
`connection_sessions` bổ sung `device_id`, `last_traffic_at`.
Không lưu IP thiết bị làm định danh (IP hiện tại là IP proxy/Cloudflare, không dùng được).

## 4. Endpoint & RBAC

| Endpoint | Quyền |
|---|---|
| `GET /api/friend/devices?limit&offset` | friend, chỉ device của mình |
| `PATCH /api/friend/devices/:id` | friend, CSRF, `WHERE id AND user_id=me` |
| `GET /api/admin/devices?limit&offset` | admin, mọi device |

Phân trang tối đa 50 (friend)/100 (admin). Friend đổi tên device người khác → 404 (đã test).

## 5. Test thực tế

`node tests/device-activity-test.js`: dùng sing-box SOCKS client thật + subscription token có device id, tải 8 MiB qua proxy, sau đó mở WS không traffic 62s, rồi đóng.

| Check | Kết quả |
|---|---|
| Không tạo device khi chưa có session | PASS |
| Device id nằm trong VLESS path | PASS |
| Traffic thật qua VPN (8 MiB) | PASS |
| Active sau khi có traffic | PASS (`down=8388767`) |
| Idle sau 62s không traffic nhưng session còn mở | PASS |
| Offline sau khi đóng kết nối | PASS |

**SUMMARY PASS=7 FAIL=0** — chi tiết `reports/runtime/device-activity.json`.

## 6. Giới hạn

- Device id là định danh do web tạo, **không phải số serial thiết bị**; nếu user mở web trên thiết bị khác thì có device id khác. Không tuyên bố nhận diện duy nhất phần cứng.
- Nếu client dùng subscription URL cũ (không có `?device=`) thì vẫn có session VPN nhưng device_id = null → không có bản ghi device. UI giải thích rõ.
- Không thể gán tên thiết bị tự động; cần người dùng đặt.
- Trạng thái Active có độ trễ tối đa ~5s do cập nhật traffic theo chu kỳ.
