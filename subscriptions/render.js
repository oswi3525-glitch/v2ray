'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const db = require('../api/db');

const { ROOT } = db;
const cfgEnv = require('../config/runtime');
const outDir = path.join(ROOT, 'subscriptions');
fs.mkdirSync(outDir, { recursive: true });

function buildUri(row) {
  const q = new URLSearchParams();
  q.set('encryption', 'none');
  q.set('type', cfgEnv.transport || 'tcp');
  q.set('security', cfgEnv.security || 'none');
  if (cfgEnv.security === 'tls' && cfgEnv.sni) q.set('sni', cfgEnv.sni);
  if (cfgEnv.flow) q.set('flow', cfgEnv.flow);
  return `vless://${row.uuid}@${cfgEnv.serverHost}:${cfgEnv.serverPort}?${q.toString()}#${encodeURIComponent(row.name)}`;
}

const byToken = new Map();
for (const row of db.listActiveUsers()) {
  if (!byToken.has(row.sub_token)) byToken.set(row.sub_token, []);
  byToken.get(row.sub_token).push(buildUri(row));
}

for (const [token, uris] of byToken) {
  const digest = crypto.createHash('sha256').update(token).digest('hex').slice(0, 12);
  const target = path.join(outDir, `${digest}.txt`);
  fs.writeFileSync(target, Buffer.from(uris.join('\n') + '\n').toString('base64'), { mode: 0o600 });
  fs.chmodSync(target, 0o600);
  process.stdout.write(`subscription written: subscriptions/${digest}.txt (${uris.length} link)\n`);
}
