/* 聊机·内置聊天记录分析面板（注入 renderer，CSP: script-src 'self' 允许）
   入口：window.__openChatAnalysis()（聊天历史页「📊 聊天记录分析」按钮调用）
   数据：window.electron.invoke('GET_CHAT_RECORDS') 分钟级分页拉取
   AI：经本地分析服务 http://127.0.0.1:7100/api/chat 代理（key 不出本机） */
(function () {
  'use strict';
  if (window.__openChatAnalysis) return;

  const API = 'http://127.0.0.1:7100';
  let overlay = null;
  let records = [];
  let matched = []; // 意图筛选命中的记录

  function h(tag, style, text) {
    const el = document.createElement(tag);
    if (style) el.style.cssText = style;
    if (text !== undefined) el.textContent = text;
    return el;
  }
  function fmt(d) {
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  function fmtInput(d) { return fmt(d).replace(' ', 'T'); }

  // ---- 轻量图表（canvas 手绘，零依赖） ----
  function setupCanvas(cv, wCss, hCss) {
    const dpr = window.devicePixelRatio || 1;
    cv.width = wCss * dpr; cv.height = hCss * dpr;
    cv.style.width = wCss + 'px'; cv.style.height = hCss + 'px';
    const ctx = cv.getContext('2d');
    ctx.scale(dpr, dpr);
    return ctx;
  }
  // 走势柱状图：两系列（客户消息 / 我方回复）
  function drawTrend(cv, buckets) {
    const W = 360, H = 190, padL = 34, padB = 30, padT = 12;
    const ctx = setupCanvas(cv, W, H);
    ctx.clearRect(0, 0, W, H);
    if (!buckets.length) { ctx.fillStyle = '#999'; ctx.font = '12px sans-serif'; ctx.fillText('该时段无数据', padL + 10, H / 2); return; }
    const max = Math.max(1, ...buckets.map(b => Math.max(b.cust, b.agent)));
    const n = buckets.length, slot = (W - padL - 10) / n;
    const bw = Math.max(3, Math.min(14, slot / 2 - 2));
    ctx.strokeStyle = '#dfe8d4'; ctx.beginPath(); ctx.moveTo(padL, padT); ctx.lineTo(padL, H - padB); ctx.lineTo(W - 8, H - padB); ctx.stroke();
    ctx.fillStyle = '#9aa98c'; ctx.font = '10px sans-serif';
    ctx.fillText(String(max), 4, padT + 9);
    ctx.fillText('0', 8, H - padB + 3);
    buckets.forEach((b, i) => {
      const x = padL + i * slot + slot / 2;
      const hC = Math.round((H - padB - padT) * b.cust / max);
      const hA = Math.round((H - padB - padT) * b.agent / max);
      ctx.fillStyle = '#f0b429';
      if (hC > 0) ctx.fillRect(x - bw - 1, H - padB - hC, bw, hC);
      ctx.fillStyle = '#8bc34a';
      if (hA > 0) ctx.fillRect(x + 1, H - padB - hA, bw, hA);
    });
    ctx.fillStyle = '#7c8a6d'; ctx.font = '10px sans-serif';
    const step = Math.ceil(n / 6);
    buckets.forEach((b, i) => {
      if (i % step !== 0) return;
      const x = padL + i * slot + slot / 2;
      ctx.fillText(b.label, Math.min(x - 14, W - 34), H - padB + 14);
    });
  }
  // 饼图 + 右侧图例
  function drawPie(cv, parts) {
    const W = 300, H = 170;
    const ctx = setupCanvas(cv, W, H);
    ctx.clearRect(0, 0, W, H);
    const total = parts.reduce((s, p) => s + p.value, 0);
    if (!total) { ctx.fillStyle = '#999'; ctx.font = '12px sans-serif'; ctx.fillText('无数据', 20, H / 2); return; }
    const cx = 80, cy = H / 2, r = 62;
    let a0 = -Math.PI / 2;
    for (const p of parts) {
      const a1 = a0 + Math.PI * 2 * p.value / total;
      ctx.beginPath(); ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, r, a0, a1); ctx.closePath();
      ctx.fillStyle = p.color; ctx.fill();
      a0 = a1;
    }
    ctx.beginPath(); ctx.arc(cx, cy, r * 0.55, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill();
    ctx.fillStyle = '#4a7a28'; ctx.font = 'bold 13px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(String(total), cx, cy + 5); ctx.textAlign = 'left';
    parts.forEach((p, i) => {
      const y = 34 + i * 26;
      ctx.fillStyle = p.color; ctx.fillRect(160, y - 9, 12, 12);
      ctx.fillStyle = '#555'; ctx.font = '12px sans-serif';
      ctx.fillText(`${p.label} ${p.value}（${Math.round(p.value / total * 100)}%）`, 178, y + 1);
    });
  }
  // 横向条形图（Top 活跃会话）
  function drawHBars(cv, items) {
    const W = 300, H = 170;
    const ctx = setupCanvas(cv, W, H);
    ctx.clearRect(0, 0, W, H);
    if (!items.length) { ctx.fillStyle = '#999'; ctx.font = '12px sans-serif'; ctx.fillText('无数据', 20, H / 2); return; }
    const max = Math.max(1, ...items.map(i => i.value));
    const rowH = Math.min(26, (H - 14) / items.length);
    items.forEach((it, i) => {
      const y = 10 + i * rowH;
      const bw = Math.round((W - 150) * it.value / max);
      ctx.fillStyle = '#666'; ctx.font = '11px sans-serif';
      const name = it.label.length > 9 ? it.label.slice(0, 9) + '…' : it.label;
      ctx.fillText(name, 2, y + rowH / 2 + 3);
      ctx.fillStyle = '#8bc34a';
      ctx.fillRect(96, y + 3, Math.max(2, bw), rowH - 8);
      ctx.fillStyle = '#5c8a2e'; ctx.font = 'bold 11px sans-serif';
      ctx.fillText(String(it.value), 96 + Math.max(2, bw) + 4, y + rowH / 2 + 3);
    });
  }

  async function llm(provider, messages, maxTokens) {
    const r = await fetch(API + '/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, messages, max_tokens: maxTokens || 1500 })
    });
    const j = await r.json();
    if (!r.ok || j.error) throw new Error(j.error || ('HTTP ' + r.status));
    return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
  }

  async function loadRecords(start, end, onProgress) {
    const all = [];
    let page = 1;
    for (;;) {
      const resp = await window.electron.invoke('GET_CHAT_RECORDS', {
        chat_type: '', chat_name: '', date_start: start, date_end: end, page, page_size: 200
      });
      const body = resp && (resp.body || {});
      const items = body.items || [];
      all.push(...items);
      onProgress && onProgress(all.length, body.total);
      if (!items.length || all.length >= (body.total || 0) || items.length < 200) break;
      page++;
      if (page > 200) break; // 安全上限 4 万条
    }
    return all;
  }

  function batch(arr, n) {
    const out = [];
    for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
    return out;
  }
  function lineOf(r) {
    return `[${r.created_at}] ${r.chat_type === '群聊' ? '[群]' : ''}${r.nickname || r.target_name}: ${r.content}`;
  }

  function buildUI() {
    overlay = h('div', 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:99999;display:flex;align-items:center;justify-content:center;');
    const panel = h('div', 'background:#fff;width:860px;max-width:94vw;height:88vh;border-radius:12px;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 12px 40px rgba(0,0,0,.25);font-size:13px;color:#333;');

    // 头部
    const head = h('div', 'display:flex;align-items:center;padding:12px 18px;border-bottom:1px solid #eee;background:#f6faf1;');
    head.appendChild(h('div', 'font-size:16px;font-weight:600;flex:1;color:#4a7a28;', '📊 聊天记录分析'));
    const closeBtn = h('button', 'border:none;background:none;font-size:20px;cursor:pointer;color:#999;', '✕');
    closeBtn.onclick = () => overlay.remove();
    head.appendChild(closeBtn);
    panel.appendChild(head);

    // 时间选择区
    const timeBar = h('div', 'display:flex;align-items:center;gap:8px;padding:12px 18px;border-bottom:1px solid #f0f0f0;flex-wrap:wrap;');
    timeBar.appendChild(h('span', 'color:#666;', '时间范围：'));
    const startInput = h('input'); startInput.type = 'datetime-local';
    const endInput = h('input'); endInput.type = 'datetime-local';
    endInput.value = fmtInput(new Date()); // 截止默认当前北京时间
    startInput.value = fmtInput(new Date(Date.now() - 24 * 3600 * 1000));
    const presets = [['1小时', 3600e3], ['24小时', 24 * 3600e3], ['一周', 7 * 86400e3]];
    const presetBtns = [];
    function markPreset(idx) {
      presetBtns.forEach((bb, i) => {
        bb.style.cssText = i === idx
          ? 'padding:4px 14px;border:1px solid #8bc34a;background:#8bc34a;color:#fff;border-radius:14px;cursor:pointer;font-weight:700;box-shadow:0 1px 4px rgba(92,138,46,.3);'
          : 'padding:4px 14px;border:1px solid #b7d68f;background:#f1f8e9;color:#5c8a2e;border-radius:14px;cursor:pointer;';
      });
    }
    presets.forEach(([label, ms], idx) => {
      const b = h('button', '', label);
      b.onclick = () => { startInput.value = fmtInput(new Date(Date.now() - ms)); endInput.value = fmtInput(new Date()); markPreset(idx); };
      presetBtns.push(b);
      timeBar.appendChild(b);
    });
    markPreset(1); // 默认选中 24小时（与初始时间一致）
    startInput.onchange = endInput.onchange = () => markPreset(-1); // 手动改时间则取消选中态
    startInput.style.cssText = endInput.style.cssText = 'padding:4px 8px;border:1px solid #ddd;border-radius:6px;';
    timeBar.appendChild(startInput);
    timeBar.appendChild(h('span', '', '至'));
    timeBar.appendChild(endInput);
    const loadBtn = h('button', 'padding:5px 18px;border:none;background:#8bc34a;color:#fff;border-radius:6px;cursor:pointer;font-weight:600;', '加载记录');
    timeBar.appendChild(loadBtn);
    panel.appendChild(timeBar);

    // 概览区
    const stats = h('div', 'padding:10px 18px;border-bottom:1px solid #f0f0f0;color:#666;min-height:20px;', '请选择时间后点击「加载记录」');
    panel.appendChild(stats);

    // 图表区（加载记录后渲染：走势柱状图 / 类型饼图 / 活跃会话条形图）
    const chartBox = h('div', 'display:none;padding:12px 18px;border-bottom:1px solid #f0f0f0;gap:12px;flex-wrap:wrap;justify-content:space-between;');
    const trendCard = h('div', 'border:1px solid #e8f0dc;border-radius:10px;padding:8px 10px;background:#fff;');
    trendCard.appendChild(h('div', 'font-weight:600;color:#3d5a1e;margin-bottom:4px;font-size:12px;', '消息走势（客户消息=黄 / 我方回复=绿）'));
    const trendCv = h('canvas'); trendCard.appendChild(trendCv);
    const pieCard = h('div', 'border:1px solid #e8f0dc;border-radius:10px;padding:8px 10px;background:#fff;');
    pieCard.appendChild(h('div', 'font-weight:600;color:#3d5a1e;margin-bottom:4px;font-size:12px;', '会话类型占比（环内=总条数）'));
    const pieCv = h('canvas'); pieCard.appendChild(pieCv);
    const topCard = h('div', 'border:1px solid #e8f0dc;border-radius:10px;padding:8px 10px;background:#fff;');
    topCard.appendChild(h('div', 'font-weight:600;color:#3d5a1e;margin-bottom:4px;font-size:12px;', '活跃会话 Top5（条数）'));
    const topCv = h('canvas'); topCard.appendChild(topCv);
    chartBox.appendChild(trendCard); chartBox.appendChild(pieCard); chartBox.appendChild(topCard);
    panel.appendChild(chartBox);

    function renderCharts(recs, startStr, endStr) {
      const t0 = new Date(startStr.replace(' ', 'T')).getTime();
      const t1 = new Date(endStr.replace(' ', 'T')).getTime();
      if (!recs.length || !isFinite(t0) || !isFinite(t1) || t1 <= t0) { chartBox.style.display = 'none'; return; }
      chartBox.style.display = 'flex';
      // 走势分桶：≤36 小时按小时，否则按天
      const hourly = (t1 - t0) <= 36 * 3600e3;
      const buckets = [];
      const bmap = new Map();
      if (hourly) {
        for (let t = t0; t <= t1; t += 3600e3) {
          const d = new Date(t); const key = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}时`;
          const b = { label: key, cust: 0, agent: 0 }; buckets.push(b); bmap.set(key, b);
        }
        for (const r of recs) {
          const d = new Date(String(r.created_at).replace(' ', 'T'));
          const key = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}时`;
          const b = bmap.get(key); if (!b) continue;
          if (r.nickname === 'sf_agent') b.agent++; else b.cust++;
        }
      } else {
        for (let t = t0; t <= t1; t += 86400e3) {
          const d = new Date(t); const key = `${d.getMonth() + 1}/${d.getDate()}`;
          const b = { label: key, cust: 0, agent: 0 }; buckets.push(b); bmap.set(key, b);
        }
        for (const r of recs) {
          const d = new Date(String(r.created_at).replace(' ', 'T'));
          const key = `${d.getMonth() + 1}/${d.getDate()}`;
          const b = bmap.get(key); if (!b) continue;
          if (r.nickname === 'sf_agent') b.agent++; else b.cust++;
        }
      }
      drawTrend(trendCv, buckets);
      // 类型饼图
      const priv = recs.filter(r => r.chat_type === '私聊' || r.chat_type === 'private').length;
      const grp = recs.length - priv;
      drawPie(pieCv, [
        { label: '私聊', value: priv, color: '#8bc34a' },
        { label: '群聊', value: grp, color: '#f0b429' }
      ]);
      // 活跃 Top5
      const byContact = {};
      recs.forEach(r => { const k = r.target_name || r.nickname || '未知'; byContact[k] = (byContact[k] || 0) + 1; });
      drawHBars(topCv, Object.entries(byContact).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([label, value]) => ({ label, value })));
    }

    // 操作区
    const ops = h('div', 'display:flex;align-items:center;gap:8px;padding:10px 18px;border-bottom:1px solid #f0f0f0;flex-wrap:wrap;');
    const providerSel = h('select', 'padding:4px 8px;border:1px solid #ddd;border-radius:6px;');
    [['deepseek', 'DeepSeek'], ['doubao', '豆包']].forEach(([v, t]) => {
      const o = document.createElement('option'); o.value = v; o.textContent = t; providerSel.appendChild(o);
    });
    const sumBtn = h('button', 'padding:5px 16px;border:none;background:#8bc34a;color:#fff;border-radius:6px;cursor:pointer;', '✨ AI 总结');
    ops.appendChild(h('span', 'color:#666;', '模型：'));
    ops.appendChild(providerSel);
    ops.appendChild(sumBtn);
    ops.appendChild(h('span', 'color:#ccc;', '｜'));
    const intentInput = h('input', 'padding:5px 10px;border:1px solid #ddd;border-radius:6px;width:220px;');
    intentInput.placeholder = '意图筛选，如：询价 / 投诉 / 售后';
    const intentBtn = h('button', 'padding:5px 16px;border:1px solid #8bc34a;background:#fff;color:#5c8a2e;border-radius:6px;cursor:pointer;', '🎯 筛选');
    const csvBtn = h('button', 'padding:5px 12px;border:1px solid #ddd;background:#fff;border-radius:6px;cursor:pointer;', '导出CSV');
    ops.appendChild(intentInput);
    ops.appendChild(intentBtn);
    ops.appendChild(csvBtn);
    panel.appendChild(ops);

    // 结果区
    const result = h('div', 'flex:1;overflow-y:auto;padding:14px 18px;line-height:1.8;white-space:pre-wrap;word-break:break-all;');
    panel.appendChild(result);
    overlay.appendChild(panel);

    // ---- 行为 ----
    loadBtn.onclick = async () => {
      if (!startInput.value || !endInput.value) { stats.textContent = '请选择完整时间范围'; return; }
      const start = startInput.value.replace('T', ' ');
      const end = endInput.value.replace('T', ' ');
      loadBtn.disabled = true; loadBtn.textContent = '加载中…';
      try {
        records = await loadRecords(start, end, (n, total) => { stats.textContent = `加载中… ${n}/${total || '?'} 条`; });
        matched = [];
        const priv = records.filter(r => r.chat_type === '私聊' || r.chat_type === 'private').length;
        const grp = records.length - priv;
        const byContact = {};
        records.forEach(r => { const k = r.target_name || r.nickname || '未知'; byContact[k] = (byContact[k] || 0) + 1; });
        const top = Object.entries(byContact).sort((a, b) => b[1] - a[1]).slice(0, 5)
          .map(([k, v]) => `${k}(${v})`).join('、');
        stats.textContent = `✅ ${records.length} 条记录（私聊 ${priv} / 群聊 ${grp}）｜活跃会话 Top5：${top || '无'}`;
        renderCharts(records, start, end);
        result.textContent = records.length ? '记录已加载，可点击「AI 总结」或输入意图筛选。' : '该时间段内没有聊天记录。';
      } catch (e) {
        stats.textContent = '加载失败：' + (e.message || e);
      } finally {
        loadBtn.disabled = false; loadBtn.textContent = '加载记录';
      }
    };

    sumBtn.onclick = async () => {
      if (!records.length) { result.textContent = '请先加载记录'; return; }
      sumBtn.disabled = true;
      result.textContent = 'AI 分析中…';
      try {
        const provider = providerSel.value;
        const batches = batch(records.slice(-3000), 80); // 最多分析最近 3000 条
        const partials = [];
        for (let i = 0; i < batches.length; i++) {
          result.textContent = `AI 分析中… 批次 ${i + 1}/${batches.length}`;
          const text = batches[i].map(lineOf).join('\n');
          partials.push(await llm(provider, [
            { role: 'system', content: '你是客服运营分析助手。根据聊天记录片段，输出：本片段的客户高频问题、客户情绪、值得注意的售后风险点。简洁分点。' },
            { role: 'user', content: text }
          ], 800));
        }
        result.textContent = 'AI 汇总中…';
        const finalText = await llm(provider, [
          { role: 'system', content: '你是客服运营分析助手。把多份分段分析汇总成一份完整报告：整体概况、高频问题 Top、客户情绪分布、客服表现亮点与改进建议。结构清晰。' },
          { role: 'user', content: partials.join('\n\n---\n\n') }
        ], 1500);
        result.textContent = finalText;
      } catch (e) {
        result.textContent = 'AI 分析失败：' + (e.message || e) + '\n（请确认本地分析服务已启动：一键启动会拉起 7100 端口）';
      } finally { sumBtn.disabled = false; }
    };

    intentBtn.onclick = async () => {
      const intent = intentInput.value.trim();
      if (!intent) { result.textContent = '请输入意图描述'; return; }
      if (!records.length) { result.textContent = '请先加载记录'; return; }
      intentBtn.disabled = true;
      matched = [];
      try {
        const provider = providerSel.value;
        const batches = batch(records, 50);
        for (let i = 0; i < batches.length; i++) {
          result.textContent = `意图筛选中… 批次 ${i + 1}/${batches.length}，已命中 ${matched.length} 条`;
          const numbered = batches[i].map((r, k) => `${k}:${lineOf(r)}`).join('\n');
          const text = await llm(provider, [
            { role: 'system', content: `判断每条聊天记录是否属于意图「${intent}」。严格只输出 JSON：{"match":[序号数组]}，没有则 {"match":[]}` },
            { role: 'user', content: numbered }
          ], 400);
          const m = text.match(/\{[\s\S]*\}/);
          const idxs = m ? (JSON.parse(m[0]).match || []) : [];
          idxs.forEach(k => { if (batches[i][k]) matched.push(batches[i][k]); });
        }
        result.textContent = `意图「${intent}」命中 ${matched.length} 条：\n\n` +
          matched.slice(0, 300).map(lineOf).join('\n') +
          (matched.length > 300 ? `\n\n…（其余 ${matched.length - 300} 条可导出 CSV 查看）` : '');
      } catch (e) {
        result.textContent = '筛选失败：' + (e.message || e);
      } finally { intentBtn.disabled = false; }
    };

    csvBtn.onclick = () => {
      const data = matched.length ? matched : records;
      if (!data.length) { result.textContent = '没有可导出的数据'; return; }
      const csv = '﻿' + ['时间,类型,会话,昵称,内容']
        .concat(data.map(r => [r.created_at, r.chat_type, r.target_name, r.nickname,
          String(r.content || '').replace(/"/g, '""')].map(v => `"${v}"`).join(',')))
        .join('\n');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
      a.download = `聊天记录分析_${Date.now()}.csv`;
      a.click();
    };
  }

  window.__openChatAnalysis = function () {
    if (!overlay) buildUI();
    document.body.appendChild(overlay);
  };
})();
