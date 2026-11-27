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
const MAX_CONNECTIONS = Number(cfg.mux_max_connections || 2000);
const CLASSIFY_TIMEOUT = Number(cfg.mux_classify_timeout_ms || 5000);
const FLUSH_MS = 2000;

let connections = 0;
let httpCount = 0;
let vlessCount = 0;
let unknownCount = 0;
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

function vlessHeaderLength(head) {
  const addons = head[17];
  const at = 18 + addons;
  if (at >= head.length) return 0;
  const type = head[at];
  let addrLen = 0;
  if (type === 1) addrLen = 4;
  else if (type === 3) {
    if (at + 1 >= head.length) return 0;
    addrLen = 1 + head[at + 1];
  } else if (type === 4) addrLen = 16;
  else return 0;
  return at + addrLen + 4;
}

function classify(head) {
  if (HTTP_METHOD.test(head.toString('latin1', 0, Math.min(head.length, 16)))) {
    return { kind: 'http', first: head };
  }
  if (head.length < 18) return null;
  const userId = userByUuid.get(head.subarray(1, 17).toString('hex')) || null;
  if (!userId) return { kind: 'unknown', first: head };
  const hlen = vlessHeaderLength(head);
  return { kind: 'vless', first: head, userId, headerBytes: hlen > 0 && hlen <= head.length ? hlen : 0 };
}

function pipe(client, decision) {
  const { first, kind, userId, headerBytes = 0 } = decision;
  const targetPort = kind === 'http' ? httpPort : vlessPort;
  let stats = null;
  if (userId && first && first.length > headerBytes) {
    const initialUp = first.length - headerBytes;
    stats = { up: initialUp, down: 0, flushedUp: 0, flushedDown: 0, flushed: false };
  }
  const flush = () => {
    if (!stats || stats.flushed) return;
    const du = stats.up - stats.flushedUp;
    const dd = stats.down - stats.flushedDown;
    if (du > 0 || dd > 0) {
      try { cdb.recordTraffic(userId, du, dd, 'vless-tcp-mux'); } catch {}
      stats.flushedUp = stats.up;
      stats.flushedDown = stats.down;
    }
  };
  const flushTimer = stats ? setInterval(flush, FLUSH_MS) : null;
  if (flushTimer) flushTimer.unref();
  const finish = () => {
    if (!stats || stats.flushed) return;
    if (flushTimer) clearInterval(flushTimer);
    flush();
    stats.flushed = true;
  };
  if (stats) {
    client.on('data', (d) => { stats.up += d.length; });
    client.once('close', finish);
    client.once('error', finish);
  }
  const target = net.connect(targetPort, '127.0.0.1', () => {
    if (first && first.length) target.write(first);
    client.pipe(target);
    target.pipe(client);
  });
  if (stats) {
    target.on('data', (d) => { stats.down += d.length; });
    target.once('close', finish);
    target.once('error', finish);
  }
  target.setNoDelay(true);
  client.setNoDelay(true);
  const done = () => { try { target.destroy(); } catch {} };
  client.once('close', done);
  client.once('error', done);
  target.once('error', () => client.destroy());
  if (kind === 'http') httpCount++;
  else if (kind === 'vless') vlessCount++;
  else unknownCount++;
}

const server = net.createServer({ pauseOnConnect: true }, (client) => {
  if (connections >= MAX_CONNECTIONS) { client.destroy(); return; }
  connections++;
  const timer = setTimeout(() => client.destroy(), CLASSIFY_TIMEOUT);
  let head = Buffer.alloc(0);
  let cleaned = false;
  const cleanup = () => {
    clearTimeout(timer);
    if (cleaned) return;
    cleaned = true;
    connections = Math.max(0, connections - 1);
  };
  client.once('close', cleanup);
  client.once('error', cleanup);
  const onReadable = () => {
    let chunk;
    while ((chunk = client.read()) !== null) {
      head = head.length ? Buffer.concat([head, chunk]) : chunk;
      const decision = classify(head);
      if (decision) {
        client.removeListener('readable', onReadable);
        clearTimeout(timer);
        pipe(client, decision);
        return;
      }
      if (head.length >= 512) {
        client.removeListener('readable', onReadable);
        clearTimeout(timer);
        pipe(client, { kind: 'unknown', first: head });
        return;
      }
    }
  };
  client.on('readable', onReadable);
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
    process.send({ connections, http: httpCount, vless: vlessCount, unknown: unknownCount });
  }
});
