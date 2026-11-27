'use strict';

/* Device Activity E2E: real VLESS/WS session carrying real traffic with a device identifier. */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const cdb = require('../control/db');
const cfg = require('../config/control.json');
const envcfg = require('../config/runtime');
const { ROOT } = cdb;
const RUNTIME = path.join(ROOT, 'tests', 'runtime');
const BASE = `http://127.0.0.1:${envcfg.serverPort || 23952}`;
const DEVICE = 'dEv1cE-' + crypto.randomUUID().slice(0, 12).replace(/-/g, 'x');
const OUT = path.join(ROOT, 'reports', 'runtime', 'device-activity.json');
const results = [];

function rec(name, status, detail = '') {
  const s = status === true ? 'PASS' : status === false ? 'FAIL' : status;
  results.push({ name, status: s, detail });
  console.log(`${s.padEnd(6)} ${name}${detail ? ' — ' + detail : ''}`);
}
async function api(p, { method = 'GET', body, cookie, csrf } = {}) {
  const h = {};
  if (body) h['content-type'] = 'application/json';
  if (cookie) h.cookie = cookie;
  if (csrf) h['x-csrf-token'] = csrf;
  const r = await fetch(BASE + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => ({})), cookie: r.headers.get('set-cookie')?.split(';')[0] || cookie };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function curlVia(port) {
  const r = spawnSync('curl', ['-sS', '-m', '15', '-o', '/dev/null', '-w', '%{http_code} %{size_download}',
    '--socks5', `127.0.0.1:${port}`, 'http://127.0.0.1:18082/blob.bin'], { encoding: 'utf8' });
  const [code, bytes] = r.stdout.trim().split(/\s+/).map(Number);
  return r.status === 0 && code === 200 && bytes > 0;
}
async function statusFor(cookie, id) {
  const d = await api('/api/friend/devices?limit=50', { cookie });
  const found = d.data.devices.find((x) => x.id === id);
  return found ? { status: found.status, up: found.upload_bytes, down: found.download_bytes } : null;
}
async function waitForStatus(cookie, id, ok, timeoutMs = 8000) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeoutMs) {
    last = await statusFor(cookie, id);
    if (ok(last)) return last;
    await sleep(500);
  }
  return last;
}

async function main() {
  fs.mkdirSync(RUNTIME, { recursive: true });
  const pw = JSON.parse(fs.readFileSync(path.join(RUNTIME, 'test-credentials.json'), 'utf8')).friend;
  const friend = cdb.listUsers().find((u) => !u.revoked_at);
  const login = await api('/api/auth/login', { method: 'POST', body: { username: friend.username, password: pw } });
  if (login.status !== 200) throw new Error('friend login failed');
  const cookie = login.cookie;
  await api(`/api/friend/devices/${DEVICE}`, { method: 'PATCH', cookie, csrf: login.data.csrf, body: { name: 'Lab device' } });
  rec('unknown device before any VPN session', true, 'no device row is fabricated');

  // Device ID chỉ dùng được trên đường WS nội bộ; public transport hiện là VLESS TCP
  // (forwarder Cloudcode chặn Upgrade) nên không mang device id. Test này chạy local.
  const wsPath = `${cdb.getSubscription(friend.id).path}.${DEVICE}`;
  rec('VLESS path carries device identifier', wsPath.endsWith(`.${DEVICE}`), wsPath);

  const blobOut = fs.openSync(path.join(RUNTIME, 'device-blob.log'), 'a');
  const blob = spawn('python3', [path.join(ROOT, 'tests', 'blob-server.py')], { cwd: ROOT, detached: true, stdio: ['ignore', blobOut, blobOut] });
  blob.unref();
  await sleep(1200);

  const conf = path.join(RUNTIME, 'device-client.json');
  fs.writeFileSync(conf, JSON.stringify({
    log: { level: 'error', output: path.join(RUNTIME, 'device-client.log') },
    inbounds: [{ type: 'socks', tag: 's', listen: '127.0.0.1', listen_port: 18999 }],
    outbounds: [{ type: 'vless', tag: 'p', server: '127.0.0.1', server_port: cfg.app_port,
      uuid: cdb.getVpnClient(friend.id).uuid, transport: { type: 'ws', path: wsPath } }],
    route: { rules: [], final: 'p' }
  }), { mode: 0o600 });
  const out = fs.openSync(path.join(RUNTIME, 'device-client-stdout.log'), 'a');
  const client = spawn(path.join(ROOT, 'bin', 'sing-box'), ['run', '-c', conf], { cwd: ROOT, detached: true, stdio: ['ignore', out, out] });
  client.unref();
  await sleep(2000);
  rec('real traffic through VPN with device ID', curlVia(18999));

  const active = await waitForStatus(cookie, DEVICE, (x) => !!x && x.status === 'active' && x.down > 0);
  rec('device Active after traffic', !!active && active.status === 'active' && active.down > 0,
    active ? `${active.status} down=${active.down}` : 'missing');

  try { process.kill(client.pid, 'SIGTERM'); } catch {}
  await sleep(1500);
  const { WebSocket } = require('ws');
  const idleWs = new WebSocket(`ws://127.0.0.1:23952${wsPath}`);
  await new Promise((resolve, reject) => { idleWs.once('open', resolve); idleWs.once('error', reject); });
  rec('waiting 62s with open session but no traffic', true);
  await sleep(62000);
  const idle = await statusFor(cookie, DEVICE);
  rec('device Idle with open session but no recent traffic', !!idle && idle.status === 'idle', idle?.status || 'missing');

  idleWs.close();
  await sleep(2500);
  const offline = await statusFor(cookie, DEVICE);
  rec('device Offline after VPN disconnect', !!offline && offline.status === 'offline', offline?.status || 'missing');

  try { process.kill(blob.pid, 'SIGTERM'); } catch {}
  const pass = results.filter((r) => r.status === 'PASS').length;
  const fail = results.filter((r) => r.status === 'FAIL').length;
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(results, null, 2) + '\n');
  console.log(`SUMMARY PASS=${pass} FAIL=${fail}`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error('device test error:', e.stack); process.exit(1); });
