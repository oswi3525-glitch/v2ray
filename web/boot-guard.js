'use strict';
setTimeout(function () {
  var app = document.getElementById('app');
  if (!app || window.__tiktunnelBooted) return;
  if (app.querySelector('.spinner')) {
    app.innerHTML = '<div class="center"><span class="brand-mark">T</span><h1>TikTunnel Control</h1>' +
      '<p class="sub">Không tải được giao diện. Kiểm tra kết nối đến máy chủ rồi thử lại.</p>' +
      '<button class="ghost" onclick="location.reload()">Thử lại</button></div>';
  }
}, 10000);
