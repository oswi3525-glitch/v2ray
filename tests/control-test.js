'use strict';

/* End-to-end tests for TikTunnel Control. No secrets are printed. */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const cdb = require('../control/db');
const cfg = require('../config/control.json');
const envcfg = require('../config/runtime');
const { ROOT } = cdb;
const RUNTIME = path.join(ROOT, 'tests', 'runtime');
fs.mkdirSync(RUNTIME, { recursive: true });
const BASE = `http://127.0.0.1:${cfg.app_port}`;
const results = [];

function rec(name, status, detail = '') {
  results.push({ name, status, detail });
  console.log(`${status.padEnd(6)} ${name}${detail ? ' — ' + detail : ''}`);
}
function check(name, c, detail = '') { rec(name, c ? 'PASS' : 'FAIL', detail); return !!c; }
function skip(name, why) { rec(name, 'SKIP', why); }

async function api(p, { method = 'GET', body, cookie, csrf } = {}) {
  const headers = {};
  if (body) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  if (csrf) headers['x-csrf-token'] = csrf;
  const r = await fetch(BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie');
  const data = await r.json().catch(() => ({}));
  return { status: r.status, data, cookie: sc ? sc.split(';')[0] : cookie };
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function configUuids() {
  const c = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'sing-box.json'), 'utf8'));
  return (c.inbounds[0].users || []).map((u) => u.uuid);
}
function curlVia(port, url) {
  const r = spawnSync('curl', ['-sS', '-m', '20', '-o', '/dev/null', '-w', '%{http_code} %{size_download}',
    '--socks5', `127.0.0.1:${port}`, url], { encoding: 'utf8' });
  return { ok: r.status === 0 && r.stdout.trim().startsWith('200'), out: r.stdout.trim() };
}

async function main() {
  console.log('=== TikTunnel Control E2E ===');
  const credFile = path.join(RUNTIME, 'test-credentials.json');
  let creds = {};
  if (fs.existsSync(credFile)) creds = JSON.parse(fs.readFileSync(credFile, 'utf8'));
  const adminUser = envcfg.adminUsername || 'admin';
  const adminPw = envcfg.adminPassword || '';
  const friendPw = process.env.TIKTUNNEL_TEST_FRIEND_PASSWORD || creds.friend || 'TestFriend!' + crypto.randomBytes(9).toString('base64url');
  creds = { friend: friendPw };
  fs.writeFileSync(credFile, JSON.stringify(creds, null, 2), { mode: 0o600 });

  const login = await api('/api/auth/login', { method: 'POST', body: { username: adminUser, password: adminPw } });
  check('admin login from .env', login.status === 200, `http=${login.status}`);
  let admin = { cookie: login.cookie, csrf: login.data.csrf };
  const me = await api('/api/auth/me', { cookie: admin.cookie });
  check('admin session valid', me.status === 200 && me.data.role === 'admin');

  const maxFriends = envcfg.maxUsers;
  for (let i = cdb.friendCount(); i < maxFriends; i++) {
    await api('/api/admin/users', { method: 'POST', cookie: admin.cookie, csrf: admin.csrf,
      body: { username: `friend${i + 1}`, display_name: `Friend ${i + 1}`, password: friendPw, quota_gb: 1 } });
  }
  const overLimit = await api('/api/admin/users', { method: 'POST', cookie: admin.cookie, csrf: admin.csrf,
    body: { username: 'friend_over_limit', display_name: 'Over limit', password: friendPw, quota_gb: 1 } });
  check(`friend limit enforced (max ${maxFriends})`, overLimit.status === 409);

  const users = (await api('/api/admin/users', { cookie: admin.cookie })).data.users.filter((u) => !u.revoked_at);
  check(`${maxFriends} friends exist`, users.length === maxFriends, `${users.length}`);
  check('UUIDs unique', new Set(users.map((u) => u.uuid)).size === maxFriends);
  for (const u of users) {
    const r = await api(`/api/admin/users/${u.id}/password`, { method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: { password: friendPw } });
    check(`password set for ${u.username}`, r.status === 200);
  }

  let f1 = await api('/api/auth/login', { method: 'POST', body: { username: users[0].username, password: friendPw } });
  let f2 = await api('/api/auth/login', { method: 'POST', body: { username: users[1].username, password: friendPw } });
  check('friend 1 login', f1.status === 200);
  check('friend 2 login', f2.status === 200);
  const denied = await api('/api/admin/users', { cookie: f1.cookie });
  check('friend cannot access admin API', denied.status === 401 || denied.status === 403, `http=${denied.status}`);
  const other = await api(`/api/admin/users/${users[1].id}`, { cookie: f1.cookie });
  check('friend cannot read other account', other.status === 401 || other.status === 403);

  const fme = await api('/api/friend/me', { cookie: f1.cookie });
  check('friend sees own data only', fme.status === 200 && fme.data.user.id === users[0].id);
  const fvpn = await api('/api/friend/vpn', { cookie: f2.cookie });
  check('friend VPN config generated', fvpn.status === 200 && String(fvpn.data.uri).startsWith('vless://'), String(fvpn.data.mode));
  const exp = await fetch(BASE + '/api/friend/export', { headers: { cookie: f1.cookie } });
  const expBody = await exp.text();
  check('config file export works', exp.status === 200 && /^vless:\/\//.test(expBody.trim()) &&
    /attachment; filename="tiktunnel-/.test(exp.headers.get('content-disposition') || ''));
  const parsed = new URL(fvpn.data.uri);
  check('VLESS URI uses Cloudcode HTTPS endpoint', parsed.hostname === cfg.public_https_host && parsed.port === '443', `${parsed.hostname}:${parsed.port}`);
  check('VLESS URI uses WebSocket + TLS', parsed.searchParams.get('type') === 'ws' && parsed.searchParams.get('security') === 'tls');
  const path2 = parsed.searchParams.get('path');

  const blobOut = fs.openSync(path.join(RUNTIME, 'control-blob.log'), 'a');
  const blob = spawn('python3', [path.join(ROOT, 'tests', 'blob-server.py')], { cwd: ROOT, detached: true, stdio: ['ignore', blobOut, blobOut] });
  blob.unref();
  await sleep(1800);

  function startClient(idx, tokenPath) {
    const f = path.join(RUNTIME, `control-client-${idx}.json`);
    fs.writeFileSync(f, JSON.stringify({
      log: { level: 'error', output: path.join(RUNTIME, `control-client-${idx}.log`) },
      inbounds: [{ type: 'socks', tag: 's', listen: '127.0.0.1', listen_port: 18700 + idx }],
      outbounds: [{ type: 'vless', tag: 'p', server: '127.0.0.1', server_port: cfg.app_port, uuid: users[idx].uuid,
        transport: { type: 'ws', path: tokenPath } }],
      route: { rules: [], final: 'p' }
    }), { mode: 0o600 });
    const o = fs.openSync(path.join(RUNTIME, `control-client-${idx}-stdout.log`), 'a');
    const p = spawn(path.join(ROOT, 'bin', 'sing-box'), ['run', '-c', f], { cwd: ROOT, detached: true, stdio: ['ignore', o, o] });
    p.unref();
    return p.pid;
  }
  const p1 = startClient(0, cdb.getSubscription(users[0].id).path);
  const p2 = startClient(1, path2);
  await sleep(2000);

  await api(`/api/admin/users/${users[1].id}/quota`, { method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: { action: 'set', gb: 5 } });
  const before = cdb.getUser(users[1].id);
  const r1 = curlVia(18701, 'http://127.0.0.1:18082/blob.bin');
  check('real VLESS/WS traffic through proxy', r1.ok, r1.out);
  await sleep(1200);
  const after = cdb.getUser(users[1].id);
  check('traffic recorded from sing-box path', (after.used_upload + after.used_download) > (before.used_upload + before.used_download),
    `delta=${after.used_upload + after.used_download - before.used_upload - before.used_download}B`);

  const qs = await api(`/api/admin/users/${users[0].id}/quota`, { method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: { action: 'set', gb: 0.0005 } });
  curlVia(18700, 'http://127.0.0.1:18082/blob.bin');
  await sleep(12000);
  const exhausted = cdb.getUser(users[0].id);
  check('quota exhaustion enforced', exhausted.exhausted === 1 && exhausted.enabled === 0);
  check('exhausted UUID removed from sing-box', !configUuids().includes(cdb.getVpnClient(users[0].id).uuid));
  const blocked = await api(`/api/sub/${cdb.getSubscription(users[0].id).token}`,
    { cookie: f1.cookie });
  check('exhausted subscription blocked', blocked.status === 404);
  await api(`/api/admin/users/${users[0].id}/quota`, { method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: { action: 'add', gb: 1 } });
  await api(`/api/admin/users/${users[0].id}/enable`, { method: 'POST', cookie: admin.cookie, csrf: admin.csrf });
  check('quota top-up restores account', cdb.getUser(users[0].id).exhausted === 0 && configUuids().includes(cdb.getVpnClient(users[0].id).uuid));

  execFileSync('bash', [path.join(ROOT, 'scripts', 'restart.sh')], { cwd: ROOT, stdio: 'ignore' });
  await sleep(1500);
  const post = await api('/api/auth/login', { method: 'POST', body: { username: adminUser, password: adminPw } });
  check('recovery: backend restart, data kept', post.status === 200 && cdb.getUser(users[1].id).quota_bytes > 0);
  check('recovery: sing-box config restored', configUuids().length === maxFriends);
  const recSub = await api(`/api/sub/${cdb.getSubscription(users[1].id).token}`);
  check('recovery: subscription still valid', recSub.status === 200);

  for (const p of [p1, p2]) { try { process.kill(p, 'SIGTERM'); } catch {} }
  try { process.kill(blob.pid, 'SIGTERM'); } catch {}
  const pass = results.filter((r) => r.status === 'PASS').length;
  const fail = results.filter((r) => r.status === 'FAIL').length;
  console.log(`SUMMARY PASS=${pass} FAIL=${fail}`);
  fs.writeFileSync(path.join(ROOT, 'reports', 'runtime', 'control-tests.json'), JSON.stringify(results, null, 2) + '\n');
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error('control test error:', e.stack); process.exit(1); });
