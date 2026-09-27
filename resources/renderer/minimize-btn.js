/* 聊机·主界面最小化悬浮按钮（注入 renderer，右上角小按钮） */
(function () {
  'use strict';
  if (window.__minBtnMounted) return;
  window.__minBtnMounted = true;
  function mount() {
    if (!document.body) { setTimeout(mount, 300); return; }
    const b = document.createElement('div');
    b.textContent = '—';
    b.title = '最小化';
    b.style.cssText = 'position:fixed;top:6px;right:12px;z-index:999998;width:26px;height:20px;line-height:18px;text-align:center;font-size:14px;font-weight:700;color:#8a9a7a;background:rgba(255,255,255,.75);border:1px solid #d7e8bb;border-radius:6px;cursor:pointer;user-select:none;';
    b.onmouseenter = () => { b.style.background = '#e8f5d8'; };
    b.onmouseleave = () => { b.style.background = 'rgba(255,255,255,.75)'; };
    b.onclick = async () => {
      try {
        if (window.electron && window.electron.invoke) await window.electron.invoke('MINIMIZE_MAIN_WINDOW');
      } catch (e) { }
    };
    document.body.appendChild(b);
  }
  mount();
})();
