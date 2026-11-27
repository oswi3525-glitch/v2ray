# SHADOWROCKET.md

**Important:** link được sinh đúng định dạng, nhưng đường public Cloudcode/Cloudflare **chưa được xác minh**. Chưa coi là VPN hoạt động cho tới khi WS upgrade qua HTTPS và kết nối iOS thành công. Xem `reports/cloudcode-audit.md`.

## Cấu hình được sinh ra

```
vless://<UUID>@app-medium-1-ac2e.cldcode.host:443
  ?encryption=none
  &type=ws
  &path=/vpn/<subscription-token>
  &host=app-medium-1-ac2e.cldcode.host
  &security=tls
  &sni=app-medium-1-ac2e.cldcode.host
#<display-name>
```

TLS được terminate tại Cloudflare / HTTPS tunnel. Đường dẫn `/vpn/<token>` dùng để xác thực WebSocket upgrade trong Node proxy. Mỗi friend có UUID và token riêng. Khi `vpn_mode: tcp`, URI chuyển sang TCP plaintext trên `public_tcp_host:public_tcp_port`.

## Deep link trên web panel

| Nút | Deep link | Hành vi |
|---|---|---|
| **Add to Shadowrocket** (chính) | `shadowrocket://subscribe?url=<encoded-sub-url>` | Mở app, tạo subscription và tự tạo các server bên trong |
| **Add single node** | `shadowrocket://add/<base64(vless-uri)>` | Mở app và tạo đúng 1 node VLESS |

Trước khi mở app, web panel **copy VLESS URI vào clipboard** để dự phòng. Nếu iOS không mở được custom scheme, dùng **Copy VLESS URI** → Shadowrocket → `+` → **Import from Clipboard**, hoặc mở subscription URL trong Safari.

Lưu ý: navigation tới custom scheme được tạo đồng bộ bằng phần tử `<a>` trong cùng user gesture — không `fetch` trước khi mở app (iOS Safari chặn custom scheme sau `await`).

Tổng số account: Admin + tối đa `MAX_USERS` friend (mặc định 3).

## Nhập thủ công trên iPhone

1. Cài Shadowrocket từ App Store.
2. Copy VLESS URI (hoặc subscription URL) trong dashboard.
3. Shadowrocket → `+` → **Import from Clipboard** (hoặc thêm subscription với URL).
4. Kiểm tra: Type VLESS, Address/SNI/Host `app-medium-1-ac2e.cldcode.host`, Port `443`, Network WebSocket, Path `/vpn/<token>`, Security TLS.
5. Lưu, bật connect, mở `https://www.apple.com` trong Safari để verify.

## Cần xác minh trước khi triển khai

- Cloudcode chuyển HTTPS subdomain tới app port 23952.
- WebSocket Upgrade được pass qua (hiện probe trả Cloudflare 404).
- Thiết bị iOS resolve/connect và reconnect sau khi đổi Wi-Fi ↔ 4G/5G.
- Kiểm tra DNS leak trên thiết bị (check server-side là chưa đủ).

## Không nên

- Không đưa mật khẩu web vào VLESS URI.
- Không dùng chung UUID giữa các friend.
- Không tắt xác thực chứng chỉ TLS.
