'use strict';

const fs = require('node:fs');
const path = require('node:path');
const cdb = require('../control/db');
const cfgEnv = require('../config/runtime');

const control = JSON.parse(fs.readFileSync(path.join(cdb.ROOT, 'config', 'control.json'), 'utf8'));
const mode = control.vpn_mode || 'ws';

const users = cdb.activeVpnUsers().map((u) => ({ name: u.username, uuid: u.uuid, flow: '' }));

const inbounds = [
  {
    type: 'vless',
    tag: 'vless-ws-in',
    listen: control.singbox_ws_host,
    listen_port: Number(control.singbox_ws_port),
    users,
    transport: { type: 'ws', path: control.ws_path }
  },
  {
    type: 'vless',
    tag: 'vless-tcp-in',
    listen: '127.0.0.1',
    listen_port: Number(control.vless_tcp_port || 23955),
    users
  }
];

let expCfg = null;
try { expCfg = cdb.getExperimentalConfig(); } catch {}
if (expCfg && expCfg.enabled) {
  for (const u of cdb.activeVpnUsers()) cdb.getOrCreateExperimentalUuid(u.id);
  const expUsers = cdb.listExperimentalClients().map((u) => ({ name: u.username + '-exp', uuid: u.uuid, flow: '' }));
  inbounds.push({
    type: 'vless',
    tag: 'vless-experimental-in',
    listen: '127.0.0.1',
    listen_port: 23956,
    users: expUsers
  });
}

const cfg = {
  log: { level: 'warn', timestamp: true, output: path.join(cdb.ROOT, 'logs', 'sing-box.log') },
  dns: { servers: [{ type: 'local', tag: 'local-dns' }] },
  inbounds,
  outbounds: [{ type: 'direct', tag: 'direct' }, { type: 'block', tag: 'block' }],
  route: { rules: [], final: 'direct' }
};

const out = path.join(cdb.ROOT, 'config', 'sing-box.json');
fs.writeFileSync(out, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
fs.chmodSync(out, 0o600);
process.stdout.write(`rendered ${users.length} VPN user(s) in ${mode} mode\n`);
