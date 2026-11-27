'use strict';

/* Non-destructive stability check using the 3 existing accounts. */

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync, execFileSync } = require('node:child_process');

const db = require('../api/db');
const cfg = require('../config/runtime');
const { ROOT } = db;
const RUNTIME = path.join(ROOT, 'tests', 'runtime');
fs.mkdirSync(RUNTIME, { recursive: true });
const DURATION = Number(process.argv[2] || 300);

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function rss(pid) {
  try { return Number(fs.readFileSync(`/proc/${pid}/status`, 'utf8').match(/VmRSS:\s+(\d+)/)[1]); }
  catch { return 0; }
}
function cpu() {
  const a = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0].split(/\s+/).slice(1).map(Number);
  return { idle: a[3], total: a.slice(0, 4).reduce((x, y) => x + y, 0) };
}
function cpuPct(a, b) {
  const d = b.total - a.total;
  return d > 0 ? +(((d - (b.idle - a.idle)) / d) * 100).toFixed(2) : 0;
}

async function main() {
  const users = db.listActiveUsers();
  if (users.length < 3) throw new Error('expected 3 active accounts');
  const out = fs.openSync(path.join(RUNTIME, 'cloudcode-blob.log'), 'a');
  const blob = spawn('python3', [path.join(ROOT, 'tests', 'blob-server.py')], { cwd: ROOT, detached: true, stdio: ['ignore', out, out] });
  blob.unref();
  const net = require('node:net');
  let ready = false;
  for (let i = 0; i < 80 && !ready; i++) {
    ready = await new Promise((r) => {
      const s = net.connect(18082, '127.0.0.1');
      s.on('connect', () => { s.destroy(); r(true); });
      s.on('error', () => r(false));
    });
    if (!ready) await sleep(150);
  }
  if (!ready) throw new Error('blob server failed to start');

  let clients = [];
  function startClients() {
    const stale = spawnSync('pgrep', ['-f', 'cc-stability-[0-9]\\.json'], { encoding: 'utf8' }).stdout.trim().split(/\n/).filter(Boolean);
    for (const sp of stale) { try { process.kill(Number(sp), 'SIGTERM'); } catch {} }
    if (stale.length) sleep(500);
    clients = [];
    for (let i = 0; i < 3; i++) {
      const f = path.join(RUNTIME, `cc-stability-${i}.json`);
      fs.writeFileSync(f, JSON.stringify({
        log: { level: 'error', output: path.join(RUNTIME, `cc-stability-${i}.log`) },
        inbounds: [{ type: 'socks', tag: 's', listen: '127.0.0.1', listen_port: 18600 + i }],
        outbounds: [{ type: 'vless', tag: 'p', server: '127.0.0.1', server_port: cfg.serverPort, uuid: users[i].uuid, flow: '' }],
        route: { rules: [], final: 'p' }
      }), { mode: 0o600 });
      const o = fs.openSync(path.join(RUNTIME, `cc-stability-${i}-stdout.log`), 'a');
      const p = spawn(path.join(ROOT, 'bin', 'sing-box'), ['run', '-c', f], { cwd: ROOT, detached: true, stdio: ['ignore', o, o] });
      p.unref();
      clients.push(p.pid);
    }
  }
  function stopClients() {
    for (const p of clients) { try { process.kill(p, 'SIGTERM'); } catch {} }
    clients = [];
  }
  function pids() {
    return {
      sb: Number(fs.readFileSync(path.join(ROOT, 'logs', 'sing-box.pid'), 'utf8').trim()),
      api: Number(fs.readFileSync(path.join(ROOT, 'logs', 'api.pid'), 'utf8').trim())
    };
  }
  function fetchVia(port) {
    const r = spawnSync('curl', ['-sS', '-m', '10', '-o', '/dev/null', '-w', '%{http_code}',
      '--socks5', `127.0.0.1:${port}`, 'http://127.0.0.1:18082/blob.bin'], { encoding: 'utf8' });
    return r.status === 0 && r.stdout.trim() === '200';
  }

  startClients();
  for (let i = 0; i < 3; i++) {
    let up = false;
    for (let k = 0; k < 40 && !up; k++) {
      up = await new Promise((r) => {
        const s = require('node:net').connect(18600 + i, '127.0.0.1');
        s.on('connect', () => { s.destroy(); r(true); });
        s.on('error', () => r(false));
      });
      if (!up) await sleep(150);
    }
    if (!up) throw new Error(`client ${i} socks port not up`);
  }
  const start = Date.now();
  let last = cpu(), ok = 0, fail = 0, didRestart = false, recovery = null;
  const samples = [];
  console.log(`cloudcode stability started: ${DURATION}s (local VLESS clients on ${cfg.serverPort})`);
  while ((Date.now() - start) / 1000 < DURATION) {
    await sleep(10_000);
    const el = Math.floor((Date.now() - start) / 1000);
    const c = cpu();
    const p = pids();
    let o = 0, f = 0;
    for (let i = 0; i < 3; i++) { if (fetchVia(18600 + i)) o++; else f++; }
    ok += o; fail += f;
    samples.push({ el, sbRss: rss(p.sb), apiRss: rss(p.api), cpu: cpuPct(last, c), ok: o, fail: f });
    last = c;
    if (!didRestart && el >= Math.floor(DURATION / 2)) {
      didRestart = true;
      execFileSync('bash', [path.join(ROOT, 'scripts', 'restart.sh')], { cwd: ROOT, stdio: 'ignore' });
      await sleep(2000);
      stopClients(); startClients();
      await sleep(2000);
      recovery = fetchVia(18600) ? 'PASS' : 'FAIL';
      console.log(`restart recovery: ${recovery}`);
    }
    if (el % 60 === 0) console.log(`  t=${el}s ok=${o}/3 fail=${f}`);
  }
  const summary = {
    duration_s: Math.floor((Date.now() - start) / 1000),
    samples: samples.length,
    sb_rss_start_kb: samples[0].sbRss, sb_rss_end_kb: samples[samples.length - 1].sbRss,
    api_rss_start_kb: samples[0].apiRss, api_rss_end_kb: samples[samples.length - 1].apiRss,
    cpu_avg_pct: +(samples.reduce((a, s) => a + s.cpu, 0) / samples.length).toFixed(2),
    cpu_max_pct: Math.max(...samples.map((s) => s.cpu)),
    transfers_ok: ok, transfers_fail: fail, restart_recovery: recovery,
    completed_30_min: false, reason: 'local-only; no Cloudcode access and public TCP 23952 refused'
  };
  fs.mkdirSync(path.join(ROOT, 'reports', 'runtime'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'reports', 'runtime', 'cloudcode-stability.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log('summary', JSON.stringify(summary));
  stopClients();
  try { process.kill(blob.pid, 'SIGTERM'); } catch {}
  process.exit(0);
}
main().catch((e) => { console.error('stability error:', e.stack); process.exit(1); });
