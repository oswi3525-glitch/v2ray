# UI_UX_REPORT.md

## Định hướng

Premium network dashboard: dark-first, có light mode, minimal, không lạm dụng gradient/animation, mobile-first, tối ưu Safari iOS. Dữ liệu thật và dữ liệu chưa xác minh luôn được phân biệt bằng nhãn.

## 1. Cấu trúc

**Admin (8 tab):** Overview · Users · Quota · Devices · Monitoring · Network · Security · Settings.
**Friend (6 tab):** Overview · Data Usage · Network Test · Devices · Shadowrocket · Settings.

Mỗi tab là một builder async; khi chuyển tab: chạy cleanup (clear interval/abort test) → skeleton → fetch → render → bind event → error state nếu lỗi. Không render toàn bộ page lại khi chỉ đổi tab.

## 2. Thành phần thiết kế lại

- Header: brand mark, role pill, username, Light/Dark toggle, Reload, Logout.
- Tab bar: ngang, cuộn được trên iPhone, active state rõ.
- Card/stat: border + shadow nhẹ, spacing nhất quán; `tabular-nums` cho số liệu.
- Thanh quota: fill đổi màu theo ngưỡng 75%/90%; live speed cập nhật mỗi 5s.
- **Gauge tốc độ**: SVG arc 251.3px + kim xoay -90°→+90°, số Mbps trung tâm, cập nhật theo từng chunk; paths màu theo ngưỡng.
- Network Test: mode toggle (VPN mặc định), 6 ô chỉ số, biểu đồ đường down/up, START/STOP/TEST AGAIN, modal cảnh báo ~5 MB.
- Devices: bảng trạng thái Active/Idle/Offline/Unknown, rename qua modal, empty state giải thích nguồn dữ liệu.
- Shadowrocket: badge "Sẵn sàng/Chưa sẵn sàng", nút one-tap + node + fallback copy/URL/file, details chứa URI thật.
- Loading skeleton, empty state, error state, toast, modal xác nhận, disabled button state, transition ngắn.

## 3. Trạng thái & dữ liệu

| Hiện thị | Ý nghĩa |
|---|---|
| `Active` | Có traffic VPN trong 60s gần nhất (có bằng chứng) |
| `Idle` | Còn session nhưng không traffic gần |
| `Offline` | Không session/traffic gần |
| `chưa xác minh` | Kết quả speed test ở chế độ VPN do người dùng khai báo, server không chứng minh được tunnel |
| `—` | Chưa có dữ liệu, không hiển thị số 0 giả |

Không có mock data, không có demo chart: mọi biểu đồ/đếm đều từ API thật.

## 4. Responsive / iOS Safari

- `@media(max-width:560px)`: live grid 1 cột, six-grid 2 cột, tabs cuộn ngang, padding giảm, nút đủ lớn để chạm.
- Deep link mở bằng `<a>` ẩn + `click()` **đồng bộ** trong user gesture (Safari chặn custom scheme sau `await`).
- `viewport-fit=cover`, `theme-color`, `-webkit-text-size-adjust:100%`.
- Không dùng `position:fixed` cho nội dung chính; toast/modal là layer riêng.

## 5. Performance UI

- Poll live 5s (giảm từ 2s), cleanup interval khi rời tab.
- Chart.js chỉ tạo khi có dữ liệu; giới hạn 40 điểm cho biểu đồ tốc độ.
- Không giữ lịch sử lớn trong RAM; API phân trang.
- Static assets `Cache-Control: no-store` + version query; nút Reload cache-bust.

## 6. Hạn chế UI

- Chart.js vẫn tải từ CDN (`cdn.jsdelivr.net`); nếu môi trường chặn CDN, biểu đồ không hiển thị nhưng số liệu vẫn hiển thị.
- Chưa kiểm thử trên iPhone Safari thật (không có thiết bị); đã thiết kế theo ràng buộc gesture/custom-scheme đã xác nhận từ tài liệu.
- Light mode được sinh bởi CSS variables, chưa có automated contrast audit.
