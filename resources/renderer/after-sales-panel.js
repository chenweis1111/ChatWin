/* 聊机·售后整理面板（注入 renderer）
   入口：window.__openAfterSalesPanel()（聊天历史页「🗂 售后整理」按钮调用）
   后端：本地 AI 服务 http://127.0.0.1:7200 的 /after-sales/* 端点
   逻辑：从聊天记录提取 order 编号+售后问题 → 按尾号分渠道（9→T9群 8→W1群 7→172群 5→L1群 1/6→C1群）
        「复制新增」只给没复制过的（复制后自动标记不再重复）；「查看」看该渠道全部订单与问题 */
(function () {
  'use strict';
  if (window.__openAfterSalesPanel) return;

  const API = 'http://127.0.0.1:7200';
  const GREEN = '#8bc34a';
  const GREEN_DARK = '#5c8a2e';
  const CHANNELS = ['T9群', 'W1群', '172群', 'L1群', 'C1群', '其他'];
  let overlay = null;

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

  async function copyText(text) {
    try {
      if (window.electron && window.electron.invoke) {
        await window.electron.invoke('COPY_TO_CLIPBOARD', text);
        return true;
      }
    } catch (e) { }
    try { await navigator.clipboard.writeText(text); return true; }
    catch (e) { return false; }
  }

  function buildUI() {
    overlay = h('div', 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:99999;display:flex;align-items:center;justify-content:center;');
    const panel = h('div', 'background:#fff;width:780px;max-width:94vw;height:86vh;border-radius:12px;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 12px 40px rgba(0,0,0,.25);font-size:13px;color:#333;');

    const head = h('div', 'display:flex;align-items:center;padding:12px 18px;border-bottom:1px solid #eee;background:#f6faf1;');
    head.appendChild(h('div', 'font-size:16px;font-weight:600;flex:1;color:#4a7a28;', '🗂 售后整理'));
    const refBtn = h('button', 'border:1px solid #ddd;background:#fff;border-radius:6px;padding:4px 14px;cursor:pointer;font-size:12px;margin-right:8px;', '重新扫描');
    const closeBtn = h('button', 'border:none;background:none;font-size:20px;cursor:pointer;color:#999;', '✕');
    closeBtn.onclick = () => overlay.remove();
    head.appendChild(refBtn); head.appendChild(closeBtn);
    panel.appendChild(head);

    const bodyBox = h('div', 'flex:1;overflow-y:auto;padding:14px 18px;');
    panel.appendChild(bodyBox);
    overlay.appendChild(panel);

    const statBar = h('div', 'font-size:12px;color:#999;margin-bottom:10px;', '正在扫描聊天记录…');
    bodyBox.appendChild(statBar);
    const chBox = h('div', '');
    bodyBox.appendChild(chBox);
    const detailBox = h('div', 'display:none;margin-top:10px;border:1px solid #eee;border-radius:8px;padding:10px 12px;background:#f8faf4;font-size:12px;white-space:pre-wrap;word-break:break-all;max-height:300px;overflow-y:auto;');
    bodyBox.appendChild(detailBox);

    async function scan() {
      statBar.textContent = '正在扫描聊天记录…';
      chBox.textContent = '';
      try {
        const b = await api('/after-sales/scan', {});
        statBar.textContent = `共整理出售后条目 ${b.total} 条（${(b.elapsed_ms / 1000).toFixed(1)}s）。「复制新增」只包含没复制过的内容，复制过的自动去除。`;
        renderChannels(b.channels);
      } catch (e) { statBar.textContent = '❌ ' + (e.message || e) + '（本地 AI 服务是否已启动？）'; }
    }

    function renderChannels(channels) {
      chBox.textContent = '';
      for (const ch of CHANNELS) {
        const info = channels[ch];
        if (!info || !info.total) continue;
        const card = h('div', 'display:flex;align-items:center;gap:8px;border:1px solid #e8f0dc;border-radius:10px;padding:10px 14px;margin-bottom:8px;background:#fff;');
        card.appendChild(h('span', `background:${GREEN};color:#fff;border-radius:6px;padding:4px 12px;font-weight:700;font-size:13px;`, ch));
        card.appendChild(h('span', `flex:1;font-size:13px;${info.fresh ? 'color:#d97706;font-weight:600;' : 'color:#999;'}`,
          info.fresh ? `新增 ${info.fresh} 条 / 共 ${info.total} 条` : `共 ${info.total} 条（都已复制过）`));
        const copyBtn = h('button', `border:none;background:${info.fresh ? GREEN : '#ccc'};color:#fff;border-radius:6px;padding:6px 14px;cursor:pointer;font-weight:600;font-size:12px;`, '复制新增');
        copyBtn.disabled = !info.fresh;
        copyBtn.onclick = () => doCopy(ch, copyBtn);
        const viewBtn = h('button', `border:1px solid ${GREEN};background:#fff;color:${GREEN_DARK};border-radius:6px;padding:6px 14px;cursor:pointer;font-weight:600;font-size:12px;`, '查看');
        viewBtn.onclick = () => doView(ch, info.items);
        card.appendChild(copyBtn); card.appendChild(viewBtn);
        chBox.appendChild(card);
      }
      if (!chBox.childElementCount) chBox.appendChild(h('div', 'color:#999;font-size:12px;', '聊天记录里没有识别到 order 开头的售后编号'));
    }

    async function doCopy(ch, btn) {
      btn.disabled = true;
      try {
        const b = await api('/after-sales/copy', { channel: ch });
        if (!b.count) { toast('该渠道没有新增内容', true); scan(); return; }
        const ok = await copyText(b.text);
        detailBox.style.display = 'block';
        detailBox.textContent = `【${ch}】已${ok ? '复制到剪贴板' : '整理如下（剪贴板写入失败，请手动复制）'}，共 ${b.count} 条：\n\n${b.text}`;
        toast(`✅ ${ch} 的 ${b.count} 条新增售后已${ok ? '复制' : '整理'}，下次复制不再包含`);
        scan();
      } catch (e) { toast('❌ ' + (e.message || e), true); }
      finally { btn.disabled = false; }
    }

    function doView(ch, items) {
      detailBox.style.display = 'block';
      const noIssueN = items.filter(i => i.no_issue && !i.copied).length;
      const lines = [`【${ch}】全部 ${items.length} 条（✓=已复制过，●=新增，⚠=只有订单号缺问题描述，不进复制；来源与时间仅在此展示）：`];
      for (const it of items) {
        const src = it.chat_type === '群聊' ? `群「${it.chat_name}」` : `私信「${it.nickname}」`;
        const mark = it.no_issue && !it.copied ? '⚠' : it.copied ? '✓' : '●';
        lines.push(`【${it.num}】${mark} ${it.issue}\n    ${src}，${it.created_at}`);
      }
      if (noIssueN) lines.push(`\n（${noIssueN} 条⚠光杆订单号待客户补充问题后再进复制）`);
      detailBox.textContent = lines.join('\n');
    }

    refBtn.onclick = scan;
    scan();
  }

  window.__openAfterSalesPanel = function () {
    if (overlay) { overlay.remove(); overlay = null; }
    buildUI();
    document.body.appendChild(overlay);
  };
})();
