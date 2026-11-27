# Deployment Report

Date: 2026-11-27 (UTC). Environment: GitHub Codespaces container (Ubuntu 24.04, x86_64, uid 1000). No root/sudo used at any step.

## Installed

| Item | Detail | Evidence |
|---|---|---|
| sing-box | v1.14.5, official release `linux-amd64-musl`, static (`ldd`: not a dynamic executable) | `bin/sing-box version`; sha256 `9cf4d31acb76696c64b4c3214854bc72a68c703482781ddd2158dbf95ab9d06a` pinned locally (upstream published no checksum/signature asset) |
| Fastify API | `api/server.js`, Fastify 5.x, npm dependencies in `node_modules/` (gitignored) | `scripts/bootstrap.sh` output |
| SQLite | `database/tiktunnel.db`, WAL mode, tables `users` + `events` | `node:sqlite` smoke + API tests |
| Config generator | `server/render-config.js` → `config/sing-box.json` chmod 600 | `sing-box check` exit 0 |
| Subscription exporter | `subscriptions/render.js`, hashed filenames, chmod 600 | test suite |
| Management | `scripts/{bootstrap,start,stop,restart,status,health-check,backup,restore,apply-config,watchdog}.sh` | script runs |
| Tests | `tests/run-tests.js`, `tests/stability.js`, `tests/network-lab.js` | results below |

## Running processes

Started with `setsid nohup` so they survive SSH/shell disconnect. PIDs in `logs/*.pid`.

- `sing-box run -c config/sing-box.json` — VLESS inbound `0.0.0.0:8443`
- `node api/server.js` — API `127.0.0.1:3000`
- `bash scripts/watchdog.sh` — 20 s health loop with auto-restart

`scripts/status.sh` reports one instance of each; `start.sh` refuses to create duplicates.

## Configuration actually deployed

- VLESS inbound, raw TCP, **no TLS** (`security=none`), public host placeholder `127.0.0.1`.
- DNS: `local` resolver only. Routing: `final=direct`. No TUN, no rule sets, no sniffing.
- Log level `warn`, output `logs/sing-box.log`; any log above 5 MiB is rotated by the scripts.
- API admin auth, rate limits, input validation, loopback bind.
- Max 3 active accounts; per-user UUID + subscription token.

This configuration is a **local lab**. It cannot serve a real iOS client because there is no reachable public host and no TLS.

## Test results (from `reports/test-results.json`)

PASS (28 in final run):
- sing-box config valid; API `/health`, `/api/status`; SQLite readable; port 8443 listening
- create 3 accounts; reject 4th; reject unauthenticated admin call; reject invalid name
- 3 unique UUIDs; 3 subscriptions exported with matching UUID; VLESS URI format
- 3 real sing-box VLESS clients started and reached an HTTP endpoint through the proxy
- HTTPS through VLESS succeeded (HTTP 200)
- 3 simultaneous VLESS transfers succeeded
- revoked UUID could no longer proxy; two remaining accounts still worked after fresh client reconnect

SKIP (7) — blocked, never claimed as PASS:
- valid TLS certificate; REALITY handshake; Shadowrocket import on iOS
- inbound connection from the Internet; Wi-Fi↔4G/5G handover
- external packet loss; client-side DNS leak

FAIL (0).

## Why internet-facing deployment stopped

Port 8443 was forwarded publicly to
`https://legendary-space-rotary-phone-6v4g97wpjr69f5wr4-8443.app.github.dev`.
A local listener returned HTTP 200 locally, but the public URL answered `401` with
`WWW-Authenticate: tunnel` and redirected to GitHub's browser sign-in flow. This is an
authenticated HTTP tunnel, not a raw TCP port: a VLESS client cannot complete it. The NAT address
`23.97.62.115` is SNAT-only (no DNAT to the container). No user-owned domain or certificate exists.

## Acceptance checklist

| Criterion | Result |
|---|---|
| VPS surveyed | PASS — `reports/vps-audit.md` |
| No root/sudo | PASS |
| sing-box stable | PASS locally for 20 min; 30-min criterion NOT met (run stopped at user request) |
| VLESS works | PASS locally with real VLESS clients |
| TLS/REALITY valid | BLOCKED (no domain/cert, no raw TCP) |
| API works | PASS |
| SQLite works | PASS |
| 3 separate accounts | PASS |
| Subscription Shadowrocket-compatible format | PASS (format only; device import SKIP) |
| Internet inbound check | BLOCKED — documented with evidence |
| 3 simultaneous connections | PASS locally with 3 real VLESS clients; not 3 external devices (documented) |
| RAM/CPU/latency/throughput measured | PASS — see `reports/performance-test.md` |
| Process management | PASS |
| Documentation and reports | PASS |

## To finish on a real VPS

Provide: (1) host with public IP + inbound TCP port, (2) domain + valid certificate (or verified REALITY support), (3) up to 3 iOS devices for the remaining tests. Then follow CONFIGURATION.md and rerun all tests.
