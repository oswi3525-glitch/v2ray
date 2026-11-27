# SHADOWROCKET.md

**Important:** the generated link is valid in format, but the public Cloudcode path is NOT verified. Do not present it as a working VPN until external TCP/WS and iOS connection tests succeed.

## Generated link (target architecture)

```
vless://<UUID>@app-medium-1-ac2e.cldcode.host:443
  ?encryption=none
  &type=ws
  &path=/vpn/<subscription-token>   (dấu / được giữ nguyên, không mã hoá %2F)
  &host=app-medium-1-ac2e.cldcode.host
  &security=tls
  &sni=app-medium-1-ac2e.cldcode.host
#<display-name>
```

TLS is terminated at Cloudflare / the Cloudcode HTTPS tunnel. The path carries that user's subscription token; it authenticates the WebSocket upgrade in the Node proxy. Each friend has a unique UUID and token.

## Friend dashboard

Each friend logs in with their own username/password and sees only their own data:

- **Copy VLESS URI** — raw URI for manual import.
- **Copy subscription URL** — `/api/sub/<token>` returns base64 by default, `?raw=1` returns the plain URI.
- **Add to Shadowrocket** — attempts `shadowrocket://add/<base64(uri)>`; if iOS does not handle it, the UI shows a fallback hint after ~1 s. Use **Copy VLESS URI** then *Import from Clipboard*, or **Copy subscription URL** then add it as a subscription. The same button exists in the Admin dashboard per account. Total accounts = 4 (Admin + 3 friends).

## Manual import on iPhone

1. Install Shadowrocket from the App Store.
2. Copy the VLESS URI (or subscription URL) in the friend dashboard.
3. Open Shadowrocket → `+` → **Import from Clipboard** (or add a subscription with the URL).
4. Confirm fields: Type VLESS, Address `app-medium-1-ac2e.cldcode.host`, Port 443, Network WebSocket, Path `/vpn/<token>`, Host/SNI `app-medium-1-ac2e.cldcode.host`, Security TLS.
5. Save, toggle connect, then open `https://www.apple.com` in Safari and verify.

## Required verification before rollout

- Cloudcode forwards the HTTPS subdomain to app port 23952.
- WebSocket Upgrade is passed through (currently a probe returned Cloudflare 404 here).
- The iOS device can resolve/connect and reconnect after Wi-Fi↔4G/5G changes.
- DNS leaks are checked on the device (server-side DNS checks are not enough).

## Never do

- Do not put the web login password into the VLESS URI.
- Do not share one UUID among friends.
- Do not disable TLS certificate validation.
