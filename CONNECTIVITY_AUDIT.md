# CONNECTIVITY_AUDIT.md

Ngày: 2026-11-27. Mọi số liệu trong báo cáo này là kết quả đo/thử trực tiếp từ workspace `/workspaces/v2ray`. Không dùng dữ liệu giả, không tự nhận WORKING khi chưa có bằng chứng.

## 1. Nguyên nhân chính xác lỗi Shadowrocket

**Lỗi hiển thị:** “URL máy chủ gặp sự cố, vui lòng thử lại sau...”

Có **3 lớp lỗi độc lập**, đã chứng minh bằng probe trực tiếp:

| Lớp | Bằng chứng đo được | Kết luận |
|---|---|---|
| Endpoint public là deployment **khác DB** | `vn-hn.cldcode.host:23952/health` uptime tăng liên tục 1123→1135s trong lúc app local có uptime 54→66s. Login admin bằng `.env` local → **401**; login 2 friend bằng password local → **401**; `/api/sub/<token local>?raw=1` → **404** (token random cũng 404). `boot-guard.js` hash trùng nhau (cùng code từ git) nhưng DB khác. | UUID/token sinh ra ở workspace này **không tồn tại** trên server public. Shadowrocket xác thực VLESS bằng UUID → bị từ chối → báo lỗi máy chủ. Đây là nguyên nhân chính. |
| HTTPS/Cloudflare không forward | `https://app-medium-1-ac2e.cldcode.host/`, `/health`, `/api/sub/...`, `/vpn/<token>` (kèm header Upgrade) đều trả **HTTP 404**, `server: cloudflare`. | Cấu hình VLESS WSS cũ (`security=tls`, port 443, host này) **không thể** kết nối. |
| Forwarder TCP chặn WebSocket | Trên `vn-hn.cldcode.host:23952`: `GET /health` → 200; cùng request có `Connection: Upgrade` → 200; thêm `Upgrade: websocket` → **empty reply / socket hang up** (lặp 3 lần). Local `127.0.0.1:23952` cùng request → **101 Switching Protocols**. Raw binary gửi tới public vẫn tới Fastify (400 Bad Request giống hệt local) → đây là forward truyền raw TCP nhưng **loại bỏ/không hỗ trợ Upgrade**. | WS/VLESS-WS không dùng được trên hạ tầng Cloudcode này. |
| TLS | Cloudflare `app-medium...:443`: TLSv1.3, CN `cldcode.host`, issuer Google Trust Services WE1, hạn `2027-01-24`, `authorized=true` — chứng chỉ hợp lệ nhưng **không route tới app**. `vn-hn.cldcode.host:443` là openresty, TLS báo `TLSV1_UNRECOGNIZED_NAME`, không phải dịch vụ của dự án. Port `8443` của Cloudflare handshake failure. | Không có TLS hợp lệ kết thúc tại endpoint VPN đang dùng. Không thể tự cấu hình reverse proxy (không có quyền host). |
| DNS/IPv4/IPv6 | `app-medium...` → 104.21.79.114 / 172.67.170.130 + 2 AAAA (Cloudflare). `vn-hn...` → 117.5.211.146 (chỉ IPv4). TCP443 public ~4–5 ms; TCP23952 public ~51–62 ms. | IPv6 chỉ có ở Cloudflare host (không dùng được); endpoint VPN là IPv4 đơn thuần. |
| sing-box/port | `127.0.0.1:23954` (WS inbound) và `127.0.0.1:23955` (TCP inbound) cùng listen; Fastify chuyển về `127.0.0.1:23950`; multiplexer giữ public `0.0.0.0:23952`. Không xung đột cổng. | Hạ tầng local đúng; public vẫn là instance khác. |

**Kết luận:** dashboards đẹp hay không không liên quan. VLESS URI trỏ tới một server không chứa tài khoản của người dùng. Không thể sửa bằng cách đổi UUID hay tinh chỉnh TLS ở workspace này; phải triển khai code + DB/account này trên đúng host public (xem mục 10).

## 2. File đã thay đổi

- `config/control.json`: thêm `app_internal_port`, `vless_tcp_port`, `public_transport: "tcp"`, giữ `app_port: 23952`.
- `server/render-control-config.js`: phát ra **2 inbound** (WS loopback 23954 + VLESS TCP loopback 23955) với cùng UUID.
- `control/port-mux.js` (mới): multiplexer trên 23952 — HTTP → Fastify nội bộ, byte VLESS → sing-box TCP; đếm byte và ghi `traffic_usage` theo UUID.
- `control/server.js`: listen nội bộ; sinh URI VLESS TCP public; subscription URL dùng public TCP; thêm `/api/diagnostics/run`; mode overview đúng `tcp`.
- `control/diagnostics.js` (mới): 9 hạng mục kiểm tra thật.
- `scripts/common.sh`, `start.sh`, `stop.sh`, `watchdog.sh`, `health-check.sh`: quản lý tiến trình multiplexer.
- `web/app.js`, `web/style.css`: tab Network Diagnostics và ghi chú giới hạn device ID ở chế độ TCP.
- `tests/control-test.js`: chuyển client E2E sang VLESS TCP qua mux; thêm checks import/diagnostics.
- `.env`, `config/env`, `.env.example`: `MAX_USERS=2` theo yêu cầu (DB hiện có đúng 2 friend, không xoá ai).
- Tài liệu: `README.md`, `ARCHITECTURE.md`, `CHANGELOG.md`, `API.md`, `SHADOWROCKET_IMPORT.md`, `DEVICE_ACTIVITY.md`, `PERFORMANCE_REPORT.md`, `SECURITY_AUDIT.md`, `UI_UX_REPORT.md`, `CONNECTIVITY_AUDIT.md`.

## 3. Lỗi đã khắc phục

1. **Không có đường VLESS dùng được trên Cloudcode** → thêm inbound VLESS TCP + multiplexer cùng port 23952. Đã chạy thật **8 MiB** qua sing-box client (local) với `200 8388608`.
2. **Mất quota accounting khi dùng TCP** → mux đọc UUID từ 17 byte đầu của header VLESS, ánh xạ tới user, ghi byte mỗi 2s và lúc đóng. E2E xác nhận delta `8388767B`.
3. **Không có cơ chế tự chẩn đoán** → 9 checks thật, trả status/thời gian/nguyên nhân/cách sửa; các mục không chứng minh được trả `UNKNOWN`.
4. **WS Upgrade bị chặn** → không còn dùng WS làm transport public; vẫn giữ WS nội bộ để test/local.
5. **Mode hiển thị sai** (`ws` dù public dùng TCP) → đã đồng bộ.
6. **MAX_USERS=3** trái yêu cầu → `2`.
7. Bug `timed()` và version byte VLESS (`0x00`, không phải `0x01`) trong diagnostics → tự phát hiện khi test, đã sửa.

## 4. Cấu hình VLESS thực tế đang sinh ra

```
vless://<UUID riêng của account>@vn-hn.cldcode.host:23952?encryption=none&type=tcp&security=none#<tên>
```
Subscription: `http://vn-hn.cldcode.host:23952/api/sub/<token>` (base64 mặc định, `?raw=1` trả URI plain).
Public transport = **TCP plaintext**; không TLS vì không có endpoint TLS nào chuyển tiếp tới ứng dụng này. UUID mỗi account một cái, không chia sẻ; không đưa mật khẩu web vào URI.

## 5. Khả năng tương thích Shadowrocket

- Shadowrocket hỗ trợ VLESS + `type=tcp` + `security=none`; deep link `shadowrocket://add/<vless-uri>` và subscription `sub://<base64>#remark` đều có nguồn (xem `SHADOWROCKET_IMPORT.md`).
- Luồng vẫn dừng ở **hộp thoại xác nhận thêm server trong app** — không tự động bật VPN; UI không báo "đã thêm" khi mới chỉ mở app.
- **Chưa test trên iPhone thật**: không có thiết bị. Không khẳng định one-tap đã hoạt động trên iOS.
- Với endpoint hiện tại (DB khác), import có thể tạo node nhưng **sẽ không kết nối** cho tới khi account/UUID được deploy đúng host.

## 6. Khả năng chạy trên mạng Viettel

| Tình huống | Kết quả |
|---|---|
| A. Viettel có gói Internet thường | Về mặt giao thức: VLESS TCP tới `vn-hn.cldcode.host:23952` là kết nối TCP/IP thường, không cần port 443 hay TLS. Tuy nhiên không có thiết bị Viettel để đo; end-to-end **chưa kiểm thử**. |
| B. Viettel gói TikTok, không có data thường | **Không có bằng chứng** gói này cho phép kết nối tới endpoint VPN. Lưu lượng VLESS đi tới IP `117.5.211.146:23952`, không phải domain/IP của TikTok; thường **không thuộc phạm vi ưu đãi** và có thể bị tính cước hoặc chặn. Không tuyên bố "Internet miễn phí". |
| C. Wi-Fi | Không test được từ workspace; logic kết nối không phụ thuộc Wi-Fi. |
| D. Di động không có VPN | Shadowrocket là VPN client; nếu nhà mạng chặn VPN hoặc require auth tunnel thì không dùng được. Không đo được ở đây. |

Không thực hiện giả mạo SNI/Host/DNS/domain fronting, không ngụy trang lưu lượng thành TikTok. Phương án hợp lệ: dùng gói Internet thông thường hoặc liên hệ nhà mạng để biết phạm vi ưu đãi.

## 7. Kết quả với gói TikTok đơn lẻ

**Chưa thể kiểm thử từ workspace này và không khẳng định hoạt động.** Lý do: (1) không có SIM Viettel/gói TikTok; (2) endpoint VPN không nằm trong danh sách ưu đãi đã biết; (3) không được phép giả mạo lưu lượng. Không có bằng chứng xác thực nào cho phép nói gói TikTok đơn lẻ dùng được TikTunnel.

Để có bằng chứng thật, đã thêm công cụ đo **từ chính thiết bị/SIM** (không phải từ server):

- Trang công khai `/plan-check` (files `web/plan-check.html`, `web/plan-check.js`), liên kết từ tab Shadowrocket trong dashboard.
- Cách dùng: mở trang trên điện thoại đang lắp SIM cần kiểm tra, **tắt VPN**, bấm “Chạy kiểm tra”.
- Các phép đo thật: (a) `https://www.tiktok.com/` (no-cors, đo thời gian phản hồi); (b) `https://example.com/` làm đại diện Internet thường; (c) `GET /health` trên endpoint TikTunnel; (d) DNS/TCP thô → **UNKNOWN**, vì trình duyệt không có API đo các lớp đó — không tự đánh dấu PASS.
- Kết luận tự động theo 4 hồ sơ: TikTok OK + Internet FAIL = gói TikTok đơn lẻ; nếu endpoint cũng FAIL → VPN **không dùng được** với gói này; nếu endpoint OK → **chỉ** chứng minh có kết nối, phạm vi tính cước vẫn chưa xác minh; có Internet thường → dùng được quy trình import bình thường.
- Công cụ **không** đổi SNI/Host/DNS, không ngụy trang lưu lượng thành TikTok, không bypass kiểm soát/tính cước; mọi kết luận đều kèm timestamp, thời gian phản hồi và thông báo rõ giới hạn.

Kết quả đo thực tế trên SIM Viettel/TikTok vẫn **chưa có** — cần người dùng chạy công cụ trên thiết bị thật. Không tuyên bố “Internet miễn phí”.

### Nghiên cứu điều khoản (nguồn công khai, cập nhật 23–27/10/2026)

| Nguồn | Nội dung liên quan |
|---|---|
| vietteldata.vn — T15K/T50K | “Data riêng cho TikTok · không có Data ngoài”; “Data TikTok chỉ dùng trong ứng dụng TikTok; mở link TikTok qua trình duyệt hoặc ứng dụng khác sẽ trừ Data thường.” |
| vietteldata.vn — MXH100 | Free TikTok/YouTube/Facebook trong app + 1GB/ngày data thường; lưu lượng ngoài app dùng data thường. |
| speednet.vn (23/11/2026) | MXH100 1GB/ngày + free MXH; MXH130 1.5GB/ngày + 20GB/hướng; MXH160 3GB/ngày + 30GB/hướng; “phát Wi-Fi … có người dùng thấy bị trừ data chung”. |
| 3gviettel.com.vn (04/05/2026) | Ưu đãi chỉ khi dùng **app chính thức từ App Store/Google Play**, SIM đăng ký gói, có sóng; phát Wi-Fi cho máy khác trừ data thường. |
| vienthonghue.com.vn (20/10/2026) | “Nên … **tắt chế độ VPN, vì kết nối qua VPN có thể khiến hệ thống không nhận ra lưu lượng thuộc ứng dụng được miễn phí**.” |
| 5gviettel.vn (19/12/2025) | Không có gói 5G TikTok vô hạn; miễn phí là data riêng có hạn (20–50GB), xem qua trình duyệt/phát Wi-Fi trừ data chung. |
| ungdung.toeic123.vn (01/10/2026) | “Khi đang bật VPN, nhà mạng có thể không nhận ra ứng dụng, dữ liệu sẽ tính như truy cập thường.” |

**Kết luận nghiên cứu:** mọi nguồn đều giới hạn ưu đãi ở **app TikTok chính thức trên máy lắm SIM**. Không có nguồn nào cho phép kết luận lưu lượng VPN TikTunnel được tính vào data TikTok. Bật VPN làm mất nhận diện ưu đãi. Do đó **không có phương án cấu hình hợp lệ** để TikTunnel chạy bằng gói TikTok đơn lẻ; chỉ có data thường (hoặc gói MXH có quỹ data thường) mới dùng được. Không thực hiện giả mạo SNI/Host/DNS/domain fronting.

## 8. Giới hạn do Cloudcode / nhà mạng

- Không có Cloudcode CLI/API/SSH/metadata trong workspace; không đổi được port mapping hay deploy lên host public.
- Forward 23952 truyền HTTP/raw TCP nhưng **không hỗ trợ WebSocket Upgrade**; không mở port public mới (theo yêu cầu).
- HTTPS host của Cloudflare trả 404 cho mọi route của app.
- Codespaces tunnel (`*.app.github.dev`) là HTTP tunnel có auth GitHub — không phải raw TCP, không dùng được cho VLESS.
- Workspace này là Codespaces (`CODESPACES=true`); `vn-hn.cldcode.host` là hạ tầng khác. Đây là blocker lớn nhất.

## 9. CPU / RAM / độ trễ đo được

Benchmark `tests/network-benchmark.js` sau thay đổi:
- API RTT median **1.30 ms** (loopback tới mux).
- Download median **655.23 Mbps** (4 × 1 MiB qua endpoint `/api/net/download`, thực byte).
- TCP server → 1.1.1.1:443 **2.26 ms**, 8.8.8.8 **2.84 ms**, public Cloudflare host **4.49 ms**.
- Host lúc đo: CPU **28.17%**, RAM **4.49 GB**.
- Real VLESS/TCP qua mux: `200 8388608` (8 MiB).
- Network Diagnostics chạy ~2.9s: PASS 5, FAIL 2 (ws, subscription), WARNING 1 (TLS), UNKNOWN 1 (client).

**Không tuyên bố ping <100 ms từ client**: chỉ có số đo từ server tới 1.1.1.1/8.8.8.8. Đường iPhone → Cloudcode → VPN → Internet chưa đo được.

## 10. Việc còn lại / blocker cần hành động trên host public

1. Triển khai **code đã push này** lên đúng Cloudcode instance đang phục vụ `vn-hn.cldcode.host:23952` (startup command trong `README.md` đã có `git reset --hard origin/main`).
2. Đảm bảo **cùng DB/account** (UUID + subscription token) được dùng ở instance đó — hiện tại instance đó có DB khác; đây là lý do trực tiếp gây lỗi Shadowrocket. Không commit DB/secret vào git.
3. Sau deploy: mở Dashboard → **Diagnostics**, chạy lại. Mục `subscription` phải chuyển sang PASS (HTTP 200, uuid_match=true); `ws` sẽ vẫn FAIL do nền tảng — bỏ qua vì public dùng TCP.
4. Trên iPhone: import lại URI/subscription mới, xác nhận trong Shadowrocket, bật VPN, truy cập `https://www.apple.com`; mục `client_connectivity` chỉ có thể xác nhận ở bước này.
5. Nếu vẫn lỗi, dùng Diagnostics (có timestamp + duration + cause + fix) thay vì đoán cấu hình.

**Trạng thái cuối:** đã sửa mọi thứ có thể sửa trong workspace này và chứng minh bằng test thật (E2E 36/36, Device Activity 7/7, 8 MiB VLESS TCP). Kết nối từ iPhone **chưa thể hoạt động** cho tới khi account/UUID được triển khai trên endpoint public đúng.
