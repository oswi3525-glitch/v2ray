# PERFORMANCE

Full measured data: [`reports/performance-test.md`](reports/performance-test.md). Raw samples: `reports/runtime/stability-20min-summary.json`, `reports/runtime/stability-smoke-120s.csv`, `reports/runtime/network-lab.json`.

## Key numbers (measured, not estimated)

| Scenario | Result |
|---|---|
| Idle sing-box RSS | ~54 MB |
| Idle API RSS | ~77 MB |
| 1 client, 8 MiB local transfer | 24–45 ms |
| 3 clients in parallel, 24 MiB total | ~0.075–0.08 s, **2,516–2,684 Mbit/s** |
| CPU during 3-client burst | ~80–87% (short spike on 2 vCPU) |
| RSS increase under load | +~600 kB |
| Direct Internet download (5 MB, Cloudflare) | 53.0 MB/s (~424 Mbit/s), TTFB 61 ms |
| Via VLESS (same host client/server) | 59.5 MB/s (~476 Mbit/s), TTFB 63 ms |
| TCP connect latency | 1.9–3.4 ms, 0% connect failures |
| 20-min stability | 357/357 transfers OK, 0 failures; RSS growth +4.7 MB then plateau; CPU avg 22.1% |
| Service restart | recovery PASS after client reconnect |

## Tuning decisions

- Minimum features: VLESS TCP only, no TUN, no rule sets/geoip/sniffing/fake-IP/multiplex.
- DNS via `local` resolver; routing `final=direct`.
- `warn` logging plus script-level rotation at 5 MiB; API logger disabled.
- No artificial bandwidth cap — measurements showed no bottleneck requiring one.
- API bound to loopback so it cannot compete with the VPN on the public interface.

## Not measured / caveats

- Three VLESS clients are real protocol clients but share one host; they are not three independent remote devices.
- No Internet-inbound path, no iOS client, no Viettel SIM: remote throughput, handover, device DNS-leak and Viettel comparisons are blocked.
- The requested 30-minute stability run was stopped at 20 minutes at the user's request; the 30-minute criterion is not claimed.
