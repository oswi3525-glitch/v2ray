'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const cdb = require('../control/db');
const cfg = require('../config/control.json');
const { ROOT } = cdb;
const RUNTIME = path.join(ROOT, 'tests', 'runtime');
const DURATION = Number(process.argv[2] || 120);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function rss(pid) { try { return Number(fs.readFileSync(`/proc/${pid}/status`, 'utf8').match(/VmRSS:\s+(\d+)/)[1]); } catch { return 0; } }
function cpu() { const a = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0].split(/\s+/).slice(1).map(Number); return { idle: a[3], total: a.slice(0, 4).reduce((x, y) => x + y, 0) }; }
function pct(a, b) { const d = b.total - a.total; return d ? +(((d - (b.idle - a.idle)) / d) * 100).toFixed(2) : 0; }
function fetchVia(p) { const r = spawnSync('curl', ['-sS', '-m', '10', '-o', '/dev/null', '-w', '%{http_code}', '--socks5', `127.0.0.1:${p}`, 'http://127.0.0.1:18082/blob.bin'], { encoding: 'utf8' }); return r.status === 0 && r.stdout.trim() === '200'; }

async function main() {
  const users = cdb.listUsers().filter((u) => !u.revoked_at).slice(0, 2);
  const o = fs.openSync(path.join(RUNTIME, 'stab-blob.log'), 'a');
  const blob = spawn('python3', [path.join(ROOT, 'tests', 'blob-server.py')], { cwd: ROOT, detached: true, stdio: ['ignore', o, o] });
  blob.unref(); await sleep(1800);
  let clients = [];
  function start() {
    clients = [];
    users.forEach((u, i) => {
      const f = path.join(RUNTIME, `stab-ws-${i}.json`);
      fs.writeFileSync(f, JSON.stringify({ log: { level: 'error', output: path.join(RUNTIME, `stab-ws-${i}.log`) },
        inbounds: [{ type: 'socks', tag: 's', listen: '127.0.0.1', listen_port: 18900 + i }],
        outbounds: [{ type: 'vless', tag: 'p', server: '127.0.0.1', server_port: cfg.app_port, uuid: cdb.getVpnClient(u.id).uuid,
          transport: { type: 'ws', path: cdb.getSubscription(u.id).path } }],
        route: { rules: [], final: 'p' } }));
      const so = fs.openSync(path.join(RUNTIME, `stab-ws-${i}-out.log`), 'a');
      const p = spawn(path.join(ROOT, 'bin', 'sing-box'), ['run', '-c', f], { cwd: ROOT, detached: true, stdio: ['ignore', so, so] });
      p.unref(); clients.push(p.pid);
    });
  }
  start(); await sleep(2000);
  const sb = Number(fs.readFileSync(path.join(ROOT, 'logs', 'sing-box.pid'), 'utf8').trim());
  const t0 = Date.now(); let last = cpu(), ok = 0, fail = 0, recovery = null;
  const samples = [];
  console.log(`control stability ${DURATION}s`);
  while ((Date.now() - t0) / 1000 < DURATION) {
    await sleep(10000);
    const el = Math.floor((Date.now() - t0) / 1000); const c = cpu();
    let o2 = 0, f2 = 0;
    for (let i = 0; i < 2; i++) { if (fetchVia(18900 + i)) o2++; else f2++; }
    ok += o2; fail += f2;
    samples.push({ el, rss: rss(sb), cpu: pct(last, c), ok: o2, fail: f2 }); last = c;
    if (recovery === null && el >= Math.floor(DURATION / 2)) {
      execFileSync('bash', [path.join(ROOT, 'scripts', 'restart.sh')], { cwd: ROOT, stdio: 'ignore' });
      await sleep(2000); start(); await sleep(2000);
      recovery = fetchVia(18900) ? 'PASS' : 'FAIL';
    }
    if (el % 30 === 0) console.log(`t=${el}s ok=${o2}/2 fail=${f2}`);
  }
  const summary = { duration_s: Math.floor((Date.now() - t0) / 1000), samples: samples.length,
    rss_start_kb: samples[0].rss, rss_end_kb: samples[samples.length - 1].rss,
    cpu_avg_pct: +(samples.reduce((a, s) => a + s.cpu, 0) / samples.length).toFixed(2),
    transfers_ok: ok, transfers_fail: fail, restart_recovery: recovery,
    completed_30_min: false, reason: 'external Cloudcode TCP/WS path unavailable; local-only smoke' };
  fs.writeFileSync(path.join(ROOT, 'reports', 'runtime', 'control-stability.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log('summary', JSON.stringify(summary));
  for (const p of clients) { try { process.kill(p, 'SIGTERM'); } catch {} }
  try { process.kill(blob.pid, 'SIGTERM'); } catch {}
  process.exit(0);
}
main().catch((e) => { console.error(e.stack); process.exit(1); });
