'use strict';

/* Long-run stability test. Usage: node tests/stability.js [seconds] (default 1800). */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync, execFileSync } = require('node:child_process');

const db = require('../api/db');
const { ROOT } = db;
const RUNTIME = path.join(ROOT, 'tests', 'runtime');
fs.mkdirSync(RUNTIME, { recursive: true });
const cfgEnv = require('../config/runtime');
const ADMIN = fs.readFileSync(path.join(ROOT, 'config', 'secrets.env'), 'utf8').match(/TIKTUNNEL_ADMIN_TOKEN=(.*)/)[1].trim();
const API = `http://127.0.0.1:${cfgEnv.apiPort}`;
const DURATION = Number(process.argv[2] || 1800);

async function req(method, url, body) {
  const r = await fetch(API + url, {
    method,
    headers: { authorization: `Bearer ${ADMIN}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: r.status, data: await r.json().catch(() => null) };
}

function rss(pid) {
  try {
    const m = fs.readFileSync(`/proc/${pid}/status`, 'utf8').match(/VmRSS:\s+(\d+)/);
    return m ? Number(m[1]) : 0;
  } catch { return 0; }
}
function cpu() {
  const a = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0].split(/\s+/).slice(1).map(Number);
  return { idle: a[3], total: a.slice(0, 4).reduce((x, y) => x + y, 0) };
}
function cpuPct(a, b) {
  const d = b.total - a.total;
  return d > 0 ? +(((d - (b.idle - a.idle)) / d) * 100).toFixed(2) : 0;
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  for (const u of db.listUsers()) if (!u.revoked_at) db.revokeUser(u.id);
  execFileSync('bash', [path.join(ROOT, 'scripts', 'apply-config.sh')], { cwd: ROOT, stdio: 'ignore' });
  const users = [];
  for (let i = 1; i <= 3; i++) {
    const r = await req('POST', '/api/users', { name: `stability-${i}` });
    if (r.status !== 201) throw new Error('create failed');
    users.push(db.listActiveUsers().find((u) => u.name === `stability-${i}`));
  }
  const www = path.join(RUNTIME, 'www-stability');
  fs.mkdirSync(www, { recursive: true });
  fs.writeFileSync(path.join(www, 'blob.bin'), crypto.randomBytes(1024 * 1024));
  const wout = fs.openSync(path.join(RUNTIME, 'www-stability.log'), 'a');
  const wwwProc = spawn('python3', ['-m', 'http.server', '18081', '--bind', '127.0.0.1', '--directory', www],
    { cwd: ROOT, detached: true, stdio: ['ignore', wout, wout] });
  wwwProc.unref();
  await sleep(600);

  let clients = [];
  function startClients() {
    clients = [];
    for (let i = 0; i < 3; i++) {
      const cfg = {
        log: { level: 'error', output: path.join(RUNTIME, `stability-client-${i}.log`) },
        inbounds: [{ type: 'socks', tag: 's', listen: '127.0.0.1', listen_port: 18300 + i }],
        outbounds: [{ type: 'vless', tag: 'p', server: '127.0.0.1', server_port: cfgEnv.serverPort, uuid: users[i].uuid, flow: '' }],
        route: { rules: [], final: 'p' }
      };
      const f = path.join(RUNTIME, `stability-client-${i}.json`);
      fs.writeFileSync(f, JSON.stringify(cfg));
      const o = fs.openSync(path.join(RUNTIME, `stability-client-${i}-stdout.log`), 'a');
      const p = spawn(path.join(ROOT, 'bin', 'sing-box'), ['run', '-c', f], { cwd: ROOT, detached: true, stdio: ['ignore', o, o] });
      p.unref();
      clients.push(p.pid);
    }
  }
  function stopClients() {
    for (const c of clients) { try { process.kill(c, 'SIGTERM'); } catch {} }
    clients = [];
  }
  function readPids() {
    return {
      sb: Number(fs.readFileSync(path.join(ROOT, 'logs', 'sing-box.pid'), 'utf8').trim()),
      api: Number(fs.readFileSync(path.join(ROOT, 'logs', 'api.pid'), 'utf8').trim())
    };
  }
  startClients();
  await sleep(1200);
  let pids = readPids();
  const csv = path.join(ROOT, 'reports', 'runtime', 'stability.csv');
  fs.mkdirSync(path.dirname(csv), { recursive: true });
  fs.writeFileSync(csv, 'elapsed_s,server_rss_kb,api_rss_kb,cpu_pct,connections,traffic_ok,traffic_fail\n');

  const start = Date.now();
  let lastCpu = cpu(), ok = 0, fail = 0, restarts = 0, didRestart = false;
  const samples = [];
  console.log(`stability run started: ${DURATION}s`);

  while ((Date.now() - start) / 1000 < DURATION) {
    await sleep(10_000);
    const el = Math.floor((Date.now() - start) / 1000);
    const c = cpu();
    pids = readPids();
    const rssSb = rss(pids.sb), rssApi = rss(pids.api);
    const conn = spawnSync('ss', ['-tn'], { encoding: 'utf8' }).stdout.split('\n').length - 1;
    let okn = 0, failn = 0;
    for (let i = 0; i < 3; i++) {
      const r = spawnSync('curl', ['-sS', '-m', '8', '-o', '/dev/null', '-w', '%{http_code}',
        '--socks5', `127.0.0.1:${18300 + i}`, 'http://127.0.0.1:18081/blob.bin'], { encoding: 'utf8' });
      if (r.status === 0 && r.stdout.trim() === '200') okn++; else failn++;
    }
    ok += okn; fail += failn;
    const pct = cpuPct(lastCpu, c); lastCpu = c;
    samples.push({ el, rssSb, rssApi, pct, okn, failn });
    fs.appendFileSync(csv, `${el},${rssSb},${rssApi},${pct},${conn},${okn},${failn}\n`);

    if (!didRestart && el >= Math.floor(DURATION / 2)) {
      didRestart = true;
      execFileSync('bash', [path.join(ROOT, 'scripts', 'restart.sh')], { cwd: ROOT, stdio: 'ignore' });
      restarts++;
      await sleep(2000);
      stopClients();
      startClients();
      await sleep(1500);
      const r = spawnSync('curl', ['-sS', '-m', '8', '-o', '/dev/null', '-w', '%{http_code}',
        '--socks5', '127.0.0.1:18300', 'http://127.0.0.1:18081/blob.bin'], { encoding: 'utf8' });
      console.log(`restart recovery check: ${r.status === 0 && r.stdout.trim() === '200' ? 'PASS' : 'FAIL'}`);
    }
    if (el % 60 === 0) console.log(`  t=${el}s rss_server=${rssSb}kB rss_api=${rssApi}kB cpu=${pct}% traffic=${okn}/${okn + failn}`);
  }

  const first = samples[0], last = samples[samples.length - 1];
  const summary = {
    duration_s: DURATION,
    samples: samples.length,
    rss_server_start_kb: first?.rssSb || 0,
    rss_server_end_kb: last?.rssSb || 0,
    rss_server_growth_kb: (last?.rssSb || 0) - (first?.rssSb || 0),
    rss_api_start_kb: first?.rssApi || 0,
    rss_api_end_kb: last?.rssApi || 0,
    cpu_avg_pct: +(samples.reduce((a, s) => a + s.pct, 0) / (samples.length || 1)).toFixed(2),
    cpu_max_pct: Math.max(0, ...samples.map((s) => s.pct)),
    traffic_success: ok,
    traffic_failures: fail,
    restarts,
    completed: (Date.now() - start) / 1000 >= DURATION
  };
  fs.writeFileSync(path.join(ROOT, 'reports', 'runtime', 'stability-summary.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log('stability summary:', JSON.stringify(summary));

  stopClients();
  try { process.kill(wwwProc.pid, 'SIGTERM'); } catch {}
  for (const u of db.listUsers()) if (!u.revoked_at) db.revokeUser(u.id);
  execFileSync('bash', [path.join(ROOT, 'scripts', 'apply-config.sh')], { cwd: ROOT, stdio: 'ignore' });
  process.exit(0);
}
main().catch((e) => { console.error('stability error:', e.stack); process.exit(1); });
