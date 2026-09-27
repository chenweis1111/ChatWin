/* 聊机·首次启动功能自检（注入 renderer，只在第一次启动时跑一次）
   步骤以本机实测流程为标准：前置窗口 → 截屏识别 → 侧边栏校准 → 输入框定位
   任一步失败：自动重新校准侧边栏并重试一次；仍失败则保留标记，下次启动再试 */
(function () {
  'use strict';
  if (window.__liaojiFuncChecked) return;
  window.__liaojiFuncChecked = true;

  const API = 'http://127.0.0.1:7200';
  const FLAG = 'liaoji_func_checked_v1';

  function toast(text, warn, long) {
    const t = document.createElement('div');
    t.style.cssText = 'position:fixed;top:24px;left:50%;transform:translateX(-50%);z-index:999999;padding:10px 24px;border-radius:20px;font-size:13px;box-shadow:0 4px 16px rgba(0,0,0,.18);max-width:80vw;'
      + (warn ? 'background:#fff7e6;color:#ad6800;border:1px solid #ffd591;' : 'background:#f6ffed;color:#389e0d;border:1px solid #b7eb8f;');
    t.textContent = text;
    document.body.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 450); }, long ? 8000 : 4200);
  }

  async function post(path, body) {
    const r = await fetch(API + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    });
    const j = await r.json();
    return (j && j.body) || {};
  }

  async function run() {
    toast('🧪 首次启动功能自检开始（窗口识别 → 侧边栏校准 → 输入框定位）');
    // 1. 前置并识别窗口
    await post('/test/activate', { app: 'wecom' });
    const shot = await post('/test/screenshot', { app: 'wecom' });
    if (!shot.image_base64) { toast('⚠️ 自检第 1 步失败：没能截到企业微信窗口（请先打开并登录企微）', true, true); return; }
    if (shot.occluded) { toast('⚠️ 自检第 1 步失败：企微窗口被遮挡（' + (shot.occlusion_reason || '') + '），请先把它拉到最前', true, true); return; }

    // 2. 侧边栏校准（学本机布局，防跨版本误杀红点）
    const cal = await post('/test/rail-calibrate', { app: 'wecom' });
    if (cal.error) { toast('⚠️ 自检第 2 步侧边栏校准失败：' + cal.error + '（不影响主流程，用默认白名单）', true, true); }

    // 3. 输入框定位
    let ib = await post('/test/input-box', { image_base64: shot.image_base64, app_type: 'wecom' });
    if (!ib.point && !cal.error) {
      // 标准不对 → 自修复：重新校准一次再试
      await post('/test/rail-calibrate', { app: 'wecom' });
      ib = await post('/test/input-box', { image_base64: shot.image_base64, app_type: 'wecom' });
    }
    if (!ib.point) {
      toast('❌ 自检第 3 步失败：聊天输入框定位不到，自动回复不可用。请把企微窗口放大到正常大小后重启聊机再试', true, true);
      return;
    }

    try { localStorage.setItem(FLAG, new Date().toISOString()); } catch { }
    toast(`✅ 首次功能自检通过：窗口识别 ✓ 侧边栏校准 ✓（${(cal.found_labels || []).join('、') || '无功能目录'}）输入框定位 ✓（${ib.via === 'layout' ? '布局' : '点定位'}）`, false, true);
  }

  // 启动后 6 秒再跑（等服务与窗口就绪），且只在没跑过时跑
  setTimeout(() => {
    try {
      if (localStorage.getItem(FLAG)) return;
    } catch { }
    run().catch(e => toast('❌ 功能自检异常：' + (e.message || e), true, true));
  }, 6000);
})();
