# SECURITY.md

## Current security posture (lab)

| Control | Status |
|---|---|
| No root / sudo / system config changes | enforced |
| All runtime files under user-owned directory | enforced |
| Admin API authentication | Bearer token, constant-time comparison (`crypto.timingSafeEqual`) |
| Admin API exposure | bound to `127.0.0.1` only |
| Subscription endpoint | public by design, token is a 192-bit random `base64url` value |
| Rate limiting | 120 req/min public, 30 req/min admin, in-memory per IP |
| Input validation | names `^[A-Za-z0-9 ._-]{1,32}$`, ISO expiry, integer IDs, token regex |
| Max accounts | 3 active, hard cap |
| Secrets in logs | API logger disabled; audit events store only IDs/names; no UUID/token/key in logs |
| Secret files | `config/secrets.env`, `config/sing-box.json`, DB, subscriptions are chmod 600 and gitignored |
| Backup protection | archives created with umask 077 and chmod 600 |
| **VLESS transport security** | **NONE (`security=none`) — lab only. Traffic is unencrypted and unauthenticated on the wire beyond the UUID.** |
| TLS / REALITY | not deployable here (no domain/cert, no transparent inbound TCP) |

## Handling secrets

```bash
TOKEN="$(sed -n 's/^TIKTUNNEL_ADMIN_TOKEN=//p' config/secrets.env)"
```

Never paste the token, a UUID or a subscription URI into a shell command that echoes it, into logs, or into git. The test suite deliberately avoids printing them.

If the admin token is suspected leaked: edit `config/secrets.env`, set a new random value (`python3 -c 'import secrets;print(secrets.token_urlsafe(32))'`), then `./scripts/health-check.sh`. No service restart is required for the API to pick it up **only if** the API is restarted — run `./scripts/restart.sh`.

## Admin API separation

`/health` and `/api/sub/:token` are the only unauthenticated endpoints. All other `/api/*` routes require the admin bearer token. Do not expose port 3000 beyond loopback. If a public API is ever required, put it behind an authenticating reverse proxy with TLS; never remove the bearer check.

## Abuse considerations

- The service does not attempt to bypass ISP billing, TikTok zero-rating, or any provider policy. See [`reports/viettel-network-test.md`](reports/viettel-network-test.md).
- No TUN interface, no packet injection, no firewall rules, no routing table changes.
- Revoked users are removed from the server config immediately, so their UUID cannot establish a new session.

## Hardening before real-world use

1. Move to a host with a public IP and open inbound port.
2. Enable TLS with a valid certificate (or verified REALITY support on Shadowrocket).
3. Keep `api_host=127.0.0.1`.
4. Rotate the admin token and all subscription tokens.
5. Set `expires_at` on every account and review active accounts regularly.
6. Verify logs stay bounded (`scripts/common.sh` rotates any log over 5 MiB).
