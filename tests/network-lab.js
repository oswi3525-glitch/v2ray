'use strict';

/* Network lab. Measures direct vs VPN path from THIS host.
   Viettel client-side tests (Wi-Fi / 4G / 5G) require external devices and are reported as SKIP. */

const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync, execFileSync } = require('node:child_process');

const db = require('../api/db');
const { ROOT } = db;
const RUNTIME = path.join(ROOT, 'tests', 'runtime');
fs.mkdirSync(RUNTIME, { recursive: true });
const cfgEnv = require('../config/runtime');
const ADMIN = fs.readFileSync(path.join(ROOT, 'config', 'secrets.env'), 'utf8').match(/TIKTUNNEL_ADMIN_TOKEN=(.*)/)[1].trim();
const API = `http://127.0.0.1:${cfgEnv.apiPort}`;
const DOWNLOAD = 'https://speed.cloudflare.com/__down?bytes=5000000';
const TARGETS = [['1.1.1.1', 443], ['8.8.8.8', 443], ['github.com', 443]];

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function tcpLatency(host, port, n = 10) {
  return new Promise((resolve) => {
    const times = []; let done = 0;
    const one = () => new Promise((r) => {
      const t = Date.now();
      const s = net.connect(port, host);
      s.setTimeout(4000);
      s.on('connect', () => { times.push(Date.now() - t); s.destroy(); r(); });
      s.on('error', () => { times.push(null); s.destroy(); r(); });
      s.on('timeout', () => { times.push(null); s.destroy(); r(); });
    });
    (async () => {
      for (let i = 0; i < n; i++) await one();
      const good = times.filter((x) => x !== null);
      resolve({
        samples_ms: times,
        avg_ms: good.length ? +(good.reduce((a, b) => a + b, 0) / good.length).toFixed(2) : null,
        loss_pct: +((n - good.length) / n * 100).toFixed(1)
      });
    })();
  });
}

function dnsLatency(host) {
  const t = Date.now();
  return new Promise((resolve) => {
    net.connect(53, '127.0.0.53').on('error', () => resolve(null));
    require('node:dns').lookup(host, (err, addr) => resolve(err ? null : { ms: Date.now() - t, addr }));
  });
}

function download(socksPort) {
  const args = ['-sS', '-m', '30', '-o', '/dev/null',
    '-w', '%{http_code} %{size_download} %{speed_download} %{time_total} %{time_starttransfer}',
    ...(socksPort ? ['--socks5', `127.0.0.1:${socksPort}`] : []), DOWNLOAD];
  const r = spawnSync('curl', args, { encoding: 'utf8' });
  const p = (r.stdout || '').trim().split(/\s+/).map(Number);
  return {
    ok: r.status === 0 && p[0] === 200,
    http: p[0], bytes: p[1], bytes_per_s: Math.round(p[2] || 0),
    total_s: p[3], ttfb_s: p[4]
  };
}

async function main() {
  console.log('=== Network lab (direct vs VPN, measured on this host) ===');
  const out = { measured_at: new Date().toISOString(), location: 'Azure Codespaces, Singapore (NOT Viettel)', direct: {}, vpn: {}, limitations: [] };

  for (const [host, port] of TARGETS) out.direct[`${host}:${port}`] = await tcpLatency(host, port);
  out.direct.dns_github = await dnsLatency('github.com');
  out.direct.download = download(null);
  console.log('direct done');
  console.log('  download:', JSON.stringify(out.direct.download));

  // Dedicated lab user + client (does not disturb other accounts).
  const before = db.listActiveUsers().length;
  const r = await fetch(API + '/api/users', {
    method: 'POST',
    headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'network-lab' })
  });
  if (r.status !== 201) {
    out.limitations.push(`cannot create lab user (HTTP ${r.status}); VPN-side measurements skipped`);
  } else {
    const user = db.listActiveUsers().find((u) => u.name === 'network-lab');
    const cfg = {
      log: { level: 'error', output: path.join(RUNTIME, 'netlab-client.log') },
      inbounds: [{ type: 'socks', tag: 's', listen: '127.0.0.1', listen_port: 18400 }],
      outbounds: [{ type: 'vless', tag: 'p', server: '127.0.0.1', server_port: cfgEnv.serverPort, uuid: user.uuid, flow: '' }],
      route: { rules: [], final: 'p' }
    };
    const f = path.join(RUNTIME, 'netlab-client.json');
    fs.writeFileSync(f, JSON.stringify(cfg), { mode: 0o600 });
    const o = fs.openSync(path.join(RUNTIME, 'netlab-client-stdout.log'), 'a');
    const p = spawn(path.join(ROOT, 'bin', 'sing-box'), ['run', '-c', f], { cwd: ROOT, detached: true, stdio: ['ignore', o, o] });
    p.unref();
    await sleep(1500);
    out.vpn.download = download(18400);
    console.log('  vpn download:', JSON.stringify(out.vpn.download));
    try { process.kill(p.pid, 'SIGTERM'); } catch {}
    execFileSync('node', [path.join(ROOT, 'server', 'render-config.js')], { cwd: ROOT, stdio: 'ignore' });
    execFileSync('bash', [path.join(ROOT, 'scripts', 'apply-config.sh')], { cwd: ROOT, stdio: 'ignore' });
    db.revokeUser(user.id);
    execFileSync('bash', [path.join(ROOT, 'scripts', 'apply-config.sh')], { cwd: ROOT, stdio: 'ignore' });
  }

  out.limitations.push('Environment is not a Viettel network; no Viettel SIM, Wi-Fi or iOS device is available.');
  out.limitations.push('Wi-Fi vs 4G/5G comparison, VLESS import on Shadowrocket, and client-side DNS leak tests are BLOCKED.');
  out.limitations.push('VPN-side download uses the same host as both client and server, so it measures proxy overhead, not a remote client path.');

  const dir = path.join(ROOT, 'reports', 'runtime');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'network-lab.json'), JSON.stringify(out, null, 2) + '\n');
  console.log('saved reports/runtime/network-lab.json');
  process.exit(0);
}
main().catch((e) => { console.error('network lab error:', e.stack); process.exit(1); });
