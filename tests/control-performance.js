'use strict';

const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const cdb = require('../control/db');
const cfg = require('../config/control.json');
const { ROOT } = cdb;
const RUNTIME = path.join(ROOT, 'tests', 'runtime');
fs.mkdirSync(RUNTIME, { recursive: true });

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function cpu() {
  const a = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0].split(/\s+/).slice(1).map(Number);
  return { idle: a[3], total: a.slice(0, 4).reduce((x, y) => x + y, 0) };
}
function pct(a, b) { const d = b.total - a.total; return d ? +(((d - (b.idle - a.idle)) / d) * 100).toFixed(2) : 0; }
function rss(pid) { try { return Number(fs.readFileSync(`/proc/${pid}/status`, 'utf8').match(/VmRSS:\s+(\d+)/)[1]); } catch { return 0; } }
function curlVia(port) {
  const t = Date.now();
  const r = spawnSync('curl', ['-sS', '-m', '20', '-o', '/dev/null', '-w', '%{http_code} %{size_download} %{speed_download}',
    '--socks5', `127.0.0.1:${port}`, 'http://127.0.0.1:18082/blob.bin'], { encoding: 'utf8' });
  const p = (r.stdout || '').trim().split(/\s+/).map(Number);
  return { ok: r.status === 0 && p[0] === 200, ms: Date.now() - t, bytes: p[1] || 0, bps: p[2] || 0 };
}
function tcp(host, port) {
  return new Promise((resolve) => {
    const t = Date.now(); const s = net.connect(port, host); s.setTimeout(4000);
    s.on('connect', () => { const ms = Date.now() - t; s.destroy(); resolve({ ok: true, ms }); });
    s.on('error', (e) => resolve({ ok: false, err: e.code }));
    s.on('timeout', () => { s.destroy(); resolve({ ok: false, err: 'ETIMEDOUT' }); });
  });
}

async function main() {
  const out = { measured_at: new Date().toISOString(), results: {} };
  const users = cdb.listUsers().filter((u) => !u.revoked_at).slice(0, 2);
  const sbPid = Number(fs.readFileSync(path.join(ROOT, 'logs', 'sing-box.pid'), 'utf8').trim());
  const apiPid = Number(fs.readFileSync(path.join(ROOT, 'logs', 'api.pid'), 'utf8').trim());
  out.results.idle = { singbox_rss_kb: rss(sbPid), api_rss_kb: rss(apiPid) };

  out.results.dns = await new Promise((r) => require('node:dns').lookup('vn-hn.cldcode.host', (e, a) => r(e ? null : a)));
  out.results.external_tcp_23952 = await tcp('vn-hn.cldcode.host', 23952);
  out.results.https_subdomain_443 = await tcp(cfg.public_https_host, 443);
  out.results.probes = {};
  for (const e of cfg.probe_endpoints) {
    const [h, p] = e.split(':');
    out.results.probes[e] = await tcp(h, Number(p));
  }

  const o = fs.openSync(path.join(RUNTIME, 'perf-blob.log'), 'a');
  const blob = spawn('python3', [path.join(ROOT, 'tests', 'blob-server.py')], { cwd: ROOT, detached: true, stdio: ['ignore', o, o] });
  blob.unref();
  await sleep(1800);

  const clients = users.map((u, i) => {
    const s = cdb.getSubscription(u.id);
    const f = path.join(RUNTIME, `perf-client-${i}.json`);
    fs.writeFileSync(f, JSON.stringify({
      log: { level: 'error', output: path.join(RUNTIME, `perf-client-${i}.log`) },
      inbounds: [{ type: 'socks', tag: 's', listen: '127.0.0.1', listen_port: 18800 + i }],
      outbounds: [{ type: 'vless', tag: 'p', server: '127.0.0.1', server_port: cfg.app_port, uuid: cdb.getVpnClient(u.id).uuid,
        transport: { type: 'ws', path: s.path } }],
      route: { rules: [], final: 'p' }
    }), { mode: 0o600 });
    const so = fs.openSync(path.join(RUNTIME, `perf-client-${i}-stdout.log`), 'a');
    const p = spawn(path.join(ROOT, 'bin', 'sing-box'), ['run', '-c', f], { cwd: ROOT, detached: true, stdio: ['ignore', so, so] });
    p.unref();
    return p.pid;
  });
  await sleep(2000);

  for (const n of [1, 2]) {
    const c0 = cpu(), r0 = rss(sbPid);
    const t0 = Date.now();
    const rs = await Promise.all(Array.from({ length: n }, (_, i) => Promise.resolve(curlVia(18800 + i))));
    const el = (Date.now() - t0) / 1000;
    out.results[`clients_${n}`] = {
      all_ok: rs.every((r) => r.ok),
      aggregate_mbit_s: +((rs.reduce((a, r) => a + r.bytes, 0) * 8) / el / 1e6).toFixed(2),
      latency_ms: rs.map((r) => r.ms),
      cpu_pct: pct(c0, cpu()), rss_delta_kb: rss(sbPid) - r0
    };
    console.log(`clients=${n}`, JSON.stringify(out.results[`clients_${n}`]));
  }
  for (const p of clients) { try { process.kill(p, 'SIGTERM'); } catch {} }
  try { process.kill(blob.pid, 'SIGTERM'); } catch {}
  fs.mkdirSync(path.join(ROOT, 'reports', 'runtime'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'reports', 'runtime', 'control-performance.json'), JSON.stringify(out, null, 2) + '\n');
  console.log('saved control-performance.json');
  process.exit(0);
}
main().catch((e) => { console.error(e.stack); process.exit(1); });
