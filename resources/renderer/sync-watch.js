/* 聊机·同步看门（注入 renderer，随主界面常驻）
   每 30 分钟 + 启动 90 秒后自动比对主机清单；有更新时顶部弹提示条「主机有更新，一键同步」
   主机地址读取 localStorage.sync_master_addr（同步面板里填写即自动保存） */
(function () {
  'use strict';
  // 【开发副本保护】本机有大量本地修复，主机（另一台电脑）没有这些更新——同步会覆盖掉它们。
  // 按机主要求整体停用同步看门；如需恢复，删掉下面这行 return 即可
  return;
  if (window.__syncWatchStarted) return;
  window.__syncWatchStarted = true;

  const API = 'http://127.0.0.1:7200';
  const LS_KEY = 'sync_master_addr';
  const INTERVAL = 30 * 60 * 1000;
  let banner = null;

  function h(tag, style, text) {
    const el = document.createElement(tag);
    if (style) el.style.cssText = style;
    if (text !== undefined) el.textContent = text;
    return el;
  }
  function getMasterAddr() {
    try { return localStorage.getItem(LS_KEY) || ''; } catch { return ''; }
  }

  function hideBanner() { if (banner) { banner.remove(); banner = null; } }

  function showBanner(diffCount, addr) {
    hideBanner();
    banner = h('div', 'position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:999998;display:flex;align-items:center;gap:10px;background:#fff7e6;color:#ad6800;border:1px solid #ffd591;border-radius:24px;padding:8px 18px;font-size:13px;box-shadow:0 6px 20px rgba(0,0,0,.18);');
    banner.appendChild(h('span', '', `🔔 主机有新版本：${diffCount} 个文件有更新`));
    const apply = h('button', 'border:none;background:#8bc34a;color:#fff;border-radius:14px;padding:4px 14px;cursor:pointer;font-weight:600;font-size:12px;', '同步更新');
    const later = h('button', 'border:none;background:none;color:#ad6800;cursor:pointer;font-size:14px;padding:0 4px;', '✕');
    later.title = '稍后再说';
    later.onclick = hideBanner;
    apply.onclick = async () => {
      apply.disabled = true;
      apply.textContent = '同步中…';
      try {
        const r = await fetch(API + '/sync/apply', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ master: addr })
        });
        const b = (await r.json()).body || {};
        if (b.error) throw new Error(b.error);
        banner.style.background = '#f6ffed'; banner.style.color = '#389e0d'; banner.style.borderColor = '#b7eb8f';
        banner.firstChild.textContent = b.updated > 0
          ? `✅ 已同步 ${b.updated} 个文件，重启聊机后生效`
          : '✅ 本机已是最新';
        apply.style.display = 'none';
        setTimeout(hideBanner, 5000);
      } catch (e) {
        banner.firstChild.textContent = '❌ 同步失败：' + (e.message || e);
        apply.style.display = 'none';
        setTimeout(hideBanner, 5000);
      }
    };
    banner.appendChild(apply); banner.appendChild(later);
    document.body.appendChild(banner);
  }

  async function check() {
    const addr = getMasterAddr().trim().replace(/\/+$/, '');
    if (!/^https?:\/\//.test(addr)) return;
    if (banner) return; // 已有提示条在展示时不重复打扰
    try {
      const [rm, lm] = await Promise.all([
        fetch(addr + '/sync/manifest').then(r => r.json()),
        fetch(API + '/sync/manifest').then(r => r.json())
      ]);
      const remote = ((rm && rm.body && rm.body.files) || []);
      if (!remote.length) return;
      const local = new Map(((lm && lm.body && lm.body.files) || []).map(f => [f.path, f.sha256]));
      const diff = remote.filter(f => local.get(f.path) !== f.sha256);
      if (diff.length) showBanner(diff.length, addr);
    } catch { /* 主机不可达时静默 */ }
  }

  setTimeout(check, 90 * 1000);
  setInterval(check, INTERVAL);
})();
