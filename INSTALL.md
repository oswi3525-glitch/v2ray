# INSTALL.md

## Prerequisites (verified on this machine)

- Ubuntu 24.04 (or compatible), x86_64, ordinary unprivileged user with a writable home.
- Node.js ≥ 22.5 (for built-in `node:sqlite`), npm, Python 3, curl, tar, openssl.
- Outbound Internet access to GitHub releases and npm registry.
- A writable project directory (here `$HOME/TikTunnel` → `/workspaces/v2ray`).

Not required / not used: root, sudo, systemd, Docker, tmux, screen.

## Steps

1. **Audit first** (do not skip):

   ```bash
   # Inspect OS, user, tools, ports, DNS, connectivity, inbound reachability
   # The completed report is reports/vps-audit.md
   ```

2. **Install sing-box** into `bin/` from the official GitHub release. Verify architecture (`uname -m` → x86_64 → `linux-amd64-musl`), confirm the static binary with `ldd`, pin its SHA-256 and check `sing-box version`. Record:

   ```
   sing-box 1.14.5
   sha256 9cf4d31acb76696c64b4c3214854bc72a68c703482781ddd2158dbf95ab9d06a
   ```

   Upstream publishes no checksum/signature asset for this release, so integrity relies on HTTPS transfer plus the locally recorded pin. Re-verify on every upgrade.

3. **Bootstrap**:

   ```bash
   cd "$HOME/TikTunnel"
   ./scripts/bootstrap.sh
   ```

   This generates `config/secrets.env` (chmod 600) **only if absent**, installs npm dependencies, renders `config/sing-box.json` and validates it. Existing secrets/data are never overwritten.

4. **Start**:

   ```bash
   ./scripts/start.sh
   ./scripts/status.sh
   ./scripts/health-check.sh
   ```

5. **Create accounts** via the admin API (see README) and export subscriptions.

6. **Test**:

   ```bash
   npm test
   ```

## Notes for this specific environment

- `systemctl` exists but is a container stub: `systemd is not running in this container`. `systemd --user` is unavailable, so `setsid`/`nohup` plus a watchdog are used.
- tmux/screen are not installed, hence no terminal multiplexer is required.
- Port 8443 was free and can be bound by the user. The Codespaces public port URL requires GitHub authentication and is not a raw TCP tunnel; inbound VLESS is therefore not reachable.
- Auto-start after VPS reboot is **not available** on this platform. On a normal VPS, set `@reboot /home/<user>/TikTunnel/scripts/start.sh` in the user crontab (no root needed) after confirming cron is available.

## Uninstall (manual)

```bash
./scripts/stop.sh
rm -rf "$HOME/TikTunnel" "$HOME/TikTunnel"   # remove symlink only after verifying path
```

Back up `database/`, `config/` and `subscriptions/` first.
