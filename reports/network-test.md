# Network Test Report

Date: 2026-11-27. Raw data: `reports/runtime/control-performance.json`.

## DNS and TCP

| Target | Result |
|---|---|
| `vn-hn.cldcode.host` | CNAME `vn-hn.cloudcode.io.vn` → `117.5.211.146` |
| `app-medium-1-ac2e.cldcode.host` | Cloudflare `104.21.79.114`, `172.67.170.130` |
| TCP `vn-hn.cldcode.host:23952` | **ECONNREFUSED** (multiple probes) |
| TCP `vn-hn.cldcode.host:443` | OK, 44–54 ms |
| TCP `app-medium-1-ac2e.cldcode.host:443` | OK, 2–17 ms |
| WS Upgrade `/vpn` on HTTPS subdomain | HTTP/2 404 from Cloudflare, not 101 |
| TCP probes to 1.1.1.1 / 8.8.8.8 / subdomain | all reachable from this host (see JSON) |

## TLS

- Cloudflare terminates TLS on the HTTPS subdomain. No certificate is held in the app.
- `vn-hn.cldcode.host:443` probe produced `tlsv1 unrecognized name`; no valid TLS service was confirmed there.
- No fake TLS or certificate-verification bypass is used. VLESS-over-WS URI uses `security=tls` with SNI set to the Cloudflare subdomain; this is correct **only if** Cloudcode forwards that hostname to the app.

## Local end-to-end (real protocol)

- A real sing-box VLESS-over-WS client connected to `127.0.0.1:23952` with the generated path and fetched an 8 MiB object through the Node WS proxy and sing-box WS inbound: HTTP 200, 8,388,608 bytes.
- This proves the software pipeline, **not** the public Cloudcode path.

## Packet loss / latency caveat

TCP-connect probes from this host show no loss, but they are not ICMP RTT and not a measurement from an iPhone or from a Viettel network. Client-side DNS leak, Wi-Fi↔4G/5G handover and real Shadowrocket connectivity remain untested.
