/* 聊机·快捷功能浮窗（注入 renderer，软件打开时自动显示）
   入口四个：提现打款 / 知识库 / 售后整理 / 聊天记录分析
   右上角：— 最小化（收成小圆点，点圆点展开）　✕ 关闭（下次启动软件再出现） */
(function () {
  'use strict';
  if (window.__liaojiDockMounted) return;
  window.__liaojiDockMounted = true;

  const GREEN = '#8bc34a';
  const GREEN_DARK = '#5c8a2e';

  function h(tag, style, text) {
    const el = document.createElement(tag);
    if (style) el.style.cssText = style;
    if (text !== undefined) el.textContent = text;
    return el;
  }

  function entries() {
    return [
      { icon: '💰', label: '提现打款', fn: window.__openDakuanPanel },
      { icon: '📚', label: '知识库', fn: window.__openKbPanel },
      { icon: '🧰', label: '售后整理', fn: window.__openAfterSalesPanel },
      { icon: '📊', label: '聊天分析', fn: window.__openChatAnalysis }
    ];
  }

  function build() {
    // 最小化小圆点
    const dot = h('div', 'position:fixed;right:14px;bottom:96px;z-index:5000;width:46px;height:46px;border-radius:50%;background:#fff;border:2px solid #8bc34a;box-shadow:0 4px 14px rgba(0,0,0,.18);display:none;align-items:center;justify-content:center;font-size:20px;cursor:pointer;', '⚡');
    dot.title = '展开快捷功能';

    // 主浮窗
    const dock = h('div', 'position:fixed;right:14px;bottom:150px;z-index:5000;width:120px;background:#fff;border:1px solid #e2ecd6;border-radius:14px;box-shadow:0 8px 26px rgba(0,0,0,.16);overflow:hidden;font-size:12px;color:#333;user-select:none;');

    const bar = h('div', 'display:flex;align-items:center;padding:7px 10px;background:#f6faf1;border-bottom:1px solid #eef2e6;cursor:move;');
    bar.appendChild(h('span', 'flex:1;font-weight:700;color:#4a7a28;font-size:12px;', '快捷功能'));
    const minBtn = h('button', 'border:none;background:none;cursor:pointer;color:#999;font-size:13px;padding:0 5px;line-height:1;', '—');
    minBtn.title = '最小化';
    const closeBtn = h('button', 'border:none;background:none;cursor:pointer;color:#999;font-size:14px;padding:0 0 0 5px;line-height:1;', '✕');
    closeBtn.title = '关闭（下次启动再显示）';
    bar.appendChild(minBtn); bar.appendChild(closeBtn);
    dock.appendChild(bar);

    const body = h('div', 'padding:8px;display:flex;flex-direction:column;gap:6px;');
    for (const e of entries()) {
      const b = h('button', 'display:flex;align-items:center;gap:8px;width:100%;border:1px solid #eef2e6;background:#fcfdf9;border-radius:9px;padding:7px 9px;cursor:pointer;font-size:12px;color:#3d5a1e;text-align:left;');
      b.onmouseenter = () => { b.style.background = '#f1f8e9'; b.style.borderColor = '#b7d68f'; };
      b.onmouseleave = () => { b.style.background = '#fcfdf9'; b.style.borderColor = '#eef2e6'; };
      b.appendChild(h('span', 'font-size:15px;', e.icon));
      b.appendChild(h('span', 'flex:1;font-weight:600;', e.label));
      b.onclick = () => {
        const fn = e.fn;
        if (typeof fn === 'function') { try { fn(); } catch (err) { console.warn('dock open failed:', err); } }
      };
      body.appendChild(b);
    }
    dock.appendChild(body);

    // 拖动（标题栏拖动换位）
    let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
    bar.addEventListener('mousedown', (ev) => {
      dragging = true;
      const r = dock.getBoundingClientRect();
      sx = ev.clientX; sy = ev.clientY; ox = r.left; oy = r.top;
      dock.style.right = 'auto'; dock.style.bottom = 'auto';
      dock.style.left = ox + 'px'; dock.style.top = oy + 'px';
      ev.preventDefault();
    });
    document.addEventListener('mousemove', (ev) => {
      if (!dragging) return;
      dock.style.left = Math.max(0, Math.min(window.innerWidth - 120, ox + ev.clientX - sx)) + 'px';
      dock.style.top = Math.max(0, Math.min(window.innerHeight - 80, oy + ev.clientY - sy)) + 'px';
    });
    document.addEventListener('mouseup', () => { dragging = false; });

    minBtn.onclick = () => {
      dock.style.display = 'none';
      dot.style.display = 'flex';
      try { localStorage.setItem('liaoji_dock_min', '1'); } catch { }
    };
    dot.onclick = () => {
      dot.style.display = 'none';
      dock.style.display = 'block';
      try { localStorage.setItem('liaoji_dock_min', '0'); } catch { }
    };
    closeBtn.onclick = () => { dock.remove(); dot.remove(); };

    document.body.appendChild(dock);
    document.body.appendChild(dot);

    // 上次是最小化的话，这次也收成小圆点
    try {
      if (localStorage.getItem('liaoji_dock_min') === '1') {
        dock.style.display = 'none';
        dot.style.display = 'flex';
      }
    } catch { }
  }

  // 等四个面板入口就绪再建（最多等 8 秒）
  let tries = 0;
  const timer = setInterval(() => {
    tries++;
    const ready = entries().every(e => typeof e.fn === 'function');
    if (ready || tries > 16) {
      clearInterval(timer);
      build();
    }
  }, 500);
})();
