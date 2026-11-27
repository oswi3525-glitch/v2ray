# TikTunnel - Experimental branch

## Overview

TikTunnel now has two independent branches:

- TikTunnel - Main: stable connection (unchanged).
- TikTunnel - Experimental: testing branch for SNI/Host/TLS/WS/VLESS/VMess.

Main configuration, UUIDs, ports, domains and protocol are not modified by Experimental.

## Enable / disable

Admin dashboard -> Experimental tab, or API:

```
POST /api/admin/experimental
{ "enabled": true, "server_address": "...", "server_port": 443, "protocol": "vless",
  "network": "ws", "tls_mode": "tls", "sni": "...", "host": "...", "ws_path": "/vpn" }
```

Rollback:

```
POST /api/admin/experimental/rollback
```

Rollback restores `backups/experimental-config.last.json`.

## Shadowrocket

Friend dashboard -> Experimental tab -> "Add Experimental to Shadowrocket" opens:

- `shadowrocket://add/<experimental-uri>` (single node)
- `sub://<base64(subscription-url)>#<remark>` (subscription)

Main import is unaffected: `/api/friend/import` and `/api/friend/import/experimental` are separate.

## Server architecture

When enabled and using the same VPS, render-control-config.js adds a separate inbound
`vless-experimental-in` on internal port 23956 with dedicated experimental UUIDs.
Main inbounds (23954, 23955) are unchanged. Rollback is handled by apply-control-config.sh
which backs up `config/sing-box.json` before applying.

## Experimental analyzer

`GET /api/experimental/analyze` performs real probes: DNS, TCP, TLS handshake, certificate
validation, SNI, HTTP Host header, WebSocket handshake, ping, packet loss, response time.
No simulated results are reported as real.

## Security

- Experimental does not auto-switch users.
- No firewall changes.
- Hostnames must be controlled/test-authorized.
