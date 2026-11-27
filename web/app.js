'use strict';
const root = document.getElementById('app');
const toastEl = document.getElementById('toast');
let me = null;
let importCache = null;
let importCacheExp = null;
let panelCleanup = null;

function toast(msg) {
  toastEl.textContent = msg; toastEl.hidden = false;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => { toastEl.hidden = true; }, 3600);
}
function csrfFromCookie() {
  const item = document.cookie.split('; ').find(x => x.startsWith('tiktunnel_csrf='));
  return item ? decodeURIComponent(item.slice('tiktunnel_csrf='.length)) : '';
}
function timedFetch(path, opts = {}, ms = 9000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(path, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(timer));
}
async function api(path, opts = {}, refreshed = false) {
  const o = { credentials: 'same-origin', headers: {}, ...opts };
  o.headers = { ...o.headers };
  if (opts.body) o.headers['Content-Type'] = 'application/json';
  const csrf = sessionStorage.getItem('csrf') || csrfFromCookie();
  if (csrf) o.headers['x-csrf-token'] = csrf;
  const r = await timedFetch(path, o);
  let d = {};
  try { d = await r.json(); } catch { d = {}; }
  if (!r.ok) {
    if (r.status === 401 && d.error === 'unauthorized' && !path.startsWith('/api/auth/') && !refreshed) {
      const fresh = await timedFetch('/api/auth/me', { credentials: 'same-origin' }, 5000).then(x => x.json()).catch(() => ({}));
      if (fresh.ok && fresh.csrf) {
        sessionStorage.setItem('csrf', fresh.csrf);
        return api(path, opts, true);
      }
      sessionStorage.clear(); location.href = '/';
    }
    throw new Error(d.error || `HTTP ${r.status}`);
  }
  return d;
}
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function gb(n) { return (Number(n || 0) / 1e9).toFixed(2) + ' GB'; }
function speedText(n) {
  let v = Number(n || 0);
  if (v <= 0) return '0 B/s';
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return v.toFixed(v >= 100 ? 0 : 1) + ' ' + units[i];
}
function mbpsText(n) { return Number(n || 0).toFixed(n >= 100 ? 0 : 1); }
function copy(text) { navigator.clipboard?.writeText(text).then(() => toast('Đã copy')).catch(() => toast('Copy thất bại')); }
function randomId() {
  if (crypto.randomUUID) return crypto.randomUUID().replace(/-/g, '');
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
function deviceId() {
  let id = localStorage.getItem('tiktunnel_device_id');
  if (!id || !/^[A-Za-z0-9_-]{8,64}$/.test(id)) {
    id = randomId() + randomId().slice(0, 16);
    localStorage.setItem('tiktunnel_device_id', id);
  }
  return id;
}
function openDeepLink(url) {
  const a = document.createElement('a');
  a.href = url; a.style.display = 'none';
  document.body.appendChild(a); a.click(); a.remove();
}
function skeleton(n = 3) {
  return `<div class="skeleton-wrap">${Array.from({ length: n }, () => '<div class="skeleton"></div>').join('')}</div>`;
}
function emptyState(msg, sub = '') { return `<div class="empty"><div class="empty-icon">○</div><b>${esc(msg)}</b>${sub ? `<p class="sub">${esc(sub)}</p>` : ''}</div>`; }
function errorState(msg) { return `<div class="empty error"><div class="empty-icon">!</div><b>Không tải được dữ liệu</b>
  <p class="sub">${esc(msg)}</p><button class="ghost small" id="retry-load">Thử lại</button></div>`; }
function statusPill(status) {
  const map = { active: ['ok', 'Active'], idle: ['warn', 'Idle'], offline: ['', 'Offline'], unknown: ['warn', 'Unknown'] };
  const [cls, label] = map[status] || map.unknown;
  return `<span class="pill ${cls}">${label}</span>`;
}
function modal(title, body, confirmText, onConfirm) {
  const wrap = document.createElement('div');
  wrap.className = 'modal-backdrop';
  wrap.innerHTML = `<div class="modal"><h2>${esc(title)}</h2><div class="modal-body">${body}</div>
    <div class="row end"><button class="ghost" id="modal-cancel">Hủy</button><button id="modal-ok">${esc(confirmText)}</button></div></div>`;
  document.body.appendChild(wrap);
  wrap.querySelector('#modal-cancel').onclick = () => wrap.remove();
  wrap.querySelector('#modal-ok').onclick = async () => { await onConfirm(); wrap.remove(); };
  wrap.onclick = (e) => { if (e.target === wrap) wrap.remove(); };
}
function shell(title) {
  const theme = localStorage.getItem('tiktunnel_theme') === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = theme;
  return `<div class="wrap"><header class="topbar">
    <div class="brand"><span class="brand-mark">T</span><span><b>TikTunnel</b><small>Control panel</small></span></div>
    <div class="row"><span class="pill ok">${esc(title)}</span><span class="sub">${esc(me?.username || '')}</span>
    <button class="ghost small" id="notif-btn" title="Thông báo">Notifications <span class="badge" id="notif-badge" hidden>0</span></button>
    <button class="ghost small" id="theme-toggle" title="Đổi chủ đề">${theme === 'light' ? 'Dark' : 'Light'}</button>
    <button class="ghost small" id="clear-cache" title="Tải lại không dùng cache">Reload</button>
    <button class="ghost small" id="logout">Logout</button></div>
    <div class="notif-panel" id="notif-panel" hidden></div></header>
    <nav class="tabs" id="tabs"></nav><div id="panel"></div></div>`;
}
let notifTimer = null;
let notifOutside = null;
function notificationsHtml(d) {
  const rows = d.items.map((n) => `<div class="notif-item ${n.read_at ? '' : 'unread'}">
    <b>${esc(n.title)}</b><span class="sub">${esc(n.type)} · ${esc(n.ts.slice(5, 16))}</span>
    <p>${esc(n.body)}</p></div>`).join('');
  return `<div class="notif-head"><b>Thông báo</b><button class="ghost small" id="notif-read">Đã đọc tất cả</button></div>
    ${rows || '<p class="sub">Chưa có thông báo.</p>'}`;
}
async function refreshNotifications() {
  const badge = document.getElementById('notif-badge');
  if (!badge) return;
  try {
    const d = await api('/api/notifications?limit=20');
    badge.textContent = String(d.unread);
    badge.hidden = d.unread === 0;
    const panel = document.getElementById('notif-panel');
    if (panel && !panel.hidden) {
      panel.innerHTML = notificationsHtml(d);
      const read = document.getElementById('notif-read');
      if (read) read.onclick = async () => {
        try { await api('/api/notifications/read', { method: 'POST', body: '{}' }); await refreshNotifications(); toast('Đã đánh dấu đã đọc'); }
        catch (e) { toast(e.message); }
      };
    }
  } catch {}
}
function bindShell() {
  const notifBtn = document.getElementById('notif-btn');
  const notifPanel = document.getElementById('notif-panel');
  notifBtn.onclick = async () => {
    notifPanel.hidden = !notifPanel.hidden;
    if (!notifPanel.hidden) { notifPanel.innerHTML = skeleton(2); await refreshNotifications(); }
  };
  if (notifOutside) document.removeEventListener('click', notifOutside);
  notifOutside = (e) => {
    if (!notifPanel.hidden && !notifPanel.contains(e.target) && e.target !== notifBtn && !notifBtn.contains(e.target)) notifPanel.hidden = true;
  };
  document.addEventListener('click', notifOutside);
  refreshNotifications();
  clearInterval(notifTimer);
  notifTimer = setInterval(refreshNotifications, 30000);
  document.getElementById('theme-toggle').onclick = () => {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    localStorage.setItem('tiktunnel_theme', next); document.documentElement.dataset.theme = next;
    document.getElementById('theme-toggle').textContent = next === 'light' ? 'Dark' : 'Light';
  };
  document.getElementById('clear-cache').onclick = () => { location.href = location.pathname + '?r=' + Date.now(); };
  document.getElementById('logout').onclick = async () => {
    try { await api('/api/auth/logout', { method: 'POST' }); } catch {}
    sessionStorage.clear(); location.href = '/';
  };
}
function mount(title, builders, initial) {
  root.innerHTML = shell(title);
  bindShell();
  const nav = document.getElementById('tabs');
  nav.innerHTML = Object.keys(builders).map(k => `<button data-tab="${k}">${esc(k)}</button>`).join('');
  async function show(name) {
    if (panelCleanup) { panelCleanup(); panelCleanup = null; }
    document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
    const panel = document.getElementById('panel');
    panel.innerHTML = skeleton();
    try {
      const { html, after } = await Promise.race([
        builders[name](),
        new Promise((_, reject) => setTimeout(() => reject(new Error('request_timeout')), 12000))
      ]);
      panel.innerHTML = html;
      if (after) after();
    } catch (e) {
      panel.innerHTML = errorState(e.message === 'request_timeout' ? 'Yêu cầu quá thời gian chờ' : e.message);
      const retry = document.getElementById('retry-load');
      if (retry) retry.onclick = () => show(name);
    }
  }
  nav.querySelectorAll('button').forEach(b => b.onclick = () => show(b.dataset.tab));
  show(initial);
}

async function authScreen() {
  root.innerHTML = `<div class="center"><span class="brand-mark" style="width:52px;height:52px;font-size:24px">T</span>
    <h1>TikTunnel Control</h1><p class="sub">Đăng nhập để tiếp tục</p>
    <div class="card" style="width:100%;max-width:380px"><form id="f">
      <label>Username</label><input id="u" autocomplete="username" required>
      <label>Password</label><input id="p" type="password" autocomplete="current-password" required>
      <button style="width:100%;margin-top:16px" type="submit">Sign In</button></form></div></div>`;
  document.getElementById('f').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const d = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({
        username: document.getElementById('u').value, password: document.getElementById('p').value }) });
      sessionStorage.setItem('csrf', d.csrf);
      location.href = d.role === 'admin' ? '/admin' : '/friend';
    } catch (err) { toast(err.message); }
  };
}

function gaugeHtml() {
  return `<div class="gauge-box"><svg viewBox="0 0 200 124" class="gauge" aria-hidden="true">
    <path d="M20 110 A80 80 0 0 1 180 110" fill="none" stroke="var(--line)" stroke-width="12" stroke-linecap="round"/>
    <path id="gauge-arc" d="M20 110 A80 80 0 0 1 180 110" fill="none" stroke="var(--accent)" stroke-width="12" stroke-linecap="round" stroke-dasharray="251.3" stroke-dashoffset="251.3"/>
    <line id="gauge-needle" x1="100" y1="110" x2="100" y2="42" stroke="var(--fg)" stroke-width="3" stroke-linecap="round" transform="rotate(-90 100 110)"/>
    <circle cx="100" cy="110" r="5" fill="var(--fg)"/></svg>
    <div class="gauge-value"><b id="gauge-num">0.0</b><span>Mbps</span></div></div>`;
}
function setGauge(mbps, label = '') {
  const pct = Math.max(0, Math.min(1, Number(mbps || 0) / 100));
  const arc = document.getElementById('gauge-arc');
  if (arc) {
    arc.style.strokeDashoffset = String(251.3 * (1 - pct));
    arc.style.stroke = pct > 0.8 ? 'var(--err)' : pct > 0.5 ? 'var(--warn)' : 'var(--accent)';
    document.getElementById('gauge-needle').setAttribute('transform', `rotate(${-90 + 180 * pct} 100 110)`);
  }
  if (label) document.getElementById('gauge-num').textContent = mbpsText(mbps);
}

function diagPill(status) {
  const cls = status === 'PASS' ? 'ok' : status === 'FAIL' ? 'bad' : status === 'WARNING' ? 'warn' : '';
  return `<span class="pill ${cls}">${esc(status)}</span>`;
}
function diagnosticsHtml(d) {
  const rows = d.checks.map((c) => `<div class="diag-item">
    <div class="diag-head">${diagPill(c.status)}<b>${esc(c.label)}</b><span class="sub">${esc(c.checked_at.slice(11, 19))} · ${c.duration_ms} ms</span></div>
    <p>${esc(c.detail)}</p>
    ${c.cause ? `<p class="sub">Nguyên nhân: ${esc(c.cause)}</p>` : ''}
    ${c.fix ? `<p class="sub">Khắc phục: ${esc(c.fix)}</p>` : ''}
  </div>`).join('');
  return `<div class="live-grid">
    <div class="live-item"><span>PASS</span><b>${d.summary.pass}</b></div>
    <div class="live-item"><span>FAIL</span><b>${d.summary.fail}</b></div>
    <div class="live-item"><span>WARNING</span><b>${d.summary.warning}</b></div>
    <div class="live-item"><span>UNKNOWN</span><b>${d.summary.unknown}</b></div></div>
    <div class="diag-list">${rows}</div>`;
}
async function diagnosticsTab() {
  let d = await api('/api/diagnostics/run');
  return { html: `<div class="card"><div class="live-head"><h2>Network Diagnostics</h2>
      <button id="diag-run">Chạy lại</button></div>
      <p class="sub">Kiểm tra thật từ máy chủ. Mục không xác minh được từ server sẽ hiện <b>UNKNOWN</b>, không tự đánh dấu PASS.</p>
      <div class="diag-list" id="diag-result">${diagnosticsHtml(d)}</div></div>`,
    after: () => document.getElementById('diag-run').onclick = async () => {
      const box = document.getElementById('diag-result');
      box.innerHTML = skeleton(3);
      try { d = await api('/api/diagnostics/run'); box.innerHTML = diagnosticsHtml(d); toast('Đã chạy xong chẩn đoán'); }
      catch (e) { box.innerHTML = errorState(e.message); }
    } };
}

async function friendView() {
  let liveTimer = null;
  let speed = { state: 'IDLE', abort: null, history: [], chart: null };
  const dev = deviceId();

  async function overview() {
    const [u, l] = await Promise.all([api('/api/friend/me'), api('/api/friend/live')]);
    const q = Number(u.user.quota_bytes || 0);
    const pct = q > 0 ? Math.min(100, l.used_bytes / q * 100) : 0;
    return { html: `<div class="card hero"><div><span class="sub">Xin chào,</span><h2>${esc(u.user.display_name)}</h2>
      <p class="sub">${u.user.enabled && !u.user.exhausted ? 'Tài khoản hoạt động' : 'Tài khoản tạm ngưng'}</p></div>
      <span class="pill ${l.active ? 'ok' : ''}" id="ov-status">${l.active ? 'Đang kết nối' : 'Không có kết nối'}</span></div>
      <div class="card"><div class="live-head"><h2>Dung lượng</h2><span class="sub">${q > 0 ? 'Có giới hạn' : 'Không giới hạn'}</span></div>
      <div class="quota-line"><span>Đã dùng <b id="ov-used">${gb(l.used_bytes)}</b></span><span class="sub">/ ${q > 0 ? gb(q) : '∞'}</span></div>
      <div class="progress"><div class="progress-fill ${pct >= 90 ? 'danger' : pct >= 75 ? 'warn' : ''}" style="width:${pct}%"></div></div>
      <div class="live-grid"><div class="live-item"><span>Còn lại</span><b>${q > 0 ? gb(l.remaining_bytes) : '∞'}</b></div>
      <div class="live-item"><span>Tải ↓</span><b id="ov-down">${speedText(l.down_bps)}</b></div>
      <div class="live-item"><span>Gửi ↑</span><b id="ov-up">${speedText(l.up_bps)}</b></div></div></div>
      <div class="grid"><div class="stat"><span>Username</span><b>${esc(u.user.username)}</b></div>
      <div class="stat"><span>Hết hạn</span><b style="font-size:14px">${esc(u.user.expires_at || '—')}</b></div>
      <div class="stat"><span>Upload</span><b>${gb(u.user.used_upload)}</b></div>
      <div class="stat"><span>Download</span><b>${gb(u.user.used_download)}</b></div></div>
      <p class="sub">Cập nhật live mỗi 5 giây. Dữ liệu lấy từ session VPN thực, không phải lần đăng nhập web.</p>`,
      after: () => {
        clearInterval(liveTimer);
        panelCleanup = () => clearInterval(liveTimer);
        liveTimer = setInterval(async () => {
          try {
            const d = await api('/api/friend/live');
            document.getElementById('ov-used').textContent = gb(d.used_bytes);
            document.getElementById('ov-down').textContent = speedText(d.down_bps);
            document.getElementById('ov-up').textContent = speedText(d.up_bps);
          } catch {}
        }, 5000);
      } };
  }

  async function dataUsage() {
    const [u, h] = await Promise.all([api('/api/friend/usage'), api('/api/friend/speedtests?limit=10')]);
    const pts = [...h.tests].reverse();
    return { html: `<div class="card"><h2>Lưu lượng theo thời gian</h2>
      ${pts.length ? '<canvas id="usage-chart" height="120"></canvas>' : emptyState('Chưa có bài test nào', 'Chạy Network Test để có dữ liệu')}</div>
      <div class="card"><h2>Lịch sử đo tốc độ</h2>${pts.length ? `<div class="scroll"><table><thead><tr><th>Thời gian</th><th>Chế độ</th><th>Ping</th><th>Down</th><th>Up</th><th>Dùng</th></tr></thead><tbody>
      ${pts.map(t => `<tr><td class="mono">${esc(t.ts.slice(5, 16))}</td><td>${esc(t.mode)}${t.verified ? '' : ' <span class="pill warn">chưa xác minh</span>'}</td>
      <td>${Number(t.ping_ms).toFixed(0)} ms</td><td>${Number(t.download_mbps).toFixed(1)} Mbps</td><td>${Number(t.upload_mbps).toFixed(1)} Mbps</td><td>${gb(t.bytes_used)}</td></tr>`).join('')}
      </tbody></table></div>` : emptyState('Chưa có lịch sử đo tốc độ')}</div>`,
      after: () => {
        if (!pts.length || !window.Chart) return;
        new Chart(document.getElementById('usage-chart'), { type: 'line', data: { labels: pts.map(p => p.ts.slice(5, 16)), datasets: [
          { label: 'Download Mbps', data: pts.map(p => p.download_mbps), borderColor: '#2f81f7', tension: .3 },
          { label: 'Upload Mbps', data: pts.map(p => p.upload_mbps), borderColor: '#3fb950', tension: .3 }
        ] }, options: { responsive: true, plugins: { legend: { labels: { color: '#8ea1b5' } } }, scales: { x: { ticks: { color: '#8ea1b5' } }, y: { ticks: { color: '#8ea1b5' } } } } });
      } };
  }

  async function networkTest() {
    return { html: `<div class="card test-card">
      <div class="live-head"><h2>Network Test</h2><span class="pill" id="test-state">IDLE</span></div>
      <p class="sub">Đo tới endpoint của TikTunnel bằng dữ liệu thật. Không dùng số liệu ngẫu nhiên, không dùng tốc độ VPS thay cho thiết bị.</p>
      <div class="mode-row"><button class="mode active" data-mode="vpn">VPN (mặc định)</button><button class="mode" data-mode="direct">Direct</button></div>
      <p class="sub warn-note" id="mode-note">VPN: kết quả chỉ gắn nhãn VPN khi bạn đã bật Shadowrocket. Máy chủ không xác minh được trạng thái tunnel qua HTTP.</p>
      ${gaugeHtml()}
      <div class="live-grid six">
        <div class="live-item"><span>Ping</span><b id="t-ping">—</b></div>
        <div class="live-item"><span>Jitter</span><b id="t-jitter">—</b></div>
        <div class="live-item"><span>Packet loss</span><b id="t-loss">—</b></div>
        <div class="live-item"><span>Download</span><b id="t-down">—</b></div>
        <div class="live-item"><span>Upload</span><b id="t-up">—</b></div>
        <div class="live-item"><span>Thời gian / Server</span><b id="t-meta">—</b></div>
      </div>
      <canvas id="speed-chart" height="110"></canvas>
      <div class="row"><button id="test-start">START TEST</button><button class="ghost" id="test-stop" disabled>STOP TEST</button><button class="ghost" id="test-again" disabled>TEST AGAIN</button></div>
      <p class="sub" id="test-bytes">Dữ liệu sẽ dùng: ~5 MB (4 MB tải + 1 MB gửi)</p>
    </div>`, after: () => { panelCleanup = () => speed.abort?.abort(); bindSpeedTest(); } };
  }

  function setTestState(s) {
    speed.state = s;
    const el = document.getElementById('test-state');
    if (el) el.textContent = s;
    const start = document.getElementById('test-start');
    const stop = document.getElementById('test-stop');
    const again = document.getElementById('test-again');
    if (start) start.disabled = !['IDLE', 'FAILED', 'COMPLETED'].includes(s);
    if (stop) stop.disabled = !['PING_TEST', 'DOWNLOAD_TEST', 'UPLOAD_TEST', 'READY'].includes(s);
    if (again) again.disabled = s !== 'COMPLETED';
  }
  function bindSpeedTest() {
    let mode = 'vpn';
    document.querySelectorAll('.mode').forEach(b => b.onclick = () => {
      mode = b.dataset.mode;
      document.querySelectorAll('.mode').forEach(x => x.classList.toggle('active', x === b));
      document.getElementById('mode-note').textContent = mode === 'vpn'
        ? 'VPN: chỉ gắn nhãn VPN khi bạn đã bật Shadowrocket. Máy chủ không xác minh được tunnel qua HTTP.'
        : 'Direct: đo đường đi hiện tại của thiết bị tới endpoint TikTunnel (không đi qua tunnel nếu VPN đang tắt).';
    });
    if (window.Chart) {
      speed.chart = new Chart(document.getElementById('speed-chart'), { type: 'line', data: { labels: [], datasets: [
        { label: 'Download Mbps', data: [], borderColor: '#2f81f7', tension: .3, pointRadius: 0 },
        { label: 'Upload Mbps', data: [], borderColor: '#3fb950', tension: .3, pointRadius: 0 }
      ] }, options: { responsive: true, animation: false, plugins: { legend: { labels: { color: '#8ea1b5' } } }, scales: { x: { ticks: { color: '#8ea1b5' } }, y: { ticks: { color: '#8ea1b5' } } } } });
    }
    document.getElementById('test-start').onclick = () => modal('Bắt đầu đo tốc độ',
      `<p>Bài test truyền <b>~5 MB</b> dữ liệu thật (4 MB tải + 1 MB gửi) tới endpoint TikTunnel.</p>
       <p class="sub">Nếu đang đi qua VPN, ~5 MB này sẽ được trừ vào quota tài khoản.</p>`,
      'Bắt đầu', () => runTest(mode));
    document.getElementById('test-stop').onclick = () => { speed.abort?.abort(); setTestState('FAILED'); toast('Đã dừng bài test'); };
    document.getElementById('test-again').onclick = () => runTest(mode);
  }
  function pushChart(down, up) {
    if (!speed.chart) return;
    speed.chart.data.labels.push(String(speed.chart.data.labels.length + 1));
    speed.chart.data.datasets[0].data.push(down);
    speed.chart.data.datasets[1].data.push(up);
    if (speed.chart.data.labels.length > 40) { speed.chart.data.labels.shift(); speed.chart.data.datasets.forEach(d => d.data.shift()); }
    speed.chart.update('none');
  }
  async function runTest(mode) {
    if (speed.abort) speed.abort.abort();
    speed.abort = new AbortController();
    const signal = speed.abort.signal;
    speed.history = [];
    setGauge(0, true);
    document.getElementById('t-ping').textContent = '—';
    document.getElementById('t-jitter').textContent = '—';
    document.getElementById('t-loss').textContent = '—';
    document.getElementById('t-down').textContent = '—';
    document.getElementById('t-up').textContent = '—';
    document.getElementById('t-meta').textContent = '—';
    let bytesUsed = 0, pingMs = 0, jitterMs = 0, loss = 0, down = 0, up = 0;
    const started = performance.now();
    try {
      setTestState('READY');
      setTestState('PING_TEST');
      const samples = []; let lost = 0;
      for (let i = 0; i < 8 && !signal.aborted; i++) {
        const t0 = performance.now();
        try { await fetch(`/api/net/ping?i=${i}&t=${Date.now()}`, { cache: 'no-store', signal }); samples.push(performance.now() - t0); }
        catch { lost++; }
      }
      if (signal.aborted) throw new Error('aborted');
      pingMs = samples.length ? Math.min(...samples) : 0;
      jitterMs = samples.length > 1 ? samples.reduce((a, b) => a + Math.abs(b - samples[0]), 0) / samples.length : 0;
      loss = lost / 8 * 100;
      document.getElementById('t-ping').textContent = pingMs.toFixed(1) + ' ms';
      document.getElementById('t-jitter').textContent = jitterMs.toFixed(1) + ' ms';
      document.getElementById('t-loss').textContent = loss.toFixed(0) + ' %';

      setTestState('DOWNLOAD_TEST');
      let downBytes = 0;
      for (let i = 0; i < 4 && !signal.aborted; i++) {
        const t0 = performance.now();
        const r = await fetch(`/api/net/download?bytes=${1024 * 1024}&i=${i}`, { cache: 'no-store', signal });
        if (!r.ok) throw new Error('download_failed');
        const buf = await r.arrayBuffer();
        const dt = (performance.now() - t0) / 1000;
        downBytes += buf.byteLength; bytesUsed += buf.byteLength;
        down = buf.byteLength * 8 / dt / 1e6;
        setGauge(down, true);
        document.getElementById('t-down').textContent = down.toFixed(1) + ' Mbps';
        pushChart(down, up);
      }
      if (signal.aborted) throw new Error('aborted');

      setTestState('UPLOAD_TEST');
      const chunk = new Uint8Array(256 * 1024);
      for (let o = 0; o < chunk.length; o += 64 * 1024) {
        crypto.getRandomValues(chunk.subarray(o, Math.min(o + 64 * 1024, chunk.length)));
      }
      let upBytes = 0;
      for (let i = 0; i < 4 && !signal.aborted; i++) {
        const t0 = performance.now();
        const r = await fetch('/api/net/upload', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: chunk, signal });
        if (!r.ok) throw new Error('upload_failed');
        const dt = (performance.now() - t0) / 1000;
        upBytes += chunk.byteLength; bytesUsed += chunk.byteLength;
        up = chunk.byteLength * 8 / dt / 1e6;
        setGauge(up, true);
        document.getElementById('t-up').textContent = up.toFixed(1) + ' Mbps';
        pushChart(down, up);
      }
      if (signal.aborted) throw new Error('aborted');
      const duration = (performance.now() - started) / 1000;
      document.getElementById('t-meta').textContent = duration.toFixed(1) + ' s / TikTunnel';
      document.getElementById('test-bytes').textContent = `Đã dùng ${gb(bytesUsed)} cho bài test này (tải ${gb(downBytes)}, gửi ${gb(upBytes)}).`;
      try {
        await api('/api/friend/speedtest', { method: 'POST', body: JSON.stringify({ mode, verified: false,
          ping_ms: pingMs, jitter_ms: jitterMs, packet_loss_pct: loss, download_mbps: down, upload_mbps: up,
          bytes_used: bytesUsed, duration_s: duration, server: 'TikTunnel endpoint' }) });
      } catch (e) { toast('Không lưu được lịch sử: ' + e.message); }
      setTestState('COMPLETED');
      toast('Hoàn tất đo tốc độ');
    } catch (e) {
      if (e.message !== 'aborted') { setTestState('FAILED'); toast('Lỗi: ' + e.message); }
      else setGauge(0, true);
    }
  }

  async function devices() {
    const d = await api(`/api/friend/devices?device=${dev}`);
    const rows = d.devices.map(x => `<tr><td><span class="mono">${esc(x.id)}</span><br><span class="sub">${esc(x.name || 'Chưa đặt tên')}</span></td>
      <td>${statusPill(x.status)}</td><td>${esc(x.last_seen.slice(5, 16))}</td>
      <td>${gb(x.upload_bytes)} / ${gb(x.download_bytes)}</td>
      <td><button class="small ghost" data-dev="${esc(x.id)}">Đổi tên</button></td></tr>`).join('');
    return { html: `<div class="card"><h2>Active Devices</h2>
      <p class="sub">Thiết bị chỉ được ghi nhận khi có session VPN thật kèm lưu lượng. Đăng nhập web không tạo thiết bị.</p>
      <p class="sub warn-note">Lưu ý: chế độ public hiện là VLESS TCP (forwarder chặn WebSocket), nên path không mang device id — mục này sẽ trống cho kết nối TCP. Đây là giới hạn của hạ tầng, không phải dữ liệu giả.</p>
      ${d.devices.length ? `<div class="scroll"><table><thead><tr><th>Device ID</th><th>Trạng thái</th><th>Last seen</th><th>Up / Down</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
        : emptyState('Chưa có thiết bị', 'Kết nối VPN bằng cấu hình có device ID để xuất hiện ở đây')}
      <p class="sub">Active: có traffic trong 60s gần nhất · Idle: có session nhưng không có traffic · Offline: đã ngắt · Unknown: thiếu dữ liệu.</p></div>`,
      after: () => document.querySelectorAll('[data-dev]').forEach(b => b.onclick = () => {
        const target = b.dataset.dev;
        modal('Đổi tên thiết bị', `<label>Tên (tối đa 40 ký tự)</label><input id="devname" maxlength="40">`, 'Lưu', async () => {
          await api(`/api/friend/devices/${encodeURIComponent(target)}`, { method: 'PATCH', body: JSON.stringify({ name: document.getElementById('devname').value }) });
          toast('Đã lưu'); mount('Account', friendBuilders, 'Devices');
        });
      }) };
  }

  async function experimental() {
    try { importCacheExp = await api('/api/friend/import/experimental'); } catch (e) { importCacheExp = { ok: false, error: e.message }; }
    const i = importCacheExp || {};
    const ready = i.ok && i.ready;
    const cfg = i.config || {};
    return { html: `<div class="card"><h2>TikTunnel - Experimental</h2>
      <span class="pill warn">Testing</span>
      <p class="sub">Nhánh thử nghiệm SNI/Host/TLS/WS/VLESS. Main không bị thay đổi.</p>
      ${i.ok ? `<div class="pill ${ready ? 'ok' : 'warn'}">${ready ? 'Sẵn sàng' : 'Chưa sẵn sàng'}</div>
      <p class="sub">Server: ${esc(cfg.server_address || '—')}:${esc(cfg.server_port || '—')} · Protocol ${esc(cfg.protocol)} · Network ${esc(cfg.network)} · TLS ${esc(cfg.tls_mode)}</p>
      <p class="sub">SNI: ${esc(cfg.sni || '—')} · Host: ${esc(cfg.host || '—')} · WS path: ${esc(cfg.ws_path || '—')}</p>
      <div class="row"><button id="exp-tap" ${ready ? '' : 'disabled'}>Add Experimental to Shadowrocket</button>
      <button class="ghost" id="exp-node" ${ready ? '' : 'disabled'}>Thêm 1 node Experimental</button></div>
      <div class="row"><button class="ghost" id="copy-exp-uri">Copy Experimental URI</button>
      <button class="ghost" id="exp-analyze">Run Experimental Analyzer</button></div>
      <details class="adv"><summary>Xem cấu hình Experimental</summary><p class="mono">${esc(i.uri || '')}</p></details>
      <div id="exp-analyze-result"></div>`
      : `<div class="empty"><b>Experimental chưa bật hoặc lỗi</b><p class="sub">${esc(i.error || 'Admin cần bật nhánh Experimental')}</p></div>`}
      </div>`, after: () => {
        if (!i.ok) return;
        const tap = (link) => { if (!ready) { toast('Experimental chưa sẵn sàng'); return; } openDeepLink(link); toast('Đang mở Shadowrocket (Experimental)'); };
        const btn = document.getElementById('exp-tap'); if (btn) btn.onclick = () => tap(i.links.subscription);
        const node = document.getElementById('exp-node'); if (node) node.onclick = () => tap(i.links.node);
        const copyBtn = document.getElementById('copy-exp-uri'); if (copyBtn) copyBtn.onclick = () => copy(i.uri);
        const an = document.getElementById('exp-analyze'); if (an) an.onclick = async () => {
          const box = document.getElementById('exp-analyze-result'); box.innerHTML = '<div class="spinner"></div>';
          try {
            const d = await api('/api/experimental/analyze');
            const rows = (d.results || []).map(c => `<div class="diag-item"><div class="diag-head">${diagPill(c.status)}<b>${esc(c.label)}</b></div><p>${esc(c.detail)}</p></div>`).join('');
            box.innerHTML = `<div class="live-grid"><div class="live-item"><span>PASS</span><b>${d.summary?.pass||0}</b></div>
              <div class="live-item"><span>FAIL</span><b>${d.summary?.fail||0}</b></div>
              <div class="live-item"><span>WARNING</span><b>${d.summary?.warning||0}</b></div></div><div class="diag-list">${rows}</div>`;
          } catch (e) { box.innerHTML = errorState(e.message); }
        };
      } };
  }

  async function shadowrocket() {
    try { importCache = await api(`/api/friend/import?device=${dev}`); } catch (e) { importCache = { ok: false, error: e.message }; }
    const i = importCache;
    const ready = i.ok && i.ready;
    return { html: `<div class="card"><h2>Add to Shadowrocket <span class="pill ok">Stable</span></h2>
      ${i.ok ? `<div class="pill ${ready ? 'ok' : 'warn'}">${ready ? 'Sẵn sàng' : 'Server chưa sẵn sàng'}</div>
      <p class="sub">Session đã xác thực · quota ${gb(i.remaining_bytes)} còn lại · server ${i.server_ready ? 'đang chạy' : 'không chạy'}.</p>
      <div class="row"><button id="one-tap" ${ready ? '' : 'disabled'}>Add to Shadowrocket</button>
      <button class="ghost" id="add-node" ${ready ? '' : 'disabled'}>Thêm 1 node</button></div>
      <p class="sub">Sẽ mở Shadowrocket và chờ bạn xác nhận thêm server. Chưa coi là thành công cho tới khi bạn xác nhận trong app.</p>
      <div class="row"><button class="ghost" id="copy-uri">Copy VLESS URI</button>
      <a class="btn ghost" href="${esc(i.fallback.open_url)}" target="_blank" rel="noopener">Mở subscription URL</a>
      <a class="btn ghost" href="${esc(i.fallback.file_url)}">Tải file .txt</a>
      <a class="btn ghost" href="/plan-check">Kiểm tra gói cước / TikTok</a></div>
      <details class="adv"><summary>Xem cấu hình được sinh ra</summary><p class="mono">${esc(i.uri)}</p></details>`
      : emptyState('Không lấy được cấu hình', i.error)}
      <ol class="steps"><li>Bấm <b>Add to Shadowrocket</b> để iOS mở app.</li>
      <li>App hiện hộp thoại thêm server/subscription → bấm xác nhận.</li>
      <li>Chọn node, bật VPN. Nếu app không mở: copy URI → Shadowrocket → + → Import from Clipboard.</li></ol></div>`,
      after: () => {
        if (!i.ok) return;
        const tap = (link) => {
          if (!ready) { toast('Server hoặc tài khoản chưa sẵn sàng'); return; }
          openDeepLink(link);
          toast('Đang mở Shadowrocket — hãy xác nhận trong app');
        };
        document.getElementById('one-tap').onclick = () => tap(i.links.subscription);
        document.getElementById('add-node').onclick = () => tap(i.links.node);
        document.getElementById('copy-uri').onclick = () => copy(i.uri);
      } };
  }

  async function settings() {
    return { html: `<div class="card"><h2>Account Settings</h2>
      <form id="pw-form"><label>Đổi mật khẩu đăng nhập (tối thiểu 8 ký tự)</label>
      <input id="newpw" type="password" minlength="8" required><button style="margin-top:12px" type="submit">Cập nhật</button></form>
      <p class="sub">Device ID của trình duyệt này: <span class="mono">${esc(dev)}</span></p></div>`,
      after: () => document.getElementById('pw-form').onsubmit = async (e) => {
        e.preventDefault();
        try { await api('/api/friend/password', { method: 'POST', body: JSON.stringify({ password: document.getElementById('newpw').value }) });
          toast('Đã đổi mật khẩu'); document.getElementById('newpw').value = ''; } catch (err) { toast(err.message); }
      } };
  }

  const friendBuilders = { 'Overview': overview, 'Data Usage': dataUsage, 'Network Test': networkTest,
    'Diagnostics': diagnosticsTab, 'Devices': devices, 'Shadowrocket': shadowrocket, 'Experimental': experimental, 'Settings': settings };
  mount('Account', friendBuilders, 'Overview');
}

async function adminView() {
  async function overview() {
    const [ov, lat] = await Promise.all([api('/api/admin/overview'), api('/api/monitor/latency')]);
    return { html: `<div class="grid">
      <div class="stat"><span>VPN</span><b>${ov.server.sing_box ? 'running' : 'stopped'}</b></div>
      <div class="stat"><span>CPU</span><b>${ov.server.cpu_pct}%</b></div>
      <div class="stat"><span>RAM</span><b>${(ov.server.ram_used_kb / 1048576).toFixed(2)} GB</b></div>
      <div class="stat"><span>Friends</span><b>${ov.accounts.friends}/${ov.accounts.max_friends}</b></div>
      <div class="stat"><span>Active VPN users</span><b>${ov.vpn_users}</b></div>
      <div class="stat"><span>Endpoint</span><b style="font-size:13px">${esc(ov.public_endpoint)}</b></div></div>
      <div class="card"><h2>Latency (server → ${esc(lat.target)})</h2><div class="live-grid">
      <div class="live-item"><span>Current</span><b>${lat.current} ms</b></div><div class="live-item"><span>Average</span><b>${lat.average} ms</b></div>
      <div class="live-item"><span>Peak</span><b>${lat.peak} ms</b></div><div class="live-item"><span>Jitter</span><b>${lat.jitter} ms</b></div>
      <div class="live-item"><span>Packet loss</span><b>${lat.packet_loss_pct}%</b></div><div class="live-item"><span>Mode</span><b>${esc(ov.mode)}</b></div></div>
      <p class="sub">${esc(lat.note)}</p></div>`, after: null };
  }
  async function users() {
    const us = await api('/api/admin/users');
    const rows = us.users.map(u => `<tr><td><b>${esc(u.display_name)}</b><br><span class="mono">${esc(u.username)}</span></td>
      <td>${u.enabled ? '<span class="pill ok">enabled</span>' : '<span class="pill bad">disabled</span>'}${u.exhausted ? '<span class="pill warn">exhausted</span>' : ''}</td>
      <td>${gb(u.quota_bytes)}<br><span class="sub">dùng ${gb(u.used_upload + u.used_download)}</span></td>
      <td class="mono">${u.uuid ? esc(u.uuid) : '—'}</td><td><div class="actions">
      <button class="small ghost" data-copy="uri" data-id="${u.id}">Copy VLESS</button>
      <button class="small ghost" data-copy="sub" data-id="${u.id}">Copy Sub</button>
      <button class="small ghost" data-export="${u.id}">Export</button>
      <button class="small ghost" data-act="disable" data-id="${u.id}">Disable</button>
      <button class="small ghost" data-act="enable" data-id="${u.id}">Enable</button>
      <button class="small danger" data-act="delete" data-id="${u.id}">Revoke</button></div></td></tr>`).join('');
    return { html: `<div class="card"><h2>User Management</h2><div class="scroll"><table><thead><tr><th>User</th><th>Status</th><th>Quota</th><th>UUID</th><th>Actions</th></tr></thead><tbody>
      ${rows || '<tr><td colspan="5">Chưa có tài khoản.</td></tr>'}</tbody></table></div></div>
      <div class="card"><h2>Create friend</h2><form id="create"><div class="row">
      <div style="flex:1;min-width:130px"><label>Username</label><input id="nu" required></div>
      <div style="flex:1;min-width:130px"><label>Display name</label><input id="nd" required></div>
      <div style="flex:1;min-width:100px"><label>Quota (GB)</label><input id="nq" type="number" min="0" step="any" value="5"></div></div>
      <label>Password (≥8)</label><input id="np" type="password" minlength="8" required>
      <button style="margin-top:12px" type="submit">Create account</button></form></div>`,
      after: () => {
        document.querySelectorAll('[data-copy]').forEach(b => b.onclick = () => {
          const u = us.users.find(x => x.id === Number(b.dataset.id));
          copy(b.dataset.copy === 'sub' ? `${location.origin}/api/sub/${u.subscription_token}` : (u.vless_uri || ''));
        });
        document.querySelectorAll('[data-export]').forEach(b => b.onclick = () => { location.href = `/api/admin/users/${b.dataset.export}/export`; });
        document.querySelectorAll('[data-act]').forEach(b => b.onclick = async () => {
          if (b.dataset.act === 'delete' && !confirm('Revoke account?')) return;
          try { await api(`/api/admin/users/${b.dataset.id}/${b.dataset.act}`, { method: 'POST' }); toast('Updated'); mount('Admin', adminBuilders, 'Users'); }
          catch (e) { toast(e.message); }
        });
        document.getElementById('create').onsubmit = async (e) => {
          e.preventDefault();
          try { await api('/api/admin/users', { method: 'POST', body: JSON.stringify({
            username: document.getElementById('nu').value.trim(), display_name: document.getElementById('nd').value.trim(),
            password: document.getElementById('np').value, quota_gb: document.getElementById('nq').value }) });
            toast('Đã tạo'); mount('Admin', adminBuilders, 'Users'); } catch (err) { toast(err.message); }
        };
      } };
  }
  async function quota() {
    return { html: `<div class="card"><h2>Quota Management</h2><form id="quota"><label>User ID</label><input id="qid" type="number" min="1" required>
      <div class="row"><div style="flex:1"><label>Action</label><select id="qact"><option value="set">Set</option><option value="add">Add</option><option value="reduce">Reduce</option><option value="reset">Reset (0 = unlimited)</option></select></div>
      <div style="flex:1"><label>GB</label><input id="qgb" type="number" min="0" value="1"></div></div>
      <button style="margin-top:12px" type="submit">Apply</button></form></div>`,
      after: () => document.getElementById('quota').onsubmit = async (e) => {
        e.preventDefault();
        try { await api(`/api/admin/users/${document.getElementById('qid').value}/quota`, { method: 'POST', body: JSON.stringify({
          action: document.getElementById('qact').value, gb: Number(document.getElementById('qgb').value) }) });
          toast('Đã cập nhật quota'); } catch (err) { toast(err.message); }
      } };
  }
  async function devices() {
    const d = await api('/api/admin/devices?limit=50');
    const rows = d.devices.map(x => `<tr><td>${esc(x.username)}</td><td class="mono">${esc(x.id)}</td><td>${statusPill(x.status)}</td>
      <td>${esc(x.last_seen.slice(5, 16))}</td><td>${gb(x.upload_bytes)} / ${gb(x.download_bytes)}</td></tr>`).join('');
    return { html: `<div class="card"><h2>Device Activity</h2>${d.devices.length ? `<div class="scroll"><table><thead><tr><th>Account</th><th>Device ID</th><th>Status</th><th>Last seen</th><th>Up / Down</th></tr></thead><tbody>${rows}</tbody></table></div>`
      : emptyState('Chưa có thiết bị', 'Chỉ session VPN có traffic mới tạo bản ghi')}</div>` };
  }
  async function monitoring() {
    const [m, perf] = await Promise.all([api('/api/monitor/server'), api('/api/monitor/performance?limit=60')]);
    return { html: `<div class="card"><h2>Server Monitoring</h2><div class="live-grid six">
      <div class="live-item"><span>CPU</span><b>${m.cpu_pct}%</b></div><div class="live-item"><span>RAM</span><b>${(m.ram_used_kb / 1048576).toFixed(2)} GB</b></div>
      <div class="live-item"><span>Disk free</span><b>${gb(m.disk_free)}</b></div><div class="live-item"><span>Uptime</span><b>${Math.floor(m.uptime_s / 60)} min</b></div>
      <div class="live-item"><span>API latency</span><b>${m.api_latency_ms} ms</b></div><div class="live-item"><span>sing-box</span><b>${m.sing_box ? 'up' : 'down'}</b></div></div></div>
      <div class="card"><h2>CPU / RAM history</h2>${perf.metrics.length ? '<canvas id="perf-chart" height="110"></canvas>' : emptyState('Chưa có dữ liệu')}</div>`,
      after: () => {
        if (!perf.metrics.length || !window.Chart) return;
        const pts = [...perf.metrics].reverse();
        new Chart(document.getElementById('perf-chart'), { type: 'line', data: { labels: pts.map(p => p.ts.slice(11, 16)), datasets: [
          { label: 'CPU %', data: pts.map(p => p.cpu_pct), borderColor: '#2f81f7' },
          { label: 'RAM GB', data: pts.map(p => p.ram_used_kb / 1048576), borderColor: '#3fb950' } ] },
          options: { responsive: true, plugins: { legend: { labels: { color: '#8ea1b5' } } }, scales: { x: { ticks: { color: '#8ea1b5' } }, y: { ticks: { color: '#8ea1b5' } } } } });
      } };
  }
  async function network() {
    const [n, lat] = await Promise.all([api('/api/monitor/network'), api('/api/monitor/latency')]);
    return { html: `<div class="card"><h2>Network Performance</h2>
      <p class="sub">${esc(n.note)}</p><div class="scroll"><table><thead><tr><th>Target</th><th>Result</th></tr></thead><tbody>
      ${n.probes.map(p => `<tr><td>${esc(p.host)}:${p.port}</td><td>${p.ok ? `<span class="pill ok">${p.ms} ms</span>` : '<span class="pill bad">unreachable</span>'}</td></tr>`).join('')}</tbody></table></div></div>
      <div class="card"><h2>Latency statistics</h2><p class="sub">${esc(lat.target)} — ${esc(lat.note)}</p>
      <div class="live-grid"><div class="live-item"><span>Current</span><b>${lat.current} ms</b></div><div class="live-item"><span>Average</span><b>${lat.average} ms</b></div>
      <div class="live-item"><span>Peak</span><b>${lat.peak} ms</b></div><div class="live-item"><span>Jitter</span><b>${lat.jitter} ms</b></div></div></div>` };
  }
  async function security() {
    const s = await api('/api/admin/security');
    return { html: `<div class="card"><h2>Security Events</h2><p class="sub">${esc(s.policy.password)} · ${esc(s.policy.session)} · CSRF ${s.policy.csrf ? 'on' : 'off'} · ${esc(s.policy.login_lockout)}</p>
      ${s.events.length ? `<div class="scroll"><table><thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Target</th><th>IP</th></tr></thead><tbody>
      ${s.events.map(e => `<tr><td class="mono">${esc(e.ts.slice(5, 19))}</td><td>${esc(e.actor)}</td><td>${esc(e.action)}</td><td>${esc(e.target)}</td><td class="mono">${esc(e.ip)}</td></tr>`).join('')}</tbody></table></div>`
      : emptyState('Chưa có sự kiện bảo mật')}</div>` };
  }
  async function experimentalAdmin() {
    let d;
    try { d = await api('/api/admin/experimental'); } catch (e) { d = { ok: false, error: e.message }; }
    const c = d.config || {};
    return { html: `<div class="card"><h2>Experimental Branch <span class="pill warn">Testing</span></h2>
      <p class="sub">Cấu hình riêng cho nhánh thử nghiệm. Main không bị thay đổi.</p>
      ${d.ok ? `<form id="exp-form">
        <label><input type="checkbox" id="exp-enabled" ${c.enabled ? 'checked' : ''}> Bật Experimental</label>
        <div class="row"><div style="flex:1"><label>Server Address</label><input id="exp-addr" value="${esc(c.server_address || '')}"></div>
        <div style="flex:1"><label>Server Port</label><input id="exp-port" type="number" value="${esc(c.server_port || 443)}"></div></div>
        <div class="row"><div style="flex:1"><label>Protocol</label><select id="exp-proto"><option value="vless" ${c.protocol==='vless'?'selected':''}>VLESS</option><option value="vmess" ${c.protocol==='vmess'?'selected':''}>VMess</option></select></div>
        <div style="flex:1"><label>Network</label><select id="exp-net"><option value="ws" ${c.network==='ws'?'selected':''}>WebSocket</option><option value="tcp" ${c.network==='tcp'?'selected':''}>TCP</option></select></div>
        <div style="flex:1"><label>TLS Mode</label><select id="exp-tls"><option value="tls" ${c.tls_mode==='tls'?'selected':''}>TLS</option><option value="none" ${c.tls_mode==='none'?'selected':''}>None</option></select></div></div>
        <div class="row"><div style="flex:1"><label>SNI</label><input id="exp-sni" value="${esc(c.sni || '')}"></div>
        <div style="flex:1"><label>Host Header</label><input id="exp-host" value="${esc(c.host || '')}"></div></div>
        <label>WebSocket Path</label><input id="exp-path" value="${esc(c.ws_path || '/vpn')}">
        <label>UUID mode</label><select id="exp-uuidmode"><option value="per_user" ${c.uuid_mode==='per_user'?'selected':''}>Per user</option><option value="shared" ${c.uuid_mode==='shared'?'selected':''}>Shared</option></select>
        <label>Shared UUID (if shared)</label><input id="exp-uuid" value="${esc(c.uuid || '')}">
        <div class="row" style="margin-top:12px"><button type="submit">Lưu Experimental</button><button type="button" class="ghost" id="exp-rollback">Rollback</button></div>
      </form>` : errorState(d.error)}`,
      after: () => {
        if (!d.ok) return;
        const form = document.getElementById('exp-form');
        if (form) form.onsubmit = async (e) => {
          e.preventDefault();
          try {
            await api('/api/admin/experimental', { method: 'POST', body: JSON.stringify({
              enabled: document.getElementById('exp-enabled').checked,
              server_address: document.getElementById('exp-addr').value.trim(),
              server_port: Number(document.getElementById('exp-port').value),
              protocol: document.getElementById('exp-proto').value,
              network: document.getElementById('exp-net').value,
              tls_mode: document.getElementById('exp-tls').value,
              sni: document.getElementById('exp-sni').value.trim(),
              host: document.getElementById('exp-host').value.trim(),
              ws_path: document.getElementById('exp-path').value.trim(),
              uuid_mode: document.getElementById('exp-uuidmode').value,
              uuid: document.getElementById('exp-uuid').value.trim()
            }) });
            toast('Đã lưu Experimental'); mount('Admin', adminBuilders, 'Experimental');
          } catch (err) { toast(err.message); }
        };
        const rb = document.getElementById('exp-rollback'); if (rb) rb.onclick = async () => {
          try { await api('/api/admin/experimental/rollback', { method: 'POST', body: '{}' }); toast('Đã rollback'); mount('Admin', adminBuilders, 'Experimental'); }
          catch (e) { toast(e.message); }
        };
      } };
  }

  async function settings() {
    return { html: `<div class="card"><h2>Settings</h2><form id="adminpw"><label>Đổi mật khẩu admin</label>
      <input id="apw" type="password" minlength="8" required><button style="margin-top:12px" type="submit">Cập nhật</button></form>
      <p class="sub">Secrets được nạp từ .env lúc khởi động, không lưu trong source.</p></div>`,
      after: () => document.getElementById('adminpw').onsubmit = async (e) => {
        e.preventDefault();
        try { await api('/api/admin/password', { method: 'POST', body: JSON.stringify({ password: document.getElementById('apw').value }) });
          toast('Đã đổi mật khẩu admin'); document.getElementById('apw').value = ''; } catch (err) { toast(err.message); }
      } };
  }
  const adminBuilders = { 'Overview': overview, 'Users': users, 'Quota': quota, 'Devices': devices,
    'Monitoring': monitoring, 'Network': network, 'Diagnostics': diagnosticsTab, 'Security': security, 'Experimental': experimentalAdmin, 'Settings': settings };
  mount('Admin', adminBuilders, 'Overview');
}

async function boot() {
  window.__tiktunnelBooted = true;
  const btn = document.getElementById('boot-retry');
  if (btn) btn.onclick = () => { root.innerHTML = '<div class="center"><div class="spinner"></div><p>Đang tải…</p></div>'; boot(); };
  try {
    const r = await timedFetch('/api/auth/me', { credentials: 'same-origin' }, 8000);
    if (!r.ok) return authScreen();
    me = await r.json();
    if (me.role === 'admin') return adminView();
    return friendView();
  } catch (e) {
    root.innerHTML = `<div class="center"><span class="brand-mark">T</span><h1>TikTunnel Control</h1>
      <p class="sub">Không kết nối được API: ${esc(e.message)}</p><button class="ghost" id="boot-retry">Thử lại</button></div>`;
    document.getElementById('boot-retry').onclick = () => boot();
  }
}
boot();
