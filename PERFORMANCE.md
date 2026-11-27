# PERFORMANCE.md

Measured values only; raw data in `reports/runtime/control-performance.json` and `reports/runtime/control-stability.json`.

| Scenario | CPU | RAM | Throughput | Latency |
|---|---|---|---|---|
| Idle | — | sing-box ~53 MB, API ~81 MB | — | — |
| 1 WS VLESS client, 8 MiB | 85.71% | +1.2 MB | 1001.62 Mbit/s | 67 ms |
| 2 WS VLESS clients, 16 MiB | 92.31% | +0.18 MB | 979.69 Mbit/s | 55–82 ms |
| 126 s stability, 2 clients | avg 30.33% | stable | 24/24 transfers OK | — |

These are **loopback** benchmarks on a 2-vCPU host. They prove the proxy pipeline and give an upper bound; they are not Internet speeds and not a substitute for external client tests.

## Latency target

The desired target is <100 ms, but it is not guaranteed and not claimed for the public path. Only TCP-connect probes from this host were measured; they do not represent latency from an iPhone/Viettel client to arbitrary websites. `GET /api/monitor/network` shows each endpoint and its measured result with an explicit caveat.

## Tuning decisions

- No TUN, Docker, rule sets, geoip/sniffing or multiplexing.
- One public port for the app; sing-box on loopback only.
- `local` DNS resolver; `warn`-level logs with 5 MiB rotation.
- No artificial bandwidth cap (benchmarks show no need).
- Quota worker interval 10 s; documented overshoot rather than a false "hard cap" claim.
