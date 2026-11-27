# Security Test Report

Date: 2026-11-27. Evidence from live API probes and `reports/runtime/control-tests.json`.

| Control | Test | Result |
|---|---|---|
| Admin first setup | no default password, setup only when no admin exists | PASS |
| Password hashing | bcryptjs cost 12 in DB; no plaintext column | PASS |
| Friend login | separate username/password, disabled/revoked users cannot log in | PASS |
| RBAC | friend → `/api/admin/users`: 401; friend → `/api/monitor/server`: 401 | PASS |
| Cross-account access | friend cannot read another user's record | PASS |
| CSRF | admin POST without `x-csrf-token`: 401 | PASS |
| Session cookie | HttpOnly, SameSite=Strict, random 256-bit id, DB-backed expiry | PASS |
| Login brute force | repeated bad logins → 429 after rate limit | PASS |
| Rate limiting | 180 req/min API, 10 logins/5 min per IP | PASS |
| Security headers | nosniff, DENY framing, referrer policy, CSP | PASS |
| Subscription auth | random 192-bit token; exhausted/revoked → 404 | PASS |
| Secrets | no UUID/token/password printed in logs or reports | PASS |
| TLS | terminated at Cloudflare subdomain; no fake TLS / no verification bypass | PASS (design), external path unverified |
| Audit log | quota changes, user changes, login failures recorded (45+ events) | PASS |

## Caveats

- `cookie_secure` is currently `false` because the app is tested over plain HTTP locally. Set `cookie_secure: true` in `config/control.json` when deployed behind the Cloudflare HTTPS tunnel.
- CSRF token is stored in `sessionStorage` by the web UI; the app has a strict CSP and no third-party scripts other than Chart.js CDN. Review CSP for your deployment.
- Cloudcode's own policy on running a private VPN could not be checked from this workspace.
