# NETWORK_TEST.md

Trang **Network Test** trong Friend Dashboard đo bằng dữ liệu thật tới endpoint của TikTunnel. Không dùng số ngẫu nhiên, không dùng tốc độ VPS thay cho tốc độ thiết bị.

## 1. Chỉ số và cách tính

| Chỉ số | Nguồn | Công thức |
|---|---|---|
| Ping | 10 request `GET /api/net/ping`, bỏ mẫu đầu (lạnh) | `median(samples[1..])` ms |
| Jitter | các mẫu còn lại | trung bình `abs(sample[i] - sample[i-1])` (IPDV giữa 2 mẫu liên tiếp) |
| Packet loss | số request timeout/lỗi | `lost / 10 * 100` |
| Download | 1 chunk khởi động + 5 chunk `GET /api/net/download?bytes=1048576` | `median(bytes * 8 / elapsed / 1e6)` Mbps; đối chiếu `X-Payload-Bytes` |
| Upload | 1 chunk khởi động + 5 chunk `POST /api/net/upload` (256 KiB random bytes) | `median(bytes * 8 / elapsed / 1e6)` Mbps |
| Test duration | `performance.now()` từ READY → COMPLETED | giây |
| Test server | cố định `TikTunnel endpoint` | — |

Gauge SVG và đường biểu diễn cập nhật theo từng chunk (không chỉ	result cuối). STATE: `IDLE → READY → PING_TEST → DOWNLOAD_TEST → UPLOAD_TEST → COMPLETED / FAILED`; có `START`, `STOP` (AbortController), `TEST AGAIN`.

## 2. Giới hạn dữ liệu & an toàn

- Download tối đa **8 MiB/request** (mặc định 1 MiB), upload **2 MiB/request**; bài test truyền ~6 MiB tải + 1.5 MiB gửi (đã tính cả chunk khởi động, vẫn trừ vào quota nếu đi qua VPN). Payload server được cache theo kích thước để không tốn CPU tạo lại mỗi lần.
- Rate limit: ping 120/phút, download 30/phút, upload 30/phút, lưu kết quả 20/phút.
- Modal cảnh báo trước khi bắt đầu: "~7.5 MB, sẽ trừ vào quota nếu đi qua VPN".
- UI hiển thị dung lượng đã dùng của chính bài test (tải/gửi riêng).
- Lịch sử tối đa 100 bản ghi/user (`purgeSpeedTests`), API phân trang `limit/offset`.
- Endpoint chạy trong cùng process Fastify nhưng tách route, bodyLimit riêng; không làm thay đổi API quản trị.

## 3. Direct vs VPN — trung thực

- Mặc định chọn `VPN`. Tuy nhiên **không có cách xác minh tunnel qua HTTP** trong kiến trúc này (TLS terminate ở Cloudflare, request browser không mang bằng chứng đi qua VLESS WS).
- Vì vậy kết quả được lưu với `verified=false` và UI gắn nhãn "chưa xác minh"; chú thích rõ: chỉ gọi là VPN test khi người dùng đã bật Shadowrocket. Không tự gắn nhãn VPN đã xác minh.
- `Direct` đo đường đi hiện tại của thiết bị tới endpoint (nếu VPN tắt thì là Internet trực tiếp).

## 4. Lịch sử

Lưu: `ts`, `mode`, `verified`, `ping_ms`, `jitter_ms`, `packet_loss_pct`, `download_mbps`, `upload_mbps`, `bytes_used`, `duration_s`, `server`. Xem tại tab **Data Usage**; admin tại `/api/admin/speedtests`.

## 5. Kết quả đo thực tế (2026-11-27)

Loopback tới endpoint control (không phải iPhone):

| Lần | API RTT median | Download median | CPU host | RAM |
|---|---|---|---|---|
| Trước 1 | 0.92 ms | 1350.43 Mbps | 61.37% | 2.65 GB |
| Trước 2 | 0.94 ms | 1233.17 Mbps | 63.45% | 2.64 GB |
| Sau | 0.82 ms | 1488.46 Mbps | 36.62% | 2.74 GB |

E2E xác nhận endpoint tải đúng 262144 byte và upload nhận đúng 131072 byte; lưu lịch sử và đọc lại đều PASS.

## 6. Chưa thể kiểm thử

- Ping/jitter/loss từ iPhone qua mạng di động/Wi-Fi thật.
- So sánh trực tiếp VPN ON/OFF trên cùng thiết bị (cần iPhone + Shadowrocket đã connect).
- Tốc độ Internet tổng quát (endpoint là server TikTunnel, không phải speedtest.net) — UI ghi rõ điều này.
- Cloudflare WS 404 hiện chặn đường VPN public; xem `SHADOWROCKET_IMPORT.md`.
