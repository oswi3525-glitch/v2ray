'use strict';

const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const cdb = require('./db');

const legacyPath = path.join(cdb.ROOT, 'database', 'tiktunnel.db');

function main() {
  if (cdb.getSetting('legacy_import_done') === '1') {
    console.log('legacy import already done');
    return;
  }
  const legacy = new DatabaseSync(legacyPath, { readOnly: true });
  const rows = legacy.prepare('SELECT name, uuid, sub_token FROM users WHERE revoked_at IS NULL ORDER BY id LIMIT 2').all();
  for (const r of rows) {
    const username = r.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'friend';
    if (cdb.getUserByUsername(username)) continue;
    try {
      cdb.createFriend({
        username,
        displayName: r.name,
        passwordHash: null,
        quotaBytes: 0,
        uuid: r.uuid,
        token: r.sub_token
      });
      console.log(`imported legacy account: ${r.name}`);
    } catch (e) {
      console.log(`skip ${r.name}: ${e.message}`);
    }
  }
  legacy.close();
  cdb.setSetting('legacy_import_done', '1');
  cdb.audit('system', 'legacy_import', 'tiktunnel.db', `${rows.length} row(s) considered, no password imported`);
  console.log('legacy import complete (old database kept intact)');
}
main();
