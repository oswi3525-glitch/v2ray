# Quota Test Report

Date: 2026-11-27. Raw data: `reports/runtime/control-tests.json`, SQLite `traffic_usage` / `quota_history`.

## Method

Traffic was **real VLESS-over-WebSocket traffic** from a sing-box client through the Node WS proxy and sing-box WS inbound to a local 8 MiB HTTP object. The Node proxy counts bytes in both directions per connection and writes them to `traffic_usage` with `source='ws-proxy'`. No simulated/hardcoded traffic was used for the PASS results below.

| Step | Result |
|---|---|
| Set Friend 02 quota to 5 GB | PASS |
| Transfer 8 MiB through VLESS/WS | HTTP 200, 8,388,608 bytes |
| Traffic accounted | +8,388,879 bytes recorded to that user (handshake + payload) |
| Set Friend 01 quota to 0.0005 GB (~500 kB) | PASS |
| Transfer through VLESS/WS | quota worker (10 s cycle) marked account exhausted |
| `exhausted=1`, `enabled=0` in SQLite | PASS |
| UUID removed from sing-box config | PASS |
| Subscription endpoint returns 404 | PASS |
| Active WS connections terminated on enforcement | PASS |
| Top-up +1 GB and re-enable | PASS, UUID restored |
| Quota survives backend + sing-box restart | PASS |

## Distinctions

- **Allocated quota** = configured `quota_bytes`.
- **Used traffic** = `used_upload + used_download` from measured WS traffic.
- **Remaining** = `max(0, quota - used)`.
- `quota_history` stores every set/add/reduce/reset/exhaust action with actor and timestamp.

## Expected overshoot

The quota worker runs every 10 s. Worst-case extra traffic after the limit is crossed is approximately `10 s × per-user link rate` plus any in-flight WebSocket frames before connections are closed. In the local test the overshoot was about 8 MB (one 8 MiB transfer). On a slower external link the overshoot will be smaller, but it is not zero. There is no kernel-level hard cap: enforcement is application-level by removing the UUID from the VPN engine and closing active sessions.

## Bug found and fixed

During testing, setting a quota below current usage marked the account `exhausted` immediately in SQLite, but the quota worker skipped already-exhausted rows and therefore never disabled the account or removed its UUID from sing-box. Fixed by re-running enforcement for any row where `exhausted=1 && enabled=1`; audit/history entries are written only once. Retest: PASS 24 / FAIL 0.

## Limitations

- Counting happens at the WebSocket proxy, so it reflects traffic through this app. Traffic that bypasses the proxy (e.g. if a client connects directly to the loopback sing-box port) is not counted; loopback is not exposed publicly.
- No external client/device was available; quota enforcement was verified with a real local VLESS client only.
