# TikTunnel — VPS / Environment Audit

Audit time: 2026-11-27 (UTC). Method: live commands executed in the authorized work environment at `/workspaces/v2ray`. No root, no sudo used.

## 1. Environment identity (critical finding)

| Item | Value | Status |
|---|---|---|
| Environment | GitHub Codespaces dev container (Azure, Singapore region) | WARNING |
| Evidence | `CODESPACES=true`, `CODESPACE_NAME=legendary-space-rotary-phone-6v4g97wpjr69f5wr4`, `GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN=app.github.dev` | — |
| Public egress IP | `23.97.62.115` (AS8075 Microsoft, Singapore) — SNAT, **not** assigned to any local interface | FAIL for inbound |
| Interface address | `eth0 10.0.2.79/16` (RFC1918, behind platform NAT) | FAIL for inbound |
| IPv6 | link-local only (`fe80::…`); no global IPv6 | WARNING |

This is **not a conventional VPS with a public IP bound to the network interface**. It is a managed container behind the Codespaces tunnel/proxy. This single fact determines most of the feasibility results below.

## 2. System inventory

| Item | Value | Status |
|---|---|---|
| Distribution | Ubuntu 24.04.5 LTS (noble) | PASS |
| Kernel | `6.8.0-1070-azure` x86_64 | PASS |
| CPU | 2 vCPU — AMD EPYC 9V74 (`nproc` = 2) | PASS (adequate for 3 users) |
| RAM | 7.8 GiB total, ~5.1 GiB available, 63 MiB shared | PASS |
| Swap | none (`swapon --show` empty) | WARNING |
| Disk | overlay 32 G, 18 G free on `/` and `/workspaces`; `/tmp` 44 G / 38 G free | PASS |
| User | `codespace`, uid/gid 1000 (normal unprivileged user) | PASS |
| HOME | `/home/codespace` writable | PASS |
| Workdir | `/workspaces/v2ray` writable | PASS |
| sudo/root | not available / not used | PASS (by design) |

## 3. Toolchain

| Program | Result | Status |
|---|---|---|
| Node.js | `v24.22.2` | PASS |
| npm | `11.19.1` | PASS |
| Python | `3.14.2` | PASS |
| curl / wget | `/usr/bin/curl`, `/usr/bin/wget` | PASS |
| openssl | `/opt/conda/bin/openssl` | PASS |
| tar / unzip / git / jq / socat | present | PASS |
| tmux / screen | **missing** | WARNING — use `setsid`/`nohup` + custom scripts |
| systemctl | present but stub: *"systemd is not running in this container"* | FAIL — no `systemd --user` |
| dig / nslookup / ping / nc | missing | WARNING — use Python sockets / `curl` |

## 4. Connectivity

| Check | Result | Status |
|---|---|---|
| Outbound HTTPS (api.github.com) | HTTP 200, 0.04 s | PASS |
| DNS resolution | `github.com`, `cloudflare.com`, `google.com` resolve via `127.0.0.53` / `168.63.129.16` | PASS |
| TCP latency (3 samples) | 1.1.1.1:443 ≈ 1.8–4.6 ms; 8.8.8.8:443 ≈ 1.5 ms; github.com:443 ≈ 3.7–5.9 ms | PASS (excellent) |
| Bind `0.0.0.0:8443` | succeeded | PASS |
| Inbound raw TCP from Internet | **Not available.** Port 8443 was forwarded publicly: `https://legendary-space-rotary-phone-6v4g97wpjr69f5wr4-8443.app.github.dev`. A local HTTP server on 8443 was reachable locally (200) but the public URL returned `401`, header `WWW-Authenticate: tunnel`, then redirected to GitHub's `pf-signin` JS flow. This is an HTTP(S) tunnel with browser/OAuth authentication, **not** a transparent TCP port — a VLESS/Shadowrocket client cannot complete it. The NAT IP is SNAT-only, so `canyouseeme`-style DNAT tests cannot reach the container. | **FAIL** |
| TLS certificate | No user-owned domain and no certificate material in HOME. The only hostname available (`*.app.github.dev`) is GitHub-controlled and TLS is terminated at GitHub's proxy. | **FAIL** |
| REALITY | Requires a transparent TCP stream so the client and server can perform the REALITY handshake. The Codespaces HTTP tunnel terminates TLS and injects an auth step, so REALITY cannot be validated here. Shadowrocket compatibility also cannot be confirmed. | **FAIL** |
| Ports already in use | 2222, 2000 (0.0.0.0), 13005/16634/16635/16636/36595/40917/... (127.0.0.1), DNS 53. **8443 is free.** | PASS |

## 5. Classification summary

| Area | Status |
|---|---|
| OS / kernel / CPU / RAM / disk / user / HOME | PASS |
| Toolchain (Node, npm, Python, curl, openssl, tar, git, jq, socat) | PASS |
| Outbound Internet, DNS, latency, local port bind | PASS |
| Background process capability | PASS via `setsid`/`nohup` (tmux/screen and systemd unavailable) |
| systemd --user / auto-start after reboot | FAIL (platform stub; no user unit support) |
| Inbound raw TCP from Internet | **FAIL (platform-level blocker)** |
| Valid TLS / trusted certificate | **FAIL (no domain, no cert; TLS terminated by platform)** |
| REALITY feasibility | **FAIL (no transparent TCP inbound)** |

## 6. Decision

Per the project rules ("if the port cannot be opened from the Internet, do not claim the VPN works") deployment proceeds **only up to the point the environment permits**:

- Deploy the full stack rootless in `$HOME`: sing-box (VLESS over plain TCP on 8443 as a *lab* listener), Fastify API, SQLite, subscriptions, process scripts, tests, docs.
- Run **all local** system/account/API/concurrency/stability tests and report real numbers.
- Do **not** claim external VPN connectivity, TLS validity, or REALITY operation.
- Exit criteria requiring internet inbound / TLS / real client devices are marked **NOT TESTABLE — BLOCKED** with the exact reason above.

### Information needed to unblock

1. A VPS with a **public IP bound to its interface** and inbound TCP port (e.g. 8443) open, OR platform-level port forwarding that passes raw TCP (not an HTTP auth tunnel).
2. For TLS: a **domain you control** pointing to that IP, plus ACME certificate issuance (or an existing valid cert/key). For REALITY instead: raw TCP reachability plus a verified Shadowrocket version supporting REALITY.
3. Physical access to **up to 3 external client devices** (Shadowrocket on iOS) for genuine simultaneous-client and Wi-Fi↔4G/5G testing.
