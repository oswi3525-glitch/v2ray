# Performance Test Report

Measured 2026-11-27 on Ubuntu 24.04, 2 vCPU AMD EPYC 9V74, 7.8 GiB RAM, no swap. All numbers are from live commands on this host; no estimates.

## Idle baseline

| Metric | Value |
|---|---|
| sing-box RSS (idle, 0 users) | ~54 MB (`VmRSS` 53,700–55,196 kB across runs) |
| Fastify API RSS | ~77 MB (76,516–77,284 kB) |
| Combined idle RSS | ~131 MB |
| RAM available | ~5.1 GiB |
| CPU idle | not the bottleneck; idle samples dominated by platform agents |

## Throughput (3 simultaneous VLESS clients, local path)

Three independent `sing-box` VLESS client processes, each with its own UUID, SOCKS inbound and an 8 MiB HTTP payload served locally. Real VLESS sessions to the server on 8443.

| Metric | Value |
|---|---|
| Per-client transfer | 8,388,608 bytes in 24–45 ms |
| Per-client throughput (single) | ~200–350 MB/s (~1.5–2.8 Gbit/s) |
| 3 clients in parallel | 25,165,824 bytes in ~0.075–0.08 s |
| Aggregate throughput | **2,516–2,684 Mbit/s** (loopback path) |
| CPU during 3-client burst | ~80–87% of one 2-vCPU host (short spike) |
| RSS delta under load | +~600 kB (55,196 → 55,804 kB) |

These figures measure the proxy on a loopback path; they are an upper bound, not Internet throughput.

## Internet path (Cloudflare speed endpoint, 5 MB)

| Path | Download | TTFB | HTTP |
|---|---|---|---|
| Direct | 53.0 MB/s (~424 Mbit/s) | 61 ms | 200 |
| Through VLESS (same host as client) | 59.5 MB/s (~476 Mbit/s) | 63 ms | 200 |

The VPN path was not slower than direct in this lab; client and server share the host, so this compares proxy overhead, not a remote client path.

## Latency / packet loss (TCP connect, 10 samples each)

| Target | Avg | Loss |
|---|---|---|
| 1.1.1.1:443 | 2.2 ms | 0% |
| 8.8.8.8:443 | 1.9 ms | 0% |
| github.com:443 | 3.4 ms | 0% |
| DNS lookup github.com (system resolver) | 2 ms | — |

These are TCP-connect measurements, not ICMP RTT (`ping` is unavailable). They do not represent a Viettel mobile path.

## Stability run (20 minutes of a requested 30)

Started 2026-11-27 ~10:14 UTC, stopped at the user's request at ~10:34 UTC.

| Metric | Value |
|---|---|
| Duration completed | **1,201 s (20.0 min)** — 30-minute criterion NOT met |
| Samples (10 s interval) | 119 |
| Server RSS start → end | 52,812 kB → 57,480 kB (**+4,668 kB**) |
| API RSS start → end | 76,816 kB → 76,552 kB (-264 kB, no leak) |
| CPU avg / max | 22.10% / 54.81% |
| Traffic through 3 clients | 357 successes, 0 failures |
| Mid-run service restart | performed; recovery PASS after client reconnect |
| Log growth | bounded by 5 MiB rotation in `scripts/common.sh` |

Memory grew ~4.7 MB over 20 min (~4 kB/sample average) and then plateaued around 57.4 MB; no unbounded growth was observed. Note that a client-side reconnect was required after the server restart (the test clients cache their outbound connection); real VPN clients reconnect on demand.

## Stability fix applied after the long run

The watchdog originally restarted **all** components when it saw the brief port gap caused by API-driven config changes, which created restart churn. Fixed by: (1) `logs/applying.lock` created by `apply-config.sh` so the watchdog skips checks during an expected restart, (2) two consecutive failed checks before acting, (3) sing-box-only recovery that leaves the API and watchdog untouched. Verified with a 120 s stability smoke containing a mid-run service restart: 36/36 transfers OK, recovery PASS, `logs/watchdog.log` empty (no false restarts). Raw data: `reports/runtime/stability-smoke-120s.{csv,json}`.

## Configuration choices for low resource use

- No TUN, no Docker, no rule sets, no geoip/geosite, no sniffing, no fake-IP, no multiplexing.
- `dns.servers` uses only the `local` resolver.
- Logging level `warn` with script-level rotation at 5 MiB.
- API rate-limit buckets pruned when the map exceeds 2,000 entries.
- 3 users maximum; no artificial bandwidth cap (measurements showed no need).

## Honest limitations

- No external device: three VLESS clients are real protocol clients but run on the same host, so they are **not** three independent VPN users on separate networks.
- No Wi-Fi/4G/5G handover, no iOS Shadowrocket import, no client-side DNS leak test.
- Internet inbound is blocked by the platform tunnel, so no remote throughput test could be performed.
- Full 30-minute stability requirement was not completed by explicit user decision; reported duration is the real measured value.
