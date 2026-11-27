'use strict';

const net = require('node:net');
const dns = require('node:dns');
const fs = require('node:fs');
const path = require('node:path');
const tls = require('node:tls');
const crypto = require('node:crypto');

function item(id, label, status, detail = '', cause = '', fix = '', durationMs = 0) {
  return { id, label, status, checked_at: new Date().toISOString(), duration_ms: Math.round(durationMs), detail, cause, fix };
}
function timed(fn, timeoutMs = 4000) {
  return Promise.race([
    fn(),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout_after_${timeoutMs}ms`)), timeoutMs))
  ]).catch((e) => { throw e; });
}
function tcpConnect(host, port, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const t = Date.now();
    const s = net.connect(port, host);
    const done = (err) => { s.destroy(); err ? reject(err) : resolve(Date.now() - t); };
    s.setTimeout(timeout);
    s.once('connect', () => done(null));
    s.once('timeout', () => done(new Error('tcp_timeout')));
    s.once('error', done);
  });
}
function rawRequest(host, port, payload, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, host);
    let buf = Buffer.alloc(0);
    const finish = (err) => { s.destroy(); err ? reject(err) : resolve(buf.toString('latin1')); };
    s.setTimeout(timeout);
    s.once('connect', () => s.write(payload));
    s.on('data', (d) => { buf = Buffer.concat([buf, d]); if (buf.length >= 200 || buf.includes('\r\n\r\n')) finish(null); });
    s.once('end', () => finish(null));
    s.once('timeout', () => finish(new Error('no_response')));
    s.once('error', finish);
    setTimeout(() => { if (!s.destroyed) finish(new Error('no_response')); }, timeout);
  });
}
function vlessHeader(uuid, port = 443, host = '1.1.1.1') {
  const u = Buffer.from(uuid.replace(/-/g, ''), 'hex');
  const addr = host.split('.').map(Number);
  return Buffer.concat([Buffer.from([0]), u, Buffer.from([0, 1]),
    Buffer.from([(port >> 8) & 255, port & 255]), Buffer.from([1]), Buffer.from(addr)]);
}
function vlessAuthProbe(port, uuid, timeout = 2500) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    let opened = false;
    const finish = (ok, detail) => { if (!s.destroyed) s.destroy(); resolve({ ok, detail }); };
    s.setTimeout(timeout);
    s.once('connect', () => { opened = true; s.write(vlessHeader(uuid)); });
    s.once('data', () => finish(false, 'unexpected_response_bytes'));
    s.once('close', () => finish(opened ? false : false, opened ? 'closed_after_handshake' : 'cannot_connect'));
    s.once('error', (e) => finish(false, e.message));
    setTimeout(() => {
      if (!s.destroyed) {
        const ok = opened;
        finish(ok, ok ? 'connection_stayed_open' : 'no_connect');
      }
    }, timeout);
  });
}
function tlsProbe(host, port, servername) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, host);
    const t0 = Date.now();
    socket.setTimeout(3500);
    const finish = (err, value) => { socket.destroy(); err ? reject(err) : resolve(value); };
    const tlsSocket = tls.connect({ socket, servername, rejectUnauthorized: false }, () => {
      const cert = tlsSocket.getPeerCertificate();
      finish(null, { ms: Date.now() - t0, subject: cert.subject?.CN || '', issuer: cert.issuer?.O || '',
        valid_from: cert.valid_from, valid_to: cert.valid_to, authorized: tlsSocket.authorized, protocol: tlsSocket.getProtocol() });
    });
    tlsSocket.once('error', finish);
    socket.once('timeout', () => finish(new Error('tls_timeout')));
  });
}

async function runDiagnostics({ control, user, cdb, internalHealthUrl }) {
  const out = [];
  const host = control.publicTcpHost;
  const port = control.publicTcpPort;
  const httpsHost = control.public_https_host;
  const sub = user ? cdb.getSubscription(user.id) : null;
  const vpn = user ? cdb.getVpnClient(user.id) : null;
  const token = sub?.token || '';
  const uuid = vpn?.uuid || '';

  let t = Date.now();
  try {
    const r = await timed(() => new Promise((res, rej) => dns.lookup(host, { family: 4 }, (e, a) => e ? rej(e) : res(a))), 4000);
    out.push(item('dns', 'DNS Resolution', 'PASS', `${host} -> ${r}`, '', '', Date.now() - t));
  } catch (e) {
    out.push(item('dns', 'DNS Resolution', 'FAIL', `${host}: ${e.message}`, 'DNS trả về lỗi hoặc chỉ có IPv6', 'Kiểm tra DNS của Cloudcode/host', Date.now() - t));
  }

  t = Date.now();
  try {
    const ms = await tcpConnect(host, port);
    out.push(item('tcp', 'TCP Connectivity', 'PASS', `${host}:${port} connected in ${ms} ms`, '', '', Date.now() - t));
  } catch (e) {
    out.push(item('tcp', 'TCP Connectivity', 'FAIL', `${host}:${port} ${e.message}`, 'Port public không mở hoặc forward sai', 'Kiểm tra port mapping trên Cloudcode', Date.now() - t));
  }

  t = Date.now();
  try {
    const r = await tlsProbe(httpsHost, 443, httpsHost);
    out.push(item('tls', 'TLS Handshake', 'WARNING',
      `${httpsHost}:443 ${r.protocol} CN=${r.subject} expires=${r.valid_to} authorized=${r.authorized}`,
      'Chứng chỉ hợp lệ nhưng HTTPS host trả 404 cho /api và /vpn; VLESS hiện dùng TCP port ' + port + ' (security=none, không TLS)',
      'Cấu hình reverse proxy chuyển /api và /vpn tới app, hoặc dùng TLS trên endpoint TCP có chứng chỉ riêng', Date.now() - t));
  } catch (e) {
    out.push(item('tls', 'TLS Handshake', 'FAIL', `${httpsHost}:443 ${e.message}`, 'Không bắt tay TLS được với HTTPS host', 'Kiểm tra Cloudflare/HTTPS forwarding', Date.now() - t));
  }

  t = Date.now();
  if (token) {
    try {
      const payload = `GET /vpn/${token} HTTP/1.1\r\nHost: ${host}:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`;
      const res = await rawRequest(host, port, payload);
      const ok = /101 Switching Protocols/.test(res);
      out.push(item('ws', 'WebSocket Handshake', ok ? 'PASS' : 'FAIL',
        ok ? '101 Switching Protocols' : (res.trim().slice(0, 120) || 'empty response'),
        ok ? '' : 'Forwarder của nền tảng không chuyển header Upgrade; kết nối bị đóng trước khi có 101',
        ok ? '' : 'Không dùng WS trên endpoint này; dùng VLESS TCP qua multiplexer', Date.now() - t));
    } catch (e) {
      out.push(item('ws', 'WebSocket Handshake', 'FAIL', e.message,
        'Không nhận được phản hồi cho WS Upgrade trên endpoint public',
        'Dùng VLESS TCP (public_transport=tcp) thay vì WS', Date.now() - t));
    }
  } else {
    out.push(item('ws', 'WebSocket Handshake', 'UNKNOWN', 'Không có subscription token để kiểm tra', '', '', Date.now() - t));
  }

  t = Date.now();
  try {
    const cfgPath = path.join(cdb.ROOT, 'config', 'sing-box.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const tcpIn = cfg.inbounds.find((x) => x.tag === 'vless-tcp-in');
    const hasUuid = !!tcpIn && tcpIn.users.some((u) => u.uuid === uuid);
    await tcpConnect('127.0.0.1', control.vless_tcp_port || Number(cfg.inbounds.find((x) => x.tag === 'vless-tcp-in')?.listen_port || 23955));
    out.push(item('vless_inbound', 'VLESS Inbound', 'PASS',
      `sing-box TCP inbound listening, user configured=${hasUuid}`, '', '', Date.now() - t));
  } catch (e) {
    out.push(item('vless_inbound', 'VLESS Inbound', 'FAIL', e.message,
      'sing-box TCP inbound không chạy hoặc thiếu UUID người dùng', 'Khởi động lại sing-box: bash scripts/restart.sh', Date.now() - t));
  }

  t = Date.now();
  try {
    const good = await vlessAuthProbe(control.app_port || 23952, uuid);
    const bad = await vlessAuthProbe(control.app_port || 23952, crypto.randomUUID());
    const ok = good.ok && !bad.ok;
    out.push(item('auth', 'Authentication', ok ? 'PASS' : 'FAIL',
      `valid_uuid_stays_open=${good.ok} (${good.detail}), random_uuid_rejected=${!bad.ok} (${bad.detail})`,
      ok ? '' : 'Không chứng minh được UUID được kiểm tra khi nhận VLESS',
      ok ? '' : 'Kiểm tra sing-box users và UUID trong DB', Date.now() - t));
  } catch (e) {
    out.push(item('auth', 'Authentication', 'UNKNOWN', e.message, '', '', Date.now() - t));
  }

  t = Date.now();
  if (token) {
    const url = `http://${host}:${port}/api/sub/${token}?raw=1`;
    try {
      const res = await timed(() => fetch(url, { signal: AbortSignal.timeout(4000) }), 5000);
      const body = await res.text();
      const ok = res.ok && body.trim().startsWith('vless://') && body.includes(uuid);
      out.push(item('subscription', 'Subscription Availability', ok ? 'PASS' : 'FAIL',
        `HTTP ${res.status} from ${host}:${port}, vless_uri=${body.trim().startsWith('vless://')}, uuid_match=${body.includes(uuid)}`,
        ok ? '' : 'Endpoint public trả về subscription của instance/deployment khác hoặc account bị từ chối; UUID local không tồn tại ở endpoint đó',
        ok ? '' : 'Deploy code + DB/account này lên đúng host public, hoặc đổi hostname/port tới instance chứa tài khoản', Date.now() - t));
    } catch (e) {
      out.push(item('subscription', 'Subscription Availability', 'FAIL', e.message,
        'Không tải được subscription từ endpoint public', 'Kiểm tra TCP forwarding và DB của endpoint public', Date.now() - t));
    }
  } else {
    out.push(item('subscription', 'Subscription Availability', 'UNKNOWN', 'Không có token', '', '', Date.now() - t));
  }

  t = Date.now();
  try {
    const res = await timed(() => fetch(internalHealthUrl, { signal: AbortSignal.timeout(3000) }), 4000);
    const j = await res.json();
    const alive = !!j.ok;
    cdb.listUsers();
    out.push(item('server_health', 'Server Health', alive ? 'PASS' : 'FAIL',
      `local health=${res.status}, sqlite=${alive ? 'readable' : 'unknown'}`, '', '', Date.now() - t));
  } catch (e) {
    out.push(item('server_health', 'Server Health', 'FAIL', e.message, 'Control app hoặc DB không phản hồi', 'Xem logs/api.log', Date.now() - t));
  }

  out.push(item('client_connectivity', 'Client Connectivity', 'UNKNOWN',
    'Không thể xác minh từ máy chủ: cần kiểm tra trong Shadowrocket trên thiết bị (import, connect, Safari test)',
    'Server-side probe không đại diện cho đường client → VPN → Internet',
    'Mở Shadowrocket, import URI/subscription, bật VPN và truy cập https://www.apple.com'));

  return out;
}

module.exports = { runDiagnostics };
