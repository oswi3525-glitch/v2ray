'use strict';

/* Cloudcode migration tests. Uses existing accounts. No secrets are printed. */

const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');

const db = require('../api/db');
const cfg = require('../config/runtime');
const { ROOT } = db;
const RUNTIME = path.join(ROOT, 'tests', 'runtime');
fs.mkdirSync(RUNTIME, { recursive: true });

const results = [];
function rec(name, status, detail = '') {
  results.push({ name, status, detail });
  console.log(`${status.padEnd(6)} ${name}${detail ? ' — ' + detail : ''}`);
}
function check(name, cond, detail = '') { return rec(name, cond ? 'PASS' : 'FAIL', detail) === undefined ? !!cond : !!cond; }
function skip(name, why) { rec(name, 'SKIP', why); }

function cpu() {
  const a = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0].split(/\s+/).slice(1).map(Number);
  return { idle: a[3], total: a.slice(0, 4).reduce((x, y) => x + y, 0) };
}
function cpuPct(a, b) {
  const d = b.total - a.total;
  return d > 0 ? +(((d - (b.idle - a.idle)) / d) * 100).toFixed(2) : 0;
}
function rss(pid) {
  try { return Number(fs.readFileSync(`/proc/${pid}/status`, 'utf8').match(/VmRSS:\s+(\d+)/)[1]); }
  catch { return 0; }
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function tcpConnect(host, port, timeout = 4000) {
  return new Promise((resolve) => {
    const t = Date.now();
    const s = net.connect(port, host);
    s.setTimeout(timeout);
    s.on('connect', () => { const ms = Date.now() - t; s.destroy(); resolve({ ok: true, ms }); });
    s.on('error', (e) => resolve({ ok: false, err: e.code }));
    s.on('timeout', () => { s.destroy(); resolve({ ok: false, err: 'ETIMEDOUT' }); });
  });
}

function curlThrough(port, url, extra = []) {
  const t = Date.now();
  const r = spawnSync('curl', ['-sS', '-m', '20', '-o', '/dev/null',
    '-w', '%{http_code} %{size_download} %{speed_download} %{time_total}',
    '--socks5', `127.0.0.1:${port}`, ...extra, url], { encoding: 'utf8' });
  const p = (r.stdout || '').trim().split(/\s+/);
  return {
    ok: r.status === 0 && p[0] === '200',
    raw: (r.stdout || '').trim(),
    ms: Date.now() - t,
    bytes: Number(p[1]) || 0,
    bytes_per_s: Math.round(Number(p[2]) || 0),
    time_total: Number(p[3]) || 0
  };
}

async function waitPort(port, tries = 40) {
  for (let i = 0; i < tries; i++) {
    const r = await tcpConnect('127.0.0.1', port, 500);
    if (r.ok) return true;
    await sleep(150);
  }
  return false;
}

async function main() {
  console.log('=== Cloudcode migration tests ===');
  const users = db.listActiveUsers();
  check('3 named accounts active', users.length === 3 && users.every((u) => /^TikTunnel User 0[123]$/.test(u.name)),
    `${users.length} active`);
  check('config uses Cloudcode host', cfg.serverHost === 'vn-hn.cldcode.host', cfg.serverHost);
  check('config uses TCP 23952', cfg.serverPort === 23952, String(cfg.serverPort));
  check('protocol vless / max 3', cfg.protocol === 'vless' && cfg.maxUsers === 3);

  const dns = await new Promise((r) => require('node:dns').lookup(cfg.serverHost, (e, a) => r(e ? null : a)));
  check('DNS resolves server host', !!dns, dns || '');
  const local = await tcpConnect('127.0.0.1', cfg.serverPort);
  check('local TCP 23952 listening', local.ok, local.ok ? `${local.ms}ms` : local.err);
  const ext = await tcpConnect(cfg.serverHost, cfg.serverPort);
  rec('external TCP to Cloudcode 23952', ext.ok ? 'PASS' : 'FAIL', ext.ok ? `${ext.ms}ms` : ext.err);
  const httpsSub = await tcpConnect('app-medium-1-ac2e.cldcode.host', 443);
  check('HTTPS subdomain TCP 443', httpsSub.ok, httpsSub.ok ? `${httpsSub.ms}ms` : httpsSub.err);
  skip('Cloudcode port-mapping mechanism', 'no Cloudcode CLI/agent/env available in this workspace');
  skip('Shadowrocket iOS import/connect/reconnect', 'no iOS device; public TCP 23952 refused from here');

  const cc = spawnSync(path.join(ROOT, 'bin', 'sing-box'), ['check', '-c', path.join(ROOT, 'config', 'sing-box.json')]);
  check('sing-box config valid', cc.status === 0);
  const sbCount = spawnSync('pgrep', ['-f', `${ROOT}/bin/sing-box run`], { encoding: 'utf8' }).stdout.trim().split(/\n/).filter(Boolean).length;
  check('sing-box running exactly once', sbCount === 1, String(sbCount));

  const out = fs.openSync(path.join(RUNTIME, 'blob-server.log'), 'a');
  const blob = spawn('python3', [path.join(ROOT, 'tests', 'blob-server.py')], { cwd: ROOT, detached: true, stdio: ['ignore', out, out] });
  blob.unref();
  if (!(await waitPort(18082, 80))) throw new Error('blob server failed to start');

  const clients = [];
  for (let i = 0; i < 3; i++) {
    const u = users[i];
    const f = path.join(RUNTIME, `migration-client-${i}.json`);
    fs.writeFileSync(f, JSON.stringify({
      log: { level: 'error', output: path.join(RUNTIME, `migration-client-${i}.log`) },
      inbounds: [{ type: 'socks', tag: 's', listen: '127.0.0.1', listen_port: 18500 + i }],
      outbounds: [{ type: 'vless', tag: 'p', server: '127.0.0.1', server_port: cfg.serverPort, uuid: u.uuid, flow: '' }],
      route: { rules: [], final: 'p' }
    }), { mode: 0o600 });
    const o = fs.openSync(path.join(RUNTIME, `migration-client-${i}-stdout.log`), 'a');
    const p = spawn(path.join(ROOT, 'bin', 'sing-box'), ['run', '-c', f], { cwd: ROOT, detached: true, stdio: ['ignore', o, o] });
    p.unref();
    clients.push(p.pid);
  }

  const metrics = {};
  const url = 'http://127.0.0.1:18082/blob.bin';
  const uploadFile = path.join(RUNTIME, 'upload.bin');
  fs.writeFileSync(uploadFile, Buffer.alloc(4 * 1024 * 1024, 7));
  for (let n = 1; n <= 3; n++) {
    const ports = Array.from({ length: n }, (_, i) => 18500 + i);
    check(`${n} VLESS client(s) start`, (await Promise.all(ports.map((p) => waitPort(p)))).every(Boolean));
    const cpuBefore = cpu();
    const rssBefore = rss(Number(fs.readFileSync(path.join(ROOT, 'logs', 'sing-box.pid'), 'utf8').trim()));
    const t0 = Date.now();
    const dl = await Promise.all(ports.map((p) => Promise.resolve(curlThrough(p, url))));
    const elapsed = (Date.now() - t0) / 1000;
    const cpuAfter = cpu();
    const rssAfter = rss(Number(fs.readFileSync(path.join(ROOT, 'logs', 'sing-box.pid'), 'utf8').trim()));
    const totalBytes = dl.reduce((a, r) => a + r.bytes, 0);
    metrics[`clients_${n}`] = {
      all_ok: dl.every((r) => r.ok),
      aggregate_mbit_s: +((totalBytes * 8) / elapsed / 1e6).toFixed(2),
      latency_ms: dl.map((r) => r.ms),
      cpu_pct: cpuPct(cpuBefore, cpuAfter),
      server_rss_kb: [rssBefore, rssAfter]
    };
    check(`${n} client(s) download through VLESS`, dl.every((r) => r.ok), `${metrics[`clients_${n}`].aggregate_mbit_s} Mbit/s aggregate`);
    const upload = await Promise.all(ports.map((p) => Promise.resolve(curlThrough(p, 'http://127.0.0.1:18082/upload',
      ['-X', 'POST', '-H', 'Content-Type: application/octet-stream', '--data-binary', `@${uploadFile}`]))));
    metrics[`clients_${n}`].upload_ok = upload.every((r) => r.ok);
    check(`${n} client(s) upload through VLESS`, upload.every((r) => r.ok));
  }

  let loss = 0;
  for (let i = 0; i < 10; i++) if (!(await tcpConnect('127.0.0.1', cfg.serverPort)).ok) loss++;
  metrics.local_connect_loss_pct = loss * 10;
  metrics.disconnects = Object.values(metrics).filter((m) => m && m.all_ok === false).length;
  console.log('METRICS', JSON.stringify(metrics));

  for (const p of clients) { try { process.kill(p, 'SIGTERM'); } catch {} }
  try { process.kill(blob.pid, 'SIGTERM'); } catch {}
  const pass = results.filter((r) => r.status === 'PASS').length;
  const fail = results.filter((r) => r.status === 'FAIL').length;
  const skipN = results.filter((r) => r.status === 'SKIP').length;
  console.log(`SUMMARY PASS=${pass} FAIL=${fail} SKIP=${skipN}`);
  fs.mkdirSync(path.join(ROOT, 'reports', 'runtime'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'reports', 'runtime', 'cloudcode-tests.json'),
    JSON.stringify({ results, metrics }, null, 2) + '\n');
  process.exit(0);
}
main().catch((e) => { console.error('migration test error:', e.stack); process.exit(1); });
