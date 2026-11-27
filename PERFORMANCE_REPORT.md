# PERFORMANCE_REPORT.md

Ngày đo: 2026-11-27. Công cụ: `node tests/network-benchmark.js` (endpoint thật, client loopback). Mọi số liệu là đo lường, không ước lượng.

## 1. Baseline (trước nâng cấp, sing-box config nguyên trạng)

| Lần | API RTT median | Download median (4 × 1 MiB) | TCP 1.1.1.1 | TCP 8.8.8.8 | TCP public host | CPU host | RAM |
|---|---|---|---|---|---|---|---|
| 1 | 0.92 ms | 1350.43 Mbps | 2.13 ms | 2.24 ms | 5.80 ms | 61.37% | 2.65 GB |
| 2 | 0.94 ms | 1233.17 Mbps | 2.13 ms | 2.07 ms | 3.21 ms | 63.45% | 2.64 GB |

## 2. Sau nâng cấp (cùng cấu hình sing-box, đã thêm endpoint/DB/UI)

| API RTT median | Download median | TCP 1.1.1.1 | TCP 8.8.8.8 | TCP public host | CPU host | RAM |
|---|---|---|---|---|---|---|
| 0.82 ms | 1488.46 Mbps | 2.01 ms | 2.69 ms | 60.78 ms | 36.62% | 2.74 GB |

## 3. Đọc kết quả

- API RTT giảm ~0.10 ms (trong noise của loopback); download tăng ~12% so với median baseline — **không coi là cải thiện nhân tạo**, cùng một host, cùng luồng; biến thiên giữa các lần chạy là bình thường.
- TCP tới `1.1.1.1`/`8.8.8.8` ổn định 2–3 ms (egress tốt). Public host tăng từ 3–6 ms lên 60.78 ms ở lần sau → **dao động mạng/Cloudflare**, không phải thay đổi code; không khẳng định cải thiện độ trễ Internet.
- CPU/RAM trong báo cáo là giá trị tích luỹ từ lúc process start, không phải tải tức thời trong lúc đo; không dùng để kết luận tối ưu CPU.
- Mục tiêu <100 ms: đạt với probe TCP từ server tới 1.1.1.1/8.8.8.8. **Không cam kết** độ trễ client→Shadowrocket→Cloudcode→server vì chưa có phép đo từ iPhone và WS public đang trả 404.

## 4. Quyết định tối ưu

| Hạng mục | Quyết định | Lý do |
|---|---|---|
| DNS sing-box (`local`) | Giữ nguyên | Đổi DNS không có bằng chứng đo được cải thiện; có thể làm hỏng resolve public host |
| WS path / transport | Giữ nguyên | `?d=` bị sing-box encode thành `%3F`; đã chuyển sang `<token>.<device>` mà không đụng transport |
| Kernel/sysctl/MTU | Không đổi | Cần root; không đo được MTU path một cách hợp lệ trong env này |
| Log level | `warn` (đã có) | Giảm log không cần thiết |
| Polling UI | 5s (từ 2s) | Giảm tải API/DB trên iPhone mà vẫn đủ "real-time" |
| Lịch sử | giới hạn 100/user, phân trang | Tránh phình DB/RAM |
| Speed test | tách route, bodyLimit, rate limit | Không ảnh hưởng API quản trị |

Không áp dụng tham số "tuning" mù; mọi thay đổi đều có baseline/after ở trên.

## 5. Độ tin cậy đo lường

- Download/upload dùng `arrayBuffer` thật và ghi thời gian `performance.now()` ở client; server chỉ phát/ghi nhận byte, không trả số tốc độ giả.
- Ping lấy 8 mẫu; timeout/lỗi đếm vào packet loss.
- `npm test` 34/34 PASS; `tests/device-activity-test.js` 7/7 PASS (8 MiB qua sing-box thật).

## 6. Blocker còn lại

- WS upgrade qua `https://app-medium-1-ac2e.cldcode.host/vpn` trả HTTP 404 (`server: cloudflare`) → chưa đo được đường VPN thật từ Internet.
- Không có iPhone → chưa đo được latency/jitter/packet loss từ thiết bị và Shadowrocket.
- 30 phút stability test với 2 thiết bị thật chưa thực hiện được; chỉ có smoke test local E2E.
