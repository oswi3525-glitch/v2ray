'use strict';
const root = document.getElementById('app');
const toastEl = document.getElementById('toast');
let me = null;

function toast(msg) {
  toastEl.textContent = msg; toastEl.hidden = false;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => { toastEl.hidden = true; }, 3200);
}
function csrfFromCookie() {
  const item = document.cookie.split('; ').find(x => x.startsWith('tiktunnel_csrf='));
  return item ? decodeURIComponent(item.slice('tiktunnel_csrf='.length)) : '';
}
async function api(path, opts = {}, refreshed = false) {
  const o = { credentials: 'same-origin', headers: {}, ...opts };
  o.headers = { ...o.headers };
  if (opts.body) o.headers['Content-Type'] = 'application/json';
  const csrf = sessionStorage.getItem('csrf') || csrfFromCookie();
  if (csrf) o.headers['x-csrf-token'] = csrf;
  const r = await fetch(path, o);
  let d = {};
  try { d = await r.json(); } catch { d = {}; }
  if (!r.ok) {
    if (r.status === 401 && d.error === 'unauthorized' && !path.startsWith('/api/auth/') && !refreshed) {
      const fresh = await fetch('/api/auth/me', { credentials: 'same-origin' }).then(x => x.json()).catch(() => ({}));
      if (fresh.ok && fresh.csrf) {
        sessionStorage.setItem('csrf', fresh.csrf);
        return api(path, opts, true);
      }
      sessionStorage.clear();
      location.href = '/';
    }
    throw new Error(d.error || `HTTP ${r.status}`);
  }
  return d;
}
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function fmt(n) { return Number(n || 0).toLocaleString(); }
function gb(n) { return (Number(n || 0) / 1e9).toFixed(2) + ' GB'; }
function b64utf8(s) {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
function openDeepLink(url) {
  const a = document.createElement('a');
  a.href = url;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
}
function shadowrocketFor(u, prefer = 'sub') {
  const uri = u?.vless_uri || '';
  const subUrl = u?.subscription_token ? `${location.origin}/api/sub/${u.subscription_token}` : '';
  if (!uri && !subUrl) throw new Error('configuration not ready');
  if (uri && navigator.clipboard?.writeText) navigator.clipboard.writeText(uri).catch(() => {});
  if (prefer === 'node' && uri) openDeepLink('shadowrocket://add/' + b64utf8(uri));
  else if (subUrl) openDeepLink('shadowrocket://subscribe?url=' + encodeURIComponent(subUrl));
  else openDeepLink('shadowrocket://add/' + b64utf8(uri));
  setTimeout(() => toast('Không mở được Shadowrocket? URI đã được copy — vào app → + → Import from Clipboard'), 1200);
}
function speedText(n) {
  let v = Number(n || 0);
  if (v <= 0) return '0 B/s';
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return v.toFixed(v >= 100 ? 0 : 1) + ' ' + units[i];
}
function copy(text) { navigator.clipboard?.writeText(text).then(() => toast('Copied')).catch(() => toast('Copy failed')); }
function shell(title, body) {
  root.innerHTML = `<div class="wrap">
    <header class="topbar">
      <div class="brand"><span class="brand-mark">T</span><span><b>TikTunnel</b><small>Control panel</small></span></div>
      <div class="row"><span class="pill ok">${esc(title)}</span><span class="sub">${esc(me?.username || '')}</span>
      <button class="ghost small" id="clear-cache" title="Reload assets without browser cache">Clear cache</button>
      <button class="ghost small" id="logout">Logout</button></div>
    </header>${body}</div>`;
  document.getElementById('clear-cache').onclick = () => { location.href = location.pathname + '?r=' + Date.now(); };
  document.getElementById('logout').onclick = async () => { await api('/api/auth/logout', { method: 'POST' }); sessionStorage.clear(); location.href = '/'; };
}

async function authScreen() {
  root.innerHTML = `<div class="center"><span class="brand-mark" style="width:52px;height:52px;font-size:24px">T</span>
    <h1>TikTunnel Control</h1>
    <p class="sub">Đăng nhập để tiếp tục</p>
    <div class="card" style="width:100%;max-width:380px">
      <form id="f">
        <label>Username</label><input id="u" autocomplete="username" required>
        <label>Password</label><input id="p" type="password" autocomplete="current-password" required>
        <button style="width:100%;margin-top:16px" type="submit">Sign In</button>
      </form></div></div>`;
  document.getElementById('f').onsubmit = async (e) => {
    e.preventDefault();
    const u = document.getElementById('u').value, p = document.getElementById('p').value;
    try {
      const d = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: u, password: p }) });
      sessionStorage.setItem('csrf', d.csrf);
      location.href = d.role === 'admin' ? '/admin' : '/friend';
    } catch (err) { toast(err.message); }
  };
}

async function adminPage() {
  const [ov, us, mon] = await Promise.all([
    api('/api/admin/overview'), api('/api/admin/users'), api('/api/monitor/network')
  ]);
  const rows = us.users.map(u => `<tr>
    <td><b>${esc(u.display_name)}</b><br><span class="mono">${esc(u.username)}</span></td>
    <td>${u.enabled ? '<span class="pill ok">enabled</span>' : '<span class="pill bad">disabled</span>'}
        ${u.exhausted ? '<span class="pill warn">exhausted</span>' : ''}</td>
    <td>${gb(u.quota_bytes)}<br><span class="sub">used ${gb(u.used_upload + u.used_download)}</span></td>
    <td class="mono">${u.uuid ? esc(u.uuid) : '—'}</td>
    <td><div class="actions">
      <button class="small ghost" data-copy="uuid" data-id="${u.id}">Copy UUID</button>
      <button class="small ghost" data-copy="uri" data-id="${u.id}">Copy VLESS</button>
      <button class="small ghost" data-copy="sub" data-id="${u.id}">Copy Sub</button>
      <button class="small ghost" data-shadow data-id="${u.id}">Add to Shadowrocket</button>
      <button class="small ghost" data-export data-id="${u.id}">Export file</button>
      <button class="small ghost" data-act="disable" data-id="${u.id}">Disable</button>
      <button class="small ghost" data-act="enable" data-id="${u.id}">Enable</button>
      <button class="small danger" data-act="delete" data-id="${u.id}">Revoke</button>
    </div></td></tr>`).join('');
  shell('Admin', `<div class="grid">
    <div class="stat"><span>VPN</span><b>${ov.server.sing_box ? 'running' : 'stopped'}</b></div>
    <div class="stat"><span>CPU</span><b>${ov.server.cpu_pct}%</b></div>
    <div class="stat"><span>RAM used</span><b>${(ov.server.ram_used_kb / 1048576).toFixed(2)} GB</b></div>
    <div class="stat"><span>Friends</span><b>${ov.accounts.friends}/${ov.accounts.max_friends}</b></div>
    <div class="stat"><span>Total accounts</span><b>${ov.accounts.friends + (ov.accounts.admin ? 1 : 0)}/${ov.accounts.max_friends + (ov.accounts.admin ? 1 : 0)}</b></div>
    <div class="stat"><span>Active VPN</span><b>${ov.vpn_users}</b></div>
    <div class="stat"><span>Endpoint</span><b style="font-size:13px">${esc(ov.public_endpoint)}</b></div>
  </div>
  <div class="card"><h2>Accounts</h2><div class="scroll"><table><thead><tr><th>User</th><th>Status</th><th>Quota</th><th>UUID</th><th>Actions</th></tr></thead><tbody>${rows || '<tr><td colspan="5">No accounts yet.</td></tr>'}</tbody></table></div></div>
  <div class="card"><h2>Add to Shadowrocket</h2>
    <p class="sub">Chọn account rồi bấm: app sẽ mở và tự tạo server. URI cũng được copy để dự phòng.</p>
    ${us.users.length ? `<label>Account</label><select id="shadow-user">${us.users.map(u => `<option value="${u.id}">${esc(u.display_name)} (${esc(u.username)})</option>`).join('')}</select>
    <div class="row" style="margin-top:12px">
      <button id="shadow-add">Add subscription</button>
      <button class="ghost" id="shadow-add-node">Add single node</button>
      <button class="ghost" id="shadow-copy-uri">Copy VLESS URI</button>
      <button class="ghost" id="shadow-copy">Copy subscription</button>
      <button class="ghost" id="shadow-export">Export file (.txt)</button>
    </div>
    <p class="sub">Xuất file: tải file <span class="mono">.txt</span> chứa 1 link VLESS, rồi mở Shadowrocket → <b>+</b> → <b>Import From File</b> → chọn file để thêm server.</p>` : '<p class="sub">No friend accounts yet. Create one below first.</p>'}
  </div>
  <div class="card"><h2>Create friend</h2><form id="create">
    <div class="row"><div style="flex:1;min-width:140px"><label>Username</label><input id="nu" required></div>
    <div style="flex:1;min-width:140px"><label>Display name</label><input id="nd" required></div>
    <div style="flex:1;min-width:100px"><label>Quota (GB)</label><input id="nq" type="number" min="0" step="any" value="5"></div></div>
    <label>Password (min 8 characters)</label><input id="np" type="password" minlength="8" required>
    <button style="margin-top:12px" type="submit">Create account</button></form></div>
  <div class="card"><h2>Quota</h2><form id="quota">
    <label>User ID</label><input id="qid" type="number" min="1" required>
    <div class="row"><div style="flex:1"><label>Action</label><select id="qact"><option value="set">Set</option><option value="add">Add</option><option value="reduce">Reduce</option><option value="reset">Reset</option></select></div>
    <div style="flex:1"><label>GB</label><input id="qgb" type="number" min="0" value="1"></div></div>
    <button style="margin-top:12px" type="submit">Apply quota</button></form></div>
  <div class="card"><h2>Network probes</h2><div id="probes">${mon.probes.map(p => `<div class="row"><span>${esc(p.host)}:${p.port}</span><span class="pill ${p.ok ? 'ok' : 'bad'}">${p.ok ? p.ms + ' ms' : 'unreachable'}</span></div>`).join('')}</div>
    <p class="sub">TCP connect probes from the server — not client-side latency to every website.</p></div>
  <div class="card"><h2>Metrics</h2><canvas id="chart" height="110"></canvas></div>`);

  document.getElementById('create').onsubmit = async e => {
    e.preventDefault();
    const username = document.getElementById('nu').value.trim();
    const password = document.getElementById('np').value;
    if (!/^[A-Za-z0-9_.-]{2,32}$/.test(username)) { toast('invalid_username'); return; }
    if (password.length < 8) { toast('invalid_password'); return; }
    try {
      await api('/api/admin/users', { method: 'POST', body: JSON.stringify({
        username, display_name: document.getElementById('nd').value.trim() || username,
        password, quota_gb: document.getElementById('nq').value
      }) });
      toast('Account created'); adminPage();
    } catch (err) { toast(err.message); }
  };
  document.getElementById('quota').onsubmit = async e => {
    e.preventDefault();
    try {
      await api(`/api/admin/users/${document.getElementById('qid').value}/quota`, { method: 'POST', body: JSON.stringify({
        action: document.getElementById('qact').value, gb: Number(document.getElementById('qgb').value)
      }) });
      toast('Quota updated'); adminPage();
    } catch (err) { toast(err.message); }
  };
  document.querySelectorAll('[data-copy]').forEach(b => b.onclick = async () => {
    const u = us.users.find(x => x.id === Number(b.dataset.id));
    let val = u?.uuid || '';
    if (b.dataset.copy === 'sub') val = `${location.origin}/api/sub/${u.subscription_token}`;
    if (b.dataset.copy === 'uri') val = u?.vless_uri || '';
    copy(val);
  });
  document.querySelectorAll('[data-shadow]').forEach(b => b.onclick = () => {
    const u = us.users.find(x => x.id === Number(b.dataset.id));
    try { shadowrocketFor(u, 'sub'); } catch (err) { toast(err.message); }
  });
  document.querySelectorAll('[data-export]').forEach(b => b.onclick = () => {
    location.href = `/api/admin/users/${b.dataset.id}/export`;
  });
  if (document.getElementById('shadow-add')) {
    document.getElementById('shadow-add').onclick = () => {
      const u = us.users.find(x => x.id === Number(document.getElementById('shadow-user').value));
      try { shadowrocketFor(u, 'sub'); } catch (err) { toast(err.message); }
    };
    document.getElementById('shadow-add-node').onclick = () => {
      const u = us.users.find(x => x.id === Number(document.getElementById('shadow-user').value));
      try { shadowrocketFor(u, 'node'); } catch (err) { toast(err.message); }
    };
    document.getElementById('shadow-copy').onclick = () => {
      const u = us.users.find(x => x.id === Number(document.getElementById('shadow-user').value));
      copy(u ? `${location.origin}/api/sub/${u.subscription_token}` : '');
    };
    document.getElementById('shadow-copy-uri').onclick = () => {
      const u = us.users.find(x => x.id === Number(document.getElementById('shadow-user').value));
      copy(u?.vless_uri || '');
    };
    document.getElementById('shadow-export').onclick = () => {
      location.href = `/api/admin/users/${document.getElementById('shadow-user').value}/export`;
    };
  }
  document.querySelectorAll('[data-act]').forEach(b => b.onclick = async () => {
    const id = b.dataset.id;
    if (b.dataset.act === 'delete' && !confirm('Revoke this account?')) return;
    try {
      await api(`/api/admin/users/${id}/${b.dataset.act}`, { method: 'POST' });
      toast('Updated'); adminPage();
    } catch (err) { toast(err.message); }
  });
  const m = await api('/api/monitor/performance');
  if (window.Chart && m.metrics.length) {
    const pts = [...m.metrics].reverse();
    new Chart(document.getElementById('chart'), {
      type: 'line', data: { labels: pts.map(p => p.ts.slice(11, 16)), datasets: [
        { label: 'CPU %', data: pts.map(p => p.cpu_pct), borderColor: '#2f81f7' },
        { label: 'RAM GB', data: pts.map(p => p.ram_used_kb / 1048576), borderColor: '#3fb950' }
      ] }, options: { responsive: true, plugins: { legend: { labels: { color: '#8ea1b5' } } }, scales: { x: { ticks: { color: '#8ea1b5' } }, y: { ticks: { color: '#8ea1b5' } } } }
    });
  }
}

async function friendPage() {
  const [u, v, sub] = await Promise.all([api('/api/friend/me'), api('/api/friend/vpn'), api('/api/friend/subscription')]);
  const uu = u.user;
  shell('Account', `<div class="card hero">
    <div><span class="sub">Xin chào,</span><h2>${esc(uu.display_name)}</h2>
    <p class="sub">${uu.enabled && !uu.exhausted ? 'Tài khoản đang hoạt động' : 'Tài khoản tạm ngưng — liên hệ admin'}</p></div>
    <span class="pill ${uu.enabled && !uu.exhausted ? 'ok' : 'bad'}" id="live-status">${uu.enabled && !uu.exhausted ? 'Active' : 'Inactive'}</span>
  </div>
  <div class="card live-card">
    <div class="live-head"><h2>Dung lượng & tốc độ</h2><span class="sub">cập nhật mỗi 2 giây</span></div>
    <div class="quota-line"><span>Đã dùng <b id="quota-used">—</b></span><span class="sub">/ <span id="quota-total">—</span></span></div>
    <div class="progress"><div class="progress-fill" id="quota-bar"></div></div>
    <div class="live-grid">
      <div class="live-item"><span>Còn lại</span><b id="quota-left">—</b></div>
      <div class="live-item"><span>Tải về ↓</span><b id="speed-down">0 B/s</b></div>
      <div class="live-item"><span>Gửi lên ↑</span><b id="speed-up">0 B/s</b></div>
    </div>
  </div>
  <div class="grid">
    <div class="stat"><span>Username</span><b>${esc(uu.username)}</b></div>
    <div class="stat"><span>Upload</span><b>${gb(uu.used_upload)}</b></div>
    <div class="stat"><span>Download</span><b>${gb(uu.used_download)}</b></div>
    <div class="stat"><span>Hết hạn</span><b style="font-size:14px">${esc(uu.expires_at || 'Không giới hạn')}</b></div>
  </div>
  <div class="card"><h2>Kết nối</h2>
    <p class="sub">Chế độ: ${esc(v.mode)} — ${v.active ? 'cấu hình đang hoạt động' : 'chưa có kết nối'}</p>
    <div class="row" style="margin-top:12px">
      <button id="addios">Add to Shadowrocket</button>
      <button class="ghost" id="addios-node">Add single node</button>
      <button class="ghost" id="copyuri">Copy VLESS URI</button>
      <button class="ghost" id="copysub">Copy subscription URL</button>
    </div>
    <details class="adv"><summary>Xem cấu hình VLESS</summary><p class="mono">${esc(v.uri || 'No configuration available')}</p></details>
    <p class="sub">Trên iPhone: bấm “Add to Shadowrocket” để app mở và tự tạo server. Nếu không mở, URI đã được copy — vào Shadowrocket → + → Import from Clipboard.</p>
  </div>
  <div class="card export-card"><h2>Xuất file cấu hình</h2>
    <p class="sub">Tải file <span class="mono">.txt</span> chứa link VLESS của bạn, rồi thêm server trong Shadowrocket bằng file này.</p>
    <ol class="steps">
      <li>Bấm <b>Tải file .txt</b> — file sẽ được lưu vào <b>Files</b> trên iPhone.</li>
      <li>Mở Shadowrocket → góc trên bên phải <b>+</b> → chọn <b>Import From File</b>.</li>
      <li>Chọn file vừa tải → app tự thêm server → bật kết nối.</li>
    </ol>
    <button id="exportfile">Tải file .txt</button>
  </div>
  <div class="card"><h2>Lưu lượng theo thời gian</h2><canvas id="chart" height="120"></canvas></div>`);
  document.getElementById('copyuri').onclick = () => copy(v.uri || '');
  document.getElementById('copysub').onclick = () => copy(`${location.origin}${sub.url}`);
  document.getElementById('addios').onclick = () => {
    try { shadowrocketFor({ vless_uri: v.uri, subscription_token: sub.token }, 'sub'); } catch (err) { toast(err.message); }
  };
  document.getElementById('addios-node').onclick = () => {
    try { shadowrocketFor({ vless_uri: v.uri, subscription_token: sub.token }, 'node'); } catch (err) { toast(err.message); }
  };
  document.getElementById('exportfile').onclick = () => { location.href = '/api/friend/export'; };
  async function refreshLive() {
    try {
      const d = await api('/api/friend/live');
      const quota = Number(d.quota_bytes || 0);
      const used = Number(d.used_bytes || 0);
      const pct = quota > 0 ? Math.min(100, (used / quota) * 100) : 0;
      document.getElementById('quota-used').textContent = gb(used);
      document.getElementById('quota-total').textContent = quota > 0 ? gb(quota) : 'Không giới hạn';
      document.getElementById('quota-left').textContent = quota > 0 ? gb(d.remaining_bytes) : '∞';
      const bar = document.getElementById('quota-bar');
      bar.style.width = pct + '%';
      bar.classList.toggle('warn', pct >= 75 && pct < 90);
      bar.classList.toggle('danger', pct >= 90);
      document.getElementById('speed-down').textContent = speedText(d.down_bps);
      document.getElementById('speed-up').textContent = speedText(d.up_bps);
      const st = document.getElementById('live-status');
      st.textContent = d.active ? 'Đang kết nối' : (uu.enabled && !uu.exhausted ? 'Active' : 'Inactive');
      st.className = 'pill ' + (d.active || (uu.enabled && !uu.exhausted) ? 'ok' : 'bad');
    } catch {}
  }
  await refreshLive();
  const timer = setInterval(refreshLive, 2000);
  window.addEventListener('pagehide', () => clearInterval(timer));
  const h = await api('/api/friend/usage');
  if (window.Chart && h.history.length) {
    const pts = [...h.history].reverse();
    new Chart(document.getElementById('chart'), {
      type: 'bar', data: { labels: pts.map(p => p.ts.slice(5, 16)), datasets: [
        { label: 'Download', data: pts.map(p => p.download_bytes / 1e6), backgroundColor: '#2f81f7' },
        { label: 'Upload', data: pts.map(p => p.upload_bytes / 1e6), backgroundColor: '#3fb950' }
      ] }, options: { responsive: true, plugins: { legend: { labels: { color: '#8ea1b5' } } }, scales: { x: { ticks: { color: '#8ea1b5' } }, y: { ticks: { color: '#8ea1b5' } } } }
    });
  }
}

(async () => {
  try {
    const r = await fetch('/api/auth/me');
    if (r.ok) {
      me = await r.json();
      if (me.role === 'admin') return adminPage();
      return friendPage();
    }
    return authScreen();
  } catch (e) {
    root.innerHTML = `<div class="center"><h1>TikTunnel Control</h1><p class="sub">Unable to reach API: ${esc(e.message)}</p></div>`;
  }
})();
