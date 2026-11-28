# TikTunnel — Core Rebuild & Full Tunnel Beta (Report)

Date: 2026-11-28
Scope: repository at `/workspaces/v2ray` (Node.js/Fastify control plane, port mux, sing-box renderer, web dashboard).

## 0. What this repository actually is (important)

This repository does **not** contain an iOS app, Swift sources, `NetworkExtension`,
`NEPacketTunnelProvider`, an Xcode project, or a provisioning profile. It is the
**server-side control plane** for sing-box VLESS:

- `control/port-mux.js` — public port splitter (HTTP vs VLESS TCP) + real traffic accounting.
- `control/server.js` — Fastify API + WS VLESS proxy + quota worker + dashboards.
- `control/db.js` — SQLite schema/migrations.
- `server/render-control-config.js` — renders sing-box server config.
- `web/*` — dashboard SPA.

Therefore iOS-only actions (system-wide VPN extension, per-app routing, fail-closed
packet filter, Wi-Fi↔Cellular handover inside an iOS tunnel) **cannot be implemented
in this repo**. They require a separate iOS target signed with the NetworkExtension
entitlement. The report states this explicitly rather than faking it.

What *was* implemented here: real full-tunnel **client profile generation** (validated
against the real `sing-box` 1.14.5 binary), accurate server-side accounting fixes,
usage aggregation, research/carrier reconciliation, response compression, tests, UI.

## 1. Initial defects (reproduced)

1. **Traffic attribution race (critical).** `port-mux` cached VPN UUIDs and reloaded
   only every 30 s. Accounts created after startup had their traffic classified
   `unknown`, so quota never increased and account exhaustion never triggered.
   Baseline E2E reproduced 4 failures (`delta=0B`, quota not enforced, etc.).
2. **False "connected" state.** The live dashboard reported `active` as soon as a
   WebSocket opened, even with zero bytes transferred. This violates the rule
   "never mark Connected before the tunnel actually carries data".
3. **No full-tunnel profile.** Only a bare VLESS URI was exported; there was no
   valid full-tunnel client config (default route, IPv6, DNS policy).
4. **No byte classification.** Accounting mixed all bytes; no separate tunnel
   overhead, no daily/weekly/monthly/source aggregation.
5. **No research module.** Ad-hoc probes existed but no persisted, evidence-labelled
   research record and no client/carrier reconciliation.
6. **No response compression** for API metadata.

## 2. Root causes

- (1) Process-local cache with a slow, non-event-driven refresh; no refresh-on-miss.
- (2) Liveness derived from socket existence instead of observed traffic.
- (3) Feature not present.
- (4) `traffic_usage` stored only up/down/total; no aggregation query layer.
- (5) Feature not present.
- (6) Feature not present.

## 3. Files changed

| File | Change |
|---|---|
| `control/port-mux.js` | Refresh-on-UUID-miss (throttled 250 ms), 5 s periodic reload, VLESS header overhead tracked separately. |
| `control/db.js` | Migration v7: `traffic_usage.overhead_bytes`, `research_runs`, `carrier_reports`; `trafficTotals`, `trafficSummary`, `sessionHistory`, research/carrier helpers. |
| `control/server.js` | Full-tunnel profile builder + endpoints; usage summary/sessions endpoints; Research Lab endpoints; carrier reconciliation; brotli/gzip JSON compression; activity now requires real traffic (`last_traffic_at`, `tunnel_open`). |
| `control/research.js` | **New.** Real DNS/TCP/TLS/HTTP probes, evidence-labelled T15KN hypotheses, explicit anti-spoofing policy. |
| `web/app.js` | Data Usage shows tunnel/overhead/source breakdown; new friend **Routing** and **Research** tabs; new admin **Research Lab** tab with probe runner + carrier form. |
| `tests/core-upgrade-test.js` | **New.** 22 checks: profile validity via real `sing-box check`, compression, aggregation, carrier mismatch, research probes/persistence. |
| `package.json` | v2.2.0; `test:core`, `test:all`. |
| `README.md`, `ARCHITECTURE.md` | Documented new modules/endpoints/schema v7 and iOS limits. |

## 4. Rewritten / new modules

- **Full Tunnel profile generator** (`buildFullTunnelProfile`): `tun` inbound with both
  IPv4 (`172.19.0.1/30`) and IPv6 (`fdfe:dcba:9876::1/126`), `route.final = proxy`,
  `auto_detect_interface`, DNS over HTTPS detoured through the proxy, UDP via VLESS
  `xudp`, `default_domain_resolver` bootstrap. Exported at
  `GET /api/friend/profile` (session) and `GET /api/sub/:token/profile` (token).
- **Research module** (`control/research.js` + API): hypotheses statuses
  (`unverified|testing|evidence|refuted`), persisted runs, server-observed probes,
  and manual carrier reconciliation with mismatch detection (>10 %).
- **Accounting aggregation** over `traffic_usage` by day/week/month/source with
  overhead separated from payload.

## 5. New APIs

- `GET /api/friend/profile?device=` — full-tunnel sing-box profile + metadata.
- `GET /api/sub/:token/profile?device=` — same, downloadable by token.
- `GET /api/friend/usage/summary?days=` — totals, day/week/month buckets, by source, sessions.
- `GET /api/friend/sessions` — connection session history.
- `GET /api/admin/users/:id/usage/summary?days=`
- `GET /api/admin/research/hypotheses` • `POST /api/admin/research/run`
- `GET /api/admin/research/runs` • `POST/GET /api/admin/research/carrier`
- `GET /api/friend/research` — read-only research view.

## 6. Benchmarks (measured in this environment)

| Metric | Before | After |
|---|---|---|
| E2E `npm test` | 35 PASS / 4 FAIL | **39 PASS / 0 FAIL** |
| Core upgrade suite | n/a | **22 PASS / 0 FAIL** |
| VLESS payload vs counted wire bytes (8 MiB transfer) | not attributed (0 B) | 8,388,608 payload → 8,388,853 wire (`overhead=245 B`, ~0.003 %) |
| `GET /api/admin/users` JSON (2,087 B) | 2,087 B | gzip **659 B (31.6 %)**, br **614 B (29.4 %)** |
| New-account traffic attribution | up to 30 s blind window | immediate (refresh-on-miss) |

## 7. iOS limitations (cannot be fixed in this repo)

- A normal iOS app cannot control other apps' traffic. System-wide routing requires
  the `com.apple.developer.networking.networkextension` entitlement (Packet Tunnel /
  App Proxy provider), a matching provisioning profile, App Group, and user approval.
- This repo has no iOS target; the full-tunnel profile targets **sing-box clients**
  (desktop/Android/macOS). On iOS the equivalent needs a NetworkExtension app or
  Shadowrocket importing the VLESS config.
- iOS always carries some system traffic outside any tunnel (e.g. certain Apple
  services, bootstrap DNS/DHCP). "100 % full tunnel" must not be advertised.
- True fail-closed is only possible inside a Packet Tunnel provider (drop when the
  tunnel is down); it cannot be done from this server.
- Per-app routing on iOS is only via `NEPacketTunnelProvider.includeAllNetworks` /
  excluded routes / App Proxy — not from this backend.

## 8. T15KN / Viettel limitations

- No Viettel SIM, iPhone 11, or carrier usage API is available in this environment.
  Client-side Viettel measurements, zero-rating verification, and Wi-Fi↔4G handover
  remain **BLOCKED**, not simulated.
- Carrier figures must be entered manually from Viettel's usage screen. The server
  reports the delta and flags mismatch; it does not claim to know Viettel's billing.
- No TikTok identity spoofing, traffic faking, or billing evasion was implemented.

## 9. Unverified research hypotheses

All T15KN hypotheses ship as `unverified` (see `GET /api/admin/research/hypotheses`):
scope of zero-rating, non-TikTok billing, VPN blocked on T15KN, DNS-based
classification, SNI-based classification. None has device-side evidence yet.

## 10. Remaining work

1. Build a separate iOS NetworkExtension target for true system VPN + fail-closed.
2. Add packet-level wire overhead for WS framing and downlink (currently VLESS
   request header only is separated).
3. Retransmission/drop counters require a proxy that terminates TCP (e.g. tun/sniff);
   VLESS passthrough cannot report them.
4. Run device-side T15KN captures and import carrier statements for real evidence.
5. Tunnel payload compression is intentionally **not** applied: VLESS carries
   end-to-end TLS, recompressing would break integrity/side-channel safety.
6. External-client tests (Safari/YouTube across the tunnel) require a real device.
