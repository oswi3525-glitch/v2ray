# Viettel Network Lab

Date: 2026-11-27 (UTC). **Important:** the authorized environment is an Azure/GitHub Codespaces container in Singapore. It is **not** a Viettel network and there is no Viettel SIM, Wi-Fi router or iOS device available here. All Viettel-specific client-side measurements are therefore **BLOCKED / SKIP**, not PASS.

## What was actually measured (this host only)

Raw data: `reports/runtime/network-lab.json`.

### Latency (TCP connect, 10 samples)

| Target | Avg | Packet loss (connect failures) |
|---|---|---|
| 1.1.1.1:443 | 2.2 ms | 0% |
| 8.8.8.8:443 | 1.9 ms | 0% |
| github.com:443 | 3.4 ms | 0% |
| DNS (github.com, system resolver) | 2 ms | — |

### Download, direct vs VPN (5 MB from Cloudflare speed endpoint)

| Path | Bytes | Bytes/s | Mbit/s | TTFB |
|---|---|---|---|---|
| Direct | 5,000,000 | 53,000,349 | ~424 | 61.3 ms |
| Via local VLESS client | 5,000,000 | 59,503,974 | ~476 | 63.1 ms |

The "via VPN" figure uses a VLESS client on the **same host** as the server, so it measures proxy overhead only. It must not be presented as the speed a phone on Viettel would get.

### Stability / continuity

20-minute run with 3 concurrent VLESS clients: 357 successful transfers, 0 failures; service restart recovered after client reconnect. Full 30-minute criterion not met (user stopped the run). See `reports/performance-test.md`.

## Legality / policy

No attempt was made to bypass ISP billing, TikTok zero-rating, or any Viettel policy. A VPN may change how traffic is classified or billed; users must check their own plan. This report does not assume TikTok traffic is free when routed through the VPN.

## Tests that could NOT be performed

| Test | Status | Reason |
|---|---|---|
| Viettel latency from a Viettel SIM | SKIP | no Viettel SIM / modem |
| Download/upload on Viettel Wi-Fi | SKIP | no Viettel router |
| Download/upload on Viettel 4G/5G | SKIP | no mobile device |
| Wi-Fi ↔ 4G/5G handover | SKIP | no external client device |
| Direct vs VPN comparison on Viettel | SKIP | no client on Viettel network |
| Shadowrocket import on iOS | SKIP | no iOS device |
| Client-side DNS leak on Viettel | SKIP | no client device |

## How to complete this lab on a real deployment

1. On an iOS device with a Viettel SIM and Shadowrocket installed, import the subscription (see `IOS-SHADOWROCKET.md`) after TLS/REALITY and a public host are configured.
2. Measure latency with a TCP/ICMP tool from the phone, direct and via VPN.
3. Run the same 5 MB Cloudflare download direct and through the VPN, recording Mbit/s and TTFB for Wi-Fi and 4G/5G separately.
4. Repeat 3+ times per network and record variance; check for packet loss during a 10-minute sustained transfer.
5. Append results to this file with the real device model, network type, location and timestamp. Do not fill in assumed numbers.
