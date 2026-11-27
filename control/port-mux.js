'use strict';

const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const cdb = require('./db');

const cfg = JSON.parse(fs.readFileSync(path.join(cdb.ROOT, 'config', 'control.json'), 'utf8'));
const listenPort = Number(cfg.app_port || 23952);
const httpPort = Number(cfg.app_internal_port || 23950);
const vlessPort = Number(cfg.vless_tcp_port || 23955);
const HTTP_METHOD = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s/;

let connections = 0;
let httpCount = 0;
let vlessCount = 0;
const userByUuid = new Map();

function reloadUsers() {
  userByUuid.clear();
  try {
    for (const r of cdb.db.prepare(`SELECT v.uuid, u.id FROM vpn_clients v
      JOIN users u ON u.id=v.user_id WHERE u.revoked_at IS NULL`).all()) {
      userByUuid.set(String(r.uuid).replace(/-/g, ''), Number(r.id));
    }
  } catch (e) { process.stderr.write(`port-mux user reload failed: ${e.message}\n`); }
}
reloadUsers();
setInterval(reloadUsers, 30000).unref();

function pipe(first, client, targetPort, kind, userId) {
  let stats = null;
  if (userId && first && first.length > 17) {
    stats = { up: first.length, down: 0, flushedUp: first.length, flushedDown: 0 };
  }
  const flush = () => {
    if (!stats) return;
    const du = stats.up - stats.flushedUp;
    const dd = stats.down - stats.flushedDown;
    if (du > 0 || dd > 0) {
      try { cdb.recordTraffic(userId, du, dd, 'vless-tcp-mux'); } catch {}
      stats.flushedUp = stats.up;
      stats.flushedDown = stats.down;
    }
  };
  const flushTimer = stats ? setInterval(flush, 2000) : null;
  if (flushTimer) flushTimer.unref();
  if (stats) {
    client.on('data', (d) => { stats.up += d.length; });
    client.on('close', () => { if (flushTimer) clearInterval(flushTimer); flush(); });
  }
  const target = net.connect(targetPort, '127.0.0.1', () => {
    if (first && first.length) target.write(first);
    client.pipe(target);
    target.pipe(client);
  });
  if (stats) target.on('data', (d) => { stats.down += d.length; });
  target.setNoDelay(true);
  client.setNoDelay(true);
  const done = () => { try { target.destroy(); } catch {} };
  client.on('error', done);
  client.on('close', done);
  target.on('error', () => client.destroy());
  if (kind === 'http') httpCount++; else vlessCount++;
}

const server = net.createServer({ pauseOnConnect: true }, (client) => {
  connections++;
  const timer = setTimeout(() => client.destroy(), 5000);
  const cleanup = () => { clearTimeout(timer); connections = Math.max(0, connections - 1); };
  client.once('close', cleanup);
  client.once('error', cleanup);
  client.once('readable', () => {
    clearTimeout(timer);
    let first = null;
    try { first = client.read(); } catch { client.destroy(); return; }
    const head = first ? first.toString('latin1', 0, Math.min(first.length, 24)) : '';
    const isHttp = HTTP_METHOD.test(head);
    let userId = null;
    if (!isHttp && first && first.length > 17) {
      userId = userByUuid.get(first.subarray(1, 17).toString('hex')) || null;
    }
    pipe(first, client, isHttp ? httpPort : vlessPort, isHttp ? 'http' : 'vless', userId);
  });
});

server.on('error', (e) => {
  process.stderr.write(`port-mux failed: ${e.message}\n`);
  process.exit(1);
});
server.listen(listenPort, '0.0.0.0', () => {
  process.stdout.write(`tiktunnel-port-mux listening on 0.0.0.0:${listenPort} http=${httpPort} vless=${vlessPort}\n`);
});

function shutdown() { try { server.close(() => process.exit(0)); } catch { process.exit(0); } }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

process.on('message', (msg) => {
  if (msg && msg.type === 'stats' && process.send) {
    process.send({ connections, http: httpCount, vless: vlessCount });
  }
});
