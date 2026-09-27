/* 聊机·多机同步卡片（精简版：只留 检查更新 / 同步更新）
   入口：window.__mountSyncCard(container)
   主机地址会持久化（localStorage），后台看门脚本 sync-watch.js 每 30 分钟自动比对并弹更新提示 */
(function () {
  'use strict';

  const API = 'http://127.0.0.1:7200';
  const GREEN = '#8bc34a';
  const GREEN_DARK = '#5c8a2e';
  const LS_KEY = 'sync_master_addr';

  function h(tag, style, text) {
    const el = document.createElement(tag);
    if (style) el.style.cssText = style;
    if (text !== undefined) el.textContent = text;
    return el;
  }

  async function api(path, body) {
    const opt = body === undefined
      ? {}
      : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
    const r = await fetch(API + path, opt);
    const j = await r.json();
    const b = (j && j.body) || {};
    if (b.error) throw new Error(b.error);
    return b;
  }

  function toast(text, warn) {
    const t = h('div', `position:fixed;top:24px;left:50%;transform:translateX(-50%);z-index:999999;padding:9px 22px;border-radius:20px;font-size:13px;box-shadow:0 4px 16px rgba(0,0,0,.18);transition:opacity .4s;${warn ? 'background:#fff7e6;color:#ad6800;border:1px solid #ffd591;' : 'background:#f6ffed;color:#389e0d;border:1px solid #b7eb8f;'}`, text);
    document.body.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 450); }, 3600);
  }

  function getMasterAddr() {
    try { return localStorage.getItem(LS_KEY) || ''; } catch { return ''; }
  }
  function saveMasterAddr(addr) {
    try { localStorage.setItem(LS_KEY, addr); } catch { }
  }

  async function checkDiff(addr) {
    const [rm, lm] = await Promise.all([
      fetch(addr + '/sync/manifest').then(r => r.json()),
      api('/sync/manifest')
    ]);
    const remote = ((rm && rm.body && rm.body.files) || []);
    const local = new Map((lm.files || []).map(f => [f.path, f.sha256]));
    if (!remote.length) return { error: '主机清单为空或地址不通' };
    const diff = remote.filter(f => local.get(f.path) !== f.sha256);
    return { version: rm.body.version, total: remote.length, diff };
  }

  window.__mountSyncCard = function (container) {
    if (container.__syncMounted) return;
    container.__syncMounted = true;

    container.appendChild(h('div', 'font-size:12px;color:#999;margin-bottom:8px;',
      '本机设置/话术/代码跟随主机：主机有更新时本机会弹提示。点「同步更新」把主机的最新文件拉到本机（先自动备份，同步后需重启聊机生效）。'));

    // ---- 主机地址 ----
    const row1 = h('div', 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px;');
    row1.appendChild(h('span', 'color:#666;font-size:13px;', '主机地址：'));
    const masterI = h('input', 'flex:1;min-width:220px;border:1px solid #ddd;border-radius:6px;padding:6px 10px;font-size:13px;');
    masterI.placeholder = 'http://主机IP:7200（如 http://192.168.1.10:7200）';
    masterI.value = getMasterAddr();
    row1.appendChild(masterI);
    container.appendChild(row1);

    // ---- 只留两个功能键 ----
    const row2 = h('div', 'display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px;');
    const checkBtn = h('button', `border:1px solid ${GREEN};background:#fff;color:${GREEN_DARK};border-radius:6px;padding:6px 14px;cursor:pointer;font-weight:600;font-size:12px;`, '检查更新');
    const applyBtn = h('button', `border:none;background:${GREEN};color:#fff;border-radius:6px;padding:6px 14px;cursor:pointer;font-weight:600;font-size:12px;`, '同步更新');
    row2.appendChild(checkBtn); row2.appendChild(applyBtn);
    container.appendChild(row2);

    const outBox = h('div', 'font-size:12px;background:#f8faf4;border-radius:6px;padding:8px 10px;display:none;white-space:pre-wrap;word-break:break-all;max-height:220px;overflow-y:auto;');
    container.appendChild(outBox);

    function show(lines) {
      outBox.style.display = 'block';
      outBox.textContent = lines.join('\n');
    }

    function validAddr() {
      const addr = masterI.value.trim().replace(/\/+$/, '');
      if (!/^https?:\/\//.test(addr)) { toast('请先填写有效的主机地址', true); return ''; }
      saveMasterAddr(addr);
      return addr;
    }

    checkBtn.onclick = async () => {
      const addr = validAddr(); if (!addr) return;
      checkBtn.disabled = true;
      show(['正在比对主机版本…']);
      try {
        const r = await checkDiff(addr);
        if (r.error) { show(['❌ ' + r.error]); return; }
        const lines = [`主机版本：${r.version}，清单 ${r.total} 个文件，本机有差异 ${r.diff.length} 个`];
        for (const f of r.diff) lines.push(`  ⟳ ${f.path}（${(f.size / 1024).toFixed(0)}KB）`);
        if (!r.diff.length) lines.push('✅ 全部一致，无需同步');
        show(lines);
      } catch (e) { show(['❌ ' + (e.message || e)]); }
      finally { checkBtn.disabled = false; }
    };

    applyBtn.onclick = async () => {
      const addr = validAddr(); if (!addr) return;
      applyBtn.disabled = true; checkBtn.disabled = true;
      show(['正在从主机同步…（大文件可能需要几十秒）']);
      try {
        const b = await api('/sync/apply', { master: addr });
        const lines = [`同步完成：更新 ${b.updated} 个文件（耗时 ${(b.elapsed_ms / 1000).toFixed(1)}s）`];
        for (const r of b.results) {
          const mark = r.action === 'updated' ? '✅' : r.action === 'same' ? '＝' : r.action === 'skipped' ? '⏭' : '❌';
          lines.push(`  ${mark} ${r.path}${r.action === 'updated' ? '（' + (r.bytes / 1024).toFixed(0) + 'KB）' : r.reason ? '：' + r.reason : ''}`);
        }
        if (b.need_restart) lines.push('', '⚠️ 有文件更新，请重启聊机使全部改动生效（备份在 ' + (b.backup || 'data/sync-backup') + '）');
        else lines.push('', '✅ 本机已是最新，无需重启');
        show(lines);
      } catch (e) { show(['❌ ' + (e.message || e)]); }
      finally { applyBtn.disabled = false; checkBtn.disabled = false; }
    };

    // 打开面板时自动比对一次，有差异直接提示
    (async () => {
      const addr = masterI.value.trim().replace(/\/+$/, '');
      if (!/^https?:\/\//.test(addr)) return;
      try {
        const r = await checkDiff(addr);
        if (!r.error && r.diff.length) {
          show([`⚠️ 主机有新版本：${r.diff.length} 个文件有更新，建议点「同步更新」`, ...r.diff.slice(0, 8).map(f => `  ⟳ ${f.path}`)]);
          toast(`主机有 ${r.diff.length} 个文件更新，点「同步更新」升级`, true);
        }
      } catch { }
    })();
  };
})();
