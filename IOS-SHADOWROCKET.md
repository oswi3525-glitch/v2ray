#IOS / Shadowrocket — Subscription Import

**Current status:** the generated subscription is a standard VLESS URI but it is configured as
`security=none` with `public_host=127.0.0.1`. It is intended for local testing only and **will not work from a phone**. Do not treat it as a usable VPN until TLS/REALITY and a reachable public host are configured (see CONFIGURATION.md).

## Get your subscription URL

Only the account owner (or admin) should receive it. After creating an account, the admin response contains `subscription_url`:

```
/api/sub/<long-random-token>
```

The full URL is `http://<server>:3000/api/sub/<token>` — the API must be reachable from the device and protected appropriately (ideally behind TLS). In this lab the API is loopback-only, so the subscription cannot be fetched from a phone at all.

The endpoint returns base64 by default (standard subscription format). `?raw=1` returns the plain VLESS URI, which can also be pasted directly.

## Import steps on iOS

1. Open **Shadowrocket** → top-right **+** (Add Node).
2. Choose **Type: VLESS**.
3. If using a subscription URL: tap the **Subscribe** / group icon, choose **Add Subscription**, paste the full `/api/sub/<token>` URL, set the remark, and tap **Done**. Then open the subscription group and select a node.
4. If using the raw URI: choose **Import from Clipboard** / paste into the link field; Shadowrocket will fill UUID, address, port and network settings automatically.
5. Verify fields:
   - Address = your server host (a domain when TLS is enabled)
   - Port = 8443
   - UUID = your personal UUID (never share it)
   - Network = TCP
   - Security = TLS with SNI = your domain (production) — currently `none` in this lab
   - Flow = `xtls-rprx-vision` if TLS/Xtls is enabled and the Shadowrocket version supports it; otherwise leave empty
6. Save, then toggle the switch to connect. Confirm the connected indicator and test `https://www.apple.com` in Safari.
7. On Wi-Fi → 4G/5G switch, confirm the connection recovers (this test requires a physical device and is SKIP in this environment).

## Privacy notes

- Each person gets a unique UUID and a unique subscription token. Never reuse or share them.
- If a friend loses access, revoke their account (`DELETE /api/users/:id`); their UUID stops working immediately.
- The subscription contains the UUID encoded in base64 — anyone with the subscription URL can use that account. Treat the URL like a password.
- This project does not claim any ISP zero-rating; using a VPN may change how traffic is billed by the mobile operator.
