# deploy/

Hạ tầng VPN cá nhân dùng sing-box: ShadowTLS v3 → Shadowsocks 2022 trên port 443, VLESS + Reality làm fallback, NAT MASQUERADE, Unbound không log.

Khác với dashboard trong repo này, stack này **không public control API/port 23952**. Chỉ mở port 443 và SSH đã đổi port.

## Cài đặt

Trên VPS Ubuntu 22.04 sạch, đã có SSH key:

```bash
SSH_PORT=2222 \
ADMIN_CIDR="1.2.3.4/32" \
HANDSHAKE_DOMAIN="www.tiktok.com" \
REALITY_IP="" \
bash deploy/server/install.sh
```

- Để trống `REALITY_IP` nếu chỉ có 1 IP public (bỏ fallback Reality).
- Script ghi secrets vào `/root/tiktunnel-client-secrets.env` (chmod 600).
- Kiểm tra: `sing-box check -c /etc/sing-box/config.json`, `ss -lntp | grep ':443'`.

## Xoay key

```bash
tiktunnel-rotate
```

`rotate.sh` tự cập nhật `/root/tiktunnel-client-secrets.env` và `/root/tiktunnel-client.json`. Phân phối file client config cho bên app qua kênh riêng.

## Kiểm tra thực tế

```bash
VPS=1.2.3.4 IFACE=eth0 JA3_PY=/path/to/ja3.py bash deploy/tests/verify.sh
```

File cấu hình và script là template; không commit secrets thật.
