# Performance Test Report

Raw data: `reports/runtime/control-performance.json`, `reports/runtime/control-stability.json`.

## Idle

| Process | RSS |
|---|---|
| sing-box (WS inbound, 2 users) | ~53,324 kB |
| Control API (Fastify + WS proxy) | ~81,112 kB |

## Throughput and CPU (loopback VLESS/WS clients)

| Scenario | Result |
|---|---|
| 1 client, 8 MiB | 1001.62 Mbit/s aggregate, 67 ms, CPU 85.71%, RSS +1,196 kB |
| 2 clients, 16 MiB | 979.69 Mbit/s aggregate, 55–82 ms, CPU 92.31%, RSS +180 kB |

These are local loopback numbers and an upper bound; they are not Internet throughput and must not be presented as such.

## Stability

| Metric | Value |
|---|---|
| Duration | 126 s (local smoke, 30-min requirement not met) |
| Transfers | 24 OK / 0 fail |
| Average CPU | 30.33% |
| Restart recovery | PASS (after client reconnect) |
| Limitation | External Cloudcode TCP/WS path unavailable |

## Optimization applied

- Node and sing-box use separate ports; no port sharing.
- sing-box WS inbound on loopback only, no TLS termination in sing-box (Cloudflare handles TLS), no TUN, no rule sets/geoip/sniffing.
- DNS: `local` resolver. Logs: `warn` level, rotation at 5 MiB.
- Admin API loopback-era defaults replaced by authenticated app on single port; rate limits and CSRF prevent abuse.
- No artificial speed cap: measurements showed no need.

## Honest caveat

The CPU figures are short-burst samples on a 2-vCPU host. Real client latency, ISP packet loss and Internet throughput cannot be measured until the Cloudcode port mapping and an external client are available.
