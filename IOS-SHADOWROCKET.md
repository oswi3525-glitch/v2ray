# iOS / Shadowrocket — hướng dẫn nhập cấu hình

**Trạng thái:** cấu hình được sinh ra là VLESS-over-WebSocket/TLS trên cổng 443 tại `app-medium-1-ac2e.cldcode.host`. Đường public (Cloudcode/Cloudflare) **chưa được xác minh** ở môi trường hiện tại — xem `reports/cloudcode-audit.md`. Không coi là VPN hoạt động cho tới khi WS upgrade qua HTTPS hoạt động và đã test trên thiết bị thật.

## Cách nhập nhanh từ web panel

Đăng nhập tài khoản friend → thẻ **Kết nối**:

1. **Add to Shadowrocket** — mở app qua `shadowrocket://subscribe?url=<subscription-url-encoded>` và tự tạo server từ subscription. Đây là cách dùng chính.
2. **Add single node** — mở `shadowrocket://add/<base64(vless-uri)>` và tạo đúng 1 node.
3. **Export file (.txt)** — tải file chứa 1 link VLESS. Mở Shadowrocket → `+` → **Import From File** → chọn file để thêm server.
4. URI VLESS cũng được **tự động copy** khi bấm. Nếu app không mở: mở Shadowrocket → `+` → **Import from Clipboard**.

Admin có các nút tương tự trong thẻ **Add to Shadowrocket** (chọn account trước).

## Subscription URL

`/api/sub/<token>` — base64 theo chuẩn subscription; `?raw=1` trả về plain VLESS URI. URL đầy đủ là `https://<public_https_host>/api/sub/<token>`. Coi URL này như mật khẩu: ai có URL thì dùng được account đó.

## Nhập thủ công trên iPhone

1. Mở Shadowrocket → `+`.
2. Chọn **Type: VLESS**.
3. Điền theo cấu hình VLESS URI:
   - Address / Host / SNI = `app-medium-1-ac2e.cldcode.host`
   - Port = `443`
   - UUID = UUID riêng của tài khoản (không chia sẻ)
   - Network = **WebSocket**, Path = `/vpn/<subscription-token>`, Host header = `app-medium-1-ac2e.cldcode.host`
   - Security = **TLS** (không bật “Allow Invalid Certificates”)
4. Lưu, bật switch kết nối, mở `https://www.apple.com` trong Safari để kiểm tra.
5. Chuyển Wi-Fi ↔ 4G/5G và kiểm tra kết nối phục hồi (cần thiết bị thật).

## Lưu ý bảo mật

- Mỗi user một UUID và một subscription token riêng; không dùng chung.
- Revoke account (`DELETE /api/admin/users/:id`) sẽ vô hiệu hoá cả UUID lẫn subscription ngay lập tức.
- Không đưa mật khẩu đăng nhập web vào VLESS URI.
- Dùng VPN có thể làm thay đổi cách nhà mạng tính cước; dự án không khẳng định miễn phí data.
