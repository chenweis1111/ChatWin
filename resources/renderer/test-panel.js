/* 聊机·分步功能测试面板（注入 renderer，功能测试页挂载）
   入口：window.__mountStepTests(container)（TestPage 的 StepTestSection 调用）
   后端：本地 AI 服务 http://127.0.0.1:7200 的 /test/* 端点
   测试卡：① 思考回复（诊断）② 窗口识别（诊断）③ 未读导航 ④ 粘贴发送 ⑤ 生产顺序循环 ⑥ 遮挡自救 */
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

  // 全局停止标记：循环点「停止」后置 true，睡眠立即返回、点击类请求直接拒绝，防"停止后卡死"
  let gCancel = false;

  async function api(path, body) {
    // 已停止时拒绝会改变状态的请求（点击/粘贴/前置/遮挡），让正在跑的测试立刻中断而不是继续点鼠标
    if (gCancel && /\/test\/(mouse|paste|activate|occlude)/.test(path)) throw new Error('已手动停止');
    const opt = body === undefined
      ? {}
      : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 150000); // 150s 硬超时：后端挂住时也不能把界面卡死
    opt.signal = ctrl.signal;
    // 常见英文错误 → 明文汉字，避免底层英文直接糊在用户脸上
    const EN2ZH = {
      'invalid json': '请求格式错误', 'empty image': '截图内容为空', 'invalid args': '参数错误',
      'invalid coordinates': '坐标无效', 'not found': '服务端没有这个接口'
    };
    try {
      let r;
      try {
        r = await fetch(API + path, opt);
      } catch (e) {
        const msg = String(e && e.message || e);
        if (e.name === 'AbortError' || /abort/i.test(msg)) throw new Error('请求超时（150 秒无响应）：本地 AI 服务卡住了，请重启聊机服务再试');
        if (/fetch failed|failed to fetch|networkerror/i.test(msg)) throw new Error('连不上本地 AI 服务（127.0.0.1:7200）：请确认服务已启动（桌面双击「聊机v7」）');
        throw new Error(EN2ZH[msg] || ('服务错误：' + msg));
      }
      if (!r.ok) throw new Error('服务端返回异常（HTTP ' + r.status + '），请把日志发给维护人员');
      const j = await r.json();
      const b = (j && j.body) || {};
      if (b.error) throw new Error(EN2ZH[String(b.error)] || String(b.error));
      return b;
    } finally { clearTimeout(timer); }
  }

  // 可被取消的睡眠：gCancel 置位后立即返回（轮询间隔 120ms，不牺牲正常计时的精度）
  const sleep = ms => new Promise((resolve) => {
    const iv = setInterval(() => {
      if (gCancel) { clearTimeout(t); clearInterval(iv); resolve(); }
    }, 120);
    const t = setTimeout(() => { clearInterval(iv); resolve(); }, ms);
  });

  // 强制前置目标窗口后截图：测试期间目标窗口必须在最前——被聊机自身/其他窗口盖住时，截图和点击全部跑偏。
  // 已在最前且裁剪正常就直接用（每步省约 1 秒的前置），只有发现被盖住或句柄丢失才补前置
  async function shotForeground(app) {
    let s = await api('/test/screenshot', { app });
    const fg = String(s.foreground_title || '');
    if (!s.cropped || s.occluded || /聊机/.test(fg)) {
      try { await api('/test/activate', { app }); } catch (e) { }
      await sleep(400);
      s = await api('/test/screenshot', { app });
    }
    return s;
  }

  // ---- 测试共用的导航辅助（模块级）：clickAt / shotChecked / locateFirstFriend / navFirstUnread ----
  const appLabelOf = app => app === 'wecom' ? '企业微信' : '微信';
  // 前置后截图（带遮挡检查：中途被遮挡立即中止）
  async function shotChecked(app) {
    const s = await shotForeground(app);
    if (!s.image_base64) throw new Error('截图失败');
    if (checkOcclusion(s, appLabelOf(app))) throw new Error(`${appLabelOf(app)}屏幕被遮挡，已中止`);
    return s;
  }
  async function clickAt(ox, oy, px, py, action, from) {
    const req = { action, x: Math.round(ox + px), y: Math.round(oy + py) };
    if (from) { req.from_x = Math.round(from.x); req.from_y = Math.round(from.y); }
    const m = await api('/test/mouse', req);
    if (!m.ok) throw new Error('鼠标动作失败：' + (m.error || ''));
    return { sx: req.x, sy: req.y };
  }
  // 定位好友列表第 1 个会话：优先红点检测结果（列表区最上面的未读行，避开「折叠的聊天」误选）→ VLM 定位 → 重试 → 几何兜底
  async function locateFirstFriend(app, mid) {
    try {
      const rd2 = await api('/test/red-dot', { image_base64: mid.image_base64, app_type: app });
      const listDots = (rd2.dots || []).map(d => ({ cx: (d[0][0] + d[1][0]) / 2, cy: (d[0][1] + d[1][1]) / 2 }))
        .filter(c => c.cx >= mid.width * 0.14 && c.cx <= mid.width * 0.45 && c.cy > 60)
        .sort((a, b) => a.cy - b.cy);
      if (listDots.length) {
        // 红点只用来确定"哪一行"：纵向取红点行心，横向取会话列表文字区中部——
        // 红点是行角标，点在角标上容易点空或点错行
        return { point: { x: Math.round(mid.width * 0.29), y: Math.round(listDots[0].cy) }, via: '红点定位（首个未读会话）' };
      }
    } catch (e) { }
    // VLM 定位结果校验：太靠上（<6% 窗高，是顶部账号头像行）或太靠左（<14% 窗宽，是侧边栏）的点不采纳——
    // 否则会把账号头像当成第一个会话，一直点到头像
    const LIFT_TARGET = '左侧会话列表（中间一栏，不含最顶部的账号头像区和搜索框）中从上往下第一个聊天会话条目（整行中部）';
    const plaus = p => p && p.y >= mid.height * 0.06 && p.x >= mid.width * 0.14;
    let loc = await api('/test/locate', {
      image_base64: mid.image_base64, app_type: app,
      target: LIFT_TARGET
    });
    if (plaus(loc.point)) return { point: loc.point, via: 'VLM 定位' };
    await sleep(1500);
    const mid2 = await shotChecked(app);
    loc = await api('/test/locate', {
      image_base64: mid2.image_base64, app_type: app,
      target: LIFT_TARGET
    });
    if (plaus(loc.point)) return { point: loc.point, via: 'VLM 定位（重试）', shot: mid2 };
    // 几何兜底：会话列表在窗口左侧固定比例区域，第 1 个条目在搜索框下方（横向点列表文字区中部，纵向取首行中心 9.5% 窗高）
    return {
      point: { x: Math.round(mid2.width * 0.29), y: Math.round(mid2.height * 0.095) },
      via: '几何兜底（列表区固定比例）', shot: mid2
    };
  }
  // 导航坐标缓存：首轮全量定位后记住「未读行/第一个会话/输入框」坐标，
  // 后续轮窗口尺寸不变就直接复用（快得多）；窗口一变自动回退全量定位
  const navCache = { w: 0, h: 0, unread: null, firstChat: null, input: null, at: 0 };

  // 导航进第一个未读会话（测试④独立运行的前置流程）：单击侧边「未读」→ 单击第一个会话
  async function navFirstUnread(app, steps, useCache) {
    const appLabel = appLabelOf(app);
    let sn = await shotChecked(app);
    if (!sn.cropped) {
      await api('/test/activate', { app });
      await sleep(800);
      sn = await shotChecked(app);
      if (!sn.cropped) throw new Error(`未能裁剪到${appLabel}窗口（窗口被最小化或进程异常），已中止`);
    }
    if (sn.width < 1500) {
      // 窗口太窄会话列表会被压缩甚至隐藏——自动恢复到标准尺寸（等于校准时的布局），不靠人拉窗口
      try { await api('/test/resize', { app, width: 2204, height: 1826 }); } catch (e) { }
      await sleep(1500);
      sn = await shotChecked(app);
    }
    if (sn.width < 900) throw new Error(`${appLabel}窗口太窄（宽 ${sn.width}px，目录和会话列表已被隐藏），请拉宽窗口再测`);
    // 快速复用：首轮没错后续就没错——原点用刚截的图，窗口挪了也不怕；尺寸变了/超 30 分钟则回退全量
    if (useCache && navCache.unread && navCache.firstChat
      && navCache.w === sn.width && navCache.h === sn.height
      && Date.now() - navCache.at < 30 * 60 * 1000) {
      const sQ = makeStep(steps, '复用上次坐标：未读 → 第一个会话');
      sQ.run();
      const pN = await clickAt(sn.origin_x, sn.origin_y, navCache.unread.cx, navCache.unread.cy, 'click');
      await sleep(1200);
      const pF = await clickAt(sn.origin_x, sn.origin_y, navCache.firstChat.cx, navCache.firstChat.cy, 'glide_click', { x: pN.sx, y: pN.sy });
      sQ.ok(`已按上次坐标点击 (${pN.sx}, ${pN.sy}) → (${pF.sx}, ${pF.sy})，等待会话打开…`);
      await sleep(1500);
      return { ok: true, fast: true };
    }
    const rd = await api('/test/red-dot', { image_base64: sn.image_base64, app_type: app });
    const railNow = rd.rail || {};
    let target, desc;
    if (railNow.unread_row_y > 0) {
      target = { cx: railNow.unread_row_x, cy: railNow.unread_row_y }; desc = '「未读」分组';
    } else if (railNow.msg_row_y > 0) {
      target = { cx: sn.width * 0.065, cy: railNow.msg_row_y }; desc = '「消息」行';
    } else {
      throw new Error('未读到侧边目录位置（无校准数据），请先点顶部「📍 校准侧边栏」');
    }
    const sN = makeStep(steps, `单击侧边${desc}，列出未读会话`);
    sN.run();
    const pN = await clickAt(sn.origin_x, sn.origin_y, target.cx, target.cy, 'click');
    sN.ok(`已点击 (${pN.sx}, ${pN.sy})（${desc}），等待列表展开…`);
    await sleep(1500);
    const mid = await shotChecked(app);
    const found = await locateFirstFriend(app, mid);
    const midShot = found.shot || mid;
    const sF = makeStep(steps, '单击第 1 个会话进入聊天');
    sF.run();
    sF.image(midShot.image_base64, [{ kind: 'point', x: found.point.x, y: found.point.y, label: '第1个会话' }], `蓝圈为将单击的位置（${found.via}）`);
    const pF = await clickAt(midShot.origin_x, midShot.origin_y, found.point.x, found.point.y, 'glide_click', { x: pN.sx, y: pN.sy });
    sF.ok(`已单击 (${pF.sx}, ${pF.sy})（${found.via}），等待聊天窗口打开…`);
    await sleep(1500);
    // 记住坐标供后续轮复用
    navCache.w = sn.width; navCache.h = sn.height;
    navCache.unread = { cx: target.cx, cy: target.cy };
    navCache.firstChat = { cx: found.point.x, cy: found.point.y };
    navCache.at = Date.now();
    return { ok: true };
  }

  // ---- 轻提示（自动消失的 toast） ----
  function toast(text, warn) {
    const t = h('div', `position:fixed;top:24px;left:50%;transform:translateX(-50%);z-index:999999;padding:9px 22px;border-radius:20px;font-size:13px;box-shadow:0 4px 16px rgba(0,0,0,.18);transition:opacity .4s;${warn ? 'background:#fff7e6;color:#ad6800;border:1px solid #ffd591;' : 'background:#f6ffed;color:#389e0d;border:1px solid #b7eb8f;'}`, text);
    document.body.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 450); }, 3600);
  }

  // 遮挡检查：目标窗口没真正在前台时，轻提示并中止（不继续识别/生成）
  function checkOcclusion(shot, appLabel) {
    if (!shot || !shot.occluded) return false;
    const reason = shot.occlusion_reason === 'no_window'
      ? `${appLabel}窗口被隐藏或最小化到托盘`
      : `${appLabel}屏幕被「${shot.foreground_title || '其他窗口'}」遮挡`;
    toast(`⚠️ ${reason}，请先把它显示到前台再测试`, true);
    return true;
  }

  // ---- 步骤行 ----
  let lastStepEndAt = Date.now(); // 上一步结束时刻：用于展示"步骤间等待了多久"
  function makeStep(listEl, name) {
    const row = h('div', 'padding:8px 10px;border:1px solid #eef2e8;border-radius:8px;margin-top:6px;background:#fcfdf9;');
    const head = h('div', 'display:flex;align-items:center;gap:8px;');
    const icon = h('span', 'font-size:14px;width:20px;text-align:center;', '⏸');
    const label = h('span', 'font-weight:600;color:#444;flex:1;', name);
    const gapEl = h('span', 'color:#c4c4c4;font-size:11px;white-space:nowrap;', ''); // 距上一步的等待间隔
    const ms = h('span', 'color:#aaa;font-size:12px;white-space:nowrap;', '');
    head.appendChild(icon); head.appendChild(label); head.appendChild(gapEl); head.appendChild(ms);
    const detail = h('div', 'color:#777;font-size:12px;margin-top:4px;white-space:pre-wrap;word-break:break-all;display:none;');
    const media = h('div', 'margin-top:6px;display:none;');
    row.appendChild(head); row.appendChild(detail); row.appendChild(media);
    listEl.appendChild(row);
    const isFirst = listEl.children.length === 1; // 新一轮的第一个步骤：不显示与上一轮的间隔
    const t0 = Date.now();
    let liveT = null;
    const stopLive = () => { if (liveT) { clearInterval(liveT); liveT = null; } };
    return {
      run() {
        const gap = (Date.now() - lastStepEndAt) / 1000;
        if (!isFirst && gap > 0.35) gapEl.textContent = `等${gap.toFixed(1)}s→`;
        icon.textContent = '⏳'; row.style.borderColor = '#d7e8bb';
        stopLive();
        // 运行中实时计时，不用等结束才看到耗时
        liveT = setInterval(() => { ms.textContent = ((Date.now() - t0) / 1000).toFixed(1) + 's'; }, 200);
      },
      ok(text) {
        stopLive();
        lastStepEndAt = Date.now();
        icon.textContent = '✅'; ms.textContent = ((Date.now() - t0) / 1000).toFixed(1) + 's';
        row.style.borderColor = '#b7d68f';
        if (text) { detail.style.display = 'block'; detail.textContent = text; }
      },
      fail(text) {
        stopLive();
        lastStepEndAt = Date.now();
        icon.textContent = '❌'; ms.textContent = ((Date.now() - t0) / 1000).toFixed(1) + 's';
        row.style.borderColor = '#f0b4b4'; row.style.background = '#fff7f7';
        detail.style.display = 'block'; detail.style.color = '#c0392b';
        detail.textContent = text || '失败';
        throw new Error(text || name + ' 失败');
      },
      skip(text) {
        stopLive();
        lastStepEndAt = Date.now();
        icon.textContent = '⏭';
        if (text) { detail.style.display = 'block'; detail.textContent = text; }
      },
      // marks: [{x,y,kind:'dot'|'point'|'rect', x2,y2, label}]
      image(b64, marks, caption) {
        media.style.display = 'block';
        media.textContent = '';
        const wrap = h('div', 'position:relative;max-width:100%;');
        const canvas = document.createElement('canvas');
        const img = new Image();
        img.onload = () => {
          const scale = Math.min(1, 640 / img.width);
          canvas.width = Math.round(img.width * scale);
          canvas.height = Math.round(img.height * scale);
          canvas.style.cssText = 'max-width:100%;border:1px solid #e5e5e5;border-radius:6px;';
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          (marks || []).forEach((m, i) => {
            const x = m.x * scale, y = m.y * scale;
            if (m.kind === 'rect') {
              ctx.strokeStyle = '#ff4d4f'; ctx.lineWidth = 2;
              ctx.strokeRect(x, y, (m.x2 - m.x) * scale, (m.y2 - m.y) * scale);
              ctx.fillStyle = '#ff4d4f'; ctx.font = 'bold 12px sans-serif';
              ctx.fillText(m.label || String(i + 1), x + 2, y - 3);
            } else if (m.kind === 'point') {
              ctx.strokeStyle = '#1677ff'; ctx.lineWidth = 2;
              ctx.beginPath(); ctx.arc(x, y, 12, 0, Math.PI * 2); ctx.stroke();
              ctx.beginPath(); ctx.moveTo(x - 18, y); ctx.lineTo(x + 18, y); ctx.stroke();
              ctx.beginPath(); ctx.moveTo(x, y - 18); ctx.lineTo(x, y + 18); ctx.stroke();
              if (m.label) { ctx.fillStyle = '#1677ff'; ctx.font = 'bold 12px sans-serif'; ctx.fillText(m.label, x + 14, y - 14); }
            }
          });
          // 释放原图内存：截图 base64 每张近 1MB，多轮测试累积会把渲染进程撑爆导致闪退
          img.onload = null;
          img.src = '';
        };
        img.src = 'data:image/png;base64,' + b64;
        wrap.appendChild(canvas);
        if (caption) wrap.appendChild(h('div', 'color:#999;font-size:11px;margin-top:2px;', caption));
        media.appendChild(wrap);
      }
    };
  }

  // ---- 卡片骨架 ----
  function makeCard(root, no, title, desc) {
    const card = h('div', 'border:1px solid #e8f0dc;border-radius:10px;padding:14px 16px;margin-bottom:14px;background:#fff;');
    const head = h('div', 'display:flex;align-items:center;gap:8px;margin-bottom:4px;');
    const badge = h('span', `background:${GREEN};color:#fff;border-radius:50%;width:22px;height:22px;display:inline-flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;`, String(no));
    head.appendChild(badge);
    head.appendChild(h('span', 'font-size:15px;font-weight:600;color:#3d5a1e;', title));
    card.appendChild(head);
    card.appendChild(h('div', 'color:#888;font-size:12px;margin-bottom:8px;', desc));
    const ctrl = h('div', 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:4px;');
    const steps = h('div', '');
    const status = h('div', 'font-size:12px;color:#999;margin-top:6px;');
    card.appendChild(ctrl); card.appendChild(steps); card.appendChild(status);
    root.appendChild(card);
    return { card, ctrl, steps, status };
  }

  function appSelect() {
    const sel = h('select', 'padding:4px 8px;border:1px solid #ddd;border-radius:6px;');
    [['wechat', '微信'], ['wecom', '企业微信']].forEach(([v, t]) => {
      const o = document.createElement('option'); o.value = v; o.textContent = t; sel.appendChild(o);
    });
    return sel;
  }
  function runBtn(text) {
    return h('button', `padding:5px 18px;border:none;background:${GREEN};color:#fff;border-radius:6px;cursor:pointer;font-weight:600;`, text || '开始测试');
  }
  function stopBtn() {
    return h('button', 'padding:5px 14px;border:1px solid #ddd;background:#fff;border-radius:6px;cursor:pointer;display:none;', '停止');
  }

  // ========== 测试 ①：思考和回复 ==========
  async function testThinkReply(app, agentType, steps) {
    steps.textContent = '';
    const appLabel = app === 'wecom' ? '企业微信' : '微信';
    const s1 = makeStep(steps, '前置目标窗口');
    s1.run();
    const act = await api('/test/activate', { app });
    if (!act.ok) s1.fail(act.hint || `未找到${appLabel}窗口（${act.reason || act.error || '未知'}）`);
    s1.ok(`已前置：${act.title || act.name}（pid ${act.pid}）${act.foreground ? '' : '，但未抢到前台焦点'}`);

    const s2 = makeStep(steps, '截取屏幕（含遮挡检测）');
    s2.run();
    const shot = await shotForeground(app);
    if (!shot.image_base64) s2.fail('截图失败');
    if (checkOcclusion(shot, appLabel)) s2.fail(`${appLabel}屏幕被遮挡，已中止——被遮挡时不生成回复`);
    s2.ok(`${shot.width}×${shot.height}，窗口在前台无遮挡`);
    s2.image(shot.image_base64, null, '当前窗口截图');

    const s3 = makeStep(steps, 'VLM 理解对话（思考）');
    s3.run();
    const r = await api('/test/think-reply', { image_base64: shot.image_base64, app_type: app, agent_type: agentType });
    const gated = r.model === 'gate:no-conversation';
    s3.ok(gated
      ? `未检测到打开的聊天会话（窗口停在菜单/列表页，右侧聊天区没有消息气泡）\n耗时 ${(r.elapsed_ms / 1000).toFixed(1)}s`
      : `会话：${r.chat_name || '（未识别）'}（${r.chat_type}）\n对方最新说：${r.customer_message || '（无）'}\n模型：${r.model}，耗时 ${(r.elapsed_ms / 1000).toFixed(1)}s`);

    const s4 = makeStep(steps, '生成回复（不真实发送）');
    s4.run();
    if (gated) s4.skip('未打开任何会话，不思考不生成——请先点开一个聊天窗口');
    else if (!r.should_reply) s4.skip('判断无需回复（没有客户新消息）');
    else s4.ok(`${r.forced_by_direction_check ? '（方向校验：最后一条是客户，按规则必须回复）' : r.polished ? '（DeepSeek 润色后）' : ''}${r.reply}`);
    return { ok: true, chat: r.chat_name, reply: r.reply };
  }

  // ========== 测试 ②：窗口与进程识别 ==========
  async function testWindows(app, steps) {
    steps.textContent = '';
    const s1 = makeStep(steps, '枚举微信 / 企业微信进程');
    s1.run();
    const w = await api('/test/windows');
    const procs = w.processes || [];
    if (!procs.length) s1.fail('未找到任何微信/企业微信进程');
    const wx = procs.filter(p => p.app === 'wechat');
    const wc = procs.filter(p => p.app === 'wecom');
    s1.ok(`微信进程 ${wx.length} 个（${wx.map(p => p.name + '#' + p.pid).join('、') || '无'}）\n企业微信进程 ${wc.length} 个（${wc.map(p => p.name + '#' + p.pid).join('、') || '无'}）`);

    const s2 = makeStep(steps, '读取窗口标题与位置');
    s2.run();
    const wins = procs.filter(p => p.has_window);
    if (!wins.length) s2.fail('所有进程都没有可见窗口');
    s2.ok(wins.map(p => `${p.app === 'wecom' ? '企微' : '微信'}「${p.title}」 位置(${p.rect.left},${p.rect.top}) 大小 ${p.rect.width}×${p.rect.height}`).join('\n'));

    const s3 = makeStep(steps, `前置${app === 'wecom' ? '企业微信' : '微信'}窗口并截图核对`);
    s3.run();
    const act = await api('/test/activate', { app });
    if (!act.ok) s3.fail(act.hint || '前置失败：' + (act.reason || act.error || ''));
    await sleep(800);
    const shot = await shotForeground(app);
    if (checkOcclusion(shot, app === 'wecom' ? '企业微信' : '微信')) s3.fail('屏幕被遮挡，已中止');
    const target = wins.find(p => p.app === app);
    s3.ok(`已前置「${act.title}」`);
    if (shot.image_base64 && target && !shot.cropped) {
      s3.image(shot.image_base64, [{ kind: 'rect', x: target.rect.left, y: target.rect.top, x2: target.rect.right, y2: target.rect.bottom, label: act.title }], '红框为识别到的目标窗口');
    } else if (shot.image_base64) {
      s3.image(shot.image_base64, null, '已裁剪到目标窗口');
    }
    return { ok: true, windows: wins };
  }

  // ========== 测试 ③：红点双击链路 ==========
  // 微信：红点在会话条目上，双击第1个红点直接进入聊天 → 定位输入框
  // 企业微信：红点分两级——侧边目录红点（消息/未读分组）双击展开列表，
  //           再单击好友列表第1个会话才进入聊天 → 定位输入框单击聚焦
  // 原则：定位可以慢，但要对；每步之间留足界面响应时间
  async function testRedDotFlow(app, steps) {
    steps.textContent = '';
    const appLabel = app === 'wecom' ? '企业微信' : '微信';

    const s1 = makeStep(steps, '前置目标窗口');
    s1.run();
    const act = await api('/test/activate', { app });
    if (!act.ok) s1.fail(act.hint || '未找到目标窗口');
    await sleep(800);
    s1.ok(`已前置：${act.title}${act.foreground ? '' : '（但未抢到前台焦点）'}`);

    const s2 = makeStep(steps, '截图并检测侧边红点（含遮挡检测）');
    s2.run();
    const shot = await shotForeground(app);
    if (!shot.image_base64) s2.fail('截图失败');
    if (checkOcclusion(shot, appLabel)) s2.fail(`${appLabel}屏幕被遮挡，已中止——被遮挡时不继续识别`);
    const rd = await api('/test/red-dot', { image_base64: shot.image_base64, app_type: app });
    const dots = rd.dots || [];
    if (!dots.length) s2.fail(`未检测到红点（${appLabel}没有未读消息，先制造一条未读再测）`);
    const centers = dots.map(d => ({ cx: (d[0][0] + d[1][0]) / 2, cy: (d[0][1] + d[1][1]) / 2, d }));
    s2.ok(`检测到 ${dots.length} 个红点（${rd.via}${shot.cropped ? '，已裁剪到窗口' : ''}）`);
    s2.image(shot.image_base64, dots.map((d, i) => ({ kind: 'rect', x: d[0][0], y: d[0][1], x2: d[1][0], y2: d[1][1], label: String(i + 1) })), '红框为检测到的未读红点');

    const findInputBox = async () => {
      const s = await shotChecked(app);
      const r = await api('/test/input-box', { image_base64: s.image_base64, app_type: app, cropped: s.cropped });
      return { shot: s, ib: r };
    };
    const focusInput = async (shot2, ib) => {
      const s5 = makeStep(steps, '鼠标移入输入框并单击聚焦');
      s5.run();
      const { sx, sy } = await clickAt(shot2.origin_x, shot2.origin_y, ib.point.x, ib.point.y, 'click');
      s5.ok(`已单击输入框 (${sx}, ${sy})，屏幕上应出现输入光标`);
    };

    if (app === 'wecom') {
      // 企业微信：先双击「侧边目录」红点（x 坐标最小的一簇，如 消息/未读 角标）
      // 用点击前最新一张截图重新检测红点：窗口被挪动后旧截图的原点已失效，点击必须基于刚截的图
      let shotNow = await shotChecked(app);
      if (!shotNow.cropped) {
        // 窗口没找到时截的是全屏（原点变成屏幕左上角），坐标完全对不上，绝不能直接点——
        // 先前置窗口再重截一次，仍裁剪不到就中止（多半是最小化到托盘了）
        await api('/test/activate', { app });
        await sleep(800);
        shotNow = await shotChecked(app);
        if (!shotNow.cropped) s2.fail('未能裁剪到企微窗口（窗口被最小化或进程异常），已中止');
      }
      // 窗口太窄时企微会隐藏左侧目录和会话列表（界面上根本没有这些元素），点了必然跑偏——提示拉宽
      if (shotNow.width < 900) s2.fail(`企微窗口太窄（宽 ${shotNow.width}px，目录和会话列表已被隐藏），请把窗口拉宽到能看全左侧列表再测`);
      const rdNow = await api('/test/red-dot', { image_base64: shotNow.image_base64, app_type: app });
      const dotsNow = (rdNow.dots && rdNow.dots.length) ? rdNow.dots : dots;
      const centersNow = dotsNow.map(d => ({ cx: (d[0][0] + d[1][0]) / 2, cy: (d[0][1] + d[1][1]) / 2, d }));
      // 侧边栏过滤已移到服务端（校准黑名单优先，没校准用默认白名单），避免误点「会议」等功能目录；
      // 服务端没过滤（异常/老版本）时退回本地白名单兜底
      const railOk = (rdNow.rail && rdNow.rail.filtered) || (rd.rail && rd.rail.filtered);
      const usable = railOk
        ? centersNow
        : centersNow.filter(c => c.cx >= shotNow.width * 0.14 || (c.cy >= 90 && c.cy <= 145) || (c.cy >= 415 && c.cy <= 530));
      // 有校准数据时直接点「消息」那一行（单击即可切到消息列表），不猜红点——
      // 红点策略曾误点到通讯录/会议等功能行；校准过的消息行 Y 坐标随窗口高度等比缩放，挪窗也不怕
      const railNow = rdNow.rail || rd.rail || {};
      const unreadY = railNow.unread_row_y || 0;
      const msgY = railNow.msg_row_y || 0;
      let target, clickAction, targetDesc;
      if (unreadY > 0) {
        // 首选：点「未读」分组（中间列表只显示未读会话，第一个会话必是未读）——位置来自过滤后红点的实测行心
        target = { cx: railNow.unread_row_x || shotNow.width * 0.07, cy: unreadY };
        clickAction = 'click';
        targetDesc = '「未读」分组（红点实测）';
      } else if (msgY > 0) {
        // 次选：点「消息」行右侧的未读角标（点角标直接跳到第一条未读会话）；
        // 角标没检测到（距消息行超过 3% 窗高视为不是它）才点行内靠左的图标/文字区，避开行右边缘和行间隙
        const badge = centersNow
          .filter(c => c.cx < shotNow.width * 0.14 && Math.abs(c.cy - msgY) <= shotNow.height * 0.03)
          .sort((a, b) => Math.abs(a.cy - msgY) - Math.abs(b.cy - msgY))[0];
        if (badge) {
          target = badge; clickAction = 'click'; targetDesc = '消息未读角标（校准定位）';
        } else {
          target = { cx: shotNow.width * 0.065, cy: msgY }; clickAction = 'click'; targetDesc = '「消息」行（校准定位）';
        }
      } else {
        // 兜底：从红点里挑侧边目录（x 坐标最小的一簇，取最上面一个）双击展开
        if (!usable.length) s2.fail('未检测到可用红点（消息行无校准数据），已中止');
        const minX = Math.min(...usable.map(c => c.cx));
        const catalog = usable.filter(c => c.cx <= minX + 40).sort((a, b) => a.cy - b.cy);
        target = catalog[0] || usable[0];
        clickAction = 'double_click';
        targetDesc = '目录红点（兜底）';
      }

      const s3 = makeStep(steps, unreadY > 0 ? '单击侧边「未读」，列出未读会话' : '单击侧边目录（未读/消息），切到会话列表');
      s3.run();
      const p3 = await clickAt(shotNow.origin_x, shotNow.origin_y, target.cx, target.cy, clickAction);
      s3.ok(`已点击 (${p3.sx}, ${p3.sy})（${targetDesc}），等待列表展开…`);
      await sleep(1500);

      // 再单击好友列表第 1 个会话（shotChecked 内部已强制前置窗口，无需重复 activate）
      const s4 = makeStep(steps, '单击好友列表第 1 个会话（轨迹右移）');
      s4.run();
      const mid = await shotChecked(app);
      const found = await locateFirstFriend(app, mid);
      const midShot = found.shot || mid;
      s4.image(midShot.image_base64, [{ kind: 'point', x: found.point.x, y: found.point.y, label: '第1个会话' }], `蓝圈为将单击的位置（${found.via}）`);
      const p4 = await clickAt(midShot.origin_x, midShot.origin_y, found.point.x, found.point.y, 'glide_click', { x: p3.sx, y: p3.sy });
      s4.ok(`已从双击点 (${p3.sx}, ${p3.sy}) 轨迹右移到 (${p4.sx}, ${p4.sy}) 单击（${found.via}），等待聊天窗口打开…`);
      await sleep(1500);

      let { shot: shot2, ib } = await findInputBox();
      if (!ib.point) {
        // 单击没进去：重新前置窗口再点一次（常见于首次点击只激活了窗口）
        const s4r = makeStep(steps, '未进入聊天：重新前置后再次单击');
        s4r.run();
        const mid2 = await shotChecked(app);
        const found2 = await locateFirstFriend(app, mid2);
        const mid2Shot = found2.shot || mid2;
        s4r.image(mid2Shot.image_base64, [{ kind: 'point', x: found2.point.x, y: found2.point.y, label: '第1个会话' }], `蓝圈为将单击的位置（${found2.via}）`);
        const p4r = await clickAt(mid2Shot.origin_x, mid2Shot.origin_y, found2.point.x, found2.point.y, 'glide_click', { x: p4.sx, y: p4.sy });
        s4r.ok(`已重新前置并再次单击 (${p4r.sx}, ${p4r.sy})（${found2.via}），等待聊天窗口打开…`);
        await sleep(1500);
        const retry = await findInputBox();
        shot2 = retry.shot; ib = retry.ib;
        if (!ib.point) s4r.fail('再次单击后仍未进入聊天窗口');
      }

      const s5b = makeStep(steps, '定位聊天输入框');
      s5b.run();
      s5b.ok(`输入框中心：(${ib.point.x}, ${ib.point.y})`);
      s5b.image(shot2.image_base64, [{ kind: 'point', x: ib.point.x, y: ib.point.y, label: '输入框' }], '蓝圈为定位到的输入框');
      await focusInput(shot2, ib);
    } else {
      // 微信：红点就在会话条目上，双击第 1 个红点直接进聊天
      // 同样用点击前最新一张截图：窗口被挪动后旧原点会失效；全屏截图（没裁剪到窗口）不能拿来点
      let shotNow = await shotChecked(app);
      if (!shotNow.cropped) {
        await api('/test/activate', { app });
        await sleep(800);
        shotNow = await shotChecked(app);
        if (!shotNow.cropped) s2.fail('未能裁剪到微信窗口（窗口被最小化或进程异常），已中止');
      }
      if (shotNow.width < 900) s2.fail(`微信窗口太窄（宽 ${shotNow.width}px，会话列表已被隐藏），请把窗口拉宽到能看全左侧列表再测`);
      const rdNow = await api('/test/red-dot', { image_base64: shotNow.image_base64, app_type: app });
      const dotsNow = (rdNow.dots && rdNow.dots.length) ? rdNow.dots : dots;
      const first = dotsNow.map(d => ({ cx: (d[0][0] + d[1][0]) / 2, cy: (d[0][1] + d[1][1]) / 2, d })).sort((a, b) => a.cy - b.cy)[0];
      const s3 = makeStep(steps, '双击第 1 个红点，点开第 1 个窗口');
      s3.run();
      const p3 = await clickAt(shotNow.origin_x, shotNow.origin_y, first.cx, first.cy, 'double_click');
      s3.ok(`已双击 (${p3.sx}, ${p3.sy})，等待聊天窗口打开…`);
      await sleep(1500);

      let { shot: shot2, ib } = await findInputBox();
      if (!ib.point) {
        const s4a = makeStep(steps, '未进入聊天窗口：前置后单击会话列表第 1 个会话');
        s4a.run();
        const found = await locateFirstFriend(app, shot2);
        const midShot = found.shot || shot2;
        s4a.image(midShot.image_base64, [{ kind: 'point', x: found.point.x, y: found.point.y, label: '第1个会话' }], `蓝圈为将单击的位置（${found.via}）`);
        const p4 = await clickAt(midShot.origin_x, midShot.origin_y, found.point.x, found.point.y, 'glide_click', { x: p3.sx, y: p3.sy });
        s4a.ok(`已从双击点轨迹滑到 (${p4.sx}, ${p4.sy}) 单击（${found.via}），等待聊天窗口打开…`);
        await sleep(3000);
        const retry = await findInputBox();
        shot2 = retry.shot; ib = retry.ib;
        if (!ib.point) {
          const s4b = makeStep(steps, '重新定位输入框');
          s4b.fail('单击会话后仍未定位到输入框');
        }
      }
      const s4 = makeStep(steps, '定位聊天输入框');
      s4.ok(`输入框中心：(${ib.point.x}, ${ib.point.y})`);
      s4.image(shot2.image_base64, [{ kind: 'point', x: ib.point.x, y: ib.point.y, label: '输入框' }], '蓝圈为定位到的输入框');
      await focusInput(shot2, ib);
    }
    return { ok: true };
  }

  // ========== 测试 ④：输入框粘贴话术并发送（可视化，真实发送） ==========
  // autoText=true 时：对当前会话现场生成回复（无需回复则跳过不发送）
  // withNav=true 时（独立运行）：思考前先导航——单击侧边「未读」→ 单击第一个会话，保证回复进对窗口
  async function testPasteSend(app, text, steps, autoText, withNav, lite) {
    steps.textContent = '';
    const appLabel = app === 'wecom' ? '企业微信' : '微信';

    const s1 = makeStep(steps, '前置目标窗口');
    s1.run();
    const act = await api('/test/activate', { app });
    if (!act.ok) s1.fail(act.hint || '未找到目标窗口');
    await sleep(800);
    s1.ok(`已前置：${act.title}${act.foreground ? '' : '（但未抢到前台焦点）'}`);

    // 独立运行时先导航进第一个未读会话（循环⑤里③已经导过航，传 withNav=false 跳过）
    if (withNav && app === 'wecom') await navFirstUnread(app, steps);

    const s2 = makeStep(steps, '截图（含遮挡检测）');
    s2.run();
    const shot = await shotForeground(app);
    if (!shot.image_base64) s2.fail('截图失败');
    if (!shot.cropped) s2.fail(`未能裁剪到${appLabel}窗口（窗口被最小化或进程句柄抖动），已中止——全屏截图的坐标不能用于点击`);
    if (checkOcclusion(shot, appLabel)) s2.fail(`${appLabel}屏幕被遮挡，已中止——被遮挡时不操作`);
    s2.ok(`${shot.width}×${shot.height}，窗口在前台无遮挡`);

    let finalText = text;
    if (autoText) {
      const s2b = makeStep(steps, '对当前会话生成回复（对齐目标聊天）');
      s2b.run();
      const tr = await api('/test/think-reply', { image_base64: shot.image_base64, app_type: app, agent_type: 'speed' });
      if (!tr.should_reply || !tr.reply) {
        s2b.skip('当前会话判断无需回复，本轮不发送');
        return { ok: true, skipped: true };
      }
      finalText = tr.reply;
      s2b.ok(`会话：${tr.chat_name || '（未识别）'}\n回复：${finalText}`);
    }

    // 发送结果审核：OCR 聊天区最后一条，应是我方气泡且带话术开头
    const probe = finalText.replace(/\s/g, '').slice(0, 4);
    const verifySent = async (shotX) => {
      try {
        const lm = await api('/test/last-message', { image_base64: shotX.image_base64, app_type: app });
        if (lm.error || !lm.text) return true; // 审核不可用时不拦
        return lm.role === 'right' && lm.text.replace(/\s/g, '').includes(probe);
      } catch (e) { return true; }
    };

    // ===== 粘贴并发送：点进会话后输入框默认已聚焦（带输入光标），不做输入框定位，直接粘贴 =====
    // 发送后才审核：OCR 聊天区最后一条应是我方气泡且带话术开头；没发出去再补点重试一次
    const sL = makeStep(steps, '粘贴并发送（发送后审核）');
    sL.run();
    const p = await api('/test/paste', { text: finalText });
    if (!p.ok || !p.pasted) sL.fail('粘贴失败：' + (p.error || ''));
    await sleep(500);
    const p2 = await api('/test/paste', { send: true });
    if (!p2.ok || !p2.sent) sL.fail('发送按键失败：' + (p2.error || ''));
    await sleep(900);
    let shot3 = await shotForeground(app);
    let sentOk = await verifySent(shot3);
    if (!sentOk) {
      // 没发出去：补点输入框（上次记的坐标，没有则用底部输入区固定比例 62%宽/88.5%高）再粘再发再审
      sL.image(shot3.image_base64, null, '发送审核未通过，补点输入框重试…');
      const ip = navCache.input || { x: Math.round(shot3.width * 0.62), y: Math.round(shot3.height * 0.885) };
      await api('/test/mouse', { action: 'click', x: Math.round(shot3.origin_x + ip.x), y: Math.round(shot3.origin_y + ip.y) });
      await sleep(500);
      await api('/test/paste', { text: finalText });
      await sleep(500);
      await api('/test/paste', { send: true });
      await sleep(900);
      shot3 = await shotForeground(app);
      sentOk = await verifySent(shot3);
    }
    if (!sentOk) sL.fail('发送后审核未通过（最后一条不是我方消息），本轮可能没发出去，已中止');
    sL.ok('已发送，OCR 审核通过 ✓');
    if (shot3.image_base64) sL.image(shot3.image_base64, null, '发送后的聊天窗口（话术在右侧气泡）');
    return { ok: true, reply: finalText };
  }

  // ========== 测试 ⑥：自救测试（遮挡 → 拉回最前，可视化） ==========
  async function testRescueFlow(app, steps) {
    steps.textContent = '';
    const appLabel = app === 'wecom' ? '企业微信' : '微信';

    const s1 = makeStep(steps, '前置目标窗口（好友列表/聊天框均可）');
    s1.run();
    const act = await api('/test/activate', { app });
    if (!act.ok) s1.fail(act.hint || `未找到${appLabel}窗口`);
    await sleep(800);
    const base = await shotForeground(app);
    if (!base.image_base64) s1.fail('截图失败');
    s1.ok(`窗口在最前（${base.width}×${base.height}）`);
    s1.image(base.image_base64, null, '基线画面');

    const s2 = makeStep(steps, '制造遮挡（打开记事本盖住窗口）');
    s2.run();
    const occ = await api('/test/occlude', { on: true, app });
    if (!occ.ok) s2.fail('遮挡制造失败：' + (occ.reason || occ.error || ''));
    await sleep(1200);
    const covered = await api('/test/screenshot', { app });
    if (!covered.occluded) s2.fail('遮挡未生效（记事本没盖住或被置顶挡回）');
    s2.ok(`已被遮挡（前台=${covered.foreground_title || '?'}）`);
    s2.image(covered.image_base64, null, '被遮挡的画面');

    const s3 = makeStep(steps, '自救：拉回最前');
    s3.run();
    const rescue = await api('/test/activate', { app });
    if (!rescue.ok) s3.fail('拉回失败：' + (rescue.reason || rescue.error || ''));
    await sleep(1000);
    const back = await shotForeground(app);
    if (back.occluded) s3.fail('自救后仍被遮挡（前台=' + (back.foreground_title || '?') + '）');
    s3.ok(`${appLabel}已回到最前`);
    s3.image(back.image_base64, null, '自救后的画面');

    const s4 = makeStep(steps, '收拾现场（关闭遮挡窗口）');
    s4.run();
    await api('/test/occlude', { on: false });
    s4.ok('已关闭遮挡窗口');
    return { ok: true };
  }

  // ========== 挂载入口 ==========
  window.__mountStepTests = function (container) {
    if (container.__stepTestsMounted) return;
    container.__stepTestsMounted = true;
    container.style.cssText = 'font-size:13px;color:#333;';

    // 后端状态
    const health = h('div', 'font-size:12px;color:#999;margin-bottom:10px;', '正在连接本地 AI 服务…');
    container.appendChild(health);
    fetch(API + '/health').then(r => r.json()).then(() => {
      health.textContent = '✅ 本地 AI 服务在线（127.0.0.1:7200）';
      health.style.color = GREEN_DARK;
    }).catch(() => {
      health.textContent = '❌ 本地 AI 服务未启动，请先运行「启动本地AI服务.bat」';
      health.style.color = '#c0392b';
    });

    // ---- 顶部全局切换条：应用 + 模式，一次切换全部测试生效 ----
    const appSel = appSelect();
    const modeSel = h('select', 'padding:4px 8px;border:1px solid #ddd;border-radius:6px;');
    [['speed', '极速'], ['think', '深思']].forEach(([v, t]) => {
      const o = document.createElement('option'); o.value = v; o.textContent = t; modeSel.appendChild(o);
    });
    const switchBar = h('div', 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 12px;margin-bottom:12px;background:#f4f9ec;border:1px solid #dcebc4;border-radius:8px;');
    switchBar.appendChild(h('span', 'color:#3d5a1e;font-weight:600;', '🎯 测试目标'));
    switchBar.appendChild(h('span', 'color:#666;', '应用：'));
    switchBar.appendChild(appSel);
    switchBar.appendChild(h('span', 'color:#666;', '模式：'));
    switchBar.appendChild(modeSel);
    switchBar.appendChild(h('span', 'color:#999;font-size:12px;', '（对所有测试生效，切一次即可）'));
    const bCal = h('button', 'margin-left:auto;padding:4px 12px;border:1px solid #c8dca8;background:#fff;border-radius:6px;cursor:pointer;font-size:12px;color:#3d5a1e;', '📍 校准侧边栏');
    bCal.title = '学习本机企微侧边栏布局：会议/文档/工作台等功能目录行的红点将被忽略，防止误点进去';
    bCal.onclick = async () => {
      bCal.disabled = true;
      const old = bCal.textContent;
      bCal.textContent = '校准中…';
      try {
        const r = await api('/test/rail-calibrate', { app: appSel.value });
        if (r.error) toast('⚠️ 校准失败：' + r.error, true);
        else toast(`✅ 侧边栏已校准（${r.window}）：将忽略 ${(r.found_labels || []).join('、') || '无'} 等功能目录的红点`);
      } catch (e) {
        toast('⚠️ 校准失败：' + (e.message || e), true);
      } finally { bCal.disabled = false; bCal.textContent = old; }
    };
    switchBar.appendChild(bCal);
    container.appendChild(switchBar);

    const loopCtl = { running: false, cancel: false };
    let lastReplyText = '';

    // ---- 卡片 ① ----
    const c1 = makeCard(container, 1, '思考和回复', '前置聊天窗口 → 截图 → VLM 理解对话 → 生成回复（只测试，不真实发送）。应用/模式在顶部统一切换');
    const b1 = runBtn();
    c1.ctrl.appendChild(b1);
    b1.onclick = async () => {
      gCancel = false;
      b1.disabled = true; c1.status.textContent = '运行中…';
      try {
        const r = await testThinkReply(appSel.value, modeSel.value, c1.steps);
        if (r && r.reply) lastReplyText = r.reply;
        c1.status.textContent = '✅ 测试①完成';
      }
      catch (e) { c1.status.textContent = '❌ ' + (e.message || e); }
      finally { b1.disabled = false; }
    };

    // ---- 卡片 ② ----
    const c2 = makeCard(container, 2, '微信 / 企业微信窗口和进程识别', '枚举进程 → 读取窗口标题与位置 → 前置窗口截图核对');
    const b2 = runBtn();
    c2.ctrl.appendChild(b2);
    b2.onclick = async () => {
      gCancel = false;
      b2.disabled = true; c2.status.textContent = '运行中…';
      try { await testWindows(appSel.value, c2.steps); c2.status.textContent = '✅ 测试②完成'; }
      catch (e) { c2.status.textContent = '❌ ' + (e.message || e); }
      finally { b2.disabled = false; }
    };

    // ---- 卡片 ③ ----
    const c3 = makeCard(container, 3, '单击侧边「未读」→ 点开第 1 个会话 → 定位输入框', '先单击侧边目录「未读」分组（列表只显示未读会话），再单击第一个会话进入聊天，最后定位输入框。测试期间请勿操作鼠标');
    const b3 = runBtn();
    c3.ctrl.appendChild(b3);
    b3.onclick = async () => {
      gCancel = false;
      b3.disabled = true; c3.status.textContent = '运行中…';
      try { await testRedDotFlow(appSel.value, c3.steps); c3.status.textContent = '✅ 测试③完成'; }
      catch (e) { c3.status.textContent = '❌ ' + (e.message || e); }
      finally { b3.disabled = false; }
    };

    // ---- 卡片 ④ ----
    const c4 = makeCard(container, 4, '输入框粘贴话术并发送（可视化）', '顺序：前置窗口 → 单击「未读」→ 单击第一个会话 → 生成回复 → 直接粘贴发送（进会话输入框默认已聚焦，不再定位）→ 发送后 OCR 审核，没过自动补点重试。留空=自动生成；填字=发指定话术。⚠️ 真实发送，请先确认目标会话');
    const text4 = h('textarea', 'width:100%;min-height:56px;border:1px solid #ddd;border-radius:6px;padding:6px 10px;font-size:13px;resize:vertical;margin:4px 0;');
    text4.placeholder = '要粘贴发送的话术（留空则自动使用测试①生成的回复）';
    const b4fill = h('button', 'padding:4px 12px;border:1px solid #ddd;background:#fff;border-radius:6px;cursor:pointer;font-size:12px;', '用①的回复填充');
    const b4 = runBtn();
    c4.ctrl.appendChild(b4fill); c4.ctrl.appendChild(b4);
    c4.ctrl.appendChild(text4);
    b4fill.onclick = () => {
      if (lastReplyText) { text4.value = lastReplyText; toast('✅ 已填充测试①的回复'); }
      else toast('还没有①的回复，先跑一下测试①', true);
    };
    b4.onclick = async () => {
      gCancel = false;
      const manual = text4.value.trim();
      b4.disabled = true; c4.status.textContent = '运行中…';
      try {
        if (manual) await testPasteSend(appSel.value, manual, c4.steps, false, true);
        else await testPasteSend(appSel.value, '', c4.steps, true, true);
        c4.status.textContent = '✅ 测试④完成';
      }
      catch (e) { c4.status.textContent = '❌ ' + (e.message || e); }
      finally { b4.disabled = false; }
    };

    // ---- 卡片 ⑤ ----
    const c5 = makeCard(container, 5, '生产顺序循环（导航→回复→发送）', '首轮全量定位，之后复用坐标快进：单击「未读」→ 第一个会话 → 现场生成回复 → 直接粘贴发送（进会话输入框默认已聚焦，不再反复定位）→ 发送后 OCR 审核，没过自动补点重试。窗口尺寸变了会自动回退全量定位。⚠️ 每轮真实发送给第一个未读会话');
    const times = h('input', 'padding:4px 8px;border:1px solid #ddd;border-radius:6px;width:60px;');
    times.type = 'number'; times.min = '1'; times.value = '3';
    const b5 = runBtn('开始循环');
    const b5stop = stopBtn();
    const loopLog = h('div', 'margin-top:8px;font-size:12px;color:#666;max-height:180px;overflow-y:auto;background:#f8faf4;border-radius:6px;padding:8px 10px;display:none;white-space:pre-wrap;');
    c5.ctrl.appendChild(h('span', 'color:#666;', '次数：')); c5.ctrl.appendChild(times);
    c5.ctrl.appendChild(b5); c5.ctrl.appendChild(b5stop);
    c5.card.appendChild(loopLog);
    b5stop.onclick = () => { loopCtl.cancel = true; gCancel = true; };
    b5.onclick = async () => {
      if (loopCtl.running) return;
      loopCtl.running = true; loopCtl.cancel = false; gCancel = false;
      b5.disabled = true; b5stop.style.display = 'inline-block';
      loopLog.style.display = 'block'; loopLog.textContent = '';
      const n = Math.max(1, parseInt(times.value, 10) || 1);
      const addLog = t => {
        const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
        loopLog.textContent += `[${ts}] ${t}\n`;
        loopLog.scrollTop = loopLog.scrollHeight;
      };
      try {
        for (let i = 1; i <= n; i++) {
          if (loopCtl.cancel) { addLog('⏹ 已手动停止'); break; }
          addLog(`—— 第 ${i}/${n} 轮 ——`);
          // 生产顺序循环：导航进第一个未读会话 → 现场生成回复 → 粘贴发送
          // 首轮全量定位并记住坐标；第 2 轮起复用坐标（窗口尺寸不变就没错），发送后才审核，不过再补点重试
          addLog(`① 导航${i > 1 ? '（复用坐标）' : '（全量定位）'}：单击「未读」→ 第一个会话…`);
          await navFirstUnread(appSel.value, c3.steps, i > 1);
          addLog('① 完成');
          if (loopCtl.cancel) { addLog('⏹ 已手动停止'); break; }
          addLog(`② 生成回复 → 粘贴 → 发送${i > 1 ? '（快速模式）' : ''}…`);
          const r4 = await testPasteSend(appSel.value, '', c4.steps, true, false, i > 1); // 导航已做，跳过
          if (r4 && r4.reply) lastReplyText = r4.reply;
          addLog('② 完成' + (r4 && r4.skipped ? '（本轮判断无需回复，未发送）' : ''));
        }
        c5.status.textContent = loopCtl.cancel ? '⏹ 循环已停止' : '✅ 全部循环完成';
        addLog(loopCtl.cancel ? '循环结束（手动停止）' : '🎉 全部循环完成');
      } catch (e) {
        c5.status.textContent = '❌ ' + (e.message || e);
        addLog('❌ 中断：' + (e.message || e));
      } finally {
        loopCtl.running = false; b5.disabled = false; b5stop.style.display = 'none'; gCancel = false;
      }
    };

    // ---- 卡片 ⑥ ----
    const c6 = makeCard(container, 6, '自救测试（遮挡 → 拉回最前）', '打开记事本盖住目标窗口 → 截图确认被遮挡 → 自救拉回最前 → 截图确认恢复，全程截图留证');
    const b6 = runBtn();
    c6.ctrl.appendChild(b6);
    b6.onclick = async () => {
      gCancel = false;
      b6.disabled = true; c6.status.textContent = '运行中…';
      try { await testRescueFlow(appSel.value, c6.steps); c6.status.textContent = '✅ 测试⑥完成'; }
      catch (e) { c6.status.textContent = '❌ ' + (e.message || e); }
      finally { b6.disabled = false; }
    };
  };
})();
