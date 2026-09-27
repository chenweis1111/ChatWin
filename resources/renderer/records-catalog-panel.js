/* 聊机·聊天记录按天编号目录面板（注入 renderer）
   入口：window.__openRecordsCatalog()（聊天历史页「# 记录目录」按钮调用）
   后端：本地 AI 服务 http://127.0.0.1:7200 的 /records/by-day 端点
   展示：左侧每天目录（日期+条数），点击看当天记录（按时间从 1 开始编号） */
(function () {
  'use strict';
  if (window.__openRecordsCatalog) return;

  const API = 'http://127.0.0.1:7200';
  const GREEN = '#8bc34a';
  const GREEN_DARK = '#5c8a2e';
  let overlay = null;

  function h(tag, style, text) {
    const el = document.createElement(tag);
    if (style) el.style.cssText = style;
    if (text !== undefined) el.textContent = text;
    return el;
  }

  function toast(text, warn) {
    const t = h('div', `position:fixed;top:24px;left:50%;transform:translateX(-50%);z-index:999999;padding:9px 22px;border-radius:20px;font-size:13px;box-shadow:0 4px 16px rgba(0,0,0,.18);transition:opacity .4s;${warn ? 'background:#fff7e6;color:#ad6800;border:1px solid #ffd591;' : 'background:#f6ffed;color:#389e0d;border:1px solid #b7eb8f;'}`, text);
    document.body.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 450); }, 3600);
  }

  function buildUI() {
    overlay = h('div', 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:99999;display:flex;align-items:center;justify-content:center;');
    const panel = h('div', 'background:#fff;width:860px;max-width:95vw;height:88vh;border-radius:12px;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 12px 40px rgba(0,0,0,.25);font-size:13px;color:#333;');

    const head = h('div', 'display:flex;align-items:center;padding:12px 18px;border-bottom:1px solid #eee;background:#f6faf1;');
    head.appendChild(h('div', 'font-size:16px;font-weight:600;flex:1;color:#4a7a28;', '# 聊天记录编号目录'));
    const refBtn = h('button', 'border:1px solid #ddd;background:#fff;border-radius:6px;padding:4px 14px;cursor:pointer;font-size:12px;margin-right:8px;', '刷新');
    const closeBtn = h('button', 'border:none;background:none;font-size:20px;cursor:pointer;color:#999;', '✕');
    closeBtn.onclick = () => overlay.remove();
    head.appendChild(refBtn); head.appendChild(closeBtn);
    panel.appendChild(head);

    const statBar = h('div', 'font-size:12px;color:#999;padding:8px 18px 0;', '加载中…');
    panel.appendChild(statBar);

    const mainBox = h('div', 'flex:1;display:flex;overflow:hidden;padding:10px 18px 14px;gap:12px;');
    panel.appendChild(mainBox);
    overlay.appendChild(panel);

    // 左：日期目录
    const dayCol = h('div', 'width:170px;flex:none;overflow-y:auto;border:1px solid #eef2e8;border-radius:8px;padding:8px;background:#fcfdf9;');
    mainBox.appendChild(dayCol);
    // 右：当天记录
    const recCol = h('div', 'flex:1;overflow-y:auto;border:1px solid #eef2e8;border-radius:8px;padding:8px 10px;background:#fff;');
    mainBox.appendChild(recCol);

    let days = [];
    let activeDay = '';

    async function load() {
      statBar.textContent = '加载中…';
      dayCol.textContent = ''; recCol.textContent = '';
      try {
        const r = await fetch(API + '/records/by-day');
        const j = await r.json();
        const b = (j && j.body) || {};
        days = b.days || [];
        statBar.textContent = `共 ${b.total || 0} 条（回复+判断过程）/ ${days.length} 天。只保留回复记录与无需回复判断，最新在上方，编号越大越新。`;
        renderDays();
        if (days.length) showDay(days[0].day);
        else recCol.appendChild(h('div', 'color:#999;padding:10px;', '（暂无记录）'));
      } catch (e) {
        statBar.textContent = '❌ ' + (e.message || e) + '（本地 AI 服务是否已启动？）';
      }
    }

    function renderDays() {
      dayCol.textContent = '';
      for (const d of days) {
        const btn = h('div', `padding:7px 10px;border-radius:7px;cursor:pointer;margin-bottom:4px;font-size:12px;${d.day === activeDay ? `background:${GREEN};color:#fff;font-weight:700;` : 'background:#fff;color:#444;border:1px solid #eef2e8;'}`,
          `${d.day}（${d.count}）`);
        btn.onclick = () => showDay(d.day);
        dayCol.appendChild(btn);
      }
    }

    function showDay(day) {
      activeDay = day;
      renderDays();
      recCol.textContent = '';
      const d = days.find(x => x.day === day);
      if (!d) return;
      recCol.appendChild(h('div', `font-weight:700;color:#3d5a1e;padding:4px 2px 8px;`, `${day}　共 ${d.count} 条`));
      for (const it of d.items) {
        const row = h('div', 'display:flex;gap:8px;padding:5px 4px;border-bottom:1px dashed #f0f0f0;align-items:flex-start;');
        const badgeBg = it.is_judge ? 'background:#fff3e0;color:#d48806;' : `background:${GREEN};color:#fff;`;
        row.appendChild(h('span', `flex:none;font-family:monospace;font-weight:700;font-size:12px;padding:1px 7px;border-radius:5px;margin-top:1px;${badgeBg}`, String(it.num)));
        const mid = h('div', 'flex:1;min-width:0;');
        mid.appendChild(h('div', 'font-size:12px;word-break:break-all;', it.content));
        if (it.is_judge && it.customer_message) {
          mid.appendChild(h('div', 'font-size:11px;color:#bbb;margin-top:1px;word-break:break-all;', `对方最新说：「${it.customer_message}」`));
        }
        const who = it.chat_type === '群聊' ? `群「${it.target_name}」` : `私信「${it.target_name}」`;
        const kind = it.is_judge ? '判断：无需回复' : '我方回复';
        mid.appendChild(h('div', `font-size:11px;margin-top:1px;${it.is_judge ? 'color:#d48806;' : 'color:#999;'}`, `${kind} · ${who} · ${String(it.created_at).slice(11)}`));
        row.appendChild(mid);
        recCol.appendChild(row);
      }
    }

    refBtn.onclick = load;
    load();
  }

  window.__openRecordsCatalog = function () {
    if (overlay) { overlay.remove(); overlay = null; }
    buildUI();
    document.body.appendChild(overlay);
  };
})();
