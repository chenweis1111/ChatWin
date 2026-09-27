/* 聊机·聊天记录分析 - 前端逻辑（无任何外部依赖） */
'use strict';

/* ================= 全局状态 ================= */
const state = {
  records: [],          // {idx, type, chat, nick, content, time(Date), timeStr, day, hour}
  fileName: '',
  provider: 'deepseek',
  page: 1,
  pageSize: 50,
  search: '',
  typeFilter: '',
  intentHits: [],       // 意图筛选命中的记录
  running: false
};

const $ = (id) => document.getElementById(id);

/* ================= 工具 ================= */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function pad2(n) { return n < 10 ? '0' + n : '' + n; }
function fmtTime(d) {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
    ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
}
function dayKey(d) {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}
/* 解析 "2026-09-15 23:38:32" 为本地时间，避免 Date 解析兼容问题 */
function parseTime(s) {
  const m = /(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?/.exec(s || '');
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
}

/* ================= XLS(HTML) 解析 ================= */
function parseXlsHtml(text) {
  const doc = new DOMParser().parseFromString(text, 'text/html');
  const table = doc.querySelector('table');
  if (!table) throw new Error('文件中未找到 <table>');
  const rows = table.querySelectorAll('tr');
  const records = [];
  // 找到表头行（含 th 的第一行），确定列位置
  let headerMap = null;
  for (let r = 0; r < rows.length; r++) {
    const cells = rows[r].children;
    if (!headerMap) {
      const headers = Array.from(cells).map(c => c.textContent.trim());
      if (headers.some(h => h.includes('内容')) && headers.some(h => h.includes('时间'))) {
        headerMap = {
          type: headers.findIndex(h => h.includes('类型')),
          chat: headers.findIndex(h => h.includes('聊天名称')),
          nick: headers.findIndex(h => h.includes('昵称')),
          content: headers.findIndex(h => h.includes('内容')),
          time: headers.findIndex(h => h.includes('时间'))
        };
        continue;
      }
      continue; // 跳过表头前的行
    }
    if (cells.length < 3) continue;
    const get = (i) => i >= 0 && cells[i] ? cells[i].textContent.trim() : '';
    const timeStr = get(headerMap.time);
    const t = parseTime(timeStr);
    if (!t) continue;
    records.push({
      idx: records.length,
      type: get(headerMap.type),
      chat: get(headerMap.chat),
      nick: get(headerMap.nick),
      content: get(headerMap.content),
      time: t,
      timeStr: fmtTime(t),
      day: dayKey(t),
      hour: t.getHours()
    });
  }
  // 按时间排序
  records.sort((a, b) => a.time - b.time);
  records.forEach((r, i) => r.idx = i);
  return records;
}

/* ================= 文件加载 ================= */
function loadFile(file) {
  setStatus('loadStatus', '正在读取 ' + esc(file.name) + ' …');
  const reader = new FileReader();
  reader.onload = () => {
    try {
      // UTF-8 带 BOM，TextDecoder 自动处理
      const text = new TextDecoder('utf-8').decode(reader.result);
      const records = parseXlsHtml(text);
      if (records.length === 0) throw new Error('未解析到任何记录');
      state.records = records;
      state.fileName = file.name;
      state.page = 1; state.search = ''; state.typeFilter = '';
      state.intentHits = [];
      $('tableSearch').value = '';
      onDataLoaded();
      setStatus('loadStatus',
        '<span class="ok">✓ 已加载 ' + records.length.toLocaleString() + ' 条记录（' + esc(file.name) + '）</span>');
    } catch (e) {
      setStatus('loadStatus', '<span class="err">✗ 解析失败：' + esc(e.message) + '</span>');
    }
  };
  reader.onerror = () => setStatus('loadStatus', '<span class="err">✗ 文件读取失败</span>');
  reader.readAsArrayBuffer(file);
}

async function loadSample() {
  setStatus('loadStatus', '正在加载示例数据…');
  try {
    const resp = await fetch('samples/sample.xls');
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const buf = await resp.arrayBuffer();
    const text = new TextDecoder('utf-8').decode(buf);
    const records = parseXlsHtml(text);
    if (records.length === 0) throw new Error('未解析到任何记录');
    state.records = records;
    state.fileName = 'sample.xls';
    state.page = 1; state.search = ''; state.typeFilter = '';
    state.intentHits = [];
    $('tableSearch').value = '';
    onDataLoaded();
    setStatus('loadStatus', '<span class="ok">✓ 已加载示例数据 ' + records.length.toLocaleString() + ' 条</span>');
  } catch (e) {
    setStatus('loadStatus', '<span class="err">✗ 示例数据加载失败：' + esc(e.message) + '</span>');
  }
}

function setStatus(id, html) { $(id).innerHTML = html; }

function onDataLoaded() {
  ['dashboardSection', 'summarySection', 'intentSection'].forEach(id => $(id).classList.remove('hidden'));
  $('summaryResult').classList.add('hidden');
  $('exportCsvBtn').classList.add('hidden');
  $('intentTableWrap').classList.add('hidden');
  $('intentStats').innerHTML = '';
  renderDashboard();
  buildSummaryRanges();
}

/* ================= 看板 ================= */
function renderDashboard() {
  renderStatCards();
  renderDailyChart();
  renderHourlyChart();
  renderTopChart();
  buildTypeFilter();
  renderTable();
}

function renderStatCards() {
  const rs = state.records;
  const total = rs.length;
  let priv = 0, group = 0;
  const typeCount = {};
  rs.forEach(r => {
    typeCount[r.type] = (typeCount[r.type] || 0) + 1;
    if (/私/.test(r.type)) priv++;
    else if (/群/.test(r.type)) group++;
  });
  const days = new Set(rs.map(r => r.day));
  const contacts = new Set(rs.map(r => r.chat || r.nick));
  const pct = (n) => total ? (n / total * 100).toFixed(1) + '%' : '-';
  const typeList = Object.entries(typeCount).sort((a, b) => b[1] - a[1])
    .map(([k, v]) => esc(k || '(空)') + ' ' + v.toLocaleString()).join(' · ');
  $('statCards').innerHTML =
    statCard(total.toLocaleString(), '总记录数', typeList) +
    statCard(pct(priv), '私聊占比', priv.toLocaleString() + ' 条') +
    statCard(pct(group), '群聊占比', group.toLocaleString() + ' 条') +
    statCard(days.size, '覆盖天数', (rs[0] ? rs[0].day : '-') + ' ~ ' + (rs[rs.length - 1] ? rs[rs.length - 1].day : '-')) +
    statCard(contacts.size.toLocaleString(), '联系人/会话数', '') +
    statCard((total / Math.max(days.size, 1)).toFixed(0), '日均消息', '');
}
function statCard(num, lbl, sub) {
  return '<div class="stat-card"><div class="num">' + num + '</div><div class="lbl">' + lbl +
    '</div>' + (sub ? '<div class="sub">' + sub + '</div>' : '') + '</div>';
}

/* ---- SVG 图表助手 ---- */
const SVG_NS = 'http://www.w3.org/2000/svg';

function renderDailyChart() {
  const counts = {};
  state.records.forEach(r => counts[r.day] = (counts[r.day] || 0) + 1);
  const days = Object.keys(counts).sort();
  const data = days.map(d => ({ label: d.slice(5), value: counts[d], title: d }));
  $('chartDaily').innerHTML = barChartSVG(data, { height: 220, color: '#3b6ef6' });
}

function renderHourlyChart() {
  const counts = new Array(24).fill(0);
  state.records.forEach(r => counts[r.hour]++);
  const data = counts.map((v, h) => ({ label: h + '', value: v, title: h + ':00 - ' + h + ':59' }));
  $('chartHourly').innerHTML = barChartSVG(data, { height: 220, color: '#7b5cf0' });
}

/* 竖向柱状图 SVG */
function barChartSVG(data, opts) {
  const height = opts.height || 220, color = opts.color || '#3b6ef6';
  const n = data.length;
  if (!n) return '<p class="muted">无数据</p>';
  const barW = Math.max(14, Math.min(48, Math.floor(640 / n) - 4));
  const w = Math.max(320, n * (barW + 4) + 40);
  const padL = 40, padB = 30, padT = 16;
  const max = Math.max(...data.map(d => d.value), 1);
  const innerH = height - padB - padT;
  let bars = '';
  data.forEach((d, i) => {
    const x = padL + i * (barW + 4);
    const h = Math.max(1, d.value / max * innerH);
    const y = padT + innerH - h;
    bars += '<rect x="' + x + '" y="' + y.toFixed(1) + '" width="' + barW + '" height="' + h.toFixed(1) +
      '" rx="2" fill="' + color + '"><title>' + esc(d.title || d.label) + '：' + d.value.toLocaleString() + '</title></rect>';
    const showLabel = n <= 31 || i % Math.ceil(n / 31) === 0;
    if (showLabel) {
      bars += '<text x="' + (x + barW / 2) + '" y="' + (height - 8) + '" text-anchor="middle" font-size="10" fill="#8a919e">' +
        esc(d.label) + '</text>';
    }
    if (d.value > 0 && barW >= 20) {
      bars += '<text x="' + (x + barW / 2) + '" y="' + (y - 3) + '" text-anchor="middle" font-size="9" fill="#8a919e">' +
        d.value + '</text>';
    }
  });
  // Y 轴参考线
  let axis = '';
  for (let g = 0; g <= 4; g++) {
    const v = Math.round(max * g / 4);
    const y = padT + innerH - (g / 4) * innerH;
    axis += '<line x1="' + padL + '" y1="' + y + '" x2="' + (w - 4) + '" y2="' + y +
      '" stroke="#e6e8ef" stroke-width="1"/>' +
      '<text x="' + (padL - 4) + '" y="' + (y + 3) + '" text-anchor="end" font-size="9" fill="#8a919e">' + v + '</text>';
  }
  return '<svg width="' + w + '" height="' + height + '" viewBox="0 0 ' + w + ' ' + height + '">' + axis + bars + '</svg>';
}

/* Top10 横向条形图 */
function renderTopChart() {
  const counts = {};
  state.records.forEach(r => {
    const k = r.chat || r.nick || '(未知)';
    counts[k] = (counts[k] || 0) + 1;
  });
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 10);
  if (!top.length) { $('chartTop').innerHTML = '<p class="muted">无数据</p>'; return; }
  const rowH = 28, padL = 150, padR = 60;
  const w = 640, h = top.length * rowH + 10;
  const max = top[0][1];
  const barMaxW = w - padL - padR;
  let out = '';
  top.forEach(([name, v], i) => {
    const y = i * rowH + 5;
    const bw = Math.max(2, v / max * barMaxW);
    const disp = name.length > 12 ? name.slice(0, 12) + '…' : name;
    out += '<text x="' + (padL - 8) + '" y="' + (y + rowH / 2 + 3) + '" text-anchor="end" font-size="11" fill="#1f2329">' +
      esc(disp) + '<title>' + esc(name) + '</title></text>' +
      '<rect x="' + padL + '" y="' + y + '" width="' + bw.toFixed(1) + '" height="' + (rowH - 10) +
      '" rx="3" fill="#22b07d"><title>' + esc(name) + '：' + v.toLocaleString() + '</title></rect>' +
      '<text x="' + (padL + bw + 6) + '" y="' + (y + rowH / 2 + 3) + '" font-size="11" fill="#8a919e">' +
      v.toLocaleString() + '</text>';
  });
  $('chartTop').innerHTML =
    '<svg width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '">' + out + '</svg>';
}

/* ================= 记录表格（分页） ================= */
function buildTypeFilter() {
  const types = [...new Set(state.records.map(r => r.type))].filter(Boolean).sort();
  const sel = $('tableFilterType');
  sel.innerHTML = '<option value="">全部类型</option>' +
    types.map(t => '<option value="' + esc(t) + '">' + esc(t) + '</option>').join('');
  sel.value = state.typeFilter;
}

function filteredRecords() {
  const q = state.search.trim().toLowerCase();
  return state.records.filter(r => {
    if (state.typeFilter && r.type !== state.typeFilter) return false;
    if (q && !(r.content.toLowerCase().includes(q) || r.nick.toLowerCase().includes(q) ||
               r.chat.toLowerCase().includes(q))) return false;
    return true;
  });
}

function renderTable() {
  const data = filteredRecords();
  const totalPages = Math.max(1, Math.ceil(data.length / state.pageSize));
  if (state.page > totalPages) state.page = totalPages;
  const start = (state.page - 1) * state.pageSize;
  const pageRows = data.slice(start, start + state.pageSize);
  const hitSet = new Set(state.intentHits.map(r => r.idx));
  $('recordTbody').innerHTML = pageRows.map(r =>
    '<tr' + (hitSet.has(r.idx) ? ' class="hit"' : '') + '><td class="col-idx">' + (r.idx + 1) + '</td><td>' + esc(r.type) +
    '</td><td>' + esc(r.chat) + '</td><td>' + esc(r.nick) + '</td><td class="col-content">' +
    esc(r.content) + '</td><td class="time">' + r.timeStr + '</td></tr>').join('');
  $('pageInfo').textContent = '第 ' + state.page + ' / ' + totalPages + ' 页';
  $('tableInfo').textContent = '共 ' + data.length.toLocaleString() + ' 条' +
    (state.search || state.typeFilter ? '（已筛选）' : '');
  $('prevPage').disabled = state.page <= 1;
  $('nextPage').disabled = state.page >= totalPages;
}

/* ================= AI 调用 ================= */
async function callLLM(messages, opts) {
  const resp = await fetch('api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({
      provider: state.provider,
      messages,
      temperature: 0.3
    }, opts || {}))
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const detail = data.detail ? (data.detail.error && data.detail.error.message || JSON.stringify(data.detail)).slice(0, 300) : '';
    throw new Error((data.error || ('HTTP ' + resp.status)) + (detail ? '：' + detail : ''));
  }
  const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!content) throw new Error('模型返回为空');
  return { content, usage: data.usage || null };
}

/* ================= AI 总结 ================= */
function buildSummaryRanges() {
  const days = [...new Set(state.records.map(r => r.day))].sort();
  const sel = $('summaryRange');
  sel.innerHTML = '<option value="all">全部记录（' + state.records.length.toLocaleString() + ' 条）</option>' +
    days.map(d => '<option value="' + d + '">' + d + '（' +
      state.records.filter(r => r.day === d).length + ' 条）</option>').join('');
}

function batchRecords(records, size) {
  const batches = [];
  for (let i = 0; i < records.length; i += size) batches.push(records.slice(i, i + size));
  return batches;
}
function recordsToText(records) {
  return records.map((r, i) => '[' + (i + 1) + '] ' + r.timeStr + ' | ' + r.type + ' | ' +
    (r.chat || '') + ' | ' + (r.nick || '') + '：' + r.content.slice(0, 300)).join('\n');
}

async function runSummary() {
  if (state.running) return;
  const range = $('summaryRange').value;
  const records = range === 'all' ? state.records : state.records.filter(r => r.day === range);
  if (!records.length) return;
  state.running = true;
  $('runSummaryBtn').disabled = true;
  $('summaryResult').classList.add('hidden');
  $('summaryProgress').classList.remove('hidden');
  const bar = $('summaryBar'), ptext = $('summaryProgressText');
  try {
    const BATCH = 100;
    const batches = batchRecords(records, BATCH);
    const partials = [];
    for (let i = 0; i < batches.length; i++) {
      ptext.textContent = '正在总结第 ' + (i + 1) + ' / ' + batches.length + ' 批（每批约 ' + BATCH + ' 条）…';
      bar.style.width = ((i / (batches.length + 1)) * 100).toFixed(1) + '%';
      const { content } = await callLLM([
        { role: 'system', content: '你是客服聊天记录分析助手。请对下面这批聊天记录做简洁的阶段小结，包含：主要话题、客户高频问题、明显的情绪倾向（正面/中性/负面）。控制在 250 字以内，直接输出纯文本。' },
        { role: 'user', content: recordsToText(batches[i]) }
      ]);
      partials.push(content);
    }
    ptext.textContent = '正在合并各批小结，生成最终报告…';
    bar.style.width = (batches.length / (batches.length + 1) * 100).toFixed(1) + '%';
    const { content: finalText } = await callLLM([
      { role: 'system', content:
        '你是资深客服运营分析师。基于以下各批聊天记录的阶段小结，输出一份 Markdown 报告，严格包含这四个部分：\n' +
        '## 整体摘要\n## 高频问题 Top\n## 客户情绪分布\n## 客服表现建议\n' +
        '要求：中文、条理清晰、用列表；情绪分布给出大致比例估计。' },
      { role: 'user', content: partials.map((p, i) => '【第' + (i + 1) + '批】\n' + p).join('\n\n') }
    ]);
    bar.style.width = '100%';
    ptext.textContent = '完成 ✓（共 ' + batches.length + ' 批 + 1 次合并）';
    $('summaryResult').innerHTML = renderMarkdown(finalText);
    $('summaryResult').classList.remove('hidden');
  } catch (e) {
    ptext.textContent = '出错：' + e.message;
  } finally {
    state.running = false;
    $('runSummaryBtn').disabled = false;
  }
}

/* ================= 意图筛选 ================= */
async function runIntent() {
  if (state.running) return;
  const intent = $('intentInput').value.trim();
  if (!intent) { $('intentStats').innerHTML = '<span class="err">请先输入意图描述</span>'; return; }
  if (!state.records.length) return;
  state.running = true;
  $('runIntentBtn').disabled = true;
  $('exportCsvBtn').classList.add('hidden');
  $('intentTableWrap').classList.add('hidden');
  $('intentProgress').classList.remove('hidden');
  const bar = $('intentBar'), ptext = $('intentProgressText');
  const hits = [];
  try {
    const BATCH = 50;
    const batches = batchRecords(state.records, BATCH);
    for (let i = 0; i < batches.length; i++) {
      ptext.textContent = '正在分析第 ' + (i + 1) + ' / ' + batches.length + ' 批（已命中 ' + hits.length + ' 条）…';
      bar.style.width = ((i / batches.length) * 100).toFixed(1) + '%';
      const { content } = await callLLM([
        { role: 'system', content:
          '你是聊天意图分类器。用户给出一个意图描述和一批带序号的聊天记录。' +
          '判断每条记录是否符合该意图（以「内容」列为主）。' +
          '只输出 JSON：{"hits":[序号数组]}，序号为记录前的方括号数字，无匹配则输出 {"hits":[]}。不要输出任何其他文字。' },
        { role: 'user', content: '意图描述：' + intent + '\n\n聊天记录：\n' + recordsToText(batches[i]) }
      ], { response_format: { type: 'json_object' } });
      const idxs = parseHitJson(content);
      idxs.forEach(n => {
        const rec = batches[i][n - 1];
        if (rec && !hits.includes(rec)) hits.push(rec);
      });
    }
    bar.style.width = '100%';
    hits.sort((a, b) => a.idx - b.idx);
    state.intentHits = hits;
    ptext.textContent = '完成 ✓';
    $('intentStats').innerHTML = '<span class="ok">意图「' + esc(intent) + '」命中 ' + hits.length.toLocaleString() +
      ' 条 / 共 ' + state.records.length.toLocaleString() + ' 条</span>';
    renderIntentTable(hits);
    renderTable(); // 主表格同步高亮
    if (hits.length) $('exportCsvBtn').classList.remove('hidden');
  } catch (e) {
    ptext.textContent = '出错：' + e.message;
  } finally {
    state.running = false;
    $('runIntentBtn').disabled = false;
  }
}

function parseHitJson(content) {
  try {
    const m = content.match(/\{[\s\S]*\}/);
    if (!m) return [];
    const obj = JSON.parse(m[0]);
    const arr = Array.isArray(obj.hits) ? obj.hits : (Array.isArray(obj) ? obj : []);
    return arr.map(Number).filter(n => Number.isInteger(n) && n > 0);
  } catch { return []; }
}

function renderIntentTable(hits) {
  const MAX = 500; // 最多渲染前 500 条，其余在 CSV 里
  $('intentTbody').innerHTML = hits.slice(0, MAX).map(r =>
    '<tr class="hit"><td class="col-idx">' + (r.idx + 1) + '</td><td>' + esc(r.type) + '</td><td>' +
    esc(r.chat) + '</td><td>' + esc(r.nick) + '</td><td class="col-content">' + esc(r.content) +
    '</td><td class="time">' + r.timeStr + '</td></tr>').join('');
  $('intentTableWrap').classList.remove('hidden');
  if (hits.length > MAX) {
    $('intentStats').innerHTML += ' <span class="muted">（页面仅显示前 ' + MAX + ' 条，完整结果请导出 CSV）</span>';
  }
}

function exportCsv() {
  const hits = state.intentHits;
  if (!hits.length) return;
  const q = (s) => '"' + String(s == null ? '' : s).replace(/"/g, '""') + '"';
  const lines = ['﻿' + ['序号', '会话类型', '聊天名称', '昵称', '内容', '创建时间'].map(q).join(',')];
  hits.forEach(r => lines.push([r.idx + 1, r.type, r.chat, r.nick, r.content, r.timeStr].map(q).join(',')));
  const blob = new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const intent = $('intentInput').value.trim().replace(/[\\/:*?"<>|\s]+/g, '_') || 'intent';
  a.download = '意图筛选_' + intent + '_' + hits.length + '条.csv';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

/* ================= Markdown 简渲染 ================= */
function renderMarkdown(md) {
  const lines = String(md).split(/\r?\n/);
  let html = '', inList = null, inCode = false;
  const inline = (s) => esc(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
  const closeList = () => { if (inList) { html += '</' + inList + '>'; inList = null; } };
  for (const line of lines) {
    const t = line.trim();
    if (/^```/.test(t)) { closeList(); inCode = !inCode; continue; }
    if (inCode) { html += '<p><code>' + esc(line) + '</code></p>'; continue; }
    if (!t) { closeList(); continue; }
    let m;
    if ((m = t.match(/^(#{1,4})\s+(.*)/))) { closeList(); const lv = Math.min(m[1].length, 3); html += '<h' + lv + '>' + inline(m[2]) + '</h' + lv + '>'; }
    else if (/^(-{3,}|\*{3,})$/.test(t)) { closeList(); html += '<hr>'; }
    else if ((m = t.match(/^[-*•]\s+(.*)/))) { if (inList !== 'ul') { closeList(); html += '<ul>'; inList = 'ul'; } html += '<li>' + inline(m[1]) + '</li>'; }
    else if ((m = t.match(/^\d+[.、)]\s*(.*)/))) { if (inList !== 'ol') { closeList(); html += '<ol>'; inList = 'ol'; } html += '<li>' + inline(m[1]) + '</li>'; }
    else { closeList(); html += '<p>' + inline(t) + '</p>'; }
  }
  closeList();
  return html;
}

/* ================= 初始化 ================= */
async function initProvider() {
  try {
    const resp = await fetch('api/config');
    const cfg = await resp.json();
    const sel = $('providerSelect');
    sel.innerHTML = (cfg.providers || []).map(p =>
      '<option value="' + esc(p) + '"' + (p === cfg.default ? ' selected' : '') + '>' +
      esc(p === 'deepseek' ? 'DeepSeek' : p === 'doubao' ? '豆包 Doubao' : p) + '</option>').join('');
    state.provider = cfg.default || (cfg.providers || [])[0] || 'deepseek';
    $('providerHint').textContent = '默认 ' + state.provider;
  } catch {
    $('providerHint').textContent = '配置加载失败，使用默认';
  }
}

function bindEvents() {
  $('fileInput').addEventListener('change', (e) => {
    if (e.target.files[0]) loadFile(e.target.files[0]);
    e.target.value = '';
  });
  $('loadSampleBtn').addEventListener('click', loadSample);
  const dz = $('dropZone');
  ['dragenter', 'dragover'].forEach(ev => dz.addEventListener(ev, (e) => {
    e.preventDefault(); dz.classList.add('dragover');
  }));
  ['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, (e) => {
    e.preventDefault(); dz.classList.remove('dragover');
  }));
  dz.addEventListener('drop', (e) => {
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) loadFile(f);
  });
  $('providerSelect').addEventListener('change', (e) => { state.provider = e.target.value; });

  let searchTimer = null;
  $('tableSearch').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.search = e.target.value; state.page = 1; renderTable(); }, 250);
  });
  $('tableFilterType').addEventListener('change', (e) => {
    state.typeFilter = e.target.value; state.page = 1; renderTable();
  });
  $('prevPage').addEventListener('click', () => { if (state.page > 1) { state.page--; renderTable(); } });
  $('nextPage').addEventListener('click', () => { state.page++; renderTable(); });

  $('runSummaryBtn').addEventListener('click', runSummary);
  $('runIntentBtn').addEventListener('click', runIntent);
  $('exportCsvBtn').addEventListener('click', exportCsv);
}

initProvider();
bindEvents();
