# SHADOWROCKET_IMPORT.md

## 1. Cơ chế import được xác nhận (không tự bịa)

Nguồn đã kiểm tra:

- **LOWERTOP/Shadowrocket handbook** (community-maintained, dựa trên keyword list từ nhóm chính thức của Shadowrocket) — mục *URL-Schemes*: `shadowrocket://add/{url}` = "添加 订阅/节点" (thêm subscription/node); `shadowrocket://config/add/{url}` = cấu hình; `shadowrocket://connect` = bật tunnel. Handbook cũng ghi nhận import tự động từ clipboard khi có link `vless://`.
- **3x-ui issue #4441 + commit 990bca1** (maintainer, đã verify): `shadowrocket://add/` là deep link cho **single node**, không phải subscription; subscription dùng `sub://BASE64(url)#REMARK`; `encodeURIComponent(btoa(...))` làm hỏng payload.
- Nhiều hướng dẫn 2026 xác nhận `.txt` mỗi dòng một share link dùng được cho **Import From File**.

Kết luận: dùng hai cơ chế có nguồn, không dùng `shadowrocket://subscribe?url=` (không có trong handbook).

## 2. Lỗi cũ và nguyên nhân

| Lỗi | Nguyên nhân | Hậu quả |
|---|---|---|
| `shadowrocket://add/<base64(uri)>` | Payload bị base64 hoá; handbook dùng `{url}` trực tiếp | Shadowrocket không nhận node |
| `shadowrocket://subscribe?url=<encoded>` | Scheme không có trong handbook; 3x-ui chỉ ra `add/` chỉ dành cho node | Không mở hoặc không thêm subscription |
| `location.href` sau `await fetch()` | iOS Safari chặn custom scheme sau user gesture đã kết thúc | Không nhảy sang app |
| UI báo "Copied"/thành công ngay | Không có xác nhận từ app | Báo sai trạng thái |
| Path `path=/vpn/<token>` không có device id | Không phân biệt được thiết bị | Device Activity thiếu dữ liệu |

## 3. Cách sửa

Backend `GET /api/friend/import?device=<id>`:

1. `guard(req, reply, 'friend')` — session hợp lệ.
2. `accountReady(u)` — chưa revoke, enabled, chưa exhausted/quota vượt, expiry còn hạn.
3. Kiểm tra `processAlive(readPid('sing-box.pid'))` và user có trong `activeVpnUsers()`.
4. Sinh `vlessUri(u, deviceId)` với path `/vpn/<token>.<device-id>` (dùng `.` vì sing-box mã hoá `?` thành `%3F`).
5. Trả:
   - `links.node = shadowrocket://add/<vless-uri>` (raw VLESS URI, không base64).
   - `links.subscription = sub://<base64(subscription-url)>#<remark>` (base64 **không** percent-encoded).
   - `uri`, `subscription_url`, `fallback: {copy_uri, open_url, file_url}`, `ready`, `server_ready`.
6. Ghi `security_event` **không chứa UUID**.

Frontend: payload được nạp sẵn khi mở tab; nút bấm dùng `<a>` ẩn + `click()` **đồng bộ** trong user gesture. Nhãn trạng thái: "Đang mở Shadowrocket — hãy xác nhận trong app". Không báo đã thêm.

Fallback: Copy VLESS URI → Shadowrocket `+` → Import from Clipboard; mở subscription URL trong Safari; tải file `.txt` (`/api/friend/export`) → `+` → Import From File.

## 4. Cấu trúc VLESS được sinh ra

```
vless://<uuid>@app-medium-1-ac2e.cldcode.host:443
  ?encryption=none
  &type=ws
  &path=/vpn/<subscription-token>.<device-id>
  &host=app-medium-1-ac2e.cldcode.host
  &security=tls
  &sni=app-medium-1-ac2e.cldcode.host
#<display-name>
```

UUID riêng từng account; không chứa mật khẩu web. E2E kiểm tra `type=ws`, `security=tls`, host/port, và device id trong path.

## 5. Kiểm thử

| Hạng mục | Kết quả |
|---|---|
| Cấu trúc VLESS (UUID, address, port, TLS, SNI, transport, path) | PASS (E2E) |
| Subscription `/api/sub/:token` base64/raw + chặn account exhausted | PASS (E2E) |
| Backend sinh 2 deep link đúng định dạng | PASS (E2E: `shadowrocket://add/vless://...`, `sub://...`) |
| Mở Shadowrocket trên iPhone thật | **CHƯA TEST** — không có thiết bị |
| App nhận config/hộp thoại xác nhận | **CHƯA TEST** |
| Kết nối VPN thực từ iPhone | **CHƯA TEST** — WS upgrade public đang trả 404 |

## 6. Giới hạn

- Không cam kết one-tap hoạt động trên mọi phiên bản Shadowrocket; đã chọn cơ chế có nguồn nhưng vẫn cần test thiết bị thật.
- Nếu Cloudflare không forward WS, node import vẫn có thể thành công nhưng **không kết nối được**; đây là blocker hạ tầng, không sửa bằng UI.
- Không tự động bật VPN sau khi thêm server: handbook có `shadowrocket://connect`, nhưng gọi nó trước khi người dùng xác nhận có thể bật tunnel sai node; luồng hiện tại dừng ở màn hình xác nhận.
