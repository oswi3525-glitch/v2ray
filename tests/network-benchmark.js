'use strict';

/* Real measurements only. No synthetic speeds. Run with the control service started. */

const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { ROOT } = require('../control/db');
const envcfg = require('../config/runtime');

const BASE = `http://127.0.0.1:${envcfg.serverPort || 23952}`;
const OUT = path.join(ROOT, 'reports', 'runtime', 'network-benchmark.json');

function tcpProbe(host, port, timeout = 3000) {
  return new Promise((resolve) => {
    const t = process.hrtime.bigint();
    const s = net.connect(port, host);
    s.setTimeout(timeout);
    s.on('connect', () => { const ms = Number(process.hrtime.bigint() - t) / 1e6; s.destroy(); resolve(+ms.toFixed(2)); });
    s.on('error', () => resolve(null));
    s.on('timeout', () => { s.destroy(); resolve(null); });
  });
}
async function login(username, password) {
  const r = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`login failed: ${d.error || r.status}`);
  return { cookie: r.headers.get('set-cookie').split(';')[0], csrf: d.csrf };
}
async function main() {
  const credFile = path.join(ROOT, 'tests', 'runtime', 'test-credentials.json');
  const pw = fs.existsSync(credFile) ? JSON.parse(fs.readFileSync(credFile, 'utf8')).friend : null;
  const users = await (await fetch(BASE + '/api/admin/users', { headers: { cookie: (await login(envcfg.adminUsername, envcfg.adminPassword)).cookie } })).json();
  const friend = users.users.find((u) => !u.revoked_at);
  if (!friend || !pw) throw new Error('friend credentials unavailable; run npm test first');
  const auth = await login(friend.username, pw);

  const apiRtt = [];
  for (let i = 0; i < 20; i++) {
    const t = process.hrtime.bigint();
    await fetch(BASE + '/api/net/ping', { headers: { cookie: auth.cookie } });
    apiRtt.push(+(Number(process.hrtime.bigint() - t) / 1e6).toFixed(2));
  }
  const downloads = [];
  for (let i = 0; i < 4; i++) {
    const t = process.hrtime.bigint();
    const r = await fetch(BASE + '/api/net/download?bytes=1048576', { headers: { cookie: auth.cookie } });
    const buf = await r.arrayBuffer();
    const secs = Number(process.hrtime.bigint() - t) / 1e9;
    downloads.push(+(buf.byteLength * 8 / secs / 1e6).toFixed(2));
  }
  const targets = [['1.1.1.1', 443], ['8.8.8.8', 443], ['app-medium-1-ac2e.cldcode.host', 443]];
  const probes = {};
  for (const [h, p] of targets) {
    const samples = [];
    for (let i = 0; i < 8; i++) samples.push(await tcpProbe(h, p));
    const ok = samples.filter((x) => x !== null);
    probes[`${h}:${p}`] = { samples, average_ms: ok.length ? +(ok.reduce((a, b) => a + b, 0) / ok.length).toFixed(2) : null,
      peak_ms: ok.length ? Math.max(...ok) : null, packet_loss_pct: +((samples.length - ok.length) / samples.length * 100).toFixed(1) };
  }
  const stats = await (await fetch(BASE + '/api/monitor/server', { headers: { cookie: (await login(envcfg.adminUsername, envcfg.adminPassword)).cookie } })).json();
  const sorted = [...apiRtt].sort((a, b) => a - b);
  const report = {
    measured_at: new Date().toISOString(),
    note: 'Local loopback measurements to the TikTunnel endpoint. Not a substitute for iOS/Cloudcode client tests.',
    api_rtt_ms: { min: sorted[0], median: sorted[10], max: sorted.at(-1), samples: apiRtt },
    download_mbps: { samples: downloads, median: [...downloads].sort((a, b) => a - b)[2] },
    bytes_transferred: 4 * 1024 * 1024,
    tcp_probes: probes,
    host: { cpu_pct: stats.cpu_pct, ram_used_kb: stats.ram_used_kb }
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ api_median_ms: report.api_rtt_ms.median, download_median_mbps: report.download_mbps.median,
    probes: Object.fromEntries(Object.entries(probes).map(([k, v]) => [k, v.average_ms])), host: report.host }, null, 2));
}
main().catch((e) => { console.error('benchmark failed:', e.message); process.exit(1); });
