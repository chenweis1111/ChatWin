/* 聊机·误触自救看门狗状态卡片（注入 renderer，诊断工具页「🛟 误触自救」挂载）
   入口：window.__mountWatchdogCard(container)
   数据：http://127.0.0.1:7200/watchdog/status（每 3 秒轮询，实时显示自救过程） */
(function () {
  'use strict';

  const API = 'http://127.0.0.1:7200';
  const GREEN = '#8bc34a';
  const GREEN_DARK = '#5c8a2e';

  function h(tag, style, text) {
    const el = document.createElement(tag);
    if (style) el.style.cssText = style;
    if (text !== undefined) el.textContent = text;
    return el;
  }

  window.__mountWatchdogCard = function (container) {
    if (container.__wdMounted) return;
    container.__wdMounted = true;

    const statRow = h('div', 'display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px;font-size:12px;');
    container.appendChild(statRow);
    const logBox = h('div', 'font-size:12px;background:#f8faf4;border-radius:6px;padding:8px 10px;max-height:180px;overflow-y:auto;color:#555;white-space:pre-wrap;');
    logBox.textContent = '等待看门狗事件…（引擎运行期间，遮挡拉回 / 误开功能页点回消息会实时显示在这里）';
    container.appendChild(logBox);
    container.appendChild(h('div', 'font-size:11px;color:#aaa;margin-top:6px;',
      '引擎运行时自动把聊天窗口置顶到最前；被遮挡/弹窗卡住会先 ESC 关弹窗再拉回；误开智能助理/总结会自动点回消息页。引擎停止自动取消置顶。'));

    let timer = null;
    let lastCount = 0;

    function badge(text, color, bg) {
      return h('span', `padding:2px 10px;border-radius:10px;font-weight:600;background:${bg};color:${color};`, text);
    }

    async function poll() {
      let b;
      try {
        const r = await fetch(API + '/watchdog/status');
        const j = await r.json();
        b = (j && j.body) || {};
      } catch (e) {
        statRow.textContent = '';
        statRow.appendChild(badge('本地 AI 服务未连接', '#c0392b', '#fdecea'));
        return;
      }
      statRow.textContent = '';
      statRow.appendChild(badge(b.enabled ? '看门狗：开' : '看门狗：关', b.enabled ? GREEN_DARK : '#999', b.enabled ? '#e8f5d8' : '#eee'));
      statRow.appendChild(badge(b.engine_active ? '引擎：运行中' : '引擎：空闲', b.engine_active ? '#d97706' : '#999', b.engine_active ? '#fff3e0' : '#eee'));
      statRow.appendChild(badge('守护：' + (b.watch_app === 'wecom' ? '企业微信' : '微信'), '#3d5a1e', '#eef2e8'));
      statRow.appendChild(badge(b.topmost ? '已置顶' : '未置顶', b.topmost ? '#1677ff' : '#999', b.topmost ? '#e3f0ff' : '#eee'));
      if (b.last_rescue) statRow.appendChild(badge('最近自救：' + b.last_rescue, '#ad6800', '#fff7e6'));

      const events = b.events || [];
      if (events.length !== lastCount) {
        lastCount = events.length;
        if (!events.length) return;
        logBox.textContent = events.map(e => `[${String(e.time).slice(11)}] ${e.text}`).join('\n');
        logBox.scrollTop = logBox.scrollHeight;
      }
    }

    poll();
    timer = setInterval(poll, 3000);
    // 卡片被移除时停轮询（简单起见用定时器检查）
    const guard = setInterval(() => {
      if (!document.contains(container)) { clearInterval(timer); clearInterval(guard); }
    }, 5000);
  };
})();
