# SHADOWROCKET_IMPORT.md

## Cấu hình đang được sinh ra (đã xác minhLocal)

```
vless://<UUID riêng>@vn-hn.cldcode.host:23952?encryption=none&type=tcp&security=none#<tên>
```

- Subscription: `http://vn-hn.cldcode.host:23952/api/sub/<token>` (base64 mặc định; `?raw=1` → plain URI).
- Deep link node: `shadowrocket://add/<vless-uri>` (theo handbook LOWERTOP: `shadowrocket://add/{url}`).
- Deep link subscription: `sub://<base64(sub-url)>#<remark>` (chuẩn đã được 3x-ui issue #4441 / commit 990bca1 xác nhận).
- File fallback: `/api/friend/export` → `.txt` chứa 1 link VLESS, dùng Shadowrocket → `+` → Import From File.

## Tại sao không còn dùng WSS

Đo trực tiếp:
- `https://app-medium-1-ac2e.cldcode.host/` + `/health` + `/vpn/<token>` đều **404** (`server: cloudflare`).
- Trên `vn-hn.cldcode.host:23952`, thêm header `Upgrade: websocket` → kết nối bị đóng ngay; local cùng request → `101 Switching Protocols`.

⇒ Cloudcode reverse proxy **không hỗ trợ WebSocket Upgrade** và HTTPS host không forward tới app. VLESS/WSS không thể hoạt động. Chuyển sang VLESS TCP trên đúng port public đã chứng minh truyền raw TCP (`GET /health` → 200).

## Kiến trúc port 23952

```
Shadowrocket --VLESS TCP--> vn-hn.cldcode.host:23952
    --> [port-mux] --HTTP--> 127.0.0.1:23950 (Fastify: dashboard/API/subscription)
    --> [port-mux] --VLESS--> 127.0.0.1:23955 (sing-box VLESS TCP inbound)
```

Mux đọc UUID trong 17 byte đầu của header VLESS để gán user và ghi lưu lượng thật vào DB (`traffic_usage`) mỗi 2s + lúc đóng kết nối. Không đổi port/host public.

## Hạn chế quan trọng

- Endpoint `vn-hn.cldcode.host:23952` hiện là **deployment khác DB/admin**. URI/UUID tạo ở workspace này không tồn tại ở đó → Shadowrocket báo “URL máy chủ gặp sự cố...”. Xem `CONNECTIVITY_AUDIT.md` mục 1 và 10.
- Không có TLS trên endpoint TCP (security=none). Chứng chỉ Cloudflare hợp lệ nhưng không route tới app; `vn-hn:443` là openresty lạ. Không tự đổi hostname/port khi chưa xác minh.
- Chế độ TCP không mang device ID trong path (client không gửi tham số tuỳ biến) → Device Activity trống cho kết nối TCP; không tạo dữ liệu giả.
- Không tự động bật VPN. Giữ nguyên bước người dùng xác nhận thêm server trong Shadowrocket. UI chỉ báo “đang mở/chờ xác nhận”.

## Kiểm thử

| Hạng mục | Kết quả |
|---|---|
| VLESS TCP qua mux, 8 MiB thật | PASS (`200 8388608`) |
| UUID riêng từng account, auth thật (đúng mở kết nối / sai bị đóng) | PASS (Diagnostics) |
| URI sinh ra đúng host/port/type/security | PASS (E2E) |
| Subscription base64/raw + chặn account exhausted | PASS (E2E) |
| Deep link đúng định dạng | PASS (E2E) |
| Import/xác nhận/kết nối trên iPhone thật | **CHƯA TEST** — không có thiết bị |
| Subscription trên endpoint public | **FAIL 404** — deployment khác DB (đã đo) |
