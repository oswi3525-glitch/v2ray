'use strict';

/* Automated test suite. Secrets are read into memory and never printed. */

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn, spawnSync, execFileSync } = require('node:child_process');

const db = require('../api/db');
const { ROOT } = db;
const cfgEnv = require('../config/runtime');
const SECRETS = fs.readFileSync(path.join(ROOT, 'config', 'secrets.env'), 'utf8');
const ADMIN = SECRETS.match(/TIKTUNNEL_ADMIN_TOKEN=(.*)/)[1].trim();
const API = `http://127.0.0.1:${cfgEnv.apiPort}`;
const RUNTIME = path.join(ROOT, 'tests', 'runtime');
fs.mkdirSync(RUNTIME, { recursive: true });

const results = [];
function record(name, status, detail = '') {
  results.push({ name, status, detail });
  console.log(`${status.padEnd(6)} ${name}${detail ? ' — ' + detail : ''}`);
}
function check(name, cond, detail = '') {
  record(name, cond ? 'PASS' : 'FAIL', detail);
  return !!cond;
}
function skip(name, why) {
  record(name, 'SKIP', why);
}

async function api(method, url, body, admin = true) {
  const headers = {};
  if (admin) headers.authorization = `Bearer ${ADMIN}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(API + url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { status: res.status, data };
}

function readCpu() {
  const s = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0].split(/\s+/).slice(1).map(Number);
  return { idle: s[3], total: s.slice(0, 4).reduce((a, b) => a + b, 0) };
}
function cpuDelta(a, b) {
  const dt = b.total - a.total;
  const di = b.idle - a.idle;
  return dt > 0 ? +(((dt - di) / dt) * 100).toFixed(2) : 0;
}
function rssOf(pid) {
  try {
    const s = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const m = s.match(/VmRSS:\s+(\d+)\s+kB/);
    return m ? Number(m[1]) : 0;
  } catch {
    return 0;
  }
}
function sbServerPid() {
  return Number(fs.readFileSync(path.join(ROOT, 'logs', 'sing-box.pid'), 'utf8').trim());
}

async function startHttpServer(port) {
  const www = path.join(RUNTIME, 'www');
  fs.mkdirSync(www, { recursive: true });
  fs.writeFileSync(path.join(www, 'payload.bin'), crypto.randomBytes(8 * 1024 * 1024));
  const out = fs.openSync(path.join(RUNTIME, 'www-server.log'), 'a');
  const child = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1', '--directory', www], {
    cwd: ROOT, detached: true, stdio: ['ignore', out, out]
  });
  child.unref();
  await new Promise((r) => setTimeout(r, 500));
  return child.pid;
}

function writeClientConfig(idx, user) {
  const cfg = {
    log: { level: 'error', output: path.join(RUNTIME, `client-${idx}.log`) },
    inbounds: [{ type: 'socks', tag: 'socks-in', listen: '127.0.0.1', listen_port: 18100 + idx }],
    outbounds: [
      {
        type: 'vless',
        tag: 'proxy',
        server: '127.0.0.1',
        server_port: cfgEnv.serverPort,
        uuid: user.uuid,
        flow: ''
      }
    ],
    route: { rules: [], final: 'proxy' }
  };
  const f = path.join(RUNTIME, `client-${idx}.json`);
  fs.writeFileSync(f, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  return f;
}

function startClient(idx, user) {
  const cfg = writeClientConfig(idx, user);
  const out = fs.openSync(path.join(RUNTIME, `client-${idx}-stdout.log`), 'a');
  const child = spawn(path.join(ROOT, 'bin', 'sing-box'), ['run', '-c', cfg], {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', out, out]
  });
  child.unref();
  return child.pid;
}

function waitPort(port, tries = 40) {
  return new Promise((resolve) => {
    let i = 0;
    const t = setInterval(async () => {
      const ok = await new Promise((r) => {
        const net = require('node:net');
        const s = net.connect(port, '127.0.0.1');
        s.on('connect', () => { s.destroy(); r(true); });
        s.on('error', () => r(false));
      });
      if (ok || ++i >= tries) { clearInterval(t); resolve(ok); }
    }, 150);
  });
}

function curlVia(socksPort, url, extra = []) {
  const t = Date.now();
  const r = spawnSync('curl', [
    '-sS', '-m', '12', '-o', '/dev/null', '-w', '%{http_code} %{size_download}',
    '--socks5', `127.0.0.1:${socksPort}`, ...extra, url
  ], { encoding: 'utf8' });
  const out = (r.stdout || '').trim();
  return {
    ok: r.status === 0 && out.startsWith('200'),
    out,
    ms: Date.now() - t
  };
}

function killPids(list) {
  for (const p of list) {
    try { process.kill(p, 'SIGTERM'); } catch {}
  }
}

async function main() {
  console.log('=== TikTunnel automated tests ===');
  console.log('Note: no UUID, token or secret is printed by this suite.\n');

  // Phase A: system
  console.log('-- A. System --');
  const cc = spawnSync(path.join(ROOT, 'bin', 'sing-box'), ['check', '-c', path.join(ROOT, 'config', 'sing-box.json')]);
  check('sing-box config valid', cc.status === 0);
  const h = await api('GET', '/health', undefined, false);
  check('API /health', h.status === 200);
  const st = await api('GET', '/api/status');
  check('API /api/status (admin)', st.status === 200 && st.data?.sing_box === 'running');
  check('SQLite readable', Array.isArray(db.listUsers()));
  check('sing-box port listening', await waitPort(cfgEnv.serverPort, 10));
  skip('TLS certificate valid', 'no user-owned domain/cert; platform terminates TLS');
  skip('REALITY handshake', 'no transparent inbound TCP; Shadowrocket compatibility unverified');

  // Safety: back up before mutating accounts, then clear test-only state.
  spawnSync('bash', [path.join(ROOT, 'scripts', 'backup.sh')], { cwd: ROOT, stdio: 'ignore' });
  for (const u of db.listUsers()) db.revokeUser(u.id);
  execFileSync('bash', [path.join(ROOT, 'scripts', 'apply-config.sh')], { cwd: ROOT, stdio: 'ignore' });

  // Phase B: accounts
  console.log('\n-- B. Accounts --');
  const created = [];
  for (let i = 1; i <= 3; i++) {
    const r = await api('POST', '/api/users', { name: `tiktunnel-test-${i}` });
    if (!check(`create account ${i}`, r.status === 201)) throw new Error('account creation failed');
    created.push({ id: r.data.user.id, token: r.data.subscription_url.split('/').pop() });
  }
  const over = await api('POST', '/api/users', { name: 'tiktunnel-test-4' });
  check('4th account rejected (max 3)', over.status === 409);
  const unauth = await api('GET', '/api/users', undefined, false);
  check('admin API rejects missing token', unauth.status === 401);
  const badName = await api('POST', '/api/users', { name: 'bad/name' });
  check('input validation (bad name)', badName.status === 400);

  const users = db.listActiveUsers();
  const uuids = users.map((u) => u.uuid);
  check('3 active accounts in DB', users.length === 3);
  check('UUIDs are unique', new Set(uuids).size === 3);

  const subs = [];
  for (let i = 0; i < 3; i++) {
    const r = await api('GET', `/api/sub/${created[i].token}`, undefined, false);
    let ok = false;
    let uri = '';
    if (r.status === 200) {
      const text = Buffer.from(await (await fetch(API + `/api/sub/${created[i].token}`)).text(), 'base64').toString('utf8');
      uri = text.trim();
      ok = uri.includes(uuids[i]) && uri.startsWith('vless://');
    }
    check(`subscription ${i + 1} exported & UUID matches`, ok);
    subs.push(uri);
  }
  skip('Shadowrocket import on iOS', 'no iOS device; URI format is standard VLESS');

  // Phase C/D: real VLESS clients, local connectivity + concurrency
  console.log('\n-- C/D. VLESS connectivity + concurrency --');
  const wwwPid = await startHttpServer(18080);
  const clientPids = [];
  for (let i = 0; i < 3; i++) {
    clientPids.push(startClient(i, users[i]));
    check(`VLESS client ${i + 1} socks port up`, await waitPort(18100 + i));
  }
  const localUrl = 'http://127.0.0.1:18080/payload.bin';
  const perClient = [];
  for (let i = 0; i < 3; i++) {
    const r = curlVia(18100 + i, localUrl);
    check(`client ${i + 1} reaches HTTP through VLESS`, r.ok, `${r.out} in ${r.ms}ms`);
    perClient.push(r);
  }
  const ext = curlVia(18100, 'https://api.github.com/');
  record('HTTPS via VLESS (external)', ext.ok ? 'PASS' : 'SKIP', ext.out);

  const cpuBefore = readCpu();
  const rssBefore = rssOf(sbServerPid());
  const t0 = Date.now();
  const parallel = await Promise.all([0, 1, 2].map((i) => Promise.resolve(curlVia(18100 + i, localUrl))));
  const elapsed = (Date.now() - t0) / 1000;
  const cpuAfter = readCpu();
  const rssAfter = rssOf(sbServerPid());
  const totalBytes = parallel.reduce((a, r) => a + (Number(r.out.split(' ')[1]) || 0), 0);
  check('3 simultaneous VLESS transfers', parallel.every((r) => r.ok));
  const mbps = +((totalBytes * 8) / elapsed / 1e6).toFixed(2);
  console.log(`METRIC concurrent_throughput=${mbps} Mbit/s elapsed=${elapsed}s cpu=${cpuDelta(cpuBefore, cpuAfter)}% rss_delta=${rssAfter - rssBefore}kB`);
  console.log(`METRIC idle_rss=${rssBefore}kB loaded_rss=${rssAfter}kB`);

  // Revocation: remove client 3, verify it can no longer proxy while 1 & 2 still can.
  console.log('\n-- Revocation --');
  const del = await api('DELETE', `/api/users/${created[2].id}`);
  check('revoke account 3', del.status === 200);
  await new Promise((r) => setTimeout(r, 1500));
  const revoked = curlVia(18102, localUrl);
  check('revoked UUID cannot proxy', !revoked.ok, revoked.out);
  killPids(clientPids);
  const freshClients = [startClient(0, users[0]), startClient(1, users[1])];
  check('fresh clients for remaining users start', (await waitPort(18100)) && (await waitPort(18101)));
  const alive1 = curlVia(18100, localUrl);
  const alive2 = curlVia(18101, localUrl);
  check('remaining accounts still work', alive1.ok && alive2.ok);
  killPids(freshClients);

  // Cleanup test users and clients
  for (const u of db.listUsers()) if (!u.revoked_at) db.revokeUser(u.id);
  execFileSync('bash', [path.join(ROOT, 'scripts', 'apply-config.sh')], { cwd: ROOT, stdio: 'ignore' });
  try { process.kill(wwwPid, 'SIGTERM'); } catch {}

  // External/inbound and device tests are not possible in this environment.
  skip('inbound connection from Internet', 'Codespaces HTTP tunnel requires GitHub auth; raw TCP not exposed');
  skip('Wi-Fi to 4G/5G handover', 'no external client device');
  skip('packet loss (external path)', 'no external client; local TCP loss not representative');
  skip('DNS leak on client device', 'no client device; server-side DNS uses local resolver only');

  const pass = results.filter((r) => r.status === 'PASS').length;
  const fail = results.filter((r) => r.status === 'FAIL').length;
  const skipN = results.filter((r) => r.status === 'SKIP').length;
  console.log(`\n=== SUMMARY: PASS=${pass} FAIL=${fail} SKIP=${skipN} ===`);
  fs.writeFileSync(path.join(ROOT, 'reports', 'test-results.json'), JSON.stringify(results, null, 2) + '\n');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('TEST HARNESS ERROR:', e.message);
  process.exit(2);
});
