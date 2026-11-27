# SECURITY.md

| Control | Implementation |
|---|---|
| Password hashing | bcryptjs cost 12 (`admins`, `users`); no plaintext column. Admin credentials are read from `ADMIN_USERNAME`/`ADMIN_PASSWORD` in `.env` and synced at startup; no first-run setup endpoint or screen exists. |
| Session | random 256-bit id, DB-backed, expiry 2 h admin / 12 h friend, HttpOnly + SameSite=Strict cookie (`Secure` when `cookie_secure=true`) |
| CSRF | double-submit token returned by login/setup, required as `x-csrf-token` on all admin writes |
| RBAC | `/api/admin/*` admin only; `/api/friend/*` friend only; friend cannot read other user records |
| Login abuse | 10 attempts / 5 min / IP, generic error, audit on failure |
| General rate limit | 180 requests/min/IP on `/api/*` |
| Input validation | username regex, password length/complexity, quota range, expiry parsing, token regex by DB lookup |
| Headers | `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, strict-ish CSP |
| Subscription | 192-bit random token; WS path contains that token; revoked/exhausted → 404 and socket destroyed |
| Secrets | `config/secrets.env` chmod 600 and gitignored; no UUID/token/password in logs or reports |
| TLS | terminated at Cloudflare; no fake TLS, no disabled verification |
| Audit | account, quota, password, login and enforcement events in `audit_logs` |

## Deployment checklist

1. Set `cookie_secure: true` once behind HTTPS.
2. Confirm Cloudcode's policy for operating a private VPN before exposing the service.
3. Keep the app port authenticated; never expose an unauthenticated admin API.
4. Rotate admin/friend passwords after first setup and after restoring backups.
5. Back up `database/control.db` before any VPN config change.

## Known gaps

- The local build was tested over plain HTTP, so cookie `Secure` is off locally.
- No external device test; TLS/SNI behavior through Cloudcode is not proven.
- CSRF token lives in `sessionStorage`; consider a non-CDN-hosted Chart.js build if you require a stricter CSP.
