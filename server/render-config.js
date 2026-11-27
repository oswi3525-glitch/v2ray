'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ROOT, listActiveUsers } = require('../api/db');

const cfgEnv = require('../config/runtime');

const users = listActiveUsers().map((u) => {
  const entry = { uuid: u.uuid, flow: cfgEnv.flow || '' };
  return entry;
});

const cfg = {
  log: {
    level: 'warn',
    timestamp: true,
    output: path.join(ROOT, 'logs', 'sing-box.log')
  },
  dns: {
    servers: [{ type: 'local', tag: 'local-dns' }]
  },
  inbounds: [
    {
      type: 'vless',
      tag: 'vless-in',
      listen: cfgEnv.listenHost,
      listen_port: cfgEnv.serverPort,
      users
    }
  ],
  outbounds: [
    { type: 'direct', tag: 'direct' },
    { type: 'block', tag: 'block' }
  ],
  route: {
    rules: [],
    final: 'direct'
  }
};

const outPath = path.join(ROOT, 'config', 'sing-box.json');
fs.writeFileSync(outPath, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
fs.chmodSync(outPath, 0o600);

process.stdout.write(`rendered ${users.length} active user(s) -> ${outPath}\n`);
