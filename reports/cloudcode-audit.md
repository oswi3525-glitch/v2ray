# Cloudcode Audit — TikTunnel Control

Date: 2026-11-27. All entries are from live checks in the authorized workspace. No root/sudo used.

## Identity and reachability

| Check | Result | Status |
|---|---|---|
| Workspace hostname | `codespaces-ca37b5` (GitHub Codespaces container), not a Cloudcode host | WARNING |
| Local address | `10.0.2.79/16` RFC1918, egress SNAT `23.97.62.115` (Singapore) | WARNING |
| `vn-hn.cldcode.host` DNS | CNAME → `vn-hn.cloudcode.io.vn` → `117.5.211.146` | PASS |
| `vn-hn.cldcode.host:23952` TCP (3+ probes) | **ECONNREFUSED** every time | **FAIL** |
| `vn-hn.cldcode.host:443` TCP | reachable, ~44–54 ms | PASS |
| `app-medium-1-ac2e.cldcode.host` DNS | Cloudflare `104.21.79.114`, `172.67.170.130` | PASS |
| `app-medium-1-ac2e.cldcode.host:443` TCP | reachable, 2–17 ms | PASS |
| WS upgrade `GET /vpn` with Upgrade headers on HTTPS subdomain | `HTTP/2 404`, `server: cloudflare`, `cf-cache-status: DYNAMIC` — **not** a WS 101 response | **FAIL / not verifiable** |
| TLS on `vn-hn.cldcode.host:443` | `SSL routines::tlsv1 unrecognized name` on HTTPS probe | WARNING |
| Local bind `0.0.0.0:23952` | possible, no conflicting process | PASS |
| Cloudcode CLI / agent / env / metadata | none present in this workspace | FAIL (no platform control) |
| SSH to Cloudcode host:22 | connection refused | FAIL |

## Port mapping determination

- Public TCP 23952 is refused from this network. There is no evidence that it is forwarded to any application.
- The HTTPS subdomain is served by Cloudflare and returned 404 to a WebSocket upgrade, so it cannot be confirmed that it forwards to primary application port 23952.
- We cannot change or create Cloudcode port mappings from this workspace (no Cloudcode tooling/credentials).
- **Conclusion:** the public entry points cannot be validated from here. The application architecture is implemented to use the supplied values, but end-to-end Internet operation is **NOT verified**.

## Platform policy check

Cloudflare's public documentation states that public hostname routes proxy HTTP traffic and that VPN replacement / private networking belongs to Cloudflare One/Tunnel private routes; it also documents request size and service-specific terms for free plans. Cloudcode's own VPN terms could not be retrieved from this workspace. No assumption is made that operating a private VPN is permitted. Confirm with Cloudcode before exposing this deployment.

## Architecture decision

Target (implemented, not externally verified):

```
Internet -> Cloudflare HTTPS (subdomain, TLS terminated at Cloudflare)
         -> Cloudcode forwards to primary app port 23952
         -> Node/Fastify :23952
              / , /admin , /friend   -> Web panel
              /api/*                 -> REST API
              /vpn/<token>           -> WebSocket reverse proxy
         -> sing-box VLESS-WS :127.0.0.1:23954 (path /vpn)
         -> direct outbound
```

- Node and sing-box never share a port.
- TLS is terminated at the HTTPS tunnel; sing-box uses plaintext WS only on loopback. No fake TLS.
- Raw TCP fallback mode is implemented in config (`vpn_mode: tcp`) but cannot be enabled here because TCP 23952 is refused.

## Blocked items

1. No Cloudcode shell access (the current workspace is Codespaces).
2. Public TCP 23952 refused; HTTPS tunnel 404 on WS upgrade.
3. No iOS device for Shadowrocket import, connection, DNS or reconnect tests.
4. 30-minute external stability test not possible; only local smoke tests were run.
