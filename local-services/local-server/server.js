/**
 * 聊机本地 AI 服务器（方案 B）
 * 完整替代 api.shiflow.com 云端后端：
 *  - POST /shiflow/v3|v2/sees/speed      截图 -> 豆包视觉 -> SSE 动作流(thinking/keyboard/done)
 *  - POST /shiflow/v1/unread/detect      纯 JS PNG 红点启发式检测（无 VLM，满足 2.5s 超时）
 *  - POST /shiflow/v1/sees/grounding/resolve  豆包视觉 UI 元素定位（最弱一环，失败返回空点位）
 *  - POST /shiflow/v1/sees/chat/completions   多模态问答 SSE 代理（event: content/done/error）
 *  - 假账户体系 / agent_type 下发 / 聊天记录沉淀与导出
 * 零依赖，Node >= 18（开发验证 v24）。
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const os = require('os');
const { execFile } = require('child_process');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const RECORDS_FILE = path.join(DATA_DIR, 'chat_records.jsonl');
const TRACE_LOG_FILE = path.join(DATA_DIR, 'trace_logs.jsonl');
let traceLogCount = 0;
let unreadDiagCount = 0;
const SHOTS_DIR = path.join(DATA_DIR, 'shots');
fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- 配置 ----------
function loadConfig() {
  const p = path.join(ROOT, 'config.json');
  try {
    const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
    // 完好时刷新备份（供自愈）
    try { fs.writeFileSync(p + '.goodbak', JSON.stringify(cfg)); } catch { }
    return cfg;
  } catch (e) {
    // 配置被污染（如 RPA 误粘贴进编辑器）：自动从最近完好备份恢复
    console.error('[config] config.json 损坏:', e.message);
    const bak = p + '.goodbak';
    if (fs.existsSync(bak)) {
      try {
        const cfg = JSON.parse(fs.readFileSync(bak, 'utf8'));
        try { fs.writeFileSync(p, JSON.stringify(cfg, null, 2)); } catch { }
        console.error('[config] 已从 config.json.goodbak 自愈恢复');
        return cfg;
      } catch { }
    }
    throw e;
  }
}
let CONFIG = loadConfig();

// ---------- CLI 参数 ----------
function parseArgs() {
  const args = { port: CONFIG.server?.port || 7200, host: CONFIG.server?.host || '127.0.0.1' };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port' && argv[i + 1]) args.port = parseInt(argv[++i], 10);
    else if (argv[i].startsWith('--port=')) args.port = parseInt(argv[i].slice(7), 10);
    else if (argv[i] === '--host' && argv[i + 1]) args.host = argv[++i];
    else if (argv[i].startsWith('--host=')) args.host = argv[i].slice(7);
  }
  if (!Number.isInteger(args.port) || args.port <= 0 || args.port > 65535) {
    console.error('无效端口:', args.port); process.exit(1);
  }
  return args;
}

// ---------- 工具 ----------
// 日志时间统一用北京时间（UTC+8），不再比本地慢 8 小时
const now = () => {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return d.toISOString().replace('T', ' ').replace('Z', '');
};
function log(...a) { console.log(`[${now()}]`, ...a); }
function randId(prefix) { return `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`; }
function fmtTime(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
// 客户端有时直接传 nativeImage.toDataURL() 的结果（带 data:image/xxx;base64, 前缀），统一剥掉
function normalizeBase64(b64) {
  return String(b64 || '').replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '').replace(/\s+/g, '');
}

function detectImageMime(base64) {
  const buf = Buffer.from(base64.slice(0, 32), 'base64');
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf.length >= 4 && buf.toString('ascii', 0, 4) === 'RIFF') return 'image/webp';
  return 'image/png';
}
function jsonResponse(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
function readBody(req, limit = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('请求体过大')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ---------- LLM 调用 ----------
async function llmChat({ provider, messages, timeoutMs = 60000, responseFormat, noFallback: noFallbackArg = false }) {
  const llm = CONFIG.llm?.[provider];
  if (!llm || !llm.api_key) throw new Error(`未配置 ${provider} API key`);
  // 豆包：按是否含图片自动分流——视觉走 model（evolving），纯文本走 model_text（ep 接入点，更快）
  const hasImage = messages.some(m => Array.isArray(m.content) && m.content.some(c => c && c.type === 'image_url'));
  let models;
  if (provider === 'doubao' && noFallbackArg) {
    models = [hasImage ? (llm.model_vision || llm.model) : (llm.model_text || llm.model)];
  } else if (provider === 'doubao') {
    const primary = hasImage ? (llm.model_vision || llm.model) : (llm.model_text || llm.model);
    models = llm.model_fallback ? [primary, llm.model_fallback] : [primary];
    if (hasImage && llm.model_text && models[0] === llm.model_text) models = [llm.model_vision || llm.model, llm.model_fallback].filter(Boolean);
  } else {
    models = [llm.model];
  }
  let lastErr = null;
  for (const model of models) {
    // 429 突发限流：同模型退避重试一次再回退（避免每次都掉进更慢的备用模型）
    for (let attempt = 0; attempt < 2; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort('timeout'), timeoutMs);
      try {
        // 布局/红点等检测要输出多个 bbox JSON，1024 token 会被截断成非 JSON（曾导致输入框定位掉到合成兜底）
        const payload = { model, messages, temperature: 0.7, max_tokens: 4096 };
        // seed-2.x 系列默认开深度思考（视觉请求会拖到超时）；定位/理解类任务无需深思，一律关闭
        if (provider === 'doubao') payload.thinking = { type: 'disabled' };
        if (responseFormat) payload.response_format = responseFormat;
        const r = await fetch(llm.endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${llm.api_key}` },
          body: JSON.stringify(payload),
          signal: ctrl.signal
        });
        if (r.status === 429 && attempt === 0) {
          const txt = (await r.text()).slice(0, 200);
          log(`【LLM】${provider}/${model} 429 限流，退避 4s 重试: ${txt}`);
          clearTimeout(timer);
          await new Promise(r2 => setTimeout(r2, 4000));
          continue;
        }
        if (!r.ok) {
          const txt = (await r.text()).slice(0, 500);
          throw new Error(`${provider}/${model} HTTP ${r.status}: ${txt}`);
        }
        const j = await r.json();
        const text = j.choices?.[0]?.message?.content;
        if (typeof text !== 'string') throw new Error(`${provider}/${model} 返回结构异常`);
        if (model !== models[0]) log(`【LLM】已回退到备用模型 ${model}`);
        return { text, model };
      } catch (e) {
        lastErr = e;
        log(`【LLM】${provider}/${model} 调用失败:`, e.message || e);
      } finally { clearTimeout(timer); }
      break; // 非 429 错误不再重试本模型
    }
  }
  throw lastErr || new Error(`${provider} 调用失败`);
}

// 从模型输出中提取首个 JSON 对象
function extractJson(text) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

// ---------- PNG 解码（零依赖，8-bit 非交错） ----------
function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}
function decodePng(buf) {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG 文件');
  let pos = 8, width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = []; let plte = null;
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9]; interlace = data[12];
    } else if (type === 'PLTE') plte = Buffer.from(data);
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (!width || !height) throw new Error('PNG 缺少 IHDR');
  if (bitDepth !== 8) throw new Error(`不支持的 PNG 位深: ${bitDepth}`);
  if (interlace !== 0) throw new Error('不支持交错 PNG');
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`不支持的 PNG 颜色类型: ${colorType}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[p++];
    const rowStart = y * stride, prevStart = (y - 1) * stride;
    for (let x = 0; x < stride; x++) {
      const rv = raw[p + x];
      const a = x >= channels ? out[rowStart + x - channels] : 0;
      const b = y > 0 ? out[prevStart + x] : 0;
      const c = x >= channels && y > 0 ? out[prevStart + x - channels] : 0;
      let v;
      switch (filter) {
        case 0: v = rv; break;
        case 1: v = rv + a; break;
        case 2: v = rv + b; break;
        case 3: v = rv + ((a + b) >> 1); break;
        case 4: v = rv + paeth(a, b, c); break;
        default: throw new Error(`未知 PNG filter: ${filter}`);
      }
      out[rowStart + x] = v & 0xff;
    }
    p += stride;
  }
  function rgbAt(x, y) {
    const i = (y * width + x) * channels;
    if (colorType === 2 || colorType === 6) return [out[i], out[i + 1], out[i + 2]];
    if (colorType === 0 || colorType === 4) { const g = out[i]; return [g, g, g]; }
    // palette
    const pi = out[i] * 3;
    return plte ? [plte[pi], plte[pi + 1], plte[pi + 2]] : [0, 0, 0];
  }
  return { width, height, rgbAt };
}

// ---------- 红点启发式检测 ----------
function detectRedDots(png) {
  const { width, height, rgbAt } = png;
  const mask = new Uint8Array(width * height);
  let redCount = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = rgbAt(x, y);
      // 微信未读角标 #FA5151 级别的高纯红（收紧：排除暗红/橘红/粉红）
      if (r >= 210 && g <= 110 && b <= 110 && r - g >= 110 && r - b >= 110) {
        mask[y * width + x] = 1; redCount++;
      }
    }
  }
  const dots = [];
  const stack = [];
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    // BFS 连通域
    let minX = width, maxX = -1, minY = height, maxY = -1, count = 0;
    mask[i] = 0; stack.push(i);
    while (stack.length) {
      const idx = stack.pop();
      const x = idx % width, y = (idx / width) | 0;
      count++;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (x > 0 && mask[idx - 1]) { mask[idx - 1] = 0; stack.push(idx - 1); }
      if (x < width - 1 && mask[idx + 1]) { mask[idx + 1] = 0; stack.push(idx + 1); }
      if (y > 0 && mask[idx - width]) { mask[idx - width] = 0; stack.push(idx - width); }
      if (y < height - 1 && mask[idx + width]) { mask[idx + width] = 0; stack.push(idx + width); }
    }
    const w = maxX - minX + 1, h = maxY - minY + 1;
    // 真未读角标：左侧会话列表内（中心 x ≤ 34% 宽）、近圆形、直径 8~40px、高填充（实心圆）
    const cx = (minX + maxX) / 2;
    if (cx > width * 0.34 || cx < 62) continue; // 排除左侧工具栏(消息/通讯录图标自身的常驻角标)
    if (count < 80 || w < 8 || h < 8 || w > 40 || h > 40) continue;
    const aspect = w / h;
    const fill = count / (w * h);
    if (aspect >= 0.55 && aspect <= 1.8 && fill >= 0.45) {
      dots.push([[minX, minY], [maxX + 1, maxY + 1]]);
    }
  }
  dots.sort((a, b) => a[0][1] - b[0][1]);
  return { dots, redCount };
}

// ---------- 聊天记录沉淀 ----------
function appendRecord(rec) {
  fs.appendFileSync(RECORDS_FILE, JSON.stringify(rec) + '\n', 'utf8');
}
// 无需回复的判断过程单独存一份（不进 chat_records，避免干扰时序校验/去重）
const JUDGE_FILE = path.join(DATA_DIR, 'judge_records.jsonl');
const lastJudgeAt = new Map(); // 同会话同理由 10 分钟内不重复记（防继续观察刷屏）
function appendJudge(rec) {
  try {
    const key = `${rec.chat_name || ''}|${rec.reason || ''}`;
    const last = lastJudgeAt.get(key) || 0;
    if (Date.now() - last < 10 * 60 * 1000) return;
    lastJudgeAt.set(key, Date.now());
    fs.appendFileSync(JUDGE_FILE, JSON.stringify(rec) + '\n', 'utf8');
  } catch { }
}
function loadJudges() {
  if (!fs.existsSync(JUDGE_FILE)) return [];
  const out = [];
  for (const line of fs.readFileSync(JUDGE_FILE, 'utf8').split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s)); } catch { }
  }
  return out;
}
function loadRecords() {
  if (!fs.existsSync(RECORDS_FILE)) return [];
  const lines = fs.readFileSync(RECORDS_FILE, 'utf8').split('\n');
  const out = [];
  for (const line of lines) {
    const s = line.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s)); } catch { /* 跳过坏行 */ }
  }
  return out;
}
function filterRecords(records, q) {
  return records.filter(r => {
    if (q.chat_type && r.chat_type !== q.chat_type) return false;
    if (q.chat_name && !(r.target_name || '').includes(q.chat_name)) return false;
    const stamp = (r.created_at || '').slice(0, 16);
    if (q.date_start && stamp < q.date_start) return false;
    if (q.date_end) {
      // 纯日期结尾 => 含当天全天；带分钟 => 到该分钟
      const end = q.date_end.length <= 10 ? q.date_end + ' 23:59' : q.date_end;
      if (stamp > end) return false;
      if (q.date_start.length <= 10 && stamp < q.date_start + ' 00:00') return false;
    }
    return true;
  });
}

// ---------- 打款/订单功能已在开源版移除 ----------

// ---------- 多机同步（主机：/sync/manifest + /sync/file 只读下发；分机：/sync/apply 拉取应用） ----------
const SYNC_APPRES = path.join(ROOT, '..', '..', 'resources');
function syncFileMap() {
  const m = {};
  const add = (rel, abs) => { if (fs.existsSync(abs)) m[rel] = abs; };
  add('local-server/server.js', path.join(ROOT, 'server.js'));
  add('local-server/config.json', path.join(ROOT, 'config.json'));
  add('local-server/data/tasks.json', path.join(ROOT, 'data', 'tasks.json'));
    for (const f of ['index.html', 'test-panel.js', 'analysis-panel.js']) {
    add('renderer/' + f, path.join(SYNC_APPRES, 'renderer', f));
  }
  add('renderer/assets/index-N3BhOyz2.js', path.join(SYNC_APPRES, 'renderer', 'assets', 'index-N3BhOyz2.js'));
  add('biz/index.js', path.join(SYNC_APPRES, 'biz', 'index.js'));
  return m;
}
function sha256File(p) { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); }

// GET /sync/manifest —— 同步文件清单（path+size+sha256）
async function handleSyncManifest(req, res) {
  const m = syncFileMap();
  const files = Object.keys(m).sort().map(rel => ({ path: rel, size: fs.statSync(m[rel]).size, sha256: sha256File(m[rel]) }));
  return jsonResponse(res, 200, { code: 0, body: { version: now(), files } });
}

// GET /sync/file?path=xxx —— 下载清单内的单个文件（白名单内才给）
function handleSyncFile(req, res, u) {
  const rel = String(u.searchParams.get('path') || '');
  const abs = syncFileMap()[rel];
  if (!abs) return jsonResponse(res, 404, { code: 404, msg: 'not in sync set' });
  const buf = fs.readFileSync(abs);
  res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': buf.length });
  res.end(buf);
}

// POST /sync/apply {master, paths?} —— 从主机拉取差异文件写入本机（先备份到 data/sync-backup/）
// 本机是开发副本（有大量本地修复），同步总开关 sync_enabled=false：一律拒绝，防止被旧版主机覆盖
async function handleSyncApply(req, res, body) {
  if (CONFIG.sync_enabled === false) {
    return jsonResponse(res, 200, { code: 0, body: { error: '本机是开发副本，同步已被禁用（sync_enabled=false）——主机的代码没有本机的修复，同步会覆盖掉它们' } });
  }
  const t0 = Date.now();
  let payload;
  try { payload = JSON.parse(body.toString('utf8')); }
  catch { return jsonResponse(res, 400, { code: 400, msg: 'invalid json' }); }
  const master = String(payload.master || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//.test(master)) return jsonResponse(res, 200, { code: 0, body: { error: '主机地址无效（形如 http://192.168.1.10:7200）' } });
  try {
    const c1 = new AbortController(); const t1 = setTimeout(() => c1.abort('timeout'), 15000);
    let mj;
    try { mj = await (await fetch(master + '/sync/manifest', { signal: c1.signal })).json(); }
    finally { clearTimeout(t1); }
    const remoteFiles = (mj && mj.body && mj.body.files) || [];
    if (!remoteFiles.length) return jsonResponse(res, 200, { code: 0, body: { error: '主机清单为空或地址不通' } });
    const localMap = syncFileMap();
    const backupRoot = path.join(DATA_DIR, 'sync-backup', String(Date.now()));
    const results = [];
    for (const rf of remoteFiles) {
      if (Array.isArray(payload.paths) && payload.paths.length && !payload.paths.includes(rf.path)) { results.push({ path: rf.path, action: 'skipped' }); continue; }
      const localAbs = localMap[rf.path];
      if (!localAbs) { results.push({ path: rf.path, action: 'skipped', reason: '本机无此路径' }); continue; }
      let localHash = '';
      try { localHash = fs.existsSync(localAbs) ? sha256File(localAbs) : ''; } catch { }
      if (localHash === rf.sha256) { results.push({ path: rf.path, action: 'same' }); continue; }
      const c2 = new AbortController(); const t2 = setTimeout(() => c2.abort('timeout'), 90000);
      let buf;
      try {
        const fr = await fetch(master + '/sync/file?path=' + encodeURIComponent(rf.path), { signal: c2.signal });
        if (!fr.ok) throw new Error('HTTP ' + fr.status);
        buf = Buffer.from(await fr.arrayBuffer());
      } catch (e) { results.push({ path: rf.path, action: 'error', reason: String(e.message || e) }); clearTimeout(t2); continue; }
      clearTimeout(t2);
      if (crypto.createHash('sha256').update(buf).digest('hex') !== rf.sha256) { results.push({ path: rf.path, action: 'error', reason: '下载校验不一致' }); continue; }
      try {
        if (fs.existsSync(localAbs)) {
          fs.mkdirSync(backupRoot, { recursive: true });
          fs.copyFileSync(localAbs, path.join(backupRoot, rf.path.replace(/[\/\\]/g, '__')));
        }
        fs.mkdirSync(path.dirname(localAbs), { recursive: true });
        fs.writeFileSync(localAbs, buf);
        results.push({ path: rf.path, action: 'updated', bytes: buf.length });
      } catch (e) { results.push({ path: rf.path, action: 'error', reason: '写入失败: ' + String(e.message || e) }); }
    }
    const updated = results.filter(r => r.action === 'updated').length;
    log(`【sync/apply】master=${master} 更新=${updated} 相同=${results.filter(r => r.action === 'same').length} 失败=${results.filter(r => r.action === 'error').length} 耗时 ${Date.now() - t0}ms`);
    return jsonResponse(res, 200, { code: 0, body: { results, updated, need_restart: updated > 0, backup: updated ? backupRoot : '', elapsed_ms: Date.now() - t0 } });
  } catch (e) {
    log('【sync/apply】失败:', e.message || e);
    return jsonResponse(res, 200, { code: 0, body: { error: String(e.message || e) } });
  }
}

// GET /records/by-day —— 回复记录目录：只含我方回复 + 无需回复判断过程；按天分组，当天内最新在上方（编号仍按时间从 1 递增，越新越大）
async function handleRecordsByDay(req, res) {
  const t0 = Date.now();
  const replies = loadRecords()
    .filter(r => r.nickname === 'sf_agent')
    .map(r => ({
      created_at: r.created_at || '', chat_type: r.chat_type || '',
      target_name: r.target_name || '', nickname: r.nickname || '',
      is_agent: true, is_judge: false,
      content: String(r.content || '')
    }));
  const judges = loadJudges().map(j => ({
    created_at: j.created_at || '', chat_type: j.chat_type || '',
    target_name: j.chat_name || '', nickname: j.chat_name || '',
    is_agent: false, is_judge: true,
    content: String(j.reason || ''),
    customer_message: String(j.customer_message || '')
  }));
  const all = replies.concat(judges).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  const days = new Map();
  for (const r of all) {
    const day = String(r.created_at || '').slice(0, 10) || '未知日期';
    if (!days.has(day)) days.set(day, []);
    days.get(day).push(r);
  }
  const out = [];
  for (const [day, list] of [...days.entries()].sort((a, b) => b[0].localeCompare(a[0]))) {
    // 编号按时间升序稳定赋号（最早=1），展示时最新在上方（编号越大越新）
    const items = list.map((r, i) => ({ num: i + 1, ...r })).reverse();
    out.push({ day, count: items.length, items });
  }
  log(`【records/by-day】回复 ${replies.length} 条 + 判断 ${judges.length} 条 / ${out.length} 天 耗时 ${Date.now() - t0}ms`);
  return jsonResponse(res, 200, { code: 0, body: { days: out, total: all.length, elapsed_ms: Date.now() - t0 } });
}

// ---------- 售后整理（按订单尾号分渠道；渠道内编号从 1 开始持续累加，复制过的不再重复） ----------
const ASF_STATE_FILE = path.join(DATA_DIR, 'after_sales_state.json');
const ASF_CHANNEL_MAP = { '9': 'T9群', '8': 'W1群', '7': '172群', '5': 'L1群', '1': 'C1群', '6': 'C1群' };
const ASF_CHANNELS = ['T9群', 'W1群', '172群', 'L1群', 'C1群', '其他'];

function loadAsfState() {
  try {
    const s = JSON.parse(fs.readFileSync(ASF_STATE_FILE, 'utf8'));
    return { counters: s.counters || {}, items: s.items || {} };
  } catch { return { counters: {}, items: {} }; }
}
function saveAsfState(st) {
  fs.writeFileSync(ASF_STATE_FILE, JSON.stringify({ counters: st.counters, items: st.items }, null, 2), 'utf8');
}

// 从聊天记录提取售后条目（order 编号 + 问题 + 来源），按 order+内容 去重；
// 只有订单号没有问题的消息：配对同会话 ±10 分钟内最近的客户问题；配不上的标记 no_issue（不进复制）
function extractAfterSales(records) {
  const items = [];
  const seen = new Set();
  const normK = t => String(t).replace(/[\s\p{P}\p{S}]/gu, '');
  const stripOrders = t => String(t).replace(/order\d{6,}/gi, '');
  // 按会话分组，供光杆订单号配对相邻客户问题
  const byChat = new Map();
  for (const r of records) {
    if (!r || !r.content) continue;
    const k = r.target_name || '';
    if (!byChat.has(k)) byChat.set(k, []);
    byChat.get(k).push(r);
  }
  for (const r of records) {
    if (!r || !r.content || r.nickname === 'sf_agent') continue;
    const ms = String(r.content).match(/order\d{6,}/gi);
    if (!ms) continue;
    for (const raw of ms) {
      const order = 'order' + raw.slice(5);
      const key = order + '|' + normK(r.content);
      if (seen.has(key)) continue;
      seen.add(key);
      const lastDigit = order.charAt(order.length - 1);
      const channel = ASF_CHANNEL_MAP[lastDigit] || '其他';
      let issue = String(r.content);
      let noIssue = false;
      if (normK(stripOrders(r.content)).length < 2) {
        const t0 = Date.parse(String(r.created_at || '').replace(' ', 'T')) || 0;
        const chatRecs = byChat.get(r.target_name || '') || [];
        let best = null, bestDt = Infinity;
        for (const q of chatRecs) {
          if (q === r || !q.content || q.nickname === 'sf_agent') continue;
          if (/order\d{6,}/i.test(q.content)) continue;
          if (normK(q.content).length < 2) continue;
          const dt = Math.abs((Date.parse(String(q.created_at || '').replace(' ', 'T')) || 0) - t0);
          if (dt <= 10 * 60 * 1000 && dt < bestDt) { best = q; bestDt = dt; }
        }
        if (best) issue = order + ' ' + String(best.content);
        else noIssue = true;
      }
      items.push({
        key,
        order,
        issue,
        chat_type: r.chat_type === '群聊' ? '群聊' : '私聊',
        chat_name: r.target_name || '',
        nickname: r.nickname || '',
        created_at: r.created_at || '',
        channel,
        no_issue: noIssue
      });
    }
  }
  return items;
}

// 给未编号条目按渠道顺序分配持续编号（首次扫描即编号，保证「查看」里编号稳定）
function asfAssignNumbers(items, st) {
  let dirty = false;
  for (const ch of ASF_CHANNELS) {
    const list = items.filter(i => i.channel === ch).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    for (const it of list) {
      if (!st.items[it.key]) {
        const next = (st.counters[ch] || 0) + 1;
        st.counters[ch] = next;
        st.items[it.key] = { num: next, copied_at: '' };
        dirty = true;
      }
      it.num = st.items[it.key].num;
      it.copied_at = st.items[it.key].copied_at || '';
      it.copied = !!it.copied_at;
    }
  }
  if (dirty) saveAsfState(st);
}

function asfSourceLabel(it) {
  return it.chat_type === '群聊' ? `群「${it.chat_name}」` : `私信「${it.nickname}」`;
}

// POST /after-sales/scan {date_start?, date_end?} —— 扫描记录，按渠道分组（含编号与已复制标记）
async function handleAsfScan(req, res, body) {
  const t0 = Date.now();
  let payload = {};
  try { payload = JSON.parse(body.toString('utf8')); } catch { }
  const q = {};
  if (payload.date_start) q.date_start = String(payload.date_start).slice(0, 16);
  if (payload.date_end) q.date_end = String(payload.date_end).slice(0, 16);
  const records = filterRecords(loadRecords(), q);
  const items = extractAfterSales(records);
  const st = loadAsfState();
  asfAssignNumbers(items, st);
  const channels = {};
  for (const ch of ASF_CHANNELS) {
    const list = items.filter(i => i.channel === ch).sort((a, b) => a.num - b.num);
    channels[ch] = {
      total: list.length,
      fresh: list.filter(i => !i.copied && !i.no_issue).length,
      no_issue: list.filter(i => i.no_issue && !i.copied).length,
      items: list
    };
  }
  log(`【after-sales/scan】记录=${records.length} 售后条目=${items.length} 耗时 ${Date.now() - t0}ms`);
  return jsonResponse(res, 200, { code: 0, body: { channels, total: items.length, elapsed_ms: Date.now() - t0 } });
}

// POST /after-sales/copy {channel} —— 标记该渠道新增条目为已复制，返回编号排版文本（编号接着上次继续）
async function handleAsfCopy(req, res, body) {
  let payload = {};
  try { payload = JSON.parse(body.toString('utf8')); } catch { }
  const channel = String(payload.channel || '');
  if (!ASF_CHANNELS.includes(channel)) return jsonResponse(res, 200, { code: 0, body: { error: '未知渠道: ' + channel } });
  const items = extractAfterSales(loadRecords()).filter(i => i.channel === channel);
  const st = loadAsfState();
  asfAssignNumbers(items, st);
  const fresh = items.filter(i => !i.copied && !i.no_issue).sort((a, b) => a.num - b.num);
  const skippedNoIssue = items.filter(i => !i.copied && i.no_issue).length;
  if (!fresh.length) {
    return jsonResponse(res, 200, { code: 0, body: { text: '', count: 0, channel, skipped_no_issue: skippedNoIssue } });
  }
  const ts = now();
  for (const it of fresh) {
    st.items[it.key].copied_at = ts;
    it.copied_at = ts;
  }
  saveAsfState(st);
  // 复制内容：只有「编号 + 订单号 + 售后」，不含来源/时间（那些只在「查看」里显示）
  const text = fresh.map(it => `【${it.num}】${it.issue}`).join('\n');
  log(`【after-sales/copy】${channel} 新增 ${fresh.length} 条（编号 ${fresh[0].num}~${fresh[fresh.length - 1].num}，跳过光杆订单号 ${skippedNoIssue} 条）已标记为已复制`);
  return jsonResponse(res, 200, { code: 0, body: { text, count: fresh.length, channel, copied_at: ts, skipped_no_issue: skippedNoIssue } });
}

// ---------- 知识库（文件上传 + 文本解析 + 回复注入） ----------
const KB_DIR = path.join(DATA_DIR, 'kb');
const KB_META_FILE = path.join(DATA_DIR, 'kb_files.json');
fs.mkdirSync(KB_DIR, { recursive: true });

function loadKbFiles() {
  try { return JSON.parse(fs.readFileSync(KB_META_FILE, 'utf8')); } catch { return []; }
}
function saveKbFiles(list) {
  fs.writeFileSync(KB_META_FILE, JSON.stringify(list, null, 2), 'utf8');
}

// 极简 zip 读取（docx 提取 word/document.xml 用；zip 解压用内置 zlib）
function readZipEntry(buf, entryName) {
  try {
    const zlib = require('zlib');
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) {
      if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) return null;
    const count = buf.readUInt16LE(eocd + 10);
    let off = buf.readUInt32LE(eocd + 16);
    for (let k = 0; k < count; k++) {
      if (buf.readUInt32LE(off) !== 0x02014b50) break;
      const method = buf.readUInt16LE(off + 10);
      const csize = buf.readUInt32LE(off + 20);
      const nameLen = buf.readUInt16LE(off + 28);
      const extraLen = buf.readUInt16LE(off + 30);
      const cmtLen = buf.readUInt16LE(off + 32);
      const lho = buf.readUInt32LE(off + 42);
      const name = buf.slice(off + 46, off + 46 + nameLen).toString('utf8');
      if (name === entryName) {
        const lnLen = buf.readUInt16LE(lho + 26);
        const leLen = buf.readUInt16LE(lho + 28);
        const data = buf.slice(lho + 30 + lnLen + leLen, lho + 30 + lnLen + leLen + csize);
        if (method === 0) return data;
        if (method === 8) return zlib.inflateRawSync(data);
        return null;
      }
      off += 46 + nameLen + extraLen + cmtLen;
    }
  } catch { }
  return null;
}

function xmlEnt(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h2) => String.fromCodePoint(parseInt(h2, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');
}

// xlsx 文本提取：sharedStrings + 逐 sheet 行解析（zip 读取器复用 readZipEntry）
function extractXlsxText(buf) {
  const shared = [];
  const ss = readZipEntry(buf, 'xl/sharedStrings.xml');
  if (ss) {
    const sxml = ss.toString('utf8');
    const siRe = /<si[\s>]([\s\S]*?)<\/si>/g;
    let m;
    while ((m = siRe.exec(sxml))) {
      const ts = [...m[1].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(x => x[1]);
      shared.push(xmlEnt(ts.join('')));
    }
  }
  const out = [];
  for (let sn = 1; sn <= 30; sn++) {
    const sh = readZipEntry(buf, `xl/worksheets/sheet${sn}.xml`);
    if (!sh) break;
    const x = sh.toString('utf8');
    const rowRe = /<row[\s>]([\s\S]*?)<\/row>/g;
    let rm;
    while ((rm = rowRe.exec(x))) {
      const cells = [];
      const cRe = /<c\b([^>]*)>([\s\S]*?)<\/c>|<c\b([^>]*)\/>/g;
      let cm;
      while ((cm = cRe.exec(rm[1]))) {
        const attrs = cm[1] || cm[3] || '';
        const inner = cm[2] || '';
        const tM = attrs.match(/\bt="([^"]+)"/);
        const t = tM ? tM[1] : '';
        let v = '';
        if (t === 'inlineStr') {
          const im = inner.match(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/);
          v = im ? im[1] : '';
        } else {
          const vm = inner.match(/<v>([\s\S]*?)<\/v>/);
          if (vm) {
            v = vm[1];
            if (t === 's') v = shared[Number(v)] !== undefined ? shared[Number(v)] : '';
          }
        }
        v = xmlEnt(v).trim();
        if (v) cells.push(v);
      }
      const line = cells.join(' ').trim();
      if (line) out.push(line);
    }
  }
  return out.join('\n').trim();
}

function extractKbText(name, buf) {
  const ext = (String(name).split('.').pop() || '').toLowerCase();
  try {
    if (['txt', 'md', 'csv', 'json', 'log'].includes(ext)) return buf.toString('utf8');
    if (ext === 'xlsx') return extractXlsxText(buf);
    if (ext === 'docx') {
      const doc = readZipEntry(buf, 'word/document.xml');
      if (!doc) return '';
      return doc.toString('utf8')
        .replace(/<w:tab[^>]*\/?>/g, ' ')
        .replace(/<\/w:p>/g, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    }
  } catch { }
  return ''; // pdf 等暂不支持解析（文件仍保存）
}

// 按客户消息从知识库检索相关段落（回复注入用）
function buildKbContext(query, capChars = 1800) {
  try {
    const docs = loadKbFiles().filter(d => d.chars > 0);
    if (!docs.length) return '';
    // 中文无空格：用二元组（bigram）做检索词，另保留英文/数字长词
    const nq = String(query || '').replace(/[\s\p{P}\p{S}]/gu, '');
    const termSet = new Set();
    for (let i = 0; i < nq.length - 1 && termSet.size < 30; i++) termSet.add(nq.slice(i, i + 2));
    for (const w of String(query || '').match(/[A-Za-z0-9]{3,}/g) || []) termSet.add(w);
    const terms = [...termSet];
    const hits = [];
    for (const d of docs) {
      let text = '';
      try { text = fs.readFileSync(path.join(KB_DIR, d.id + '.txt'), 'utf8'); } catch { continue; }
      const paras = text.split(/\n+|。/).map(s => s.trim()).filter(s => s.length >= 6);
      for (const p of paras) {
        let sc = 0;
        for (const t of terms) if (p.includes(t)) sc += t.length;
        if (sc >= 4) hits.push({ doc: d.name, text: p.slice(0, 300), sc });
      }
    }
    hits.sort((a, b) => b.sc - a.sc);
    let out = '';
    for (const h2 of hits) {
      const line = `【${h2.doc}】${h2.text}\n`;
      if ((out + line).length > capChars) break;
      out += line;
    }
    return out.trim();
  } catch { return ''; }
}

// 知识库摘要（无查询词时给 VLM 的全局资料，截断控制）
function buildKbDigest(capChars = 2200) {
  try {
    const docs = loadKbFiles().filter(d => d.chars > 0);
    if (!docs.length) return '';
    let out = '';
    for (const d of docs) {
      let text = '';
      try { text = fs.readFileSync(path.join(KB_DIR, d.id + '.txt'), 'utf8'); } catch { continue; }
      const line = `【${d.name}】\n${text.slice(0, 700)}\n`;
      if ((out + line).length > capChars) break;
      out += line;
    }
    return out.trim();
  } catch { return ''; }
}

// GET /shiflow/v2/sees/files?page&size —— 客户端知识库文件列表
async function handleKbList(req, res, u) {
  const page = Math.max(1, parseInt(u.searchParams.get('page') || '1', 10));
  const size = Math.max(1, Math.min(100, parseInt(u.searchParams.get('size') || '10', 10)));
  const all = loadKbFiles().sort((a, b) => String(b.uploaded_at).localeCompare(String(a.uploaded_at)));
  const items = all.slice((page - 1) * size, page * size);
  return jsonResponse(res, 200, { code: 0, body: { items, files: items, total: all.length, page, size } });
}

// POST /shiflow/v1/sees/files/upload —— 客户端知识库上传（multipart）
async function handleKbUpload(req, res, body) {
  try {
    const ct = String(req.headers['content-type'] || '');
    const bm = ct.match(/boundary=([^\s;]+)/);
    if (!bm) return jsonResponse(res, 200, { code: 0, body: { error: '缺少 multipart boundary' } });
    const boundary = Buffer.from('--' + bm[1]);
    const start = body.indexOf(boundary);
    const end = body.indexOf(boundary, start + boundary.length);
    if (start < 0 || end < 0) return jsonResponse(res, 200, { code: 0, body: { error: 'multipart 解析失败' } });
    const part = body.slice(start + boundary.length, end);
    const headEnd = part.indexOf('\r\n\r\n');
    const headText = part.slice(0, headEnd).toString('utf8');
    const fm = headText.match(/filename="([^"]*)"/);
    const name = fm ? fm[1] : ('kb_' + Date.now() + '.txt');
    let content = part.slice(headEnd + 4);
    if (content.length >= 2 && content[content.length - 2] === 13 && content[content.length - 1] === 10) content = content.slice(0, content.length - 2);
    if (content.length > 20 * 1024 * 1024) return jsonResponse(res, 200, { code: 0, body: { error: '文件超过 20MB 限制' } });

    const text = extractKbText(name, content);
    const id = 'kb_' + Date.now().toString(36) + '_' + crypto.randomBytes(3).toString('hex');
    fs.writeFileSync(path.join(KB_DIR, id + '.bin'), content);
    if (text) fs.writeFileSync(path.join(KB_DIR, id + '.txt'), text, 'utf8');
    const meta = { id, name, size: content.length, chars: text.length, uploaded_at: now() };
    const list = loadKbFiles();
    list.push(meta);
    saveKbFiles(list);
    log(`【kb/upload】${name} ${(content.length / 1024).toFixed(0)}KB 解析文本 ${text.length} 字`);
    return jsonResponse(res, 200, { code: 0, body: { ...meta, parsed: text.length > 0 } });
  } catch (e) {
    log('【kb/upload】失败:', e.message || e);
    return jsonResponse(res, 200, { code: 0, body: { error: String(e.message || e) } });
  }
}

// DELETE /shiflow/v2/sees/files/:id —— 删除知识库文件
async function handleKbDelete(req, res, id) {
  const list = loadKbFiles();
  const idx = list.findIndex(d => d.id === id);
  if (idx < 0) return jsonResponse(res, 200, { code: 0, body: { error: '文件不存在' } });
  const [gone] = list.splice(idx, 1);
  saveKbFiles(list);
  for (const ext of ['.bin', '.txt']) {
    try { fs.unlinkSync(path.join(KB_DIR, id + ext)); } catch { }
  }
  log(`【kb/delete】${gone.name}`);
  return jsonResponse(res, 200, { code: 0, body: { ok: true, id } });
}

// GET /kb/preview?id=xxx —— 面板用：查看解析文本
async function handleKbPreview(req, res, u) {
  const id = String(u.searchParams.get('id') || '');
  const d = loadKbFiles().find(x => x.id === id);
  if (!d) return jsonResponse(res, 200, { code: 0, body: { error: '文件不存在' } });
  let text = '';
  try { text = fs.readFileSync(path.join(KB_DIR, id + '.txt'), 'utf8'); } catch { }
  return jsonResponse(res, 200, { code: 0, body: { ...d, preview: text.slice(0, 200000), text_length: text.length } });
}

// POST /kb/test {query} —— 面板用：测试某条客户消息会命中哪些知识库段落
async function handleKbTest(req, res, body) {
  let payload = {};
  try { payload = JSON.parse(body.toString('utf8')); } catch { }
  const ctx = buildKbContext(String(payload.query || ''));
  return jsonResponse(res, 200, { code: 0, body: { query: String(payload.query || ''), matched: ctx, empty: !ctx } });
}

// ---------- SSE 辅助（主聊天流，客户端 SseEventDecoder 解析） ----------
function sseWrite(res, obj, event) {
  let frame = '';
  if (event) frame += `event: ${event}\n`;
  frame += `data: ${typeof obj === 'string' ? obj : JSON.stringify(obj)}\n\n`;
  res.write(frame);
}
function sseHeaders(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
}
function splitChunks(text, size = 8) {
  const chars = [...text];
  const out = [];
  for (let i = 0; i < chars.length; i += size) out.push(chars.slice(i, i + size).join(''));
  return out.length ? out : [''];
}

// ---------- 核心：截图 -> VLM -> 回复决策 ----------
// 人设优先级：本地存档 prompt_setting > 启用中的 auto 任务 system_prompt > config.json persona
function resolvePersona() {
  const archived = getArchivedPromptSetting();
  if (archived && archived.trim()) return archived;
  const activeAuto = loadTasks().find(t => t.type === 'auto' && t.status === 'open' && t.system_prompt);
  if (activeAuto) return activeAuto.system_prompt;
  const anyAuto = loadTasks().find(t => t.type === 'auto' && t.system_prompt);
  if (anyAuto) return anyAuto.system_prompt;
  return CONFIG.persona || '你是一名热情、简洁的在线客服';
}

// ---------- 人设/知识库内存缓存：按文件 mtime+size 签名失效 ----------
// 每个新窗口不再反复读盘拼人设和知识库摘要，文件一变（保存人设/传知识库）自动重载
function fileSig(files) {
  return files.map(f => {
    try { const s = fs.statSync(f); return f + ':' + s.mtimeMs + ':' + s.size; }
    catch { return f + ':gone'; }
  }).join('|');
}
const personaCache = { sig: '', text: '' };
function resolvePersonaCached() {
  const sig = fileSig([IMPORTED_SETTINGS_FILE, TASKS_FILE]);
  if (personaCache.text && personaCache.sig === sig) return personaCache.text;
  const p = resolvePersona();
  personaCache.sig = sig; personaCache.text = p;
  return p;
}
const kbDigestCache = { sig: '', text: '' };
function buildKbDigestCached(capChars = 2200) {
  const docs = loadKbFiles().filter(d => d.chars > 0);
  const sig = fileSig([KB_META_FILE].concat(docs.map(d => path.join(KB_DIR, d.id + '.txt'))));
  if (kbDigestCache.sig === sig) return kbDigestCache.text;
  const text = buildKbDigest(capChars);
  kbDigestCache.sig = sig; kbDigestCache.text = text;
  return text;
}

async function analyzeScreenshot({ base64, agentType, appType }) {
  const mime = detectImageMime(base64);
  const persona = resolvePersonaCached();
  const personaPreview = persona.slice(0, 50).split('\n').join(' ');
  log('【人设】使用: ' + personaPreview + '…（共' + persona.length + '字）');
  // 测试模式：文件传输助手联调（config.test_file_helper_reply=true 时生效）——
  // 文件传输助手里全是自己的消息，VLM 按常规规则会判定无需回复，无法验证自动发送链路
  const fileHelperTest = CONFIG.test_file_helper_reply === true;
  const kbDigest = buildKbDigestCached();
  const sys = [
    persona,
    ...(kbDigest ? ['以下是你必须掌握的知识库资料（产品、规则、FAQ）。回答产品相关问题严格以知识库为准；知识库没提到的内容不要编造：\n' + kbDigest] : []),
    '你会收到一张即时通讯软件（微信/企微/WhatsApp）聊天窗口的截图。请仔细观察截图中的聊天内容，完成两件事：',
    '1. 理解当前对话：对方（客户）最新发来的一条消息是什么；',
    '2. 严格按照上述人设的要求生成回复——语气、格式、长度、表情、话术结构都听人设的，人设没规定的才默认简洁口语化。',
    '3. 检查截图里我方（右侧气泡）已经说过的内容：不要重复已经说过的话。如果该表达的意思之前已发过，必须换一种措辞；如果客户没有新问题，只是重复确认，则 should_reply 置 false。',
    '',
    '如果截图中没有需要回复的新消息（例如只有自己的发言、空白窗口、系统提示），则不需要回复。',
    '严格只输出一个 JSON 对象，不要输出任何其他文字：',
    '{"chat_name":"当前聊天对象名称(取不到则空字符串)","chat_type":"私聊或群聊","customer_message":"对方最新一条消息原文(没有则空字符串)","should_reply":true或false,"reply":"回复内容(should_reply为false时为空字符串)"}',
    ...(fileHelperTest ? ['【联调测试规则】当前截图若来自微信「文件传输助手」会话：该会话里所有消息都是用户自己发的测试消息，请把最新一条消息当作客户消息处理，should_reply 一律为 true，并生成一条简短回复（回复开头加"【自动回复测试】"便于识别）。'] : [])
  ].join('\n');
  const messages = [
    { role: 'system', content: sys },
    {
      role: 'user',
      content: [
        { type: 'text', text: `请分析这张${appType === 'wecom' ? '企业微信' : appType === 'whatsapp' ? 'WhatsApp' : '微信'}聊天窗口截图并按要求输出 JSON。` },
        { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } }
      ]
    }
  ];
  const { text, model } = await llmChat({ provider: 'doubao', messages, timeoutMs: 45000 });
  const parsed = extractJson(text);
  if (!parsed) throw new Error(`VLM 输出无法解析为 JSON: ${text.slice(0, 200)}`);
  let reply = typeof parsed.reply === 'string' ? parsed.reply.trim() : '';
  const shouldReply = parsed.should_reply !== false && reply.length > 0;

  // 知识库改写：客户消息命中知识库段落时，回复严格以知识库内容为准（极速/深思都生效）
  let kbUsed = false;
  if (shouldReply) {
    const kbCtx = buildKbContext(parsed.customer_message || reply);
    if (kbCtx) {
      try {
        const krw = await llmChat({
          provider: 'doubao', timeoutMs: 30000,
          messages: [
            { role: 'system', content: `${persona}\n以下是知识库资料，回答产品相关问题必须严格以知识库为准，不要编造知识库没有的内容；知识库没有答案就按人设通用回应：\n${kbCtx}` },
            { role: 'user', content: `客户最新消息：${parsed.customer_message || '(未识别)'}\n回复草稿：${reply}\n请结合知识库把回复改得更准确（草稿已准确且无需补充则原样输出）。只输出最终回复文本。` }
          ]
        });
        const kt = krw.text.trim();
        if (kt) { reply = kt; kbUsed = true; log(`【知识库】命中资料，已按知识库改写回复（${kbCtx.length}字）`); }
      } catch (e) { log('【知识库】改写失败，使用原稿:', e.message || e); }
    }
  }

  // think/深思模式：DeepSeek 二次润色
  let polished = false;
  if (shouldReply && (agentType === 'think' || agentType === 'think_beta') && CONFIG.think_with_deepseek !== false) {
    try {
      const ds = await llmChat({
        provider: 'deepseek',
        timeoutMs: 30000,
        messages: [
          { role: 'system', content: `${persona}\n请基于对话上下文，把给定回复草稿润色得更自然、更贴合上下文。只输出润色后的回复文本，不要解释。` },
          { role: 'user', content: `客户最新消息：${parsed.customer_message || '(未识别)'}\n回复草稿：${reply}` }
        ]
      });
      const t = ds.text.trim();
      if (t) { reply = t; polished = true; }
    } catch (e) {
      log('【think】DeepSeek 润色失败，使用 VLM 原稿:', e.message || e);
    }
  }
  return {
    chatName: parsed.chat_name || '',
    chatType: parsed.chat_type === '群聊' ? '群聊' : '私聊',
    customerMessage: typeof parsed.customer_message === 'string' ? parsed.customer_message : '',
    shouldReply, reply, model, polished, kbUsed
  };
}

// 回复去重表：key=会话|客户消息 -> 回复时间戳
const repliedMessages = new Map();
const lastReplyAtChat = {}; // 同会话回复冷却：归一化会话名 -> 最近回复时间戳
let lastReplyChatName = ''; // 最近一次下发回复的会话名（供 verify_send 回报）

// 画面指纹（16x16 平均亮度哈希）：识别"画面没变化"的轮询帧，已回复后跳过 VLM 分析
function frameFingerprint(base64) {
  try {
    const png = decodePng(Buffer.from(base64, 'base64'));
    const W = 16, H = 16, vals = [];
    let sum = 0;
    for (let gy = 0; gy < H; gy++) {
      for (let gx = 0; gx < W; gx++) {
        const x = Math.min(png.width - 1, Math.round((gx + 0.5) * png.width / W));
        const y = Math.min(png.height - 1, Math.round((gy + 0.5) * png.height / H));
        const px = png.rgbAt(x, y);
        const lum = (px[0] * 299 + px[1] * 587 + px[2] * 114) / 1000;
        vals.push(lum); sum += lum;
      }
    }
    const avg = sum / vals.length;
    let bits = 0n;
    for (let i = 0; i < vals.length; i++) if (vals[i] >= avg) bits |= (1n << BigInt(i));
    return bits;
  } catch { return null; }
}
function hamming64(a, b) {
  let x = a ^ b, d = 0;
  while (x) { d += Number(x & 1n); x >>= 1n; }
  return d;
}
let lastReplyFrame = { fp: null, at: 0 }; // 最近一次已回复画面（3 分钟内一致则跳过分析）

// 会话名归一化：VLM 读名不稳定（"阿微@微信" vs "阿微"、"纯🐮🐴" vs "纯🐂🐎"），统一去掉平台后缀与 emoji 再比对
function normChatName(n) {
  return String(n || '')
    .replace(/@(微信|企微|企业微信|wechat|wecom)/gi, '')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, '')
    .replace(/\s+/g, '')
    .replace(/[\p{P}\p{S}\p{No}Ωω]+$/gu, '')
    .toLowerCase();
}
// 取某会话的记录（双方归一化后比较）
function recordsForChat(chatName, limit) {
  const want = normChatName(chatName);
  const all = loadRecords().filter(r => normChatName(r.target_name) === want);
  return limit ? all.slice(-limit) : all;
}

// ---------- 端点：POST /shiflow/v3|v2/sees/speed ----------
async function handleSeesSpeed(req, res, body) {
  let payload;
  try { payload = JSON.parse(body.toString('utf8')); }
  catch { return jsonResponse(res, 400, { code: 400, msg: 'invalid json' }); }

  const base64 = normalizeBase64(payload.base64_data);
  const agentType = payload.agent_type || 'speed';
  const appType = payload.app_type || 'wechat';
  noteEngineActivity(appType);
  const turnId = payload.client_turn_id || randId('turn');
  const turnStartAt = Date.now(); // 本轮开始时间：若早于引擎停止时刻，说明回复流会在已中止的旧轮里被丢弃
  const chatHistoryId = randId('local-chat');
  const traceThinking = randId('trace');
  const traceKeyboard = randId('trace');
  log(`【sees/speed】agent_type=${agentType} app_type=${appType} turn=${turnId} 图片=${(base64.length / 1024).toFixed(0)}KB base64, 窗口=${payload.width}x${payload.height}`);

  if (CONFIG.save_screenshots && base64) {
    fs.mkdirSync(SHOTS_DIR, { recursive: true });
    fs.writeFileSync(path.join(SHOTS_DIR, `${Date.now()}.${detectImageMime(base64) === 'image/jpeg' ? 'jpg' : 'png'}`), Buffer.from(base64, 'base64'));
  }

  sseHeaders(res);
  const t0 = Date.now();
  wpState.state = '回复中';
  wpState.at = now();
  const keepalive = setInterval(() => res.write(': keepalive\n\n'), 5000);
  const finish = () => { wpState.state = '查看中'; wpState.reply = ''; wpState.chat = ''; wpState.step = '查看会话中'; clearInterval(keepalive); sseWrite(res, '{}', 'done'); res.end(); };
  req.on('close', () => clearInterval(keepalive));

  if (!base64) {
    sseWrite(res, { action: 'stop-reply', data: '本地服务器：截图数据为空', trace_id: traceThinking, is_end: true });
    return finish();
  }

  try {
    // 画面级去重：与最近一次已回复画面近似（3 分钟内）→ 跳过 VLM 分析直接判无需回复（毫秒级，下一条更快）
    const fpNow = frameFingerprint(base64);
    if (fpNow && lastReplyFrame.fp && Date.now() - lastReplyFrame.at < 3 * 60 * 1000) {
      const dist = hamming64(fpNow, lastReplyFrame.fp);
      if (dist <= 4) {
        log(`【画面去重】与 ${Math.round((Date.now() - lastReplyFrame.at) / 1000)}s 前已回复画面一致（距离${dist}），跳过 VLM 分析 耗时 ${Date.now() - t0}ms`);
        sseWrite(res, { action: 'thinking', data: '本轮无需回复', trace_id: traceThinking, is_end: true, chat_history_id: chatHistoryId });
        sseWrite(res, { action: 'stop-reply', data: '该消息已回复过（画面未变）', trace_id: traceKeyboard, is_end: true, chat_history_id: chatHistoryId });
        return finish();
      }
    }
    // 思考流：先发一段 thinking，让客户端 UI 有反馈
    sseWrite(res, { action: 'thinking', data: '正在理解最新对话…', trace_id: traceThinking, is_end: false, chat_history_id: chatHistoryId });
    wpState.step = '正在理解对话';
    const result = await analyzeScreenshot({ base64, agentType, appType });
    // 非客户会话拦截：智能助理/智能总结/官方服务号等绝不回复（这些页面长得像聊天框，会骗过引擎）
    const BLOCKED = /智能助理|智能总结|企业微信团队|微信团队|腾讯新闻/.test(result.chatName || '')
      || (!fileHelperTestOrUndef() && /文件传输助手/.test(result.chatName || ''));
    function fileHelperTestOrUndef() { return CONFIG.test_file_helper_reply === true; }
    if (BLOCKED) {
      log(`【sees/speed】命中非客户会话「${result.chatName}」，拒绝回复`);
      appendJudge({ chat_name: result.chatName || '', chat_type: result.chatType, customer_message: result.customerMessage || '', reason: '非客户会话（功能页/服务号），不回复', app_type: appType, created_at: fmtTime(new Date()) });
      sseWrite(res, { action: 'thinking', data: '非客户会话，跳过回复', trace_id: traceThinking, is_end: true, chat_history_id: chatHistoryId });
      sseWrite(res, { action: 'stop-reply', data: '内置功能页/服务号不回复', trace_id: traceKeyboard, is_end: true, chat_history_id: chatHistoryId });
      return finish();
    }
    // 面板遮挡污染防护：聊机面板盖住企微时，VLM 可能把面板状态语读成「客户消息」，直接丢弃
    if (/内置功能页|服务号不回复|本轮无需回复|正在理解|继续观察中|非客户会话|刚回复过该会话/.test(result.customerMessage || '')) {
      log(`【sees/speed】客户消息疑似自家面板状态语，丢弃: "${(result.customerMessage || '').slice(0, 30)}"`);
      result.shouldReply = false; result.customerMessage = '';
    }
    // 空白会话名自救：VLM 读不出名字（空/"@微信"）时用标题条 OCR 补读——否则时序/补回兜底全失效，空名消息会被漏回
    if (!normChatName(result.chatName)) {
      const rescued = await readChatTitle(appType);
      if (rescued) {
        log(`【会话名补读】标题条 OCR 补读为「${rescued}」（VLM 原本读到"${result.chatName || '空'}"）`);
        result.chatName = rescued;
      }
    }
    // 沉淀聊天记录（必须先于时序先行检查入库——否则新消息还没落记录，时序会拿旧数据误判「我方已回复」漏回新消息）
    const ts = fmtTime(new Date());
    const chatName = result.chatName || '未知会话';
    if (result.customerMessage) {
      // 记录去重：轮询会反复识别同一条客户消息——同会话 30 分钟内已有近似记录则跳过，避免记录翻倍
      const normC = t => String(t).replace(/[\s\p{P}\p{S}]/gu, '');
      const bgC = t => { const n = normC(t); const st = new Set(); for (let i = 0; i < n.length - 1; i++) st.add(n.slice(i, i + 2)); return st; };
      const simC = (a, b) => { const A = bgC(a), B = bgC(b); if (!A.size || !B.size) return 0; let h = 0; for (const x of A) if (B.has(x)) h++; return h / Math.max(A.size, B.size); };
      const nowMs = Date.now();
      const recentDup = loadRecords().filter(r => {
        if (normChatName(r.target_name) !== normChatName(chatName) || r.nickname === 'sf_agent') return false;
        const t = Date.parse(String(r.created_at || '').replace(' ', 'T'));
        if (Number.isFinite(t) && nowMs - t > 30 * 60 * 1000) return false;
        return normC(r.content) === normC(result.customerMessage) || simC(r.content, result.customerMessage) >= 0.85;
      })[0];
      if (recentDup) {
        log(`【记录去重】客户消息与 ${recentDup.created_at} 近似，跳过重复沉淀: "${result.customerMessage.slice(0, 30)}"`);
      } else {
        appendRecord({ chat_type: result.chatType, target_name: chatName, nickname: chatName, content: result.customerMessage, created_at: ts, source: 'local-vlm', agent_type: agentType, app_type: appType });
        maybeAutoDakuan(result.customerMessage, chatName);
      }
    }
    // 去重降级为兜底：仅在 OCR 方向校验不可用时启用（主裁判是「最后一条必须是我方」规则）
    const dedupKey = `${normChatName(result.chatName)}|${result.customerMessage || ''}`.trim();
    let ocrVerdict = null; // 'left' | 'right' | null(不可用)
    let ocrRecentTexts = []; // 近几条气泡文本（碎片容错用）
    let lastOcrText = '';
    if (result.shouldReply && CONFIG.forbid_reply_when_last_is_ours !== false) {
      wpState.state = '回复中';
      // 时序先行（零成本）：记录显示最后是我方 → 直接不回；显示客户消息更新 → 直接回，OCR 只在无记录时才用（省 70% OCR 调用）
      let timingDecided = false;
      if (result.chatName) {
        try {
          const recs0 = recordsForChat(result.chatName);
          const lastC0 = [...recs0].reverse().find(r => r.nickname !== 'sf_agent');
          const lastA0 = [...recs0].reverse().find(r => r.nickname === 'sf_agent');
          const tc0 = lastC0 ? (Date.parse(String(lastC0.created_at || '').replace(' ', 'T')) || 0) : 0;
          const ta0 = lastA0 ? (Date.parse(String(lastA0.created_at || '').replace(' ', 'T')) || 0) : 0;
          if (lastA0 && ta0 >= tc0) {
            timingDecided = true;
            log(`【方向校验】时序先行：我方最近=${lastA0.created_at} ≥ 客户最近=${lastC0 ? lastC0.created_at : '无'} → 不回（免 OCR）`);
            appendJudge({ chat_name: result.chatName || '', chat_type: result.chatType, customer_message: result.customerMessage || '', reason: '已核实最后一句是我方回复（记录时序先行）', app_type: appType, created_at: fmtTime(new Date()) });
            sseWrite(res, { action: 'thinking', data: '本轮无需回复', trace_id: traceThinking, is_end: true, chat_history_id: chatHistoryId });
            sseWrite(res, { action: 'stop-reply', data: '最后一句已是我方回复', trace_id: traceKeyboard, is_end: true, chat_history_id: chatHistoryId });
            return finish();
          }
          if (lastC0 && tc0 > ta0) {
            timingDecided = true;
            log(`【方向校验】时序先行：客户最近=${lastC0.created_at} 晚于我方最近=${lastA0 ? lastA0.created_at : '（无）'} → 客户新消息直接回（免 OCR）`);
          }
        } catch { }
      }
      if (!timingDecided) try {
        const ctrl2 = new AbortController();
        const timer2 = setTimeout(() => ctrl2.abort('ocr_timeout'), 8000);
        let ocrResp;
        try {
          ocrResp = await fetch('http://127.0.0.1:7300/ocr/last_message', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ image_base64: base64, app_type: appType, bottom: true }), signal: ctrl2.signal
          });
        } finally { clearTimeout(timer2); }
        const ocrJson = await ocrResp.json();
        if (ocrJson.code === 0 && ocrJson.message) {
          const fragLen = String(ocrJson.message.text || '').replace(/[\s\p{P}\p{S}]/gu, '').length;
          if (fragLen >= 2) {
            ocrVerdict = ocrJson.message.role;
            lastOcrText = ocrJson.message.text;
            // 近几条气泡文本都留底：最后一条是碎片时，用前几条参与我方记录比对（防方向误判）
            ocrRecentTexts = [ocrJson.message].concat(ocrJson.message.recent || [])
              .map(m => String(m && m.text || '')).filter(Boolean).slice(0, 3);
            log(`【方向校验】最后一条=${ocrVerdict} text="${String(ocrJson.message.text).slice(0, 30)}"`);
          } else {
            log(`【方向校验】OCR 文本过短(净长${fragLen})视为不可用: "${String(ocrJson.message.text || '').slice(0, 30)}"`);
          }
        }
      } catch (e) {
        log('【方向校验】OCR 不可用:', e.message || e);
      }
      // 核心规则：最后一条是我方 → 不回；是客户 → 必须回
      // 权威判定：截图最后几条气泡与我方最近已发记录比对（不依赖位置判断，碎片逐条容错）
      if (ocrVerdict && result.chatName) {
        const normT = t => String(t).replace(/[\s\p{P}\p{S}]/gu, '');
        const candTexts = (ocrRecentTexts.length ? ocrRecentTexts : [lastOcrText || '']).map(normT).filter(Boolean);
        const ours = loadRecords()
          .filter(r => normChatName(r.target_name) === normChatName(result.chatName) && r.nickname === 'sf_agent')
          .slice(-5);
        const hit = ours.find(r => {
          const a = normT(r.content);
          return candTexts.some(b => a && b && (a.includes(b) || b.includes(a) || a === b));
        });
        if (hit) {
          log(`【方向校验】最后一条与我方 ${hit.created_at} 已发内容吻合 → 我方最后一句话，不回`);
          appendJudge({ chat_name: result.chatName || '', chat_type: result.chatType, customer_message: result.customerMessage || '', reason: `已核实最后一句是我方回复（与我方 ${hit.created_at} 已发内容吻合）`, app_type: appType, created_at: fmtTime(new Date()) });
          sseWrite(res, { action: 'thinking', data: '本轮无需回复', trace_id: traceThinking, is_end: true, chat_history_id: chatHistoryId });
          sseWrite(res, { action: 'stop-reply', data: '最后一句已是我方回复', trace_id: traceKeyboard, is_end: true, chat_history_id: chatHistoryId });
          return finish();
        }
      }
      if (ocrVerdict === 'right') {
        log('【方向校验】最后一条是我方消息 → 不回复（等待客户新消息）');
        appendJudge({ chat_name: result.chatName || '', chat_type: result.chatType, customer_message: result.customerMessage || '', reason: '最后一条是我方消息，等待客户新消息', app_type: appType, created_at: fmtTime(new Date()) });
        sseWrite(res, { action: 'thinking', data: '本轮无需回复', trace_id: traceThinking, is_end: true, chat_history_id: chatHistoryId });
        sseWrite(res, { action: 'stop-reply', data: '最后一条已是我方回复', trace_id: traceKeyboard, is_end: true, chat_history_id: chatHistoryId });
        return finish();
      }
    }
    if (result.shouldReply && dedupKey !== '|' && normChatName(result.chatName) && CONFIG.dedup_enabled !== false) {
      // 模糊去重：同会话、30分钟内、客户消息相似度≥0.8 即视为同一条（覆盖 VLM 误读个别字符）
      const normK = t => String(t).replace(/[\s\p{P}\p{S}]/gu, '');
      const bg = t => { const n = normK(t); const st = new Set(); for (let i = 0; i < n.length - 1; i++) st.add(n.slice(i, i + 2)); return st; };
      const simK = (a, b) => { const A = bg(a), B = bg(b); if (!A.size || !B.size) return 0; let h2 = 0; for (const x of A) if (B.has(x)) h2++; return h2 / Math.max(A.size, B.size); };
      const now2 = Date.now();
      let last = null;
      for (const [k, v] of repliedMessages) {
        if (now2 - v >= 3 * 60 * 1000) continue;
        const sep = k.indexOf('|');
        if (normChatName(k.slice(0, sep)) !== normChatName(result.chatName)) continue;
        if (k === dedupKey || simK(k.slice(sep + 1), result.customerMessage || '') >= 0.8) { last = v; break; }
      }
      if (last) {
        log(`【sees/speed】去重命中：该消息 ${Math.round((Date.now() - last) / 1000)}s 前已回复，跳过`);
        appendJudge({ chat_name: result.chatName || '', chat_type: result.chatType, customer_message: result.customerMessage || '', reason: `同一条消息 ${Math.round((Date.now() - last) / 1000)}s 前已回复过（去重拦截）`, app_type: appType, created_at: fmtTime(new Date()) });
        sseWrite(res, { action: 'thinking', data: '本轮无需回复', trace_id: traceThinking, is_end: true, chat_history_id: chatHistoryId });
        sseWrite(res, { action: 'stop-reply', data: '本轮无需回复', trace_id: traceKeyboard, is_end: true, chat_history_id: chatHistoryId });
        return finish();
      }
    }
    log(`【sees/speed】VLM(${result.model}) 耗时 ${Date.now() - t0}ms, should_reply=${result.shouldReply}, 客户消息="${result.customerMessage.slice(0, 60)}"`);
    // 让用户看到具体识别到的对话内容
    if (result.customerMessage) {
      sseWrite(res, { action: 'thinking', data: `对方最新说：「${result.customerMessage.slice(0, 60)}」`, trace_id: traceThinking, is_end: false, chat_history_id: chatHistoryId });
    }
    sseWrite(res, { action: 'thinking', data: result.shouldReply ? '理解完成，正在生成回复…' : '本轮无需回复', trace_id: traceThinking, is_end: true, chat_history_id: chatHistoryId });

    // 同会话回复冷却（默认 60s，config.reply_cooldown_ms 可调）：只对「同一条消息」冷却——
    // 冷却期内客户发来新内容（追问）必须放行，否则会漏回新消息
    const cooldownMs = CONFIG.reply_cooldown_ms || 60000;
    const msgSim = (a, b) => {
      const nk = t => String(t || '').replace(/[\s\p{P}\p{S}]/gu, '');
      const bg2 = t => { const n = nk(t); const st = new Set(); for (let i = 0; i < n.length - 1; i++) st.add(n.slice(i, i + 2)); return st; };
      const A = bg2(a), B = bg2(b); if (!A.size || !B.size) return 0;
      let h = 0; for (const x of A) if (B.has(x)) h++; return h / Math.max(A.size, B.size);
    };
    const cooldownEntry = cn => { const e = lastReplyAtChat[cn]; return typeof e === 'number' ? { at: e, msg: '' } : (e || { at: 0, msg: '' }); };
    if (result.shouldReply && result.chatName && normChatName(result.chatName)) {
      const cn = normChatName(result.chatName);
      const ent = cooldownEntry(cn);
      const inCooldown = Date.now() - ent.at < cooldownMs;
      const sameContent = !result.customerMessage || (ent.msg && msgSim(ent.msg, result.customerMessage) >= 0.8);
      if (inCooldown && sameContent) {
        log(`【回复冷却】${result.chatName} 同一条消息 ${Math.round((Date.now() - ent.at) / 1000)}s 前已回复，本轮跳过（冷却 ${cooldownMs / 1000}s）`);
        appendJudge({ chat_name: result.chatName || '', chat_type: result.chatType, customer_message: result.customerMessage || '', reason: `同一条消息 ${Math.round((Date.now() - ent.at) / 1000)}s 前刚回过（冷却拦截）`, app_type: appType, created_at: fmtTime(new Date()) });
        sseWrite(res, { action: 'thinking', data: '本轮无需回复', trace_id: traceThinking, is_end: true, chat_history_id: chatHistoryId });
        sseWrite(res, { action: 'stop-reply', data: '刚回复过该会话（冷却中）', trace_id: traceKeyboard, is_end: true, chat_history_id: chatHistoryId });
        return finish();
      }
      if (inCooldown) log(`【回复冷却】冷却期内但客户消息是新内容，放行追问（${result.chatName}）`);
    }

    if (!result.shouldReply) {
      // 用户规则：必须有「最后一句是我方回复」的实证才允许无需回复
      // 时序先行（零成本）：记录已能判定我方已回复时，直接免掉 OCR 举证（省 CPU）
      let timingOurs = false, timingUnanswered = false, timingSource = '';
      try {
        if (result.chatName && result.chatType !== '群聊') {
          const recs = recordsForChat(result.chatName);
          const lastC = [...recs].reverse().find(r => r.nickname !== 'sf_agent');
          const lastA = [...recs].reverse().find(r => r.nickname === 'sf_agent');
          if (lastC) {
            const tc = Date.parse(String(lastC.created_at || '').replace(' ', 'T')) || 0;
            const ta = lastA ? (Date.parse(String(lastA.created_at || '').replace(' ', 'T')) || 0) : 0;
            if (lastA && ta >= tc) timingOurs = true;
            else if (tc > ta) { timingUnanswered = true; timingSource = result.customerMessage || String(lastC.content || ''); }
            log(`【记录时序】客户最近=${lastC.created_at} 我方最近=${lastA ? lastA.created_at : '（无）'} → ${timingOurs ? '我方已回复(免OCR)' : timingUnanswered ? '客户未被回复' : '不明'}`);
          }
        }
      } catch (e) { log('【记录时序】校验异常:', e.message || e); }
      if (timingOurs) {
        appendJudge({ chat_name: result.chatName || '', chat_type: result.chatType, customer_message: result.customerMessage || '', reason: '已核实最后一句是我方回复（记录时序先行）', app_type: appType, created_at: fmtTime(new Date()) });
        sseWrite(res, { action: 'stop-reply', data: '已核实最后一句是我方回复', trace_id: traceKeyboard, is_end: true, chat_history_id: chatHistoryId });
        return finish();
      }

      let provenOurs = false, provenCustomer = false, lastTxt = '';
      try {
        const ctrl3 = new AbortController();
        const timer3 = setTimeout(() => ctrl3.abort('t'), 8000);
        let ocrR;
        try {
          ocrR = await fetch('http://127.0.0.1:7300/ocr/last_message', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ image_base64: base64, app_type: appType, bottom: true }), signal: ctrl3.signal
          });
        } finally { clearTimeout(timer3); }
        const oj = await ocrR.json();
        if (oj.code === 0 && oj.message) {
          lastTxt = String(oj.message.text || '');
          const normT = t => String(t).replace(/[\s\p{P}\p{S}]/gu, '');
          const lastN = normT(lastTxt);
          // 近几条气泡文本一起和我方记录比对（最后一条是碎片时不再误判）
          const candN = [oj.message].concat(oj.message.recent || []).map(m => normT(String(m && m.text || ''))).filter(Boolean).slice(0, 3);
          const ours = recordsForChat(result.chatName || '未知会话').filter(r => r.nickname === 'sf_agent').slice(-5);
          const matchOurs = !!(candN.length && ours.find(r => { const a = normT(r.content); return candN.some(b => a && b && (a.includes(b) || b.includes(a))); }));
          provenOurs = oj.message.role === 'right' || matchOurs;
          // 碎片拦截：OCR 文本净长<3（如 "目"、"?"、"昨天" 之类碎片/日期标签）不足以证明是客户新消息，不得触发强制补回
          provenCustomer = !provenOurs && lastN.length >= 3;
          log(`【无需回复举证】role=${oj.message.role} text="${lastTxt.slice(0, 30)}" 记录吻合=${matchOurs} 净长=${lastN.length} → ${provenOurs ? '我方' : provenCustomer ? '客户' : '过短存疑(继续观察)'}`);
        }
      } catch (e) { log('【无需回复举证】OCR 不可用:', e.message || e); }

      // 空名兜底：补读仍失败、但 OCR 明确最后一条是客户消息（净长≥5）——以「当前会话」放行补回，目标就是当前打开的窗口
      if (!normChatName(result.chatName) && provenCustomer) {
        result.chatName = '当前会话';
        log('【空名兜底】会话名读不出，但 OCR 确认最后一条是客户消息 → 以「当前会话」名义补回');
      }

      if (provenOurs || timingOurs) {
        appendJudge({ chat_name: result.chatName || '', chat_type: result.chatType, customer_message: result.customerMessage || '', reason: `已核实最后一句是我方回复（${provenOurs ? 'OCR 举证' : '记录时序'}）`, app_type: appType, created_at: fmtTime(new Date()) });
        sseWrite(res, { action: 'stop-reply', data: '已核实最后一句是我方回复', trace_id: traceKeyboard, is_end: true, chat_history_id: chatHistoryId });
        return finish();
      }
      // 强制补回：OCR 举证为客户（净长≥3），或记录时序显示客户消息未被回复——取最可信的文本来源
      // （同内容且在冷却期内才拦截；记录时序证明有新消息（timingUnanswered）时绝不拦截）
      let forceSource = (provenCustomer && lastTxt) ? lastTxt : (timingUnanswered ? timingSource : '');
      const why = (provenCustomer && lastTxt) ? `OCR 最后一条是客户 "${String(lastTxt).slice(0, 30)}"` : '记录时序：客户消息未被回复';
      if (forceSource && result.chatName) {
        const cn2 = normChatName(result.chatName);
        const ent2 = cooldownEntry(cn2);
        const same2 = !timingUnanswered && ent2.msg && msgSim(ent2.msg, forceSource) >= 0.8;
        if (Date.now() - ent2.at < cooldownMs && (same2 || (!timingUnanswered && !ent2.msg))) {
          log(`【回复冷却】强制补回被冷却拦截（${result.chatName}）`);
          forceSource = '';
        }
      }
      if (forceSource && result.chatName) {
        // 自家面板状态语黑名单：面板遮挡企微时 OCR 可能把聊机 UI 文字读成「客户消息」，绝不补回
        if (/内置功能页|服务号不回复|本轮无需回复|正在理解|继续观察中|非客户会话|刚回复过该会话/.test(forceSource)) {
          log(`【强制补回】举证文本疑似自家面板状态语，拦截: "${forceSource.slice(0, 30)}"`);
          forceSource = '';
        }
      }
      if (forceSource && result.chatName) {
        log(`【无需回复举证】VLM 判无需回复，但${why} → 强制补回`);
        try {
          const kbForce = buildKbContext(forceSource);
          const forced = await llmChat({
            provider: 'doubao', timeoutMs: 30000,
            messages: [
              { role: 'system', content: resolvePersona() + (kbForce ? '\n知识库资料（产品问题严格以此为准）：\n' + kbForce : '') + '\n根据客户最新消息生成一条客服回复。只输出回复文本。' },
              { role: 'user', content: '客户最新消息：' + forceSource }
            ]
          });
          const ft = forced.text.trim();
          if (ft) {
            sseWrite(res, { action: 'thinking', data: '复核发现客户消息未回复，正在回复…', trace_id: traceThinking, is_end: true, chat_history_id: chatHistoryId });
            for (const ch of splitChunks(ft, 8)) {
              sseWrite(res, { action: 'keyboard', data: ch, trace_id: traceKeyboard, is_end: false, chat_history_id: chatHistoryId, chat_name: result.chatName || '' });
              await new Promise(r2 => setTimeout(r2, 60));
            }
            sseWrite(res, { action: 'keyboard', data: '', trace_id: traceKeyboard, is_end: true, chat_history_id: chatHistoryId });
            lastReplyChatName = result.chatName || lastReplyChatName;
            if (turnStartAt < engineStoppedAt) {
              log(`【发送核实】补回本轮开始于引擎停止前，回复可能未送达【${result.chatName}】：不计入已回复记录，下轮重新判定`);
            } else {
              appendRecord({ chat_type: result.chatType, target_name: result.chatName || '未知会话', nickname: 'sf_agent', content: ft, created_at: fmtTime(new Date()), source: 'local-forced', agent_type: agentType, app_type: appType });
              wpState.reply = ft;
              wpState.chat = result.chatName || '';
              wpState.at = now();
              lastReplyFrame = { fp: fpNow, at: Date.now() };
              lastReplyAtChat[normChatName(result.chatName)] = { at: Date.now(), msg: forceSource };
            }
            log(`【发送回报】发送完成，已回复【${result.chatName || '未知会话'}】，开启下一个未读消息回复（强制补回，等待 verify_send 截图核实）`);
            return finish();
          }
        } catch (e) { log('【强制补回】生成失败:', e.message || e); }
      }
      // 无法举证：诚实提示并继续观察（不假装"无需回复"）
      appendJudge({ chat_name: result.chatName || '', chat_type: result.chatType, customer_message: result.customerMessage || '', reason: '未能确认对话状态，继续观察中', app_type: appType, created_at: fmtTime(new Date()) });
      sseWrite(res, { action: 'stop-reply', data: '未能确认对话状态，继续观察中…', trace_id: traceKeyboard, is_end: true, chat_history_id: chatHistoryId });
      return finish();
    }

    // 机械查重：同一会话近期我方已发内容，措辞近似则改写一次，仍近似则拦截
    if (result.shouldReply && result.reply) {
      const norm = t => String(t).replace(/[\s\p{P}\p{S}]/gu, '');
      const bigrams = t => { const n = norm(t); const st = new Set(); for (let i = 0; i < n.length - 1; i++) st.add(n.slice(i, i + 2)); return st; };
      const sim = (a, b) => {
        const A = bigrams(a), B = bigrams(b);
        if (!A.size || !B.size) return 0;
        let hit = 0; for (const x of A) if (B.has(x)) hit++;
        return hit / Math.max(A.size, B.size);
      };
      const recentOurs = loadRecords()
        .filter(r => normChatName(r.target_name) === normChatName(result.chatName) && r.nickname === 'sf_agent')
        .slice(-5);
      const dup = recentOurs.find(r => sim(r.content, result.reply) >= 0.6);
      if (dup) {
        log(`【防话术重复】与 ${dup.created_at} 已发内容相似: "${String(dup.content).slice(0, 30)}" ≈ "${result.reply.slice(0, 30)}"`);
        try {
          const rw = await llmChat({
            provider: 'doubao', timeoutMs: 15000, noFallback: true,
            messages: [
              { role: 'system', content: resolvePersona() + '\n把给定回复改写成意思相同但措辞明显不同的版本，只输出改写后的文本。' },
              { role: 'user', content: `已发过的旧回复：${dup.content}
需要改写的新回复：${result.reply}` }
            ]
          });
          const t2 = rw.text.trim();
          if (t2 && sim(t2, dup.content) < 0.6) {
            log('【防话术重复】已改写:', t2.slice(0, 40));
            result.reply = t2;
          } else {
            // 改写后仍近似：用改写版照发（客户新消息必须回，只是换个说法）
            log('【防话术重复】改写后仍近似，发送改写版');
            if (t2) result.reply = t2;
          }
        } catch (e) {
          log('【防话术重复】改写失败，发原版:', e.message || e);
        }
      }
    }

    // keyboard 分片流式输出回复
    // 引擎在本轮开始后被停过 → biz 已中止本轮流，回复极可能没贴上：不落记录/不设冷却，让下轮重新判
    const sendDropped = turnStartAt < engineStoppedAt;
    if (result.reply && sendDropped) {
      log(`【发送核实】本轮开始于引擎停止前，回复可能未送达【${chatName}】：不计入已回复记录，下轮重新判定`);
    }
    if (result.reply && !sendDropped) {
      appendRecord({ chat_type: result.chatType, target_name: chatName, nickname: 'sf_agent', content: result.reply, created_at: fmtTime(new Date()), source: result.polished ? 'local-vlm+deepseek' : 'local-vlm', agent_type: agentType, app_type: appType });
      wpState.reply = result.reply;
      wpState.chat = chatName;
      wpState.at = now();
      wpState.step = '正在发送回复';
      lastReplyFrame = { fp: fpNow, at: Date.now() };
      lastReplyAtChat[normChatName(chatName)] = { at: Date.now(), msg: result.customerMessage || '' };
    }
    const chunks = splitChunks(result.reply, 8);
    for (let i = 0; i < chunks.length; i++) {
      sseWrite(res, {
        action: 'keyboard',
        data: chunks[i],
        trace_id: traceKeyboard,
        is_end: i === chunks.length - 1,
        chat_history_id: chatHistoryId,
        chat_name: result.chatName || ''
      });
      // 模拟逐段生成的节奏，同时给客户端 RPA 留处理时间
      await new Promise(r => setTimeout(r, 60));
    }
    lastReplyChatName = result.chatName || lastReplyChatName;
    // 用户规则：发送后必须回报对象名 + 下一个动作，确保没回错
    log(`【发送回报】发送完成，已回复【${chatName}】，开启下一个未读消息回复（等待 verify_send 截图核实）`);
    // 回复已下发：记入去重表（30 分钟内同消息不再回复）；被丢弃的发送不记，保证下轮能补回
    if (dedupKey !== '|' && normChatName(chatName) && !sendDropped) {
      repliedMessages.set(dedupKey, Date.now());
      if (repliedMessages.size > 500) {
        const cutoff = Date.now() - 30 * 60 * 1000;
        for (const [k, v] of repliedMessages) if (v < cutoff) repliedMessages.delete(k);
      }
    }
    return finish();
  } catch (e) {
    log('【sees/speed】处理失败:', e.message || e);
    try {
      sseWrite(res, { action: 'thinking', data: `本地 AI 处理失败: ${String(e.message || e).slice(0, 120)}`, trace_id: traceThinking, is_end: true, chat_history_id: chatHistoryId });
      sseWrite(res, { action: 'stop-reply', data: '本地 AI 服务暂时不可用', trace_id: traceKeyboard, is_end: true, chat_history_id: chatHistoryId });
    } catch { /* 连接可能已断开 */ }
    return finish();
  }
}

// 企微侧边栏红点过滤。默认白名单：目录栏(x<14%w)里只有「消息」行(y90~145)和「分组未读区」(y415~530)的红点保留。
// 校准模式（/test/rail-calibrate 学过一次后）：改用黑名单——只丢「智能助理/智能总结/文档/待办/工作台」等功能目录行的点，
// 其余全保留（跨企微版本布局不同也不怕误杀聊天红点）
const RAIL_CAL_FILE = path.join(DATA_DIR, 'rail_calibration.json');
function railBlacklist(w, h) {
  try {
    const c = JSON.parse(fs.readFileSync(RAIL_CAL_FILE, 'utf8'));
    if (c && Array.isArray(c.fnBands) && c.fnBands.length && c.h > 0) {
      const sy = h / c.h;
      return c.fnBands.map(([a, b]) => [a * sy, b * sy]);
    }
  } catch { }
  return null;
}
function filterWecomRailDots(dots, appType, w, h) {
  if (appType !== 'wecom' || !Array.isArray(dots) || !dots.length || !w || !h) return dots;
  const cal = railBlacklist(w, h);
  const keep = [];
  let dropped = 0;
  for (const d of dots) {
    const cx = (d[0][0] + d[1][0]) / 2, cy = (d[0][1] + d[1][1]) / 2;
    if (cx < w * 0.14) {
      if (cal) { if (cal.some(([a, b]) => cy >= a && cy <= b)) { dropped++; continue; } }
      else if (!((cy >= 90 && cy <= 145) || (cy >= 415 && cy <= 530))) { dropped++; continue; }
    }
    keep.push(d);
  }
  if (dropped) log(`【unread/detect】企微侧边栏${cal ? '黑名单(校准)' : '白名单(默认)'}：源头丢弃 ${dropped} 个非聊天目录红点（智能助理/总结等）`);
  return keep;
}

// POST /test/rail-calibrate {app?} —— 侧边栏校准：截窗 → OCR 目录栏 → 记下功能目录行的 Y 区间
// （不同企微版本侧边目录不同：有的没有智能助理，写死的白名单会误杀聊天红点/误点头像）
async function handleRailCalibrate(req, res, body) {
  const t0 = Date.now();
  let payload = {};
  try { payload = JSON.parse(body.toString('utf8')); } catch { }
  const app = payload.app === 'wechat' ? 'wechat' : 'wecom';
  try {
    // 先前置目标窗口：校准依赖完整可见的侧边栏——被其他窗口（包括聊机自身）盖住会漏读功能行
    await selfPost('/test/activate', { app });
    await new Promise(r => setTimeout(r, 1200));
    const shot = await selfPost('/test/screenshot', { app });
    const b64 = shot && shot.body && shot.body.image_base64;
    if (!b64) return jsonResponse(res, 200, { code: 0, body: { error: '截图失败：' + ((shot && shot.body && shot.body.error) || '未知') } });
    let w = 0, h = 0;
    try { const png = decodePng(Buffer.from(b64, 'base64')); w = png.width; h = png.height; } catch { }
    if (!w || !h) return jsonResponse(res, 200, { code: 0, body: { error: '截图尺寸无法解析' } });
    const railW = Math.round(w * 0.14);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort('t'), 20000);
    let oj;
    try {
      oj = await (await fetch('http://127.0.0.1:7300/ocr', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image_base64: b64, region: [0, 0, railW, h] }), signal: ctrl.signal
      })).json();
    } finally { clearTimeout(timer); }
    const boxes = (oj && oj.boxes) || [];
    const FN = /智能助理|智能总结|智能文档|文档|待办|工作台|微盘|会议|视频号|打卡|审批|汇报|邮箱|收集表|对外收款|直播/;
    const CHAT = /^(消息|微信)$/;
    const UNREAD = /^(未读|单聊|群聊)$/;
    const fnBands = [];
    const found = [];
    let msgY = null;
    let unreadY = null; let unreadX = null;
    for (const b of boxes) {
      const text = String(b.text || '').trim();
      const cy = (b.bbox[0][1] + b.bbox[1][1]) / 2;
      if (FN.test(text)) { fnBands.push([cy - 24, cy + 24]); found.push(text); }
      if (CHAT.test(text)) msgY = cy;
      if (UNREAD.test(text) && (unreadY === null || cy < unreadY)) { unreadY = cy; unreadX = (b.bbox[0][0] + b.bbox[1][0]) / 2; }
    }
    fnBands.sort((a, b) => a[0] - b[0]);
    // 合并重叠/相邻区间
    const merged = [];
    for (const band of fnBands) {
      const last = merged[merged.length - 1];
      if (last && band[0] <= last[1] + 8) { last[1] = Math.max(last[1], band[1]); } else merged.push(band);
    }
    fs.writeFileSync(RAIL_CAL_FILE, JSON.stringify({ fnBands: merged, msg_row_y: msgY, unread_row_y: unreadY, unread_row_x: unreadX, w, h, at: now(), found }, null, 2), 'utf8');
    log(`【rail-calibrate】目录栏 OCR 到 ${boxes.length} 个文本块，功能目录行 ${merged.length} 段（${found.join('、') || '无'}），消息行 Y=${msgY || '未读到'}，未读行 Y=${unreadY || '未读到'} 耗时 ${Date.now() - t0}ms`);
    return jsonResponse(res, 200, { code: 0, body: {
      ok: true, window: `${w}x${h}`, fn_bands: merged, found_labels: found, msg_row_y: msgY, unread_row_y: unreadY,
      note: found.length ? '已按本机侧边栏布局校准：功能目录行的红点将被丢弃，其余保留' : '没读到任何功能目录（这版企微侧边栏很干净），所有红点都会保留',
      elapsed_ms: Date.now() - t0
    } });
  } catch (e) {
    log('【rail-calibrate】失败:', e.message || e);
    return jsonResponse(res, 200, { code: 0, body: { error: String(e.message || e) } });
  }
}

// ---------- 端点：POST /shiflow/v1/unread/detect ----------
// 真实客户端发的是 JPEG（PNG 启发式只覆盖少数情况），非 PNG 走 VLM 快路径，
// VLM 超时/失败兜底返回合法空结果，客户端会继续轮询不崩。
function emptyUnreadResult(t0, w, h, note) {
  return {
    code: 0,
    body: {
      dialogue_red_dots: [],
      has_unread: false,
      is_chats_on_red: false,
      total_time: (Date.now() - t0) / 1000,
      image_width: w || 0,
      image_height: h || 0,
      ...(note ? { note } : {})
    }
  };
}
async function handleUnreadDetect(req, res, body) {
  const t0 = Date.now();
  let payload;
  try { payload = JSON.parse(body.toString('utf8')); }
  catch { return jsonResponse(res, 400, { code: 400, msg: 'invalid json' }); }
  const base64 = normalizeBase64(payload.image_base64);
  if (!base64) return jsonResponse(res, 200, emptyUnreadResult(t0, 0, 0, 'empty image'));
  const appType = String(payload.app_type || 'wechat');
  noteEngineActivity(appType);
  // 诊断：记录原始字符串头部与长度（真机排查格式用，采样输出）
  unreadDiagCount++;
  if (unreadDiagCount <= 5 || unreadDiagCount % 60 === 0) {
    log(`【unread/detect诊断】len=${base64.length} head="${base64.slice(0, 80)}" keys=${Object.keys(payload).join(',')}`);
  }
  const buf = Buffer.from(base64.slice(0, 64), 'base64');
  const hexHead = buf.subarray(0, 16).toString('hex');
  const mime = detectImageMime(base64);
  const reqW = Number(payload.width) || Number(payload.image_width) || 0;
  const reqH = Number(payload.height) || Number(payload.image_height) || 0;

  // PNG：纯 JS 红点启发式（快，~百 ms）
  if (mime === 'image/png') {
    try {
      const png = decodePng(Buffer.from(base64, 'base64'));
      const { dots } = detectRedDots(png);
      const kept = filterWecomRailDots(dots, appType, png.width, png.height);
      const has = kept.length > 0;
      log(`【unread/detect】PNG ${png.width}x${png.height} 红点=${kept.length} 耗时 ${Date.now() - t0}ms`);
      return jsonResponse(res, 200, {
        code: 0,
        body: {
          dialogue_red_dots: kept,
          has_unread: has,
          is_chats_on_red: has,
          total_time: (Date.now() - t0) / 1000,
          image_width: png.width,
          image_height: png.height
        }
      });
    } catch (e) {
      log('【unread/detect】PNG 解码失败，转 VLM 快路径:', e.message || e, 'hex=' + hexHead);
    }
  } else {
    log(`【unread/detect】非 PNG（${mime} hex=${hexHead}），走 VLM 快路径`);
  }

  // JPEG/WebP/其它：VLM 快路径（ep 接入点，目标 <2.5s）
  try {
    const { text, model } = await llmChat({
      provider: 'doubao',
      timeoutMs: 12000,
      responseFormat: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: [
            '你是微信未读红点检测器。给你一张即时通讯软件会话列表截图。',
            '找出所有红色未读角标（圆形或带数字的红色小圆点，通常在会话头像或会话条目右上角）。',
            '严格只输出 JSON：{"dots":[[x1,y1,x2,y2],...]}，坐标为红点在图片中的像素包围盒（左上角原点）。',
            '如果没有红点，输出 {"dots":[]}。不要输出任何其他文字。'
          ].join('\n')
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: '检测这张会话列表截图的红色未读角标，输出 JSON。' },
            { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } }
          ]
        }
      ]
    });
    // 解析 dots：优先 JSON，失败正则抓 [[x1,y1,x2,y2],...]
    let dots = [];
    const parsed = extractJson(text);
    if (parsed && Array.isArray(parsed.dots)) {
      dots = parsed.dots;
    } else {
      const m = text.match(/\[\s*\[[\d\s,.\[\]]*\]\s*\]/);
      if (m) { try { dots = JSON.parse(m[0]); } catch { } }
    }
    // 校验并规整为 [[[x1,y1],[x2,y2]],...]，过滤畸形项
    const clean = [];
    for (const d of dots) {
      if (!Array.isArray(d)) continue;
      let x1, y1, x2, y2;
      if (d.length === 4 && d.every(Number.isFinite)) [x1, y1, x2, y2] = d;
      else if (d.length === 2 && Array.isArray(d[0]) && Array.isArray(d[1])) { [x1, y1] = d[0]; [x2, y2] = d[1]; }
      else continue;
      if (![x1, y1, x2, y2].every(Number.isFinite) || x2 <= x1 || y2 <= y1) continue;
      clean.push([[Math.round(x1), Math.round(y1)], [Math.round(x2), Math.round(y2)]]);
    }
    const kept = filterWecomRailDots(clean, appType, reqW, reqH);
    const has = kept.length > 0;
    log(`【unread/detect】VLM(${model}) ${mime} 红点=${kept.length} 耗时 ${Date.now() - t0}ms`);
    return jsonResponse(res, 200, {
      code: 0,
      body: {
        dialogue_red_dots: kept,
        has_unread: has,
        is_chats_on_red: has,
        total_time: (Date.now() - t0) / 1000,
        image_width: reqW,
        image_height: reqH
      }
    });
  } catch (e) {
    log(`【unread/detect】VLM 快路径失败（${Date.now() - t0}ms），返回合法空结果:`, e.message || e);
    return jsonResponse(res, 200, emptyUnreadResult(t0, reqW, reqH, 'vlm_unavailable'));
  }
}

// ---------- 端点：POST /shiflow/v1/sees/grounding/resolve ----------
const OPERATION_HINTS = {
  'search.candidates': '搜索框或搜索结果候选列表',
  'chat_entrance': '聊天入口（会话列表中目标会话的可点击区域）',
  'message_input': '消息输入框',
  'search_input': '搜索输入框',
  'collection_button': '收藏内容项或收藏按钮',
  'send_targets': '搜索结果第一项与发送按钮'
};
// 从 VLM 文本中稳健提取坐标点：JSON -> "x":N "y":N -> [N,N] -> 前两个整数
function extractPoint(text, width, height) {
  const clampOk = (x, y) => Number.isFinite(x) && Number.isFinite(y) &&
    x >= -width * 0.08 && y >= -height * 0.08 && x <= width * 1.08 && y <= height * 1.08;
  const parsed = extractJson(text);
  const pt = parsed && parsed.point;
  if (pt && clampOk(Number(pt.x), Number(pt.y))) return { x: Number(pt.x), y: Number(pt.y) };
  if (parsed && parsed.point === null) return null;
  // 显式 "x":N ... "y":N（兼容畸形 JSON，如 {"point":{"x":223,"392}}）
  const mx = text.match(/"x"\s*:\s*(-?\d+(?:\.\d+)?)/);
  const my = text.match(/"y"\s*:\s*(-?\d+(?:\.\d+)?)/);
  if (mx && my && clampOk(Number(mx[1]), Number(my[1]))) return { x: Number(mx[1]), y: Number(my[1]) };
  // 模型把 y 写成键名的畸形输出：{"point":{"x":255,"498":"498"}}——取 x 之后的第一个数字当 y
  if (mx) {
    const rest = text.slice(mx.index + mx[0].length, mx.index + mx[0].length + 40);
    const my2 = rest.match(/(\d{1,4}(?:\.\d+)?)/);
    if (my2 && clampOk(Number(mx[1]), Number(my2[1]))) return { x: Number(mx[1]), y: Number(my2[1]) };
  }
  // 坐标对 [223,392] 或 (223,392)
  const mp = text.match(/[\[\(]\s*(-?\d+(?:\.\d+)?)\s*[,，]\s*(-?\d+(?:\.\d+)?)\s*[\]\)]/);
  if (mp && clampOk(Number(mp[1]), Number(mp[2]))) return { x: Number(mp[1]), y: Number(mp[2]) };
  // x:223 y:392 / x 223 y 392 变体
  const mv = text.match(/x\s*[:：]?\s*(-?\d+(?:\.\d+)?)[\s,，]+y?\s*[:：]?\s*(-?\d+(?:\.\d+)?)/i);
  if (mv && clampOk(Number(mv[1]), Number(mv[2]))) return { x: Number(mv[1]), y: Number(mv[2]) };
  return undefined; // 无法解析
}

async function handleGroundingResolve(req, res, body) {
  let payload;
  try { payload = JSON.parse(body.toString('utf8')); }
  catch { return jsonResponse(res, 400, { code: 400, msg: 'invalid json' }); }
  const operation = String(payload.operation || '');
  noteEngineActivity(operation.includes('wecom') ? 'wecom' : 'wechat');
  const frame = payload.frame || {};
  const frameId = frame.id || randId('grounding');
  const width = frame.width_px, height = frame.height_px;
  const base64 = normalizeBase64(frame.image_base64);
  log(`【grounding】operation=${operation} frame=${frameId} ${width}x${height}`);

  // 客户端校验：operation/frame_id/coordinate_space/frame 尺寸必须逐字段回显
  const envelope = result => jsonResponse(res, 200, {
    code: 0,
    body: {
      operation,
      frame_id: frameId,
      coordinate_space: 'frame_pixels',
      frame_width_px: width,
      frame_height_px: height,
      result
    }
  });
  const nullResult = () => envelope({ point: null });
  const crop = frame.crop_px || null; // 裁剪图：VLM 坐标需平移回完整帧
  const toFrame = (x, y) => crop ? [x + (crop.left || 0), y + (crop.top || 0)] : [x, y];

  if (!base64 || !Number.isInteger(width) || !Number.isInteger(height)) return nullResult();

  // chat_main 布局探测：客户端要的是「聊天消息区顶边界的 bbox」（只要 bbox.top）
  if (operation.includes('layout.chat_main') || operation.includes('layout.header')) {
    // 客户端只用 bbox.top（消息区上边界），该位置高度可预测——VLM 只答一个数字，失败直接按比例合成
    let topPx = null;
    try {
      const mime0 = detectImageMime(base64);
      const { text } = await llmChat({
        provider: 'doubao', timeoutMs: 6000, noFallback: true,
        responseFormat: { type: 'json_object' },
        messages: [{ role: 'user', content: [
          { type: 'text', text: '这是微信聊天窗口截图（可能是裁剪区）。聊天标题栏下方、第一条消息气泡的上边界在图片纵轴的哪个像素位置？只返回 JSON：{"top": 整数}。' },
          { type: 'image_url', image_url: { url: `data:${mime0};base64,${base64}` } }
        ] }]
      });
      const m = String(text).match(/"top"\s*:\s*(\d+)/);
      if (m) topPx = Number(m[1]);
    } catch (e) {
      log('【grounding】chat_main VLM 失败（用比例兜底）:', e.message || e);
    }
    if (topPx === null) {
      topPx = Math.round(height * 0.115); // 微信标题栏+间隔约占 11.5%
      log(`【grounding】chat_main 合成 top=${topPx}`);
    }
    const [, fy1] = toFrame(0, topPx);
    return envelope({
      bbox: { left: 0, top: Math.round(fy1), right: width, bottom: Math.round(fy1 + 100) },
      point: { x: Math.round(width / 2), y: Math.round(fy1 + 5) }
    });
  }

  try {
    const mime = detectImageMime(base64);
    const hint = OPERATION_HINTS[Object.keys(OPERATION_HINTS).find(k => operation.includes(k))] || operation;
    const cropNote = frame.crop_px ? `（本图是从完整窗口裁剪出来的区域，坐标仍按本图自身的像素坐标返回）` : '';
    const { text } = await llmChat({
      provider: 'doubao',
      timeoutMs: 30000,
      responseFormat: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: [
            '你是 UI 元素定位器。给你一张聊天软件界面截图，图片尺寸为 ' + width + 'x' + height + ' 像素（左上角为原点 0,0）。',
            `请定位「${hint}」的中心点位置${cropNote}。`,
            '只返回 JSON，格式 {"point":{"x":整数,"y":整数}}，坐标是相对整张图片的像素坐标，必须是图片范围内的整数。',
            '如果图片中确实找不到该元素，输出 {"point":null}。不要输出任何其他文字。'
          ].join('\n')
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: `operation: ${operation}，请输出坐标 JSON。` },
            { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } }
          ]
        }
      ]
    });
    const pt = extractPoint(text, width, height);
    if (pt) {
      const [fx, fy] = toFrame(pt.x, pt.y);
      const cx = Math.round(Math.min(width, Math.max(0, fx)));
      const cy = Math.round(Math.min(height, Math.max(0, fy)));
      // 企微侧边栏白名单：x<14% 的目录栏里，只有「消息」行(y≈111) 和「分组未读区」(y≈415~530) 可点——
      // 智能助理/智能总结/文档/待办/工作台等目录一旦命中即拦截（返回空点位，客户端本轮跳过，安全兜底）
      if (operation.includes('wecom') && cx < width * 0.14) {
        const inMsgRow = cy >= 90 && cy <= 145;
        const inGroupRows = cy >= 415 && cy <= 530;
        if (!inMsgRow && !inGroupRows) {
          log(`【grounding】点位(${cx},${cy})命中企微侧边栏非聊天目录（白名单外），已拦截返回空点位`);
          return nullResult();
        }
      }
      log(`【grounding】VLM 定位成功: (${cx}, ${cy})${cx !== Math.round(pt.x) || cy !== Math.round(pt.y) ? ' (已钳制越界坐标)' : ''}`);
      return envelope({ point: { x: cx, y: cy } });
    }
    if (pt === null) {
      log('【grounding】VLM 明确返回 point:null（未找到元素）');
      return nullResult();
    }
    log('【grounding】VLM 输出无法解析坐标，返回空点位:', text.slice(0, 120));
    return nullResult();
  } catch (e) {
    // 兜底：返回空点位（客户端对空点位有容错，会走“未找到”分支而不是乱点）
    log('【grounding】VLM 调用失败，返回空点位:', e.message || e);
    return nullResult();
  }
}

// ---------- 端点：POST /shiflow/v1/sees/chat/completions（multipart, SSE 代理） ----------
function parseMultipart(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!m) throw new Error('缺少 multipart boundary');
  const boundary = Buffer.from('--' + (m[1] || m[2]));
  const fields = {};
  let start = buf.indexOf(boundary);
  while (start !== -1) {
    let pos = start + boundary.length;
    if (buf[pos] === 45 && buf[pos + 1] === 45) break; // 结束边界
    if (buf[pos] === 13 && buf[pos + 1] === 10) pos += 2;
    const headEnd = buf.indexOf('\r\n\r\n', pos);
    if (headEnd === -1) break;
    const head = buf.toString('utf8', pos, headEnd);
    const nameM = /name="([^"]+)"/.exec(head);
    const bodyStart = headEnd + 4;
    let next = buf.indexOf(boundary, bodyStart);
    if (next === -1) break;
    // 去掉结尾的 \r\n
    let end = next;
    if (buf[end - 2] === 13 && buf[end - 1] === 10) end -= 2;
    if (nameM) fields[nameM[1]] = buf.toString('utf8', bodyStart, end);
    start = next;
  }
  return fields;
}
async function handleChatCompletions(req, res, body, contentType) {
  let fields;
  try { fields = parseMultipart(body, contentType); }
  catch (e) { return jsonResponse(res, 400, { code: 400, msg: e.message }); }
  const question = fields.question || '';
  const prompt = fields.prompt || '';
  const imageBase64 = normalizeBase64(fields.image_base64);
  log(`【chat/completions】question="${question.slice(0, 50)}" 图片=${(imageBase64.length / 1024).toFixed(0)}KB`);

  sseHeaders(res);
  const keepalive = setInterval(() => res.write(': keepalive\n\n'), 5000);
  const done = () => { clearInterval(keepalive); sseWrite(res, '', 'done'); res.end(); };
  req.on('close', () => clearInterval(keepalive));
  try {
    const content = [];
    if (prompt) content.push({ type: 'text', text: prompt });
    content.push({ type: 'text', text: question || '请描述这张图片。' });
    if (imageBase64) content.push({ type: 'image_url', image_url: { url: `data:${detectImageMime(imageBase64)};base64,${imageBase64}` } });
    const { text } = await llmChat({
      provider: 'doubao', timeoutMs: 45000,
      messages: [{ role: 'user', content }]
    });
    // 客户端协议：event: content 逐段累加（空 data 视为空格），event: done 结束，event: error 报错
    for (const piece of splitChunks(text, 12)) {
      sseWrite(res, piece, 'content');
      await new Promise(r => setTimeout(r, 30));
    }
    return done();
  } catch (e) {
    log('【chat/completions】失败:', e.message || e);
    try { sseWrite(res, String(e.message || e).slice(0, 200), 'error'); } catch { }
    clearInterval(keepalive);
    return res.end();
  }
}

// ---------- 登录 mock：任意账号/手机号+任意密码/验证码均登录成功 ----------
// 伪造但格式合法的 JWT（三段 base64url，payload 带 sub 与 2099 年 exp）
function fakeJwt(subject) {
  const b64 = o => Buffer.from(JSON.stringify(o), 'utf8').toString('base64url');
  const header = b64({ alg: 'HS256', typ: 'JWT' });
  const payload = b64({
    sub: String(subject || 'local-user'),
    username: String(subject || 'local-user'),
    iat: Math.floor(Date.now() / 1000),
    exp: 4099680000 // 2099-12-01T00:00:00Z
  });
  const sig = crypto.createHmac('sha256', 'liaoji-local-secret').update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${sig}`;
}
function loginOkBody(username, extra = {}) {
  return { access_token: fakeJwt(username), username: String(username || 'local-user'), avatar: '', ...extra };
}
// 路径可能带 /shiflow/v1 前缀（apiRequest 默认走 v1 scope），统一剥掉再匹配
function stripApiPrefix(p) {
  const m = p.match(/^\/shiflow\/v[123](\/.*)$/);
  return m ? m[1] : p;
}
function handleLoginMock(req, res, body, p) {
  let payload = {};
  if (body && body.length) {
    try { payload = JSON.parse(body.toString('utf8')); } catch { /* 容忍空/坏 body */ }
  }
  switch (p) {
    case '/login': { // 账号密码登录：biz ACCOUNT_LOGIN 期望 {code:0, body:{access_token, username, avatar}}
      const username = payload.username || 'local-user';
      log(`【登录 mock】/login 账号="${username}"（任意密码均通过）`);
      return jsonResponse(res, 200, { code: 0, msg: 'ok', body: loginOkBody(username) });
    }
    case '/phone_code': { // 发送短信验证码：biz PHONE_CODE 检查 code===200||0||success
      log(`【登录 mock】/phone_code 手机号="${payload.phone || ''}"（本地 mock，任意验证码均可登录）`);
      return jsonResponse(res, 200, { code: 200, msg: '验证码已发送（本地 mock：任意验证码均可登录）', success: true });
    }
    case '/phone_login': { // 手机号+验证码登录：biz PHONE_LOGIN 期望 {code:200, data|body:{token|access_token, user:{...}}}
      const phone = payload.phone || '13800000000';
      const data = {
        token: fakeJwt(phone), access_token: fakeJwt(phone),
        user: { id: 10001, username: `用户${String(phone).slice(-4)}`, nickname: `用户${String(phone).slice(-4)}`, avatar: '', phone }
      };
      log(`【登录 mock】/phone_login 手机号="${phone}"（任意验证码均通过）`);
      return jsonResponse(res, 200, { code: 200, msg: 'ok', success: true, data, body: data });
    }
    case '/register': { // 注册：biz ACCOUNT_REGISTER 检查 code===0
      log(`【登录 mock】/register 账号="${payload.username || ''}"`);
      return jsonResponse(res, 200, { code: 0, msg: 'ok' });
    }
    case '/qrcode': { // 扫码登录二维码：biz REQUEST_LOGIN_QRCODE 期望 {code:0, body:{ticket, nonce}}
      const nonce = randId('local-nonce');
      log('【登录 mock】/qrcode 下发本地 ticket/nonce（二维码图片不可扫，请改用账号/手机号登录）');
      return jsonResponse(res, 200, { code: 0, body: { ticket: `local-ticket-${nonce}`, nonce } });
    }
    case '/qrcode/login': { // 扫码轮询：返回 code:0 但无 access_token -> 客户端视为"等待中"，不报错
      return jsonResponse(res, 200, { code: 0, msg: 'waiting', body: {} });
    }
    case '/phone_bind': // 绑定手机号：直接成功
      log('【登录 mock】/phone_bind 直接成功');
      return jsonResponse(res, 200, { code: 0, msg: 'ok', body: {} });
    default:
      return null;
  }
}

// ---------- 假账户体系 / 设置 ----------
const FAKE_SETTINGS = {
  balance: 999999, left_count: 999999, total_count: 999999,
  month_left_count: 0, point_left_count: 0,
  vip_level: 'corp', expired_at: '2099-12-31T23:59:59Z'
};
const AGENT_TYPES = [
  { alias: '极速', name: '极速模式', value: 'speed', key: 'fast' },
  { alias: '深思', name: '深思模式', value: 'think', key: 'deep' }
];

// ---------- 本地设置存档（imported_settings.json） ----------
const IMPORTED_SETTINGS_FILE = path.join(DATA_DIR, 'imported_settings.json');
function loadImportedSettings() {
  try { return JSON.parse(fs.readFileSync(IMPORTED_SETTINGS_FILE, 'utf8')); }
  catch { return null; }
}
function saveImportedSettings(obj) {
  fs.writeFileSync(IMPORTED_SETTINGS_FILE, JSON.stringify(obj, null, 1), 'utf8');
}
// 本地人设存档（设置页保存的内容）
function getArchivedPromptSetting() {
  const imp = loadImportedSettings();
  if (imp && typeof imp.prompt_setting === 'string') return imp.prompt_setting;
  return imp?.accounts_settings?.body?.prompt_content ?? '';
}

// ---------- 任务体系（tasks.json 持久化，初始数据为原版复刻的真实任务） ----------
const TASKS_FILE = path.join(DATA_DIR, 'tasks.json');
function loadTasks() {
  try { return JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8')); }
  catch { return []; }
}
function saveTasks(tasks) {
  fs.writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 1), 'utf8');
}
function isoNow() {
  // 与服务端一致：+08:00 时区 ISO
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return d.toISOString().slice(0, 19) + '+08:00';
}
function nextTaskId(tasks) {
  return tasks.reduce((m, t) => Math.max(m, Number(t.id) || 0), 0) + 1;
}
function handleTaskList(res, query) {
  const all = loadTasks();
  const type = query.get('type') || '';
  const name = query.get('name') || '';
  let items = all.filter(t => (!type || t.type === type) && (!name || String(t.name || '').includes(name)));
  // 无分页参数时返回全部（对齐真实服务器 get_all_task 无参行为）
  if (!query.has('page') && !query.has('size')) {
    return jsonResponse(res, 200, { code: 0, msg: 'ok', body: { items, total: items.length, total_count: items.length } });
  }
  const page = Math.max(1, parseInt(query.get('page') || '1', 10) || 1);
  const size = Math.min(200, Math.max(1, parseInt(query.get('size') || '10', 10) || 10));
  const total = items.length;
  items = items.slice((page - 1) * size, page * size);
  return jsonResponse(res, 200, { code: 0, msg: 'ok', body: { items, total, total_count: total, page, size } });
}
function handleTaskCreate(res, body) {
  let payload;
  try { payload = JSON.parse(body.toString('utf8')); }
  catch { return jsonResponse(res, 400, { code: 400, msg: 'invalid json' }); }
  const tasks = loadTasks();
  const now = isoNow();
  const task = {
    id: nextTaskId(tasks),
    user_task_id: (tasks.reduce((m, t) => Math.max(m, Number(t.user_task_id) || 0), 0) + 1),
    account_id: 10001,
    owner_account_id: 10001,
    name: payload.name || '未命名任务',
    system_prompt: payload.system_prompt || '',
    manual_enable: payload.manual_enable ?? 0,
    manual_prompt: payload.manual_prompt || '',
    manual_intervention_notify_type: payload.manual_intervention_notify_type ?? 1,
    status: payload.status || 'close',
    type: payload.type || 'simple',
    created_at: now,
    updated_at: now,
    schedule: payload.schedule || { type: 'time', value: '', start_time: '', end_time: '', exec_time: '' },
    actions: Array.isArray(payload.actions) ? payload.actions : [],
    ext: payload.ext || { enable_at_check: false, agent_nickname: '', default_agent_nickname: '', agent_nickname_list: [], enable_black_list: false, enable_white_list: false, black_list: [], white_list: [] },
    file_ids: Array.isArray(payload.file_ids) ? payload.file_ids : [],
    rules: Array.isArray(payload.rules) ? payload.rules : [],
    target_names: Array.isArray(payload.target_names) ? payload.target_names : [],
    proactive_enable: payload.proactive_enable ?? 0
  };
  tasks.push(task);
  saveTasks(tasks);
  log(`【tasks】创建任务 id=${task.id} name="${task.name}" type=${task.type}`);
  return jsonResponse(res, 200, { code: 0, msg: 'ok', body: task });
}
function findTask(tasks, id) {
  return tasks.find(t => String(t.id) === String(id));
}
function handleTaskDetail(res, id) {
  const t = findTask(loadTasks(), id);
  if (!t) return jsonResponse(res, 200, { code: 404, msg: '任务不存在' });
  return jsonResponse(res, 200, { code: 0, msg: 'ok', body: t });
}
function handleTaskUpdate(res, id, body) {
  let payload;
  try { payload = JSON.parse(body.toString('utf8')); }
  catch { return jsonResponse(res, 400, { code: 400, msg: 'invalid json' }); }
  const tasks = loadTasks();
  const t = findTask(tasks, id);
  if (!t) return jsonResponse(res, 200, { code: 404, msg: '任务不存在' });
  Object.assign(t, payload, { id: t.id, updated_at: isoNow() });
  saveTasks(tasks);
  log(`【tasks】更新任务 id=${t.id} name="${t.name}"`);
  return jsonResponse(res, 200, { code: 0, msg: 'ok', body: t });
}
function handleTaskDelete(res, id) {
  const tasks = loadTasks();
  const idx = tasks.findIndex(t => String(t.id) === String(id));
  if (idx < 0) return jsonResponse(res, 200, { code: 404, msg: '任务不存在' });
  const [removed] = tasks.splice(idx, 1);
  saveTasks(tasks);
  log(`【tasks】删除任务 id=${removed.id} name="${removed.name}"`);
  return jsonResponse(res, 200, { code: 0, msg: 'ok', body: {} });
}

// ---------- 聊天历史：分页查询 ----------
function handleChatRecords(res, query) {
  const page = Math.max(1, parseInt(query.get('page') || '1', 10) || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(query.get('page_size') || '20', 10) || 20));
  const q = {
    chat_type: query.get('chat_type') || '',
    chat_name: query.get('chat_name') || '',
    date_start: (query.get('date_start') || '').slice(0, 16),
    date_end: (query.get('date_end') || '').slice(0, 16)
  };
  const all = filterRecords(loadRecords(), q);
  all.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  const items = all.slice((page - 1) * pageSize, page * pageSize).map(r => ({
    chat_type: r.chat_type, target_name: r.target_name, nickname: r.nickname,
    content: r.content, created_at: r.created_at
  }));
  return jsonResponse(res, 200, { code: 0, body: { items, total: all.length, page, page_size: pageSize } });
}

// ---------- 聊天历史：导出（HTML 表格 xls，与原版格式一致） ----------
function handleChatRecordsExport(res, query) {
  const q = {
    chat_type: query.get('chat_type') || '',
    chat_name: query.get('chat_name') || '',
    date_start: (query.get('date_start') || '').slice(0, 16),
    date_end: (query.get('date_end') || '').slice(0, 16)
  };
  const all = filterRecords(loadRecords(), q);
  all.sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));
  const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const td = v => `<td style="mso-number-format:'\\@';">${esc(v)}</td>`;
  let html = '<html><head><meta charset="utf-8"></head><body><table border="1">';
  html += '<tr><th>会话类型</th><th>聊天名称</th><th>昵称</th><th>内容</th><th>创建时间</th></tr>';
  for (const r of all) html += `<tr>${td(r.chat_type)}${td(r.target_name)}${td(r.nickname)}${td(r.content)}${td(r.created_at)}</tr>`;
  html += '</table></body></html>';
  const buf = Buffer.concat([Buffer.from('﻿', 'utf8'), Buffer.from(html, 'utf8')]);
  const filename = `聊天记录_开始-${q.date_start || '全部'}_结束-${q.date_end || '全部'}.xls`;
  res.writeHead(200, {
    'Content-Type': 'application/vnd.ms-excel; charset=utf-8',
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
    'Content-Length': buf.length
  });
  res.end(buf);
  log(`【chat_records/export】导出 ${all.length} 条`);
}

// ---------- 端点：POST /shiflow/v1/layout/detect（VLM 布局检测） ----------
// 客户端 parseYoloBestObservation 约定：body 内 search_bar/chats_on/input_area/dialogues/messages/conversation_area，
// bbox 一律 [[x1,y1],[x2,y2]] 像素坐标（x2>x1, y2>y1）。inputArea 是自动发送点击输入框的关键数据源。
function clampNum(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function coerceBBox(b, w, h) {
  if (!Array.isArray(b) || b.length !== 2) return null;
  const [p1, p2] = b;
  if (!Array.isArray(p1) || !Array.isArray(p2)) return null;
  const n = [Number(p1[0]), Number(p1[1]), Number(p2[0]), Number(p2[1])];
  if (!n.every(Number.isFinite)) return null;
  let [x1, y1, x2, y2] = n;
  x1 = clampNum(x1, 0, w - 1); y1 = clampNum(y1, 0, h - 1);
  x2 = clampNum(x2, x1 + 1, w); y2 = clampNum(y2, y1 + 1, h);
  // 客户端契约：嵌套 [[x1,y1],[x2,y2]]（coerceYoloBbox/parseMessage 都要求两点式），坐标取整防小数漂移
  return x2 > x1 && y2 > y1 ? [[Math.round(x1), Math.round(y1)], [Math.round(x2), Math.round(y2)]] : null;
}
// VLM 布局连续失败短路 + 成功缓存：避免轮询热路径每轮白烧 8s 超时
let layoutVlmDownUntil = 0;
const layoutOkCache = new Map(); // key=appType:WxH -> {t, body}
async function handleLayoutDetect(req, res, body) {
  const t0 = Date.now();
  let payload = {};
  try { payload = JSON.parse(body.toString('utf8')); } catch { }
  const base64 = normalizeBase64(payload.image_base64);
  const appType = String(payload.app_type || 'wechat');
  if (!base64) return jsonResponse(res, 200, { code: 4003, msg: 'missing image_base64' });
  const mime = detectImageMime(base64) || 'image/png';
  const appName = appType === 'wecom' ? '企业微信' : '微信';
  // 快路径①：近 60s 内同应用同尺寸的成功布局直接复用（窗口不动布局不变）
  let w0 = 0, h0 = 0;
  try { const png0 = decodePng(Buffer.from(base64, 'base64')); w0 = png0.width; h0 = png0.height; } catch { }
  // 全屏（未裁剪到窗口）截图的坐标是屏幕绝对坐标，窗口一挪动布局就失效——这类结果不入缓存、也不吃缓存
  const absImg = payload.cropped === false;
  const cacheKey = `${appType}:${w0}x${h0}`;
  const hit = !absImg && w0 > 1 ? layoutOkCache.get(cacheKey) : null;
  if (hit && Date.now() - hit.t < 60000) {
    return jsonResponse(res, 200, { code: 0, body: hit.body });
  }
  // 快路径②：VLM 短路期（失败后 60s 内）直接合成布局，不再白等 8s 超时
  if (Date.now() < layoutVlmDownUntil && w0 > 1 && h0 > 1) {
    return jsonResponse(res, 200, { code: 0, body: { ...synthesizeLayout(w0, h0), synthetic: true, synthetic_reason: 'vlm_down' } });
  }
  const prompt =
    `这是${appName} Windows 客户端窗口截图。检测界面布局并只返回 JSON（像素坐标，原点左上角）：\n` +
    `{"image_width": 截图实际宽, "image_height": 截图实际高,\n` +
    `"search_bar": [[x1,y1],[x2,y2]] 或 null,  // 顶部搜索框\n` +
    `"chats_on": [[x1,y1],[x2,y2]] 或 null,      // 左侧会话列表中当前选中会话条目\n` +
    `"input_area": [[x1,y1],[x2,y2]],           // 右侧底部消息输入区（整个输入框+工具栏区域，必须给出）\n` +
    `"dialogues": [[[x1,y1],[x2,y2]],...],      // 左侧会话列表每一行（最多12行）\n` +
    `"messages": [{"role":"left","bbox":[[x1,y1],[x2,y2]]},...]  // 右侧聊天区气泡，left=对方 right=我方（最多8条）\n` +
    `}\n不要输出任何其他文字。`;
  try {
    const { text, model } = await llmChat({
      provider: 'doubao',
      timeoutMs: 20000, // 实测同参数视觉调用约 10s，12s 余量太小会频繁超时掉进合成兜底
      noFallback: true,
      responseFormat: { type: 'json_object' },
      messages: [{ role: 'user', content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } }
      ] }]
    });
    const j = extractJson(text);
    // 估算图片尺寸：优先 PNG 真实解码，否则用 VLM 自检值或上次成功尺寸
    let w = 0, h = 0;
    try { const png = decodePng(Buffer.from(base64, 'base64')); w = png.width; h = png.height; } catch { }
    if (!w || !h) { w = Number(j?.image_width) || lastLayoutDims.w || 1920; h = Number(j?.image_height) || lastLayoutDims.h || 1080; }
    if (w > 1 && h > 1) lastLayoutDims = { w, h };
    if (!j) {
      layoutVlmDownUntil = Date.now() + 60000;
      log(`【layout/detect】VLM 返回非 JSON，用合成布局兜底（60s 内短路）。原文: ${String(text).slice(0, 120)}`);
      return jsonResponse(res, 200, { code: 0, body: { ...synthesizeLayout(w, h), synthetic: true, synthetic_reason: 'vlm_bad_json' } });
    }
    // VLM 平台会把大图缩放到 ~1600 宽再推理，模型按缩放后的尺寸返回坐标（j.image_width/height 自检值
    // 与原图不一致）——必须把所有 bbox 按比例换算回原图，否则点击位置整体偏移、消息发不出去
    let sx = 1, sy = 1;
    const jw = Number(j && j.image_width), jh = Number(j && j.image_height);
    if (jw > 1 && jh > 1 && w > 1 && h > 1 && (Math.abs(jw - w) > w * 0.05 || Math.abs(jh - h) > h * 0.05)) {
      sx = w / jw; sy = h / jh;
      log(`【layout/detect】VLM 坐标系 ${jw}x${jh} 与原图 ${w}x${h} 不一致，bbox 按比例 ${sx.toFixed(3)}/${sy.toFixed(3)} 换算回原图`);
    }
    const rb = b => (b && (sx !== 1 || sy !== 1)) ? [[b[0][0] * sx, b[0][1] * sy], [b[1][0] * sx, b[1][1] * sy]] : b;
    const out = {
      search_bar: coerceBBox(rb(j.search_bar), w, h),
      chats_on: coerceBBox(rb(j.chats_on), w, h),
      input_area: coerceBBox(rb(j.input_area), w, h),
      dialogues: (Array.isArray(j.dialogues) ? j.dialogues : []).map(b => coerceBBox(rb(b), w, h)).filter(Boolean),
      messages: (Array.isArray(j.messages) ? j.messages : [])
        .filter(m => m && (m.role === 'left' || m.role === 'right'))
        .map(m => ({ role: m.role, bbox: coerceBBox(rb(m.bbox), w, h) }))
        .filter(m => m.bbox),
    };
    // 客户端 validateRoleBbox 硬约束（与 biz 同规则）：不满足即判 null → 输入区缓存为空 → 无法发送。
    // 这里按同一套规则校验，VLM 框不达标时修复/合成为规范区域。
    const validSearchBar = b => b && b[1] <= h * 0.25 && b[2] <= w * 0.65 && (b[2] - b[0]) >= w * 0.08 && (b[3] - b[1]) <= h * 0.2;
    const validChatEntrance = b => b && b[2] <= w * 0.3 && b[1] <= h * 0.5 && (b[2] - b[0]) >= 8 && (b[3] - b[1]) >= 8;
    const margin = { x1: Math.ceil(w * 0.15) + 2, y1: Math.ceil(h * 0.35) + 2, x2: Math.ceil(w * 0.55) + 2, y2: Math.ceil(h * 0.75) + 2, minW: Math.ceil(w * 0.25) + 2, minH: Math.ceil(h * 0.08) + 2 };
    const validInputArea = b => b && b[0][0] >= margin.x1 && b[0][1] >= margin.y1 && b[1][0] >= margin.x2 && b[1][1] >= margin.y2 && (b[1][0] - b[0][0]) >= margin.minW && (b[1][1] - b[0][1]) >= margin.minH;
    if (out.search_bar && !validSearchBar(out.search_bar)) { log(`【layout/detect】search_bar 不合规已置空: ${JSON.stringify(out.search_bar)}`); out.search_bar = null; }
    if (out.chats_on && !validChatEntrance(out.chats_on)) { log(`【layout/detect】chats_on 不合规已置空: ${JSON.stringify(out.chats_on)}`); out.chats_on = null; }
    // 会话入口统一为「未读」分组（校准坐标，侧边栏行高固定不随窗缩放）。
    // 这是治本：客户端所有导航路径（clickYoloRedDot / YOLO·3b / RPA）拿到的入口都是未读行，
    // 彻底杜绝引擎"点消息"（消息行是遗留入口，且未读行 y>0.5h 过不了上面的校验，VLM 只能给消息行）
    if (appType === 'wecom') {
      try {
        const rc = JSON.parse(fs.readFileSync(RAIL_CAL_FILE, 'utf8'));
        if (rc && rc.unread_row_y > 0) {
          const uy = Math.round(rc.unread_row_y), ux = Math.round(rc.unread_row_x || w * 0.07);
          out.chats_on = [[Math.max(0, ux - 70), Math.max(0, uy - 22)], [Math.min(w, ux + 70), Math.min(h, uy + 22)]];
        }
      } catch { }
    }
    if (out.input_area && !validInputArea(out.input_area)) {
      // 以 VLM 框为基础做最小扩展修复（VLM 通常只是高度差几像素，不要整体换掉）
      let [[x1, y1], [x2, y2]] = out.input_area;
      x2 = Math.max(x2, margin.x2);
      y2 = Math.max(y2, margin.y2);
      if (y2 > h - 4 && y2 < h) y2 = h;                 // 贴近底部就直接到底
      if (y2 - y1 < margin.minH) y1 = Math.max(margin.y1, y2 - margin.minH);   // 向上补高
      if (x2 - x1 < margin.minW) x1 = Math.max(margin.x1, x2 - margin.minW);   // 向左补宽
      if (x1 < margin.x1) x1 = margin.x1;
      const fixed = [[x1, y1], [Math.min(x2, w), Math.min(y2, h)]];
      log(`【layout/detect】input_area 最小扩展修复 ${JSON.stringify(out.input_area)} → ${JSON.stringify(fixed)}`);
      out.input_area = fixed;
    }
    if (!out.input_area) {
      // VLM 完全没给框：合成「右侧聊天面板底部输入条」（恒过客户端校验）
      out.input_area = [[Math.round(w * 0.30), Math.round(h * 0.78)], [Math.round(w * 0.98), Math.round(h * 0.97)]];
      out.synthetic = true;
      out.synthetic_reason = 'vlm_no_input_area';
      log(`【layout/detect】VLM 未给 input_area，合成底部输入条 ${JSON.stringify(out.input_area)}`);
    }
    // conversation_area 必须满足：y1≈0、x2≈inputArea.x2、y2≈inputArea.y1（客户端 parseConversationArea 硬校验）
    out.conversation_area = [[out.input_area[0][0], 0], [out.input_area[1][0], out.input_area[0][1]]];
    log(`【layout/detect】VLM(${model}) ${w}x${h} input_area=${JSON.stringify(out.input_area)} dialogues=${out.dialogues.length} messages=${out.messages.length} 耗时 ${Date.now() - t0}ms`);
    // 合成兜底和全屏绝对坐标结果不入缓存（前者不是真实检测，后者窗口挪动即失效）
    if (!out.synthetic && !absImg) {
      if (layoutOkCache.size > 12) layoutOkCache.clear();
      layoutOkCache.set(`${appType}:${w}x${h}`, { t: Date.now(), body: out });
    }
    layoutVlmDownUntil = 0;
    return jsonResponse(res, 200, { code: 0, body: out });
  } catch (e) {
    layoutVlmDownUntil = Date.now() + 60000; // 失败短路 60s：热路径直接合成布局
    log(`【layout/detect】VLM 失败（${Date.now() - t0}ms），用合成布局兜底（60s 内短路）:`, e.message || e);
    // 布局结构高度可预测（输入区恒在右下），合成兜底绝不返回失败码
    let w = lastLayoutDims.w, h = lastLayoutDims.h;
    try { const png = decodePng(Buffer.from(base64, 'base64')); w = png.width; h = png.height; } catch { }
    if (w > 1 && h > 1) lastLayoutDims = { w, h };
    if (!w || !h) return jsonResponse(res, 200, { code: 4003, msg: 'local vlm layout failed and no dims known' });
    return jsonResponse(res, 200, { code: 0, body: { ...synthesizeLayout(w, h), synthetic: true, synthetic_reason: 'vlm_failed' } });
  }
}

// 合成规范布局：输入区=右侧聊天面板底部条（恒过客户端 validateRoleBbox 校验）
let lastLayoutDims = { w: 0, h: 0 };
function synthesizeLayout(w, h) {
  // 兜底框取窗口底部 78%~97%：覆盖输入文字区、避开最底部工具栏/系统提示条。
  // 点击点由调用方取框内 55% 处（≈0.884h），正好落在文字输入行而不是表情/发送按钮行。
  const input = [[Math.round(w * 0.30), Math.round(h * 0.78)], [Math.round(w * 0.98), Math.round(h * 0.97)]];
  return {
    search_bar: null,
    chats_on: null,
    input_area: input,
    dialogues: [],
    messages: [],
    conversation_area: [[input[0][0], 0], [input[1][0], input[0][1]]]
  };
}

// ---------- 端点：POST /shiflow/v1/messages/detect（消息方向检测，2s 预算） ----------
// 客户端 parseWechatMessageObservation 约定：body.messages=[{role:"left"|"right",bbox}]，
// last_role 若出现必须等于最后一条 role —— 省略该字段最稳。
async function handleMessagesDetect(req, res, body) {
  const t0 = Date.now();
  let payload = {};
  try { payload = JSON.parse(body.toString('utf8')); } catch { }
  const base64 = normalizeBase64(payload.image_base64);
  if (!base64) return jsonResponse(res, 200, { code: 4003, msg: 'missing image_base64' });
  const mime = detectImageMime(base64) || 'image/png';
  // 优先走本地 OCR 服务（~1.6s，赶在客户端 2s 超时内）；OCR 不可用再退化到 VLM
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort('ocr_timeout'), 1900);
    let ocrResp;
    try {
      ocrResp = await fetch('http://127.0.0.1:7300/ocr/last_message', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image_base64: base64, app_type: payload.app_type || 'wechat' }), signal: ctrl.signal
      });
    } finally { clearTimeout(timer); }
    const ocrJson = await ocrResp.json();
    if (ocrJson.code === 0 && ocrJson.message) {
      const m = ocrJson.message;
      log(`【messages/detect】OCR 命中 role=${m.role} text="${String(m.text).slice(0, 30)}" 耗时 ${Date.now() - t0}ms`);
      return jsonResponse(res, 200, { code: 0, body: {
        messages: [{ role: m.role, bbox: m.bbox }],
        total_time: (Date.now() - t0) / 1000,
        image_width: 0, image_height: 0
      } });
    }
    log(`【messages/detect】OCR 无结果，转 VLM（${Date.now() - t0}ms）`);
  } catch (e) {
    log(`【messages/detect】OCR 不可用（${e.message || e}），转 VLM`);
  }
  try {
    const { text } = await llmChat({
      provider: 'doubao',
      timeoutMs: 1800,
      responseFormat: { type: 'json_object' },
      messages: [{ role: 'user', content: [
        { type: 'text', text: '微信聊天窗口截图。只返回最后一条（最靠下的）消息气泡：{"image_width":宽,"image_height":高,"messages":[{"role":"left或right","bbox":[[x1,y1],[x2,y2]]}]}，right=我方（右侧），left=对方（左侧），像素坐标，不要其他文字。' },
        { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } }
      ] }]
    });
    const j = extractJson(text);
    let w = 0, h = 0;
    try { const png = decodePng(Buffer.from(base64, 'base64')); w = png.width; h = png.height; } catch { }
    if (!w || !h) { w = Number(j.image_width) || 1920; h = Number(j.image_height) || 1080; }
    const msgs = (Array.isArray(j.messages) ? j.messages : [])
      .filter(m => m && (m.role === 'left' || m.role === 'right'))
      .map(m => ({ role: m.role, bbox: coerceBBox(m.bbox, w, h) }))
      .filter(m => m.bbox);
    log(`【messages/detect】VLM 消息数=${msgs.length} last=${msgs.length ? msgs[msgs.length - 1].role : '-'} 耗时 ${Date.now() - t0}ms`);
    return jsonResponse(res, 200, { code: 0, body: { messages: msgs, total_time: (Date.now() - t0) / 1000, image_width: w, image_height: h } });
  } catch (e) {
    log(`【messages/detect】VLM 失败（${Date.now() - t0}ms）:`, e.message || e);
    return jsonResponse(res, 200, { code: 4003, msg: 'local vlm messages detect failed' });
  }
}

// ---------- 分步测试端点（功能测试页专用，/test/*） ----------
// 通过 PowerShell 完成进程/窗口枚举、窗口前置、屏幕截图、鼠标移动与双击，
// 视觉部分复用现有 analyzeScreenshot / detectRedDots / grounding 逻辑。
const TEST_PS_DIR = path.join(DATA_DIR, 'test-ps');
fs.mkdirSync(TEST_PS_DIR, { recursive: true });

// 写 .ps1 临时文件并执行（避免命令行转义问题），返回 stdout 解析后的 JSON
const POWERSHELL_EXE = (() => {
  const full = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return fs.existsSync(full) ? full : 'powershell.exe';
})();
function runPowerShell(script, timeoutMs = 20000, extraArgs = []) {
  return new Promise((resolve, reject) => {
    const file = path.join(TEST_PS_DIR, `ps_${Date.now()}_${crypto.randomBytes(3).toString('hex')}.ps1`);
    fs.writeFileSync(file, '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n' + script, 'utf8');
    execFile(POWERSHELL_EXE, ['-NoProfile', '-NonInteractive', ...extraArgs, '-ExecutionPolicy', 'Bypass', '-File', file],
      { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
        fs.unlink(file, () => { });
        if (err) return reject(new Error(`PowerShell 失败: ${err.message}${stderr ? ' | ' + String(stderr).slice(0, 300) : ''}`));
        const text = String(stdout || '').trim();
        try { resolve(text ? JSON.parse(text) : {}); }
        catch { reject(new Error(`PowerShell 输出非 JSON: ${text.slice(0, 300)}`)); }
      });
  });
}

// C# 签名块（各脚本共用）
const PS_U32 = `
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class U32 {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint from, uint to, bool attach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
}
public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
'@;
[void][U32]::SetProcessDPIAware();
`;

// 企微窗口枚举（内部弹窗遮挡检测用）
const PS_ENUM = `
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Collections.Generic;
public class WinItem {
  public IntPtr Hwnd; public uint Pid; public bool Visible; public string Class; public string Title;
  public RECT Rect; public int W; public int H;
}
public class WinEnum2 {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  public static List<WinItem> Items = new List<WinItem>();
  public static bool Cb(IntPtr h, IntPtr l) {
    uint pid; GetWindowThreadProcessId(h, out pid);
    System.Diagnostics.Process p;
    try { p = System.Diagnostics.Process.GetProcessById((int)pid); } catch { return true; }
    if (p.ProcessName != "WXWork") return true;
    var cls = new StringBuilder(256); GetClassName(h, cls, 256);
    int len = GetWindowTextLength(h);
    var title = new StringBuilder(len + 1); GetWindowText(h, title, title.Capacity);
    RECT r; GetWindowRect(h, out r);
    Items.Add(new WinItem { Hwnd = h, Pid = pid, Visible = IsWindowVisible(h), Class = cls.ToString(), Title = title.ToString(), Rect = r, W = r.Right - r.Left, H = r.Bottom - r.Top });
    return true;
  }
  public static List<WinItem> EnumAll() { Items.Clear(); EnumWindows(Cb, IntPtr.Zero); return Items; }
}
'@;
`;

// 前台窗口信息（遮挡判断用）的 PS 片段：输出 $fgPid / $fgTitle
const PS_FOREGROUND = `
$fg = [U32]::GetForegroundWindow()
$fgPid = [UInt32]::Zero
[void][U32]::GetWindowThreadProcessId($fg, [ref]$fgPid)
$sb = New-Object System.Text.StringBuilder 256
[void][U32]::GetWindowText($fg, $sb, 256)
$fgTitle = $sb.ToString()
$fgPath = ''
try { $fgPath = (Get-Process -Id $fgPid -ErrorAction SilentlyContinue).Path } catch {}
`;

// 拟人鼠标轨迹（复用客户端同款贝塞尔算法）
const { generateBezierPath } = require('./mouse-trajectory');

// 目标应用进程名映射
const TEST_APP_PROCS = {
  wechat: ['WeChat', 'Weixin'],
  wecom: ['WXWork']
};
function testAppFromPayload(payload) {
  const a = String(payload.app || payload.app_type || 'wechat').toLowerCase();
  // 注意：客户端设置里存的是 enterprise（企业版），不是 wecom——漏映射会让整个引擎跑微信分支
  if (a === 'wecom' || a === 'wework' || a === 'wxwork' || a === 'enterprise' || a === '企微' || a === '企业微信') return 'wecom';
  return 'wechat';
}

// GET /test/windows —— 枚举微信/企微进程与窗口
async function handleTestWindows(req, res) {
  const t0 = Date.now();
  try {
    const j = await runPowerShell(`
${PS_U32}
$procs = Get-Process -Name WeChat,Weixin,WXWork -ErrorAction SilentlyContinue
$items = @()
foreach ($p in $procs) {
  $r = New-Object RECT
  $hasWin = $p.MainWindowHandle -ne [IntPtr]::Zero
  if ($hasWin) { [void][U32]::GetWindowRect($p.MainWindowHandle, [ref]$r) }
  $items += [PSCustomObject]@{
    pid = $p.Id
    name = $p.ProcessName
    app = $(if ($p.ProcessName -eq 'WXWork') { 'wecom' } else { 'wechat' })
    title = $p.MainWindowTitle
    has_window = $hasWin
    visible = $(if ($hasWin) { [U32]::IsWindowVisible($p.MainWindowHandle) } else { $false })
    rect = [PSCustomObject]@{ left = $r.Left; top = $r.Top; right = $r.Right; bottom = $r.Bottom; width = ($r.Right - $r.Left); height = ($r.Bottom - $r.Top) }
  }
}
[PSCustomObject]@{ items = @($items) } | ConvertTo-Json -Depth 5
`);
    const items = (j.items || []).map(it => ({ ...it, app: it.name === 'WXWork' ? 'wecom' : 'wechat' }));
    log(`【test/windows】进程=${items.length} 耗时 ${Date.now() - t0}ms`);
    return jsonResponse(res, 200, { code: 0, body: { processes: items, elapsed_ms: Date.now() - t0 } });
  } catch (e) {
    log('【test/windows】失败:', e.message || e);
    return jsonResponse(res, 200, { code: 0, body: { processes: [], error: String(e.message || e), elapsed_ms: Date.now() - t0 } });
  }
}

// POST /test/resize {app, width, height} —— 把目标窗口调整到指定尺寸（保持左上角不动）；布局需要最小区间才稳定，窗口太窄时导航前调用
async function handleTestResize(req, res, body) {
  let payload = {};
  try { payload = JSON.parse(body.toString('utf8')); } catch { }
  const app = testAppFromPayload(payload);
  const w = Math.round(Number(payload.width)) || 1600;
  const h = Math.round(Number(payload.height)) || 1000;
  const names = TEST_APP_PROCS[app].map(n => `'${n}'`).join(',');
  try {
    const j = await runPowerShell(`
${PS_U32}
$p = Get-Process -Name ${names} -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } | Select-Object -First 1
if (-not $p) { [PSCustomObject]@{ ok = $false; reason = 'no_window' } | ConvertTo-Json; exit }
$r = New-Object RECT
[void][U32]::GetWindowRect($p.MainWindowHandle, [ref]$r)
[void][U32]::SetWindowPos($p.MainWindowHandle, [IntPtr]::Zero, $r.Left, $r.Top, ${w}, ${h}, 0x0006)
Start-Sleep -Milliseconds 400
[PSCustomObject]@{ ok = $true; width = ${w}; height = ${h} } | ConvertTo-Json
`, 20000);
    return jsonResponse(res, 200, { code: 0, body: { ok: !!j.ok, width: w, height: h, reason: j.reason || '' } });
  } catch (e) {
    return jsonResponse(res, 200, { code: 0, body: { ok: false, error: String(e.message || e) } });
  }
}

// POST /test/activate {app} —— 把目标应用窗口前置（并验证是否真的抢到前台）
async function handleTestActivate(req, res, body) {
  let payload = {};
  try { payload = JSON.parse(body.toString('utf8')); } catch { }
  const app = testAppFromPayload(payload);
  const names = TEST_APP_PROCS[app].map(n => `'${n}'`).join(',');
  try {
    const j = await runPowerShell(`
${PS_U32}
$p = Get-Process -Name ${names} -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } | Select-Object -First 1
if (-not $p) { [PSCustomObject]@{ ok = $false; reason = 'no_window' } | ConvertTo-Json; exit }
$r = New-Object RECT
[void][U32]::GetWindowRect($p.MainWindowHandle, [ref]$r)
$w = $r.Right - $r.Left; $hh = $r.Bottom - $r.Top
if ($w -le 50 -or $hh -le 50) { [PSCustomObject]@{ ok = $false; reason = 'window_hidden'; hint = '窗口被最小化到托盘，请先恢复窗口' } | ConvertTo-Json; exit }
# 只在真正最小化时才恢复——SW_RESTORE 会把最大化窗口打回原尺寸（位置/大小突变会让已截取的坐标原点全部失效）
if ([U32]::IsIconic($p.MainWindowHandle)) { [void][U32]::ShowWindow($p.MainWindowHandle, 9); Start-Sleep -Milliseconds 120 }
# Windows 前台限制绕过：AttachThreadInput + Alt 轻拍，让 SetForegroundWindow 生效
$fg0 = [U32]::GetForegroundWindow()
$fgTid = [U32]::GetWindowThreadProcessId($fg0, [ref]([UInt32]::Zero))
$myTid = [U32]::GetCurrentThreadId()
[void][U32]::AttachThreadInput($myTid, $fgTid, $true)
[U32]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
[void][U32]::SetForegroundWindow($p.MainWindowHandle)
[void][U32]::BringWindowToTop($p.MainWindowHandle)
[U32]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
[void][U32]::AttachThreadInput($myTid, $fgTid, $false)
Start-Sleep -Milliseconds 300
${PS_FOREGROUND}
$ok2 = ([int]$fgPid -eq [int]$p.Id)
[PSCustomObject]@{ ok = $true; pid = $p.Id; name = $p.ProcessName; title = $p.MainWindowTitle; foreground = $ok2; foreground_title = $fgTitle } | ConvertTo-Json
`);
    log(`【test/activate】app=${app} ok=${!!j.ok} foreground=${!!j.foreground} title="${j.title || ''}"`);
    return jsonResponse(res, 200, { code: 0, body: { app, ok: !!j.ok, foreground: !!j.foreground, title: j.title || '', pid: j.pid || 0, reason: j.reason || '', hint: j.hint || '', foreground_title: j.foreground_title || '' } });
  } catch (e) {
    log('【test/activate】失败:', e.message || e);
    return jsonResponse(res, 200, { code: 0, body: { app, ok: false, error: String(e.message || e) } });
  }
}

// POST /test/screenshot {app?} —— 截屏（DPI 感知物理像素）；带 app 时裁剪到该应用窗口，定位更准
async function handleTestScreenshot(req, res, body) {
  const t0 = Date.now();
  let payload = {};
  if (body) { try { payload = JSON.parse(body.toString('utf8')); } catch { } }
  const app = payload.app || payload.app_type ? testAppFromPayload(payload) : '';
  const names = app ? TEST_APP_PROCS[app].map(n => `'${n}'`).join(',') : '';
  try {
    const j = await runPowerShell(`
${PS_U32}
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $vs.Width, $vs.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($vs.Left, $vs.Top, 0, 0, $bmp.Size)
$g.Dispose()
${app ? `
$crop = $null
# 窗口句柄会瞬时为空（多进程/切换瞬间），重试 3 次再放弃，避免动不动就退回全屏截图导致坐标全偏
$p = $null
for ($try = 0; $try -lt 3 -and -not $p; $try++) {
  $p = Get-Process -Name ${names} -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } | Select-Object -First 1
  if (-not $p) { Start-Sleep -Milliseconds 600 }
}
if ($p) {
  $r = New-Object RECT
  if ([U32]::GetWindowRect($p.MainWindowHandle, [ref]$r)) {
    $cx = $r.Left - $vs.Left; $cy = $r.Top - $vs.Top
    $cw = $r.Right - $r.Left; $ch = $r.Bottom - $r.Top
    if ($cw -gt 50 -and $ch -gt 50) {
      if ($cx -lt 0) { $cw += $cx; $cx = 0 }
      if ($cy -lt 0) { $ch += $cy; $cy = 0 }
      if ($cx + $cw -gt $vs.Width) { $cw = $vs.Width - $cx }
      if ($cy + $ch -gt $vs.Height) { $ch = $vs.Height - $cy }
      $rect = New-Object System.Drawing.Rectangle $cx, $cy, $cw, $ch
      $crop = $bmp.Clone($rect, $bmp.PixelFormat)
    }
  }
}
${PS_FOREGROUND}
$myPids = @(Get-Process -Name ${names} -ErrorAction SilentlyContinue | ForEach-Object { [int]$_.Id })
$winOk = ($p -ne $null) -and ($crop -ne $null)
$occluded = $true
$occReason = 'no_window'
if ($winOk) {
  if ($myPids -contains [int]$fgPid) { $occluded = $false; $occReason = '' } else { $occReason = 'not_foreground' }
}
` : '$crop = $null\n$occluded = $false\n$occReason = \'\'; $fgTitle = \'\''}
$out = if ($crop) { $crop } else { $bmp }
$ox = if ($crop) { $vs.Left + $cx } else { $vs.Left }
$oy = if ($crop) { $vs.Top + $cy } else { $vs.Top }
$file = Join-Path $env:TEMP ('lj_shot_' + [guid]::NewGuid().ToString('N') + '.png')
$out.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
$w2 = $out.Width; $h2 = $out.Height
$out.Dispose(); if ($crop) { $crop.Dispose() }; $bmp.Dispose()
[PSCustomObject]@{ file = $file; origin_x = $ox; origin_y = $oy; width = $w2; height = $h2; cropped = [bool]$crop; occluded = [bool]$occluded; occlusion_reason = $occReason; foreground_title = $fgTitle; fg_path = $fgPath } | ConvertTo-Json
`, 30000);
    const buf = fs.readFileSync(j.file);
    fs.unlink(j.file, () => { });
    // 聊机自身不算遮挡：功能测试就在聊机里跑，用户点面板必然把聊机置前
    try {
      if (j.occluded && j.fg_path) {
        const installDir = path.resolve(ROOT, '..', '..').toLowerCase();
        if (String(j.fg_path).toLowerCase().startsWith(installDir)) {
          log(`【test/screenshot】前台=聊机自身（${j.foreground_title || '?'}），不计遮挡`);
          j.occluded = false;
          j.occlusion_reason = '';
        }
      }
    } catch { }
    log(`【test/screenshot】${j.width}x${j.height} 原点(${j.origin_x},${j.origin_y}) 裁剪=${!!j.cropped} 遮挡=${!!j.occluded}${j.occluded ? '(' + j.occlusion_reason + ', 前台=' + (j.foreground_title || '?') + ')' : ''} ${(buf.length / 1024).toFixed(0)}KB 耗时 ${Date.now() - t0}ms`);
    return jsonResponse(res, 200, {
      code: 0,
      body: {
        image_base64: buf.toString('base64'), width: j.width, height: j.height,
        origin_x: j.origin_x, origin_y: j.origin_y, cropped: !!j.cropped,
        occluded: !!j.occluded, occlusion_reason: j.occlusion_reason || '',
        foreground_title: j.foreground_title || '',
        elapsed_ms: Date.now() - t0
      }
    });
  } catch (e) {
    log('【test/screenshot】失败:', e.message || e);
    return jsonResponse(res, 200, { code: 0, body: { error: String(e.message || e) } });
  }
}

// POST /test/think-reply {image_base64, app_type, agent_type} —— 只理解和生成，不真实发送
async function handleTestThinkReply(req, res, body) {
  const t0 = Date.now();
  let payload;
  try { payload = JSON.parse(body.toString('utf8')); }
  catch { return jsonResponse(res, 400, { code: 400, msg: 'invalid json' }); }
  const base64 = normalizeBase64(payload.image_base64);
  if (!base64) return jsonResponse(res, 200, { code: 0, body: { error: 'empty image' } });
  const agentType = payload.agent_type || 'speed';
  const appType = payload.app_type || 'wechat';
  // 会话存在性预检：窗口停在菜单页/会话列表页（没打开任何聊天）时，VLM 会对着菜单幻觉出会话和回复——
  // 先确认右侧聊天区真的有消息气泡；检测失败（超时/异常）不拦截，继续正常分析
  try {
    const ctrl0 = new AbortController();
    const timer0 = setTimeout(() => ctrl0.abort('md_timeout'), 3000); // 3s：检测服务 consistently 超时，预算放太长纯属浪费每轮时间
    let mdResp;
    try {
      mdResp = await fetch('http://127.0.0.1:7200/shiflow/v1/messages/detect', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image_base64: base64, app_type: appType }), signal: ctrl0.signal
      });
    } finally { clearTimeout(timer0); }
    const mdJson = await mdResp.json();
    const mdMsgs = mdJson && mdJson.body && mdJson.body.messages;
    if (mdJson && mdJson.code === 0 && Array.isArray(mdMsgs) && mdMsgs.length === 0) {
      log(`【test/think-reply】右侧聊天区没有消息气泡（未打开任何会话，窗口可能停在菜单/列表页），跳过思考`);
      return jsonResponse(res, 200, {
        code: 0,
        body: {
          chat_name: '', chat_type: '', customer_message: '', should_reply: false, reply: '',
          polished: false, kb_used: false, forced_by_direction_check: false,
          model: 'gate:no-conversation', elapsed_ms: Date.now() - t0
        }
      });
    }
  } catch (e) {
    log('【test/think-reply】会话预检不可用（继续正常分析）:', e.message || e);
  }
  try {
    const result = await analyzeScreenshot({ base64, agentType, appType });
    // 方向校验：最后一条是客户（左气泡）而 VLM 判断无需回复时，按生产规则必须回复——用文本模型补一条
    let forced = false;
    if (!result.shouldReply) {
      try {
        const ctrl2 = new AbortController();
        const timer2 = setTimeout(() => ctrl2.abort('ocr_timeout'), 8000);
        let ocrResp;
        try {
          ocrResp = await fetch('http://127.0.0.1:7300/ocr/last_message', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ image_base64: base64, app_type: appType, bottom: true }), signal: ctrl2.signal
          });
        } finally { clearTimeout(timer2); }
        const ocrJson = await ocrResp.json();
        if (ocrJson.code === 0 && ocrJson.message && ocrJson.message.role === 'left') {
          const persona = resolvePersonaCached();
          const lastText = String(ocrJson.message.text || result.customerMessage || '').slice(0, 200);
          const g = await llmChat({
            provider: 'doubao', timeoutMs: 30000,
            messages: [
              { role: 'system', content: `${persona}\n当前是测试模式：客户最新发来的消息是「${lastText}」。请严格按人设生成一句回复，只输出回复文本，不要解释。` },
              { role: 'user', content: '请生成回复。' }
            ]
          });
          const t = g.text.trim();
          if (t) {
            result.reply = t;
            result.shouldReply = true;
            if (!result.customerMessage) result.customerMessage = lastText;
            forced = true;
            log(`【test/think-reply】方向校验强制回复：最后一条=left text="${lastText.slice(0, 30)}"`);
          }
        }
      } catch (e) {
        log('【test/think-reply】方向校验不可用（维持 VLM 判断）:', e.message || e);
      }
    }
    log(`【test/think-reply】会话="${result.chatName}" should_reply=${result.shouldReply}${forced ? '(方向校验强制)' : ''} 耗时 ${Date.now() - t0}ms`);
    return jsonResponse(res, 200, {
      code: 0,
      body: {
        chat_name: result.chatName,
        chat_type: result.chatType,
        customer_message: result.customerMessage,
        should_reply: result.shouldReply,
        reply: result.reply,
        polished: result.polished,
        kb_used: !!result.kbUsed,
        forced_by_direction_check: forced,
        model: result.model,
        elapsed_ms: Date.now() - t0
      }
    });
  } catch (e) {
    log('【test/think-reply】失败:', e.message || e);
    return jsonResponse(res, 200, { code: 0, body: { error: String(e.message || e), elapsed_ms: Date.now() - t0 } });
  }
}

// 校准数据里的「消息」行 Y 坐标（按窗口高度等比缩放）——有它就直接点消息行，不用猜红点
function railMsgRowY(h) {
  try {
    const c = JSON.parse(fs.readFileSync(RAIL_CAL_FILE, 'utf8'));
    if (c && c.msg_row_y > 0 && c.h > 0) return c.msg_row_y * (h / c.h);
  } catch { }
  return 0;
}

// 侧边栏功能目录红点过滤（与 /shiflow/v1/unread/detect 同一套规则）：
// 校准过（rail_calibration.json）按黑名单丢功能目录行；没校准按默认白名单只留「消息」行和「分组未读区」
function filterRailDots(dots, w, h, appType) {
  // 消息行坐标独立于红点存在与否返回：没有红点也能直接点「消息」行进列表
  const msgRowY = (appType === 'wecom' && w && h) ? railMsgRowY(h) : 0;
  if (appType !== 'wecom' || !Array.isArray(dots) || !dots.length || !w || !h) {
    return { dots: dots || [], filtered: false, dropped: 0, mode: '', msgRowY, unreadRowX: 0, unreadRowY: 0 };
  }
  const cal = railBlacklist(w, h);
  let dropped = 0;
  const out = [];
  for (const d of dots) {
    const cx = (d[0][0] + d[1][0]) / 2, cy = (d[0][1] + d[1][1]) / 2;
    if (cx < w * 0.14) {
      if (cal) { if (cal.some(([a, b]) => cy >= a && cy <= b)) { dropped++; continue; } }
      else if (!((cy >= 90 && cy <= 145) || (cy >= 415 && cy <= 530))) { dropped++; continue; }
    }
    out.push(d);
  }
  if (dropped) log(`【test/red-dot】侧边栏${cal ? '黑名单(校准)' : '白名单(默认)'}：丢弃 ${dropped} 个功能目录红点（会议/文档等）`);
  // 「未读」分组行定位：优先用校准的权威值；没有校准则实测——功能目录红点被过滤后，
  // 剩下的侧边红点里排除消息行上方的（账号行等），取最上面的一个（其下依次是单聊/群聊）
  let unreadRowX = 0, unreadRowY = 0;
  try {
    const c = JSON.parse(fs.readFileSync(RAIL_CAL_FILE, 'utf8'));
    if (c && c.unread_row_y > 0 && c.h > 0) {
      unreadRowY = Math.round(c.unread_row_y * (h / c.h));
      unreadRowX = Math.round((c.unread_row_x || c.w * 0.07) * (w / c.w));
    }
  } catch { }
  if (!unreadRowY) {
    const msgYv = railMsgRowY(h);
    const floorY = msgYv > 0 ? msgYv + h * 0.02 : h * 0.2;
    const railKept = out.filter(d => (d[0][0] + d[1][0]) / 2 < w * 0.14 && (d[0][1] + d[1][1]) / 2 > floorY)
      .sort((a, b) => (a[0][1] + a[1][1]) - (b[0][1] + b[1][1]));
    if (railKept.length) {
      unreadRowX = Math.round((railKept[0][0][0] + railKept[0][1][0]) / 2);
      unreadRowY = Math.round((railKept[0][0][1] + railKept[0][1][1]) / 2);
    }
  }
  return { dots: out, filtered: true, dropped, mode: cal ? 'blacklist' : 'whitelist', msgRowY, unreadRowX, unreadRowY };
}

// POST /test/red-dot {image_base64, app_type?} —— 红点检测（PNG 启发式，失败转 VLM），返回坐标点
// app_type=wecom 时按侧边栏规则过滤功能目录红点（会议/智能总结等），防止双击误点进功能页
async function handleTestRedDot(req, res, body) {
  const t0 = Date.now();
  let payload;
  try { payload = JSON.parse(body.toString('utf8')); }
  catch { return jsonResponse(res, 400, { code: 400, msg: 'invalid json' }); }
  const appType = testAppFromPayload(payload);
  const base64 = normalizeBase64(payload.image_base64);
  if (!base64) return jsonResponse(res, 200, { code: 0, body: { dots: [], error: 'empty image' } });
  const mime = detectImageMime(base64);
  if (mime === 'image/png') {
    try {
      const png = decodePng(Buffer.from(base64, 'base64'));
      const { dots } = detectRedDots(png);
      const rail = filterRailDots(dots, png.width, png.height, appType);
      log(`【test/red-dot】PNG 红点=${dots.length} 过滤后=${rail.dots.length} 耗时 ${Date.now() - t0}ms`);
      return jsonResponse(res, 200, { code: 0, body: { dots: rail.dots, width: png.width, height: png.height, via: 'png-heuristic', rail: { filtered: rail.filtered, dropped: rail.dropped, mode: rail.mode, msg_row_y: Math.round(rail.msgRowY), unread_row_x: rail.unreadRowX, unread_row_y: rail.unreadRowY }, elapsed_ms: Date.now() - t0 } });
    } catch (e) {
      log('【test/red-dot】PNG 解码失败，转 VLM:', e.message || e);
    }
  }
  try {
    const { text } = await llmChat({
      provider: 'doubao', timeoutMs: 12000, responseFormat: { type: 'json_object' },
      messages: [
        { role: 'system', content: '你是微信未读红点检测器。找出截图中所有红色未读角标（圆形或带数字的红色小圆点，通常在会话头像或会话条目右上角）。严格只输出 JSON：{"dots":[[x1,y1,x2,y2],...]}，坐标为像素包围盒。没有则 {"dots":[]}。' },
        { role: 'user', content: [
          { type: 'text', text: '检测这张截图的红色未读角标，输出 JSON。' },
          { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } }
        ] }
      ]
    });
    let dots = [];
    const parsed = extractJson(text);
    if (parsed && Array.isArray(parsed.dots)) dots = parsed.dots;
    const clean = [];
    for (const d of dots) {
      if (Array.isArray(d) && d.length === 4 && d.every(Number.isFinite) && d[2] > d[0] && d[3] > d[1]) {
        clean.push([[Math.round(d[0]), Math.round(d[1])], [Math.round(d[2]), Math.round(d[3])]]);
      }
    }
    log(`【test/red-dot】VLM 红点=${clean.length} 耗时 ${Date.now() - t0}ms`);
    let vw = 0, vh = 0;
    try { const png2 = decodePng(Buffer.from(base64, 'base64')); vw = png2.width; vh = png2.height; } catch { }
    const rail2 = filterRailDots(clean, vw, vh, appType);
    return jsonResponse(res, 200, { code: 0, body: { dots: rail2.dots, via: 'vlm', rail: { filtered: rail2.filtered, dropped: rail2.dropped, mode: rail2.mode, msg_row_y: Math.round(rail2.msgRowY), unread_row_x: rail2.unreadRowX, unread_row_y: rail2.unreadRowY }, elapsed_ms: Date.now() - t0 } });
  } catch (e) {
    log('【test/red-dot】VLM 失败:', e.message || e);
    return jsonResponse(res, 200, { code: 0, body: { dots: [], error: String(e.message || e), elapsed_ms: Date.now() - t0 } });
  }
}

// POST /test/ocr-region {image_base64, region:[x1,y1,x2,y2]} —— OCR 截图指定区域（粘贴落点校验用），转发 7300
async function handleTestOcrRegion(req, res, body) {
  let payload = {};
  try { payload = JSON.parse(body.toString('utf8')); } catch { }
  const base64 = normalizeBase64(payload.image_base64);
  const region = Array.isArray(payload.region) && payload.region.length === 4 ? payload.region : null;
  if (!base64 || !region) return jsonResponse(res, 200, { code: 0, body: { error: 'invalid args' } });
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort('ocr_timeout'), 10000);
    let j;
    try {
      const r = await fetch('http://127.0.0.1:7300/ocr', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image_base64: base64, region }), signal: ctrl.signal
      });
      j = await r.json();
    } finally { clearTimeout(timer); }
    const texts = (j && j.boxes ? j.boxes : []).map(b => String(b.text || '')).filter(Boolean);
    return jsonResponse(res, 200, { code: 0, body: { texts, text: texts.join(' ') } });
  } catch (e) {
    return jsonResponse(res, 200, { code: 0, body: { error: String(e.message || e) } });
  }
}

// POST /test/last-message {image_base64, app_type} —— OCR 聊天区最后一条消息（发送结果校验用），转发 7300
async function handleTestLastMessage(req, res, body) {
  let payload = {};
  try { payload = JSON.parse(body.toString('utf8')); } catch { }
  const base64 = normalizeBase64(payload.image_base64);
  if (!base64) return jsonResponse(res, 200, { code: 0, body: { error: 'empty image' } });
  const appType = testAppFromPayload(payload);
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort('ocr_timeout'), 8000);
    let j;
    try {
      const r = await fetch('http://127.0.0.1:7300/ocr/last_message', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image_base64: base64, app_type: appType, bottom: true }), signal: ctrl.signal
      });
      j = await r.json();
    } finally { clearTimeout(timer); }
    return jsonResponse(res, 200, { code: 0, body: { role: (j && j.message && j.message.role) || '', text: (j && j.message && j.message.text) || '', raw: j && j.code } });
  } catch (e) {
    return jsonResponse(res, 200, { code: 0, body: { error: String(e.message || e) } });
  }
}

// POST /test/input-box {image_base64, app_type} —— 定位消息输入框中心点（优先布局检测 input_area，空点位回退 VLM 点定位）
async function handleTestInputBox(req, res, body) {
  const t0 = Date.now();
  let payload;
  try { payload = JSON.parse(body.toString('utf8')); }
  catch { return jsonResponse(res, 400, { code: 400, msg: 'invalid json' }); }
  const base64 = normalizeBase64(payload.image_base64);
  if (!base64) return jsonResponse(res, 200, { code: 0, body: { point: null, error: 'empty image' } });
  const mime = detectImageMime(base64);
  const appLabel = testAppFromPayload(payload) === 'wecom' ? '企业微信' : '微信';
  const appType = testAppFromPayload(payload);
  let w = 0, h = 0;
  if (mime === 'image/png') {
    try { const png = decodePng(Buffer.from(base64, 'base64')); w = png.width; h = png.height; } catch { }
  }
  if (!w || !h) { w = 1920; h = 1080; }
  // 方案一：布局检测的 input_area（带合规校验与最小扩展修复），取文字区中心（垂直 55% 处，避开底部发送提示条）
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort('layout_timeout'), 45000);
    let lr;
    try {
      lr = await fetch('http://127.0.0.1:7200/shiflow/v1/layout/detect', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image_base64: base64, app_type: appType, cropped: payload.cropped }), signal: ctrl.signal
      });
    } finally { clearTimeout(timer); }
    const lj = await lr.json();
    const ia = lj && lj.body && lj.body.input_area;
    if (Array.isArray(ia) && ia.length === 2 && ia[1][0] > ia[0][0] && ia[1][1] > ia[0][1]) {
      const cx = Math.round((ia[0][0] + ia[1][0]) / 2);
      const cy = Math.round(ia[0][1] + (ia[1][1] - ia[0][1]) * 0.55);
      const synthetic = !!(lj.body && lj.body.synthetic);
      log(`【test/input-box】${synthetic ? '合成兜底' : '布局'}定位成功 (${cx},${cy}) input_area=${JSON.stringify(ia)} 耗时 ${Date.now() - t0}ms`);
      return jsonResponse(res, 200, { code: 0, body: { point: { x: cx, y: cy }, width: w, height: h, via: synthetic ? 'synthetic' : 'layout', synthetic, input_area: ia, elapsed_ms: Date.now() - t0 } });
    }
    log('【test/input-box】布局检测未给 input_area，回退 VLM 点定位');
  } catch (e) {
    log('【test/input-box】布局检测失败，回退 VLM 点定位:', e.message || e);
  }
  // 方案二：VLM 自由点定位（兜底）
  try {
    const { text } = await llmChat({
      provider: 'doubao', timeoutMs: 45000, responseFormat: { type: 'json_object' },
      messages: [
        { role: 'system', content: [
          `你是 UI 元素定位器。给你一张${appLabel}聊天窗口的屏幕截图，图片尺寸为 ${w}x${h} 像素（左上角为原点 0,0）。`,
          '请定位「消息输入框」（聊天窗口底部用于输入文字的区域）的中心点位置。',
          '只返回 JSON，格式 {"point":{"x":整数,"y":整数}}，坐标是相对整张图片的像素坐标。',
          '如果图片中确实找不到该元素，输出 {"point":null}。不要输出任何其他文字。'
        ].join('\n') },
        { role: 'user', content: [
          { type: 'text', text: '请输出消息输入框中心点的坐标 JSON。' },
          { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } }
        ] }
      ]
    });
    const pt = extractPoint(text, w, h);
    if (pt) {
      const cx = Math.round(Math.min(w, Math.max(0, pt.x)));
      const cy = Math.round(Math.min(h, Math.max(0, pt.y)));
      log(`【test/input-box】定位成功 (${cx},${cy}) 耗时 ${Date.now() - t0}ms`);
      return jsonResponse(res, 200, { code: 0, body: { point: { x: cx, y: cy }, width: w, height: h, via: 'vlm-point', elapsed_ms: Date.now() - t0 } });
    }
    log(`【test/input-box】未找到输入框 耗时 ${Date.now() - t0}ms`);
    return jsonResponse(res, 200, { code: 0, body: { point: null, elapsed_ms: Date.now() - t0 } });
  } catch (e) {
    log('【test/input-box】失败:', e.message || e);
    return jsonResponse(res, 200, { code: 0, body: { point: null, error: String(e.message || e), elapsed_ms: Date.now() - t0 } });
  }
}

// POST /test/occlude {on, app} —— 自救测试用：打开记事本盖住目标窗口（on=true）/ 关闭（on=false）
let occludePid = 0;
async function handleTestOcclude(req, res, body) {
  let payload = {};
  try { payload = JSON.parse(body.toString('utf8')); } catch { }
  const on = payload.on !== false;
  const app = payload.app === 'wechat' ? 'wechat' : 'wecom';
  const names = TEST_APP_PROCS[app].map(n => `'${n}'`).join(',');
  try {
    const j = await runPowerShell(on ? `
${PS_U32}
$t = Get-Process -Name ${names} -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } | Select-Object -First 1
if (-not $t) { [PSCustomObject]@{ ok = $false; reason = 'no_window' } | ConvertTo-Json; exit }
$r = New-Object RECT
[void][U32]::GetWindowRect($t.MainWindowHandle, [ref]$r)
$p = Start-Process notepad.exe -PassThru
$w = 0
while ($p.MainWindowHandle -eq [IntPtr]::Zero -and $w -lt 20) { Start-Sleep -Milliseconds 200; $p.Refresh(); $w++ }
if ($p.MainWindowHandle -ne [IntPtr]::Zero) {
  [void][U32]::SetWindowPos($p.MainWindowHandle, [IntPtr]::Zero, $r.Left, $r.Top, ($r.Right - $r.Left), ($r.Bottom - $r.Top), 0x4)
  [void][U32]::ShowWindow($p.MainWindowHandle, 6)
  Start-Sleep -Milliseconds 250
  [void][U32]::ShowWindow($p.MainWindowHandle, 9)
  $fg0 = [U32]::GetForegroundWindow()
  $fgTid = [U32]::GetWindowThreadProcessId($fg0, [IntPtr]::Zero)
  $myTid = [U32]::GetCurrentThreadId()
  [void][U32]::AttachThreadInput($myTid, $fgTid, $true)
  [U32]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
  [void][U32]::SetForegroundWindow($p.MainWindowHandle)
  [void][U32]::BringWindowToTop($p.MainWindowHandle)
  [U32]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
  [void][U32]::AttachThreadInput($myTid, $fgTid, $false)
}
[PSCustomObject]@{ ok = $true; pid = $p.Id } | ConvertTo-Json
` : `
if (${occludePid} -gt 0) { Stop-Process -Id ${occludePid} -Force -ErrorAction SilentlyContinue }
[PSCustomObject]@{ ok = $true } | ConvertTo-Json
`, 20000);
    if (j.pid) occludePid = j.pid;
    if (!on) occludePid = 0;
    log(`【test/occlude】on=${on} app=${app} ok=${!!j.ok}${j.pid ? ' pid=' + j.pid : ''}`);
    return jsonResponse(res, 200, { code: 0, body: { ok: !!j.ok, reason: j.reason || '' } });
  } catch (e) {
    return jsonResponse(res, 200, { code: 0, body: { ok: false, error: String(e.message || e) } });
  }
}

// POST /test/key {key:'esc'|'enter'|'ctrl+a'|'delete'} —— 发送单个按键/组合键（看门狗关弹窗、清草稿用）
async function handleTestKey(req, res, body) {
  let payload;
  try { payload = JSON.parse(body.toString('utf8')); }
  catch { return jsonResponse(res, 400, { code: 400, msg: 'invalid json' }); }
  const key = String(payload.key || '').toLowerCase();
  const scripts = {
    esc: '[U32]::keybd_event(0x1B, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 60; [U32]::keybd_event(0x1B, 0, 2, [UIntPtr]::Zero)',
    enter: '[U32]::keybd_event(0x0D, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 60; [U32]::keybd_event(0x0D, 0, 2, [UIntPtr]::Zero)',
    'ctrl+a': '[U32]::keybd_event(0x11, 0, 0, [UIntPtr]::Zero); [U32]::keybd_event(0x41, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 60; [U32]::keybd_event(0x41, 0, 2, [UIntPtr]::Zero); [U32]::keybd_event(0x11, 0, 2, [UIntPtr]::Zero)',
    delete: '[U32]::keybd_event(0x2E, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 60; [U32]::keybd_event(0x2E, 0, 2, [UIntPtr]::Zero)'
  };
  const script = scripts[key];
  if (!script) return jsonResponse(res, 200, { code: 0, body: { ok: false, error: 'unsupported key: ' + key } });
  try {
    const j = await runPowerShell(`
${PS_U32}
${script}
[PSCustomObject]@{ ok = $true } | ConvertTo-Json
`, 10000);
    log(`【test/key】${key} ok=${!!j.ok}`);
    return jsonResponse(res, 200, { code: 0, body: { ok: !!j.ok } });
  } catch (e) {
    return jsonResponse(res, 200, { code: 0, body: { ok: false, error: String(e.message || e) } });
  }
}

// POST /test/paste {text?, send?} —— 向前台焦点输入框粘贴文本（Ctrl+V）；send=true 时随后回车发送
async function handleTestPaste(req, res, body) {
  const t0 = Date.now();
  let payload;
  try { payload = JSON.parse(body.toString('utf8')); }
  catch { return jsonResponse(res, 400, { code: 400, msg: 'invalid json' }); }
  const text = typeof payload.text === 'string' ? payload.text : '';
  const doSend = payload.send === true;
  if (!text && !doSend) return jsonResponse(res, 200, { code: 0, body: { error: 'empty text' } });
  const b64 = text ? Buffer.from(text, 'utf8').toString('base64') : '';
  try {
    const j = await runPowerShell(`
${PS_U32}
$pasted = $false
$sent = $false
if ('${b64}' -ne '') {
  $t = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${b64}'))
  Set-Clipboard -Value $t
  Start-Sleep -Milliseconds 200
  [U32]::keybd_event(0x11, 0, 0, [UIntPtr]::Zero)
  [U32]::keybd_event(0x56, 0, 0, [UIntPtr]::Zero)
  [U32]::keybd_event(0x56, 0, 2, [UIntPtr]::Zero)
  [U32]::keybd_event(0x11, 0, 2, [UIntPtr]::Zero)
  $pasted = $true
  Start-Sleep -Milliseconds 400
}
if ('${doSend ? '1' : ''}' -eq '1') {
  [U32]::keybd_event(0x0D, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 80
  [U32]::keybd_event(0x0D, 0, 2, [UIntPtr]::Zero)
  $sent = $true
}
[PSCustomObject]@{ ok = $true; pasted = $pasted; sent = $sent } | ConvertTo-Json
`, 20000, ['-STA']);
    log(`【test/paste】pasted=${!!j.pasted} sent=${!!j.sent} 文本=${text.length}字 耗时 ${Date.now() - t0}ms`);
    return jsonResponse(res, 200, { code: 0, body: { ok: !!j.ok, pasted: !!j.pasted, sent: !!j.sent, elapsed_ms: Date.now() - t0 } });
  } catch (e) {
    log('【test/paste】失败:', e.message || e);
    return jsonResponse(res, 200, { code: 0, body: { ok: false, error: String(e.message || e), elapsed_ms: Date.now() - t0 } });
  }
}

// POST /test/locate {image_base64, app_type, target} —— 通用 UI 元素定位（target 为自然语言描述）
async function handleTestLocate(req, res, body) {
  const t0 = Date.now();
  let payload;
  try { payload = JSON.parse(body.toString('utf8')); }
  catch { return jsonResponse(res, 400, { code: 400, msg: 'invalid json' }); }
  const base64 = normalizeBase64(payload.image_base64);
  const target = String(payload.target || '').trim();
  if (!base64) return jsonResponse(res, 200, { code: 0, body: { point: null, error: 'empty image' } });
  if (!target) return jsonResponse(res, 200, { code: 0, body: { point: null, error: 'empty target' } });
  const mime = detectImageMime(base64);
  const appLabel = testAppFromPayload(payload) === 'wecom' ? '企业微信' : '微信';
  let w = 0, h = 0;
  if (mime === 'image/png') {
    try { const png = decodePng(Buffer.from(base64, 'base64')); w = png.width; h = png.height; } catch { }
  }
  if (!w || !h) { w = 1920; h = 1080; }
  try {
    const { text } = await llmChat({
      provider: 'doubao', timeoutMs: 45000, responseFormat: { type: 'json_object' },
      messages: [
        { role: 'system', content: [
          `你是 UI 元素定位器。给你一张${appLabel}窗口的截图，图片尺寸为 ${w}x${h} 像素（左上角为原点 0,0）。`,
          `请定位「${target}」的中心点位置。`,
          '只返回 JSON，格式 {"point":{"x":整数,"y":整数}}，坐标是相对整张图片的像素坐标。',
          '如果图片中确实找不到该元素，输出 {"point":null}。不要输出任何其他文字。'
        ].join('\n') },
        { role: 'user', content: [
          { type: 'text', text: `请输出「${target}」中心点的坐标 JSON。` },
          { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } }
        ] }
      ]
    });
    const pt = extractPoint(text, w, h);
    if (pt) {
      const cx = Math.round(Math.min(w, Math.max(0, pt.x)));
      const cy = Math.round(Math.min(h, Math.max(0, pt.y)));
      log(`【test/locate】「${target.slice(0, 30)}」→ (${cx},${cy}) 耗时 ${Date.now() - t0}ms`);
      return jsonResponse(res, 200, { code: 0, body: { point: { x: cx, y: cy }, width: w, height: h, elapsed_ms: Date.now() - t0 } });
    }
    log(`【test/locate】「${target.slice(0, 30)}」未找到 耗时 ${Date.now() - t0}ms`);
    return jsonResponse(res, 200, { code: 0, body: { point: null, elapsed_ms: Date.now() - t0 } });
  } catch (e) {
    log('【test/locate】失败:', e.message || e);
    return jsonResponse(res, 200, { code: 0, body: { point: null, error: String(e.message || e), elapsed_ms: Date.now() - t0 } });
  }
}

// POST /test/mouse {action:'move'|'click'|'double_click'|'glide_click'|'glide_double_click', x, y, from_x?, from_y?} —— 鼠标动作（屏幕物理像素坐标）
// glide_click：从 (from_x,from_y) 沿拟人贝塞尔轨迹滑到 (x,y) 再单击（复用客户端轨迹算法）
// glide_double_click：同上但滑到后双击（进聊天窗口用：单击常被窗口激活吃掉，双击必进）
async function handleTestMouse(req, res, body) {
  let payload;
  try { payload = JSON.parse(body.toString('utf8')); }
  catch { return jsonResponse(res, 400, { code: 400, msg: 'invalid json' }); }
  const action = ['double_click', 'click', 'move', 'glide_click', 'glide_double_click'].includes(payload.action) ? payload.action : 'move';
  const x = Math.round(Number(payload.x));
  const y = Math.round(Number(payload.y));
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return jsonResponse(res, 200, { code: 0, body: { ok: false, error: 'invalid coordinates' } });
  }
  try {
    let glidePs = '';
    if (action === 'glide_click' || action === 'glide_double_click') {
      const fx = Math.round(Number(payload.from_x));
      const fy = Math.round(Number(payload.from_y));
      const path = Number.isFinite(fx) && Number.isFinite(fy)
        ? generateBezierPath(fx, fy, x, y, { minSteps: 8, maxSteps: 22, baseDelay: 14 })
        : { points: [] };
      const lines = path.points.map(pt =>
        `[void][U32]::SetCursorPos(${pt.x}, ${pt.y})\nStart-Sleep -Milliseconds ${Math.max(5, pt.delay)}`
      ).join('\n');
      glidePs = `${lines}\n[void][U32]::SetCursorPos(${x}, ${y})\nStart-Sleep -Milliseconds 150`;
    }
    const j = await runPowerShell(`
${PS_U32}
${action === 'glide_click' ? glidePs : `[void][U32]::SetCursorPos(${x}, ${y})\nStart-Sleep -Milliseconds 120`}
${action === 'double_click' || action === 'glide_double_click' ? `
[U32]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
[U32]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 90
[U32]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
[U32]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
` : ''}
${action === 'click' || action === 'glide_click' ? `
[U32]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
[U32]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
` : ''}
[PSCustomObject]@{ ok = $true } | ConvertTo-Json
`);
    log(`【test/mouse】${action} (${x},${y})${action === 'glide_click' ? ` 起点(${payload.from_x},${payload.from_y})` : ''} ok=${!!j.ok}`);
    return jsonResponse(res, 200, { code: 0, body: { ok: !!j.ok, action, x, y } });
  } catch (e) {
    log('【test/mouse】失败:', e.message || e);
    return jsonResponse(res, 200, { code: 0, body: { ok: false, error: String(e.message || e) } });
  }
}

// ---------- 路由 ----------
// ---------- 线上产品目录自动同步（每 12 小时抓取，无需手动上传） ----------
const CATALOG_URL = CONFIG.catalog_url || ''; // 开源版未内置商品目录地址，可在 config.json 里配 catalog_url
const CATALOG_INTERVAL_MS = 12 * 3600 * 1000;

function fmtCatalogText(products) {
  const lines = ['产品知识库（线上目录实时同步）', ''];
  for (const p of products) {
    // 每个产品一行（字段用；连接），检索时整行命中，产品名和字段不分离
    const parts = [];
    if (p.name) parts.push(`产品：${p.name}`);
    if (p.core) parts.push(`简称：${p.core}`);
    if (p.type) parts.push(`类型：${p.type}`);
    if (p.plan) parts.push(`套餐内容：${p.plan}`);
    if (p.contract) parts.push(`合约期：${p.contract}`);
    if (p.region) parts.push(`归属地：${p.region}`);
    if (p.ship) parts.push(`发货范围：${p.ship}`);
    if (p.ban) parts.push(`禁发地：${p.ban}`);
    if (p.activate) parts.push(`激活方式：${p.activate}`);
    if (p.recharge) parts.push(`首充渠道：${p.recharge}`);
    if (p.delivery) parts.push(`配送方式：${p.delivery}`);
    if (p.age) parts.push(`年龄限制：${p.age}`);
    if (parts.length) lines.push(parts.join('；'));
  }
  return lines.join('\n');
}

async function syncCatalog(reason) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort('timeout'), 20000);
    let j;
    try {
      const r = await fetch(CATALOG_URL, { signal: ctrl.signal });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      j = await r.json();
    } finally { clearTimeout(timer); }
    if (!Array.isArray(j) || !j.length) throw new Error('目录为空或格式不对');
    const text = fmtCatalogText(j);
    const id = 'remote_catalog';
    fs.writeFileSync(path.join(KB_DIR, id + '.txt'), text, 'utf8');
    const list = loadKbFiles();
    const meta = { id, name: '线上产品目录（实时同步）', size: Buffer.byteLength(text), chars: text.length, uploaded_at: now(), remote: true };
    const idx = list.findIndex(d => d.id === id);
    if (idx >= 0) list[idx] = meta; else list.push(meta);
    saveKbFiles(list);
    log(`【知识库目录】同步成功（${reason}）：${j.length} 个产品，${text.length} 字`);
    return { ok: true, count: j.length, chars: text.length };
  } catch (e) {
    log(`【知识库目录】同步失败（${reason}）:`, e.message || e);
    return { ok: false, error: String(e.message || e) };
  }
}

// POST /kb/catalog/refresh —— 手动立即同步线上产品目录
async function handleCatalogRefresh(req, res) {
  const r = await syncCatalog('手动');
  return jsonResponse(res, 200, { code: 0, body: r });
}

if (CONFIG.catalog_sync !== false) {
  setTimeout(() => syncCatalog('启动'), 8000);
  setInterval(() => syncCatalog('定时'), CATALOG_INTERVAL_MS);
}

// ---------- 啄木鸟跟班状态 ----------
// 状态规则：正在理解对方对话（sees/speed 处理中）= 回复中；其余 = 查看中
const wpState = { state: '查看中', reply: '', chat: '', at: '', step: '查看会话中' };
// biz 主动上报的引擎真实状态（启动/停止时推送，比"最近活动推断"准确——未启动就绝不动窗口）
let engineExplicit = { running: null, at: 0 };
let engineStoppedAt = 0; // 最近一次 biz 上报「已停止」的时间：发送途中被停 → 回复多半没贴上，不计入已回复
// POST /engine/state {running:true|false}
async function handleEngineState(req, res, body) {
  let payload = {};
  try { payload = JSON.parse(body.toString('utf8')); } catch { }
  engineExplicit = { running: payload.running === true, at: Date.now() };
  if (engineExplicit.running === false) engineStoppedAt = Date.now();
  log('【引擎状态】biz 上报：' + (engineExplicit.running ? '已启动' : '已停止'));
  return jsonResponse(res, 200, { code: 0, body: { ok: true } });
}

// POST /reply/rollback {expected, app_type} —— 截图核实未看到刚发的气泡时回滚：
// 删该会话最近 10 分钟内匹配的我方回复记录 + 清冷却/去重，下一轮轮询会重新判定并补回
async function handleReplyRollback(req, res, body) {
  let payload = {};
  try { payload = JSON.parse(body.toString('utf8')); } catch { }
  const expected = String(payload.expected || '');
  const chat = lastReplyChatName || '';
  const normT = t => String(t || '').replace(/[\s\p{P}\p{S}]/gu, '');
  const expN = normT(expected);
  let removed = null;
  try {
    const lines = fs.existsSync(RECORDS_FILE) ? fs.readFileSync(RECORDS_FILE, 'utf8').split('\n') : [];
    const nowMs = Date.now();
    let removeIdx = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      const s = lines[i].trim(); if (!s) continue;
      let r; try { r = JSON.parse(s); } catch { continue; }
      if (r.nickname !== 'sf_agent') continue;
      if (chat && normChatName(r.target_name) !== normChatName(chat)) continue;
      const t = Date.parse(String(r.created_at || '').replace(' ', 'T')) || 0;
      if (nowMs - t > 10 * 60 * 1000) break;
      const a = normT(r.content);
      if (expN && (a.includes(expN) || expN.includes(a) || a.includes(expN.slice(-12)))) { removeIdx = i; removed = r; break; }
    }
    if (removeIdx >= 0) { lines.splice(removeIdx, 1); fs.writeFileSync(RECORDS_FILE, lines.join('\n'), 'utf8'); }
  } catch (e) { log('【回复回滚】删记录失败:', e.message || e); }
  if (chat) delete lastReplyAtChat[normChatName(chat)];
  if (chat) {
    for (const k of [...repliedMessages.keys()]) {
      const sep = k.indexOf('|');
      if (normChatName(k.slice(0, sep)) === normChatName(chat)) repliedMessages.delete(k);
    }
  }
  log(`【回复回滚】会话=${chat || '-'} 删记录=${removed ? '是' : '否'} 内容="${removed ? String(removed.content).slice(0, 30) : ''}"，下轮将重新判定回复`);
  return jsonResponse(res, 200, { code: 0, body: { ok: true, removed: !!removed } });
}
// GET /woodpecker/status —— 啄木鸟悬浮窗轮询
async function handleWoodpeckerStatus(req, res) {
  return jsonResponse(res, 200, {
    code: 0,
    body: {
      state: wpState.state,
      reply: wpState.reply,
      chat: wpState.chat,
      at: wpState.at,
      step: wpState.step,
      engine_active: !!lastEngineApiAt && Date.now() - lastEngineApiAt <= 45000
    }
  });
}

// POST /reply/guard —— 防发错人校验：当前输入框会话名（截标题条+OCR）vs 回复目标会话（lastReplyChatName）
async function handleReplyGuard(req, res, body) {
  const t0 = Date.now();
  let payload = {};
  try { payload = JSON.parse(body.toString('utf8')); } catch { }
  const app = payload.app_type === 'wechat' ? 'wechat' : 'wecom';
  const expected = lastReplyChatName || '';
  if (!expected || expected === '当前会话') return jsonResponse(res, 200, { code: 0, body: { match: true, reason: 'no_expected' } });
  try {
    const names = TEST_APP_PROCS[app].map(n => `'${n}'`).join(',');
    const j = await runPowerShell(`
${PS_U32}
Add-Type -AssemblyName System.Drawing
$p = Get-Process -Name ${names} -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } | Select-Object -First 1
if (-not $p) { [PSCustomObject]@{ ok = $false; reason = 'no_window' } | ConvertTo-Json; exit }
$r = New-Object RECT
[void][U32]::GetWindowRect($p.MainWindowHandle, [ref]$r)
$w = $r.Right - $r.Left; $hh = $r.Bottom - $r.Top
if ($w -le 50 -or $hh -le 50) { [PSCustomObject]@{ ok = $false; reason = 'window_hidden' } | ConvertTo-Json; exit }
$x = $r.Left + [int]($w * 0.36); $y = $r.Top; $cw = [int]($w * 0.64); $ch = 56
$bmp = New-Object System.Drawing.Bitmap $cw, $ch
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($x, $y, 0, 0, $bmp.Size)
$g.Dispose()
$file = Join-Path $env:TEMP ('lj_guard_' + [guid]::NewGuid().ToString('N') + '.png')
$bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
[PSCustomObject]@{ ok = $true; file = $file } | ConvertTo-Json
`, 15000);
    if (!j.ok) return jsonResponse(res, 200, { code: 0, body: { match: true, reason: j.reason || 'capture_failed', elapsed_ms: Date.now() - t0 } });
    const b64 = fs.readFileSync(j.file).toString('base64');
    fs.unlink(j.file, () => { });
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort('t'), 8000);
    let oj;
    try {
      oj = await (await fetch('http://127.0.0.1:7300/ocr', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image_base64: b64 }), signal: ctrl.signal
      })).json();
    } finally { clearTimeout(timer); }
    const text = ((oj && oj.boxes) || []).map(b => b.text || '').join(' ');
    const strip = s => String(s).replace(/[\s\p{P}\p{S}]/gu, '').replace(/@(微信|企微|企业微信|wechat|wecom)$/i, '').replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, '');
    const expN = strip(expected), scrN = strip(text);
    // 默认放行（证据不足绝不误拦）；仅当屏幕上出现「明确可读且不同」的会话名（带微信/企微标记）才确信发错人并拦截
    let match = true;
    if (expN && scrN) {
      if (scrN.includes(expN) || expN.includes(scrN)) {
        match = true;
      } else if (scrN.length >= 4 && /微信|企微/.test(scrN)) {
        match = false;
      }
    }
    log(`【reply/guard】期望="${expected}" 屏幕="${text.slice(0, 30)}" match=${match} 耗时 ${Date.now() - t0}ms`);
    return jsonResponse(res, 200, { code: 0, body: { match, expected, screen: text.slice(0, 40), elapsed_ms: Date.now() - t0 } });
  } catch (e) {
    log('【reply/guard】异常（放行）:', e.message || e);
    return jsonResponse(res, 200, { code: 0, body: { match: true, reason: String(e.message || e), elapsed_ms: Date.now() - t0 } });
  }
}

// 读当前聊天窗口标题条里的会话名（VLM 读不出名字时的自救：截标题条 + OCR）
async function readChatTitle(appType) {
  try {
    const app = appType === 'wechat' ? 'wechat' : 'wecom';
    const names = TEST_APP_PROCS[app].map(n => `'${n}'`).join(',');
    const j = await runPowerShell(`
${PS_U32}
Add-Type -AssemblyName System.Drawing
$p = Get-Process -Name ${names} -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } | Select-Object -First 1
if (-not $p) { [PSCustomObject]@{ ok = $false } | ConvertTo-Json; exit }
$r = New-Object RECT
[void][U32]::GetWindowRect($p.MainWindowHandle, [ref]$r)
$w = $r.Right - $r.Left; $hh = $r.Bottom - $r.Top
if ($w -le 50 -or $hh -le 50) { [PSCustomObject]@{ ok = $false } | ConvertTo-Json; exit }
$x = $r.Left + [int]($w * 0.36); $y = $r.Top; $cw = [int]($w * 0.40); $ch = 56
$bmp = New-Object System.Drawing.Bitmap $cw, $ch
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($x, $y, 0, 0, $bmp.Size)
$g.Dispose()
$file = Join-Path $env:TEMP ('lj_title_' + [guid]::NewGuid().ToString('N') + '.png')
$bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
[PSCustomObject]@{ ok = $true; file = $file } | ConvertTo-Json
`, 15000);
    if (!j.ok) return '';
    const b64 = fs.readFileSync(j.file).toString('base64');
    fs.unlink(j.file, () => { });
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort('t'), 8000);
    let oj;
    try { oj = await (await fetch('http://127.0.0.1:7300/ocr', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image_base64: b64 }), signal: ctrl.signal })).json(); }
    finally { clearTimeout(timer); }
    const boxes = ((oj && oj.boxes) || []);
    boxes.sort((a, b) => (a.bbox[0][1] - b.bbox[0][1]) || (a.bbox[0][0] - b.bbox[0][0]));
    for (const b of boxes) {
      const cand = String(b.text || '').replace(/@(微信|企微|企业微信|wechat|wecom).*/i, '').trim();
      if (normChatName(cand).length >= 1 && /[\p{L}\p{N}]/u.test(normChatName(cand))) return cand;
    }
    return '';
  } catch { return ''; }
}

// ---------- 误触自救看门狗 ----------
// 引擎运行期间（45 秒内有引擎调用）每 15 秒自检：
// ① 企微/微信被其他窗口挡住 → 拉回最前；② 误开智能助理/智能总结页 → 自动点回「消息」页
let lastEngineApiAt = 0;
let lastEngineApp = 'wecom';
let lastTestApiAt = 0; // 最近一次 /test/* 功能测试调用时间（看门狗避让用）
const watchdogState = { lastCheck: '', lastRescue: '' };
const watchdogEvents = [];
let watchdogTopmost = false;
function noteEngineActivity(appType) {
  lastEngineApiAt = Date.now();
  const a = String(appType || '').toLowerCase();
  if (a === 'wecom' || a === 'enterprise' || a === 'wework' || a === 'wxwork') lastEngineApp = 'wecom';
  else if (a === 'wechat' || a === 'personal' || a === 'weixin') lastEngineApp = 'wechat';
}
function wdEvent(text) {
  watchdogEvents.push({ time: fmtTime(new Date()), text });
  if (watchdogEvents.length > 30) watchdogEvents.shift();
}

async function selfPost(pathname, payload, timeoutMs = 30000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort('timeout'), timeoutMs);
  try {
    const r = await fetch('http://127.0.0.1:7200' + pathname, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-internal-call': '1' },
      body: JSON.stringify(payload || {}), signal: ctrl.signal
    });
    return await r.json();
  } finally { clearTimeout(timer); }
}

// 置顶管理：引擎活跃时把目标窗口设为置顶（任何窗口/弹窗都挡不住），引擎停止后取消置顶归还正常层级
async function setChatTopmost(app, on) {
  const names = app === 'wecom' ? "'WXWork'" : "'Weixin','WeChat'";
  const after = on ? '-1' : '-2'; // HWND_TOPMOST / HWND_NOTOPMOST
  try {
    const j = await runPowerShell(`
${PS_U32}
$p = Get-Process -Name ${names} -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } | Select-Object -First 1
if (-not $p) { [PSCustomObject]@{ ok = $false } | ConvertTo-Json; exit }
[void][U32]::SetWindowPos($p.MainWindowHandle, [IntPtr]${after}, 0, 0, 0, 0, 0x3)
[PSCustomObject]@{ ok = $true } | ConvertTo-Json
`, 15000);
    return !!j.ok;
  } catch (e) { log('【看门狗】置顶设置失败:', e.message || e); return false; }
}

// AI 鼠标（蓝紫渐变放大）：引擎开自动回复时切换，停止后还原系统默认
let aiCursorApplied = false;
async function setAiCursor(on) {
  const curPath = path.join(DATA_DIR, 'ai_cursor.cur');
  if (on && !fs.existsSync(curPath)) { log('【AI鼠标】缺少 ai_cursor.cur'); return false; }
  const curB64 = on ? Buffer.from(curPath, 'utf8').toString('base64') : '';
  try {
    const j = await runPowerShell(`
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class Cur32 {
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr LoadCursorFromFile(string path);
  [DllImport("user32.dll")] public static extern bool SetSystemCursor(IntPtr hcur, uint id);
  [DllImport("user32.dll")] public static extern IntPtr LoadImage(IntPtr hinst, IntPtr name, uint type, int x, int y, uint load);
}
'@
if ('${on ? '1' : ''}' -eq '1') {
  $cur = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${curB64}'))
  $h = [Cur32]::LoadCursorFromFile($cur)
  if ($h -eq [IntPtr]::Zero) { [PSCustomObject]@{ ok = $false; reason = 'load failed' } | ConvertTo-Json; exit }
  [void][Cur32]::SetSystemCursor($h, 32512)
  [PSCustomObject]@{ ok = $true } | ConvertTo-Json
} else {
  $h = [Cur32]::LoadImage([IntPtr]::Zero, [IntPtr]32512, 2, 0, 0, 0x8000)
  [void][Cur32]::SetSystemCursor($h, 32512)
  [PSCustomObject]@{ ok = $true } | ConvertTo-Json
}
`, 15000);
    return !!j.ok;
  } catch (e) { log('【AI鼠标】切换失败:', e.message || e); return false; }
}

let lastAlertAt = 0; // 遮挡告警弹窗冷却：10 分钟内不重复弹（多次运行回复期间绝不刷屏）

// 遮挡人工告警弹窗：独立进程悬挂显示，不等待用户点击（不阻塞服务循环）
function alertPopup(appLabel, fg) {
  try {
    const msg = `聊机检测到${appLabel}窗口被「${fg}」遮挡，自动回复可能中断。\n\n请把${appLabel}窗口保持在桌面最前（不要最小化、不要被其他窗口盖住），然后点「确定」继续。`;
    const script = `Add-Type -AssemblyName System.Windows.Forms; [void][System.Windows.Forms.MessageBox]::Show(${JSON.stringify(msg)},'聊机：需要人工配合',[System.Windows.Forms.MessageBoxButtons]::OK,[System.Windows.Forms.MessageBoxIcon]::Warning)`;
    const p = require('child_process').spawn('powershell', ['-NoProfile', '-Command', script], { detached: true, stdio: 'ignore' });
    p.unref();
  } catch (e) { log('【看门狗】告警弹窗失败:', e.message || e); }
}

async function watchdogTick() {
  // 自动自救总开关：watchdog_enabled=false 时不做任何鼠标/窗口操作（ESC、拉回、点回消息、置顶、AI鼠标全关），
  // 只做轻量遮挡检测 + 弹窗提醒人工配合——人把企微窗口置顶后点确定即可
  const auto = CONFIG.watchdog_enabled !== false;
  // 只有「明确上报已停止」才算停；未上报（服务重启丢状态）时按最近 45s 活动推断——biz 还在跑就继续护航
  const engineActive = engineExplicit.running === false ? false
    : (!!lastEngineApiAt && Date.now() - lastEngineApiAt <= 45000);
  const appLabel = lastEngineApp === 'wecom' ? '企业微信' : '微信';
  watchdogState.lastCheck = now();

  if (!auto) {
    if (engineActive) {
      try {
        const s = await selfPost('/test/screenshot', { app: lastEngineApp });
        if (s && s.body && s.body.image_base64 && s.body.occluded && Date.now() - lastAlertAt > 10 * 60 * 1000) {
          lastAlertAt = Date.now();
          const fg = s.body.foreground_title || '其他窗口';
          log(`【看门狗】自动自救已关闭：${appLabel}被「${fg}」遮挡，已弹窗提醒人工置顶（10 分钟内不再重复弹）`);
          alertPopup(appLabel, fg);
          watchdogState.lastRescue = `${now()} 遮挡人工告警（前台=${fg}，弹窗提醒）`;
        }
      } catch (e) { /* 告警失败不致命 */ }
    }
    return;
  }

  // AI 鼠标跟随引擎状态
  if (engineActive && !aiCursorApplied) {
    if (await setAiCursor(true)) {
      aiCursorApplied = true;
      log('【AI鼠标】已切换：蓝紫渐变放大鼠标');
      wdEvent('已切换 AI 鼠标（蓝紫渐变放大）');
    }
  } else if (!engineActive && aiCursorApplied) {
    if (await setAiCursor(false)) {
      aiCursorApplied = false;
      log('【AI鼠标】已还原默认鼠标');
      wdEvent('已还原默认鼠标');
    }
  }

  // 置顶跟随引擎状态：功能测试期间临时取消置顶（不遮挡聊机面板），并暂停自救动作避免抢窗口
  const testing = lastTestApiAt && Date.now() - lastTestApiAt < 30000;
  if (testing) {
    if (watchdogTopmost) {
      if (await setChatTopmost(lastEngineApp, false)) {
        watchdogTopmost = false;
        log('【看门狗】功能测试中，临时取消置顶');
        wdEvent('功能测试中，临时取消置顶');
      }
    }
    // 测试期间仍做预览劫持自救（点开了图片/文件预览会卡死后续步骤，必须 ESC 爬回来）
    try {
      const names2 = lastEngineApp === 'wecom' ? "'WXWork'" : "'Weixin','WeChat'";
      const tj = await runPowerShell(`
$p = Get-Process -Name ${names2} -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } | Select-Object -First 1
if ($p) { [PSCustomObject]@{ title = $p.MainWindowTitle } | ConvertTo-Json } else { [PSCustomObject]@{ title = '' } | ConvertTo-Json }
`, 15000);
      const wt = String(tj.title || '');
      if (wt && /预览|图片|image|photo|viewer/i.test(wt)) {
        log(`【看门狗】测试期间检测到预览劫持（标题="${wt}"），ESC 关闭`);
        wdEvent(`测试期间预览劫持（${wt}）→ ESC 关闭`);
        await selfPost('/test/key', { key: 'esc' });
        await new Promise(r => setTimeout(r, 700));
        await selfPost('/test/activate', { app: lastEngineApp });
        watchdogState.lastRescue = `${now()} 预览劫持自救（${wt}，测试中）`;
      }
    } catch (e) { log('【看门狗】测试期预览检测异常:', e.message || e); }
    return;
  }
  if (engineActive && !watchdogTopmost) {
    if (await setChatTopmost(lastEngineApp, true)) {
      watchdogTopmost = true;
      log(`【看门狗】引擎运行中：已将${appLabel}聊天窗口置顶到最前`);
      wdEvent(`引擎运行中，已把${appLabel}窗口置顶到最前`);
    }
  } else if (!engineActive && watchdogTopmost) {
    if (await setChatTopmost(lastEngineApp, false)) {
      watchdogTopmost = false;
      log('【看门狗】引擎已停：已取消置顶，归还正常窗口层级');
      wdEvent('引擎停止，已取消置顶');
    }
  }
  if (!engineActive) return; // 引擎不在跑（含空轮休眠），不打扰用户

  const app = lastEngineApp;
  try {
    // ① 遮挡/弹窗自救：目标窗口不在前台 → 先 ESC 关掉可能的弹窗，再拉回最前
    let shot = await selfPost('/test/screenshot', { app });
    if (!shot || !shot.body || !shot.body.image_base64) return;
    if (shot.body.occluded) {
      const fg = shot.body.foreground_title || '其他窗口';
      log(`【看门狗】${appLabel}被「${fg}」遮挡/弹窗卡住，先 ESC 再拉回最前`);
      wdEvent(`检测到${appLabel}被「${fg}」遮挡/弹窗卡住 → ESC 关弹窗 → 拉回最前`);
      await selfPost('/test/key', { key: 'esc' });
      await new Promise(r => setTimeout(r, 300));
      await selfPost('/test/activate', { app });
      watchdogState.lastRescue = `${now()} 遮挡自救（前遮挡=${fg}）`;
      await new Promise(r => setTimeout(r, 800));
      shot = await selfPost('/test/screenshot', { app });
      if (!shot || !shot.body || !shot.body.image_base64 || shot.body.occluded) return;
      wdEvent(`${appLabel}已回到最前`);
    }
    // ② 误开智能助理/智能总结自救：OCR 右侧主区域（从 40% 起，避开会话列表预览文字），
    // 命中功能页特征词 → 点「消息」图标回消息页
    const w = shot.body.width, h2 = shot.body.height;
    const region = [Math.round(w * 0.4), 0, w - Math.round(w * 0.4), h2];
    let text = '';
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort('t'), 10000);
      let oj;
      try {
        oj = await (await fetch('http://127.0.0.1:7300/ocr', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ image_base64: shot.body.image_base64, region }), signal: ctrl.signal
        })).json();
      } finally { clearTimeout(timer); }
      text = ((oj && oj.boxes) || []).map(b => b.text || '').join(' ');
    } catch { return; }
    if (/开始总结|输入你想总结的主题|汇总项目进展|总结团队周报|智能助理/.test(text)) {
      log(`【看门狗】检测到${appLabel}误开功能页（右侧命中「${text.slice(0, 24)}…」），点回「消息」页`);
      wdEvent(`检测到误开智能助理/总结页 → 点回「消息」页`);
      // 「消息」图标在窗口左侧目录栏固定位置（窗口裁剪坐标 ≈(35,111)）
      await selfPost('/test/mouse', {
        action: 'click',
        x: Math.round(shot.body.origin_x + 35),
        y: Math.round(shot.body.origin_y + 111)
      });
      watchdogState.lastRescue = `${now()} 功能页自救（点回消息）`;
    }
    // ③ 企微内部弹窗遮挡自救（独立聊天窗/智能助理弹窗——同进程弹窗，前台检查发现不了）：
    // 找到弹窗后先点它自己的关闭键（右上角 ✕），关不掉再 ESC 兜底，最后主窗口拉回最前
    if (app === 'wecom') {
      const internal = await detectWecomInternalPopup();
      if (internal.found && internal.rect) {
        const rcx = Math.round(internal.rect.r - 16);
        const rcy = Math.round(internal.rect.t + 12);
        log(`【看门狗】检测到企微内部弹窗遮挡（${internal.cls}${internal.title ? ' ' + internal.title : ''}），点击关闭键 (${rcx},${rcy})`);
        wdEvent(`检测到内部弹窗（${internal.cls}）遮挡 → 点击关闭键关闭`);
        await selfPost('/test/mouse', { action: 'click', x: rcx, y: rcy });
        await new Promise(r => setTimeout(r, 700));
        const again = await detectWecomInternalPopup();
        if (again.found) {
          log('【看门狗】关闭键未关掉，ESC 兜底');
          wdEvent('关闭键未关掉 → ESC 兜底');
          await selfPost('/test/key', { key: 'esc' });
          await new Promise(r => setTimeout(r, 400));
        }
        await selfPost('/test/activate', { app });
        watchdogState.lastRescue = `${now()} 内部弹窗自救（${internal.cls}）`;
      }
    }
    // ④ 主窗口被图片/文件预览劫持（标题为预览类，引擎盯着照片变瞎）→ ESC 关闭预览恢复聊天窗
    try {
      const names2 = app === 'wecom' ? "'WXWork'" : "'Weixin','WeChat'";
      const tj = await runPowerShell(`
$p = Get-Process -Name ${names2} -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } | Select-Object -First 1
if ($p) { [PSCustomObject]@{ title = $p.MainWindowTitle } | ConvertTo-Json } else { [PSCustomObject]@{ title = '' } | ConvertTo-Json }
`, 15000);
      const wt = String(tj.title || '');
      if (wt && /预览|图片|image|photo|viewer/i.test(wt)) {
        log(`【看门狗】${appLabel}主窗口被预览劫持（标题="${wt}"），ESC 关闭预览恢复聊天窗`);
        wdEvent(`检测到预览窗口（${wt}）劫持 → ESC 关闭 → 拉回聊天窗`);
        await selfPost('/test/key', { key: 'esc' });
        await new Promise(r => setTimeout(r, 700));
        await selfPost('/test/activate', { app });
        watchdogState.lastRescue = `${now()} 预览劫持自救（${wt}）`;
      }
    } catch (e) { log('【看门狗】预览劫持检测异常:', e.message || e); }
    watchdogState.lastCheck = now();
  } catch (e) { log('【看门狗】异常:', e.message || e); }
}

// 检测企微内部弹窗遮挡：枚举企微进程全部顶层窗口，找出白名单外、可见、且覆盖主窗口区域的弹窗
// （独立聊天窗 / 智能助理弹窗 / 其他对话框——前台 PID 与主窗口同进程，普通遮挡检查发现不了）
async function detectWecomInternalPopup() {
  try {
    const j = await runPowerShell(`
${PS_ENUM}
$mainHwnd = [IntPtr]::Zero
$mainRect = New-Object RECT
$allow = @('WeWorkWindow','TitleBarWindow','PerryShadowWnd','WeWorkNewTipsWindow','Tencent.WXWork.WedocHostWindow','SearchResultWindow2','WeworkAppBarWin','MSCTFIME UI','IME','GDI+ Hook Window Class','SystemEventMonitorWindow','Device Monitor Window','Thread Task Window','crashpad_SessionEndWatcher','Base_PowerMessageWindow','Chrome_StatusTrayWindow','tooltips_class32','WebViewInitialHostWindowClassName')
$procs = Get-Process -Name 'WXWork' -ErrorAction SilentlyContinue
$mainArea = 0
foreach ($w in [WinEnum2]::EnumAll()) {
  if ($w.Class -eq 'WeWorkWindow' -and $w.Visible) {
    $a = $w.W * $w.H
    if ($a -gt $mainArea) { $mainArea = $a; $mainHwnd = $w.Hwnd; $mainRect = $w.Rect }
  }
}
$found = $false; $cls = ''; $title = ''; $pl = 0; $pt = 0; $pr = 0; $pb = 0
if ($mainHwnd -ne [IntPtr]::Zero -and $mainArea -gt 40000) {
  foreach ($w in [WinEnum2]::EnumAll()) {
    if ($w.Hwnd -eq $mainHwnd -or -not $w.Visible) { continue }
    if ($allow -contains $w.Class) { continue }
    if ($w.W -lt 200 -or $w.H -lt 150) { continue }
    $ox = [Math]::Max(0, [Math]::Min($w.Rect.Right, $mainRect.Right) - [Math]::Max($w.Rect.Left, $mainRect.Left))
    $oy = [Math]::Max(0, [Math]::Min($w.Rect.Bottom, $mainRect.Bottom) - [Math]::Max($w.Rect.Top, $mainRect.Top))
    if ($ox * $oy -gt 30000) { $found = $true; $cls = $w.Class; $title = $w.Title; $pl = $w.Rect.Left; $pt = $w.Rect.Top; $pr = $w.Rect.Right; $pb = $w.Rect.Bottom; break }
  }
}
[PSCustomObject]@{ found = $found; cls = $cls; title = $title; l = $pl; t = $pt; r = $pr; b = $pb } | ConvertTo-Json
`, 20000);
    return {
      found: !!j.found, cls: String(j.cls || ''), title: String(j.title || ''),
      rect: j.found ? { l: Number(j.l), t: Number(j.t), r: Number(j.r), b: Number(j.b) } : null
    };
  } catch (e) {
    log('【看门狗】内部弹窗检测异常:', e.message || e);
    return { found: false };
  }
}

// GET /watchdog/status —— 看门狗状态
async function handleWatchdogStatus(req, res) {
  return jsonResponse(res, 200, {
    code: 0,
    body: {
      enabled: CONFIG.watchdog_enabled !== false,
      engine_active: engineExplicit.running === false ? false : (!!lastEngineApiAt && Date.now() - lastEngineApiAt <= 45000),
      engine_reported: engineExplicit.running === null ? 'never' : (engineExplicit.running ? 'started' : 'stopped'),
      watch_app: lastEngineApp,
      last_engine_activity: lastEngineApiAt ? fmtTime(new Date(lastEngineApiAt)) : '',
      topmost: watchdogTopmost,
      last_check: watchdogState.lastCheck,
      last_rescue: watchdogState.lastRescue,
      events: watchdogEvents.slice(-30)
    }
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname.startsWith('/test/') && req.headers['x-internal-call'] !== '1') lastTestApiAt = Date.now();
  const p = u.pathname;
  const method = req.method.toUpperCase();
  try {
    // layout/detect：VLM 布局检测（输入区定位是自动发送的关键）
    if (method === 'POST' && p === '/shiflow/v1/layout/detect') {
      return await handleLayoutDetect(req, res, await readBody(req));
    }
// ---------- 端点：POST /shiflow/v1/sees/verify_send（发送后截图核实） ----------
async function handleVerifySend(req, res, body) {
  const t0 = Date.now();
  let payload = {};
  try { payload = JSON.parse(body.toString('utf8')); } catch { }
  const expected = String(payload.expected || '');

  // 快速核实模式（fast=true）：不截图不 OCR，直接查聊天记录——我方是否刚对该会话发过这条回复（毫秒级，换来秒切下一个）
  if (payload.fast === true) {
    const normT = t => String(t).replace(/[\s\p{P}\p{S}]/gu, '');
    const expN = normT(expected);
    const nowMs = Date.now();
    const chat = lastReplyChatName || '';
    const recent = recordsForChat(chat).filter(r => r.nickname === 'sf_agent').slice(-3);
    const hit = recent.find(r => {
      const a = normT(r.content);
      const t = Date.parse(String(r.created_at || '').replace(' ', 'T')) || 0;
      return a && expN && (a.includes(expN) || expN.includes(a)) && nowMs - t <= 3 * 60 * 1000;
    });
    log(`【verify_send:fast】会话=${chat || '-'} 记录命中=${!!hit} 耗时 ${Date.now() - t0}ms`);
    return jsonResponse(res, 200, { code: 0, body: { verified: !!hit, mode: 'records', chat_name: chat, report: hit ? `发送完成，已回复【${chat || '未知会话'}】（聊天记录核验），开启下一个未读消息回复` : `聊天记录中未找到刚发送的回复【${chat || '未知会话'}】` } });
  }

  const base64 = normalizeBase64(payload.image_base64);
  if (!base64) {
    log(`【verify_send】收到空截图核实请求（biz 截图失败/超时） trace=${payload.trace || '-'} 期望="${expected.slice(-20)}"`);
    return jsonResponse(res, 200, { code: 0, body: { verified: false, reason: 'no image' } });
  }
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort('t'), 25000);
    let ocrResp;
    try {
      ocrResp = await fetch('http://127.0.0.1:7300/ocr/last_message', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image_base64: base64, app_type: payload.app_type || 'wechat', bottom: true }), signal: ctrl.signal
      });
    } finally { clearTimeout(timer); }
    const j = await ocrResp.json();
    const normT = t => String(t).replace(/[\s\p{P}\p{S}]/gu, '');
    const expN = normT(expected);
    const lastRole = j.code === 0 && j.message ? j.message.role : null;
    // 方向为准：最后一条气泡在右侧 = 我方回复确实落窗；文本匹配只做日志参考（OCR 文本经常乱码，不能当判据）
    const recent = (j.message ? [j.message] : []).concat(j.message && j.message.recent || []);
    const textHit = recent.find(b => b.role === 'right' && expN && (normT(b.text).includes(expN.slice(-12)) || expN.includes(normT(b.text))));
    const chatLabel = lastReplyChatName || '未知会话';
    // 标题名复核（有目标名就查）：same_window=true 同窗口 / false 明确发错窗 / null 读不出
    let sameWindow = null, titleTxt = '';
    if (lastReplyChatName && normChatName(lastReplyChatName) !== '当前会话') {
      try {
        let w = 0, h = 0;
        try { const png = decodePng(Buffer.from(base64, 'base64')); w = png.width; h = png.height; } catch { }
        if (w > 400) {
          const hx = Math.round(w * 0.36), hw = Math.round(w * 0.40);
          const ctrlT = new AbortController();
          const timerT = setTimeout(() => ctrlT.abort('t'), 15000);
          let ojT;
          try { ojT = await (await fetch('http://127.0.0.1:7300/ocr', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image_base64: base64, region: [hx, 0, hw, 56] }), signal: ctrlT.signal })).json(); }
          finally { clearTimeout(timerT); }
          titleTxt = ((ojT && ojT.boxes) || []).map(b => b.text || '').join(' ');
          const expT = normChatName(lastReplyChatName);
          const scrT = normChatName(titleTxt);
          if (expT && scrT && scrT.length >= 2) sameWindow = (scrT.includes(expT) || expT.includes(scrT));
        }
      } catch { }
    }
    // 明确发错窗：标题读得出且与目标完全不同 → 直接判未通过（客户端立即回滚重发）
    if (sameWindow === false) {
      log(`【verify_send】⚠️ 疑似发错窗口：标题="${titleTxt.slice(0, 30)}" 目标="${lastReplyChatName}" → 判未通过，等客户端回滚`);
      return jsonResponse(res, 200, { code: 0, body: { verified: false, reason: 'wrong_window', same_window: false, last_role: lastRole, chat_name: chatLabel, screen: titleTxt.slice(0, 40), report: `发错窗口拦截：回复目标是【${chatLabel}】，当前窗口是【${titleTxt.slice(0, 20)}】` } });
    }
    const hit = lastRole === 'right' || !!textHit; // 方向或文本任一证实即通过（单框方向判定在高负载下会误读）
    if (hit) {
      log(`【发送回报】发送完成，已回复【${chatLabel}】（截图核实通过${textHit ? '，文本也吻合' : '，方向核实'}${sameWindow === true ? '，标题相符' : ''}），开启下一个未读消息回复`);
    } else {
      log(`【发送回报】⚠️ 发送核实未通过：【${chatLabel}】最后一条方向=${lastRole || '-'} 同窗口=${sameWindow}，请检查是否漏发或回错人`);
    }
    log(`【verify_send】verified=${hit} 最后方向=${lastRole || '-'} 文本吻合=${!!textHit} 同窗口=${sameWindow} 耗时 ${Date.now() - t0}ms`);
    return jsonResponse(res, 200, { code: 0, body: { verified: hit, same_window: sameWindow, last_role: lastRole, chat_name: chatLabel, report: hit ? `发送完成，已回复【${chatLabel}】，开启下一个未读消息回复` : `发送核实未通过：【${chatLabel}】` } });
  } catch (e) {
    log('【verify_send】OCR 不可用，放行:', e.message || e);
    log(`【发送回报】发送完成，已回复【${lastReplyChatName || '未知会话'}】（OCR 不可用未核实），开启下一个未读消息回复`);
    return jsonResponse(res, 200, { code: 0, body: { verified: true, reason: 'ocr_unavailable_bypass', chat_name: lastReplyChatName, report: `发送完成，已回复【${lastReplyChatName || '未知会话'}】（未核实），开启下一个未读消息回复` } });
  }
}

    if (method === 'POST' && p === '/shiflow/v1/sees/verify_send') {
      return await handleVerifySend(req, res, await readBody(req));
    }
    // 分步测试端点（功能测试页）
    if (method === 'GET' && p === '/test/windows') {
      return await handleTestWindows(req, res);
    }
    if (method === 'POST' && p === '/test/activate') {
      return await handleTestActivate(req, res, await readBody(req));
    }
    if (method === 'POST' && p === '/test/resize') {
      return await handleTestResize(req, res, await readBody(req));
    }
    if (method === 'POST' && p === '/test/screenshot') {
      return await handleTestScreenshot(req, res, await readBody(req));
    }
    if (method === 'POST' && p === '/test/locate') {
      return await handleTestLocate(req, res, await readBody(req));
    }
    if (method === 'POST' && p === '/test/think-reply') {
      return await handleTestThinkReply(req, res, await readBody(req));
    }
    if (method === 'POST' && p === '/test/red-dot') {
      return await handleTestRedDot(req, res, await readBody(req));
    }
    // 引擎导航轨迹（排查"点消息/点未读"）：biz 每轮上报将要点击的侧边坐标，原样落日志
    if (method === 'POST' && p === '/navtrace') {
      let np = {};
      try { np = JSON.parse((await readBody(req)).toString('utf8')); } catch { }
      log(`【navtrace】${np.step || '?'} navXY=${JSON.stringify(np.navXY)} fb=${JSON.stringify(np.fb)} cal_y=${np.calY} 说明=${np.note || ''}`);
      return jsonResponse(res, 200, { code: 0, body: { ok: true } });
    }
    if (method === 'POST' && p === '/test/ocr-region') {
      return await handleTestOcrRegion(req, res, await readBody(req));
    }
    if (method === 'POST' && p === '/test/last-message') {
      return await handleTestLastMessage(req, res, await readBody(req));
    }
    if (method === 'POST' && p === '/test/input-box') {
      return await handleTestInputBox(req, res, await readBody(req));
    }
    if (method === 'POST' && p === '/test/mouse') {
      return await handleTestMouse(req, res, await readBody(req));
    }
    if (method === 'POST' && p === '/test/paste') {
      return await handleTestPaste(req, res, await readBody(req));
    }
    if (method === 'POST' && p === '/test/key') {
      return await handleTestKey(req, res, await readBody(req));
    }
    if (method === 'POST' && p === '/test/occlude') {
      return await handleTestOcclude(req, res, await readBody(req));
    }
    // 侧边栏校准：学习本机企微侧边栏布局（功能目录行的位置），红点过滤从默认白名单切换到黑名单
    if (method === 'POST' && p === '/test/rail-calibrate') {
      return await handleRailCalibrate(req, res, await readBody(req));
    }
    // 提现编号自动打款（本店）
    // 多机同步
    if (method === 'GET' && p === '/sync/manifest') {
      return await handleSyncManifest(req, res);
    }
    if (method === 'GET' && p === '/sync/file') {
      return handleSyncFile(req, res, u);
    }
    if (method === 'POST' && p === '/sync/apply') {
      return await handleSyncApply(req, res, await readBody(req));
    }
    // 知识库
    if (method === 'GET' && p === '/shiflow/v2/sees/files') {
      return await handleKbList(req, res, u);
    }
    if (method === 'POST' && p === '/shiflow/v1/sees/files/upload') {
      return await handleKbUpload(req, res, await readBody(req));
    }
    if (method === 'DELETE' && p.startsWith('/shiflow/v2/sees/files/')) {
      return await handleKbDelete(req, res, decodeURIComponent(p.slice('/shiflow/v2/sees/files/'.length)));
    }
    if (method === 'GET' && p === '/kb/preview') {
      return await handleKbPreview(req, res, u);
    }
    if (method === 'POST' && p === '/kb/test') {
      return await handleKbTest(req, res, await readBody(req));
    }
    if (method === 'POST' && p === '/kb/catalog/refresh') {
      return await handleCatalogRefresh(req, res);
    }
    // 售后整理
    if (method === 'POST' && p === '/after-sales/scan') {
      return await handleAsfScan(req, res, await readBody(req));
    }
    if (method === 'POST' && p === '/after-sales/copy') {
      return await handleAsfCopy(req, res, await readBody(req));
    }
    // 聊天记录按天编号目录
    if (method === 'GET' && p === '/records/by-day') {
      return await handleRecordsByDay(req, res);
    }
    // 误触自救看门狗状态
    if (method === 'GET' && p === '/watchdog/status') {
      return await handleWatchdogStatus(req, res);
    }
    // 啄木鸟跟班状态
    if (method === 'GET' && p === '/woodpecker/status') {
      return await handleWoodpeckerStatus(req, res);
    }
    // 引擎真实状态上报
    if (method === 'POST' && p === '/engine/state') {
      return await handleEngineState(req, res, await readBody(req));
    }
    // 防发错人校验
    if (method === 'POST' && p === '/reply/guard') {
      return await handleReplyGuard(req, res, await readBody(req));
    }
    // 发送回滚（截图核实未通过时调用：删幽灵记录+清冷却去重，下轮自动补回）
    if (method === 'POST' && p === '/reply/rollback') {
      return await handleReplyRollback(req, res, await readBody(req));
    }
    // messages/detect：消息方向检测
    if (method === 'POST' && p === '/shiflow/v1/messages/detect') {
      return await handleMessagesDetect(req, res, await readBody(req));
    }
    // 遥测日志：收下并存档（图片不入库），确认无害
    if (method === 'POST' && p === '/tools/trace/log') {
      const body = await readBody(req);
      try {
        const rec = { received_at: now(), bytes: body.length };
        // 尝试提取元数据（JSON 或 multipart 文本部分），图片内容不落地
        const text = body.toString('utf8');
        const m = text.match(/\{[\s\S]*\}/);
        if (m) {
          const j = JSON.parse(m[0]);
          rec.phase = j.phase; rec.step = j.step; rec.result = j.result;
          if (j.error) rec.error = String(j.error).slice(0, 200);
          if (j.session_id) rec.session_id = j.session_id;
        }
        fs.appendFileSync(TRACE_LOG_FILE, JSON.stringify(rec) + '\n', 'utf8');
      } catch { }
      traceLogCount++;
      if (traceLogCount % 60 === 1) log(`【trace/log】已收下遥测（累计 ${traceLogCount} 条，存档 data/trace_logs.jsonl）`);
      return jsonResponse(res, 200, { code: 0, body: {} });
    }
    // 核心 SSE 聊天流
    if (method === 'POST' && (p === '/shiflow/v3/sees/speed' || p === '/shiflow/v2/sees/speed')) {
      return await handleSeesSpeed(req, res, await readBody(req));
    }
    // 红点检测
    if (method === 'POST' && p === '/shiflow/v1/unread/detect') {
      return await handleUnreadDetect(req, res, await readBody(req));
    }
    // UI 元素定位
    if (method === 'POST' && p === '/shiflow/v1/sees/grounding/resolve') {
      return await handleGroundingResolve(req, res, await readBody(req));
    }
    // 视觉问答 SSE 代理
    if (method === 'POST' && p === '/shiflow/v1/sees/chat/completions') {
      return await handleChatCompletions(req, res, await readBody(req), req.headers['content-type']);
    }
    // 登录 mock（任意账号/手机号均可登录）
    if (method === 'POST') {
      const lp = stripApiPrefix(p);
      if (['/login', '/phone_code', '/phone_login', '/register', '/qrcode', '/qrcode/login', '/phone_bind'].includes(lp)) {
        return handleLoginMock(req, res, await readBody(req), lp);
      }
    }
    // 假账户体系（优先返回原版复刻存档）
    if (method === 'GET' && (p === '/shiflow/v1/accounts/open/settings' || p === '/shiflow/v1/accounts/settings')) {
      const imp = loadImportedSettings();
      const archived = p.includes('/open/')
        ? imp?.accounts_open_settings?.body
        : imp?.accounts_settings?.body;
      const body = archived && typeof archived === 'object'
        ? { ...archived }
        : { ...FAKE_SETTINGS };
      // 余额/会员类字段始终用本地 mock（任意账号都享受本机满级权益），保证算力体系一致
      body.balance = FAKE_SETTINGS.balance;
      body.left_count = FAKE_SETTINGS.left_count;
      body.total_count = FAKE_SETTINGS.total_count;
      body.vip_level = FAKE_SETTINGS.vip_level;
      body.expired_at = FAKE_SETTINGS.expired_at;
      return jsonResponse(res, 200, { code: 0, msg: 'ok', body });
    }
    // 人设 prompt_setting：读存档 / 写存档
    if (method === 'GET' && (p === '/shiflow/v1/accounts/prompt_setting' || p === '/shiflow/v1/accounts/open/prompt_setting')) {
      return jsonResponse(res, 200, { code: 0, msg: 'ok', body: { prompt_setting: getArchivedPromptSetting(), prompt_content: getArchivedPromptSetting() } });
    }
    if (method === 'PUT' && (p === '/shiflow/v1/accounts/prompt_setting' || p === '/shiflow/v1/accounts/open/prompt_setting')) {
      const body = await readBody(req);
      let payload = {};
      try { payload = JSON.parse(body.toString('utf8')); } catch { }
      const value = typeof payload.prompt_setting === 'string' ? payload.prompt_setting : (payload.prompt_content ?? '');
      const imp = loadImportedSettings() || {};
      imp.prompt_setting = value;
      if (imp.accounts_settings?.body) imp.accounts_settings.body.prompt_content = value;
      saveImportedSettings(imp);
      log(`【prompt_setting】已保存人设（${String(value).length} 字）到本地存档`);
      return jsonResponse(res, 200, { code: 0, msg: 'ok', body: { prompt_setting: value } });
    }
    if (method === 'POST' && p === '/shiflow/v1/accounts/see/use_code') {
      log('【accounts/use_code】本地假兑换成功');
      return jsonResponse(res, 200, { code: 0, body: { balance: 999999, add_count: 1000 } });
    }
    if (method === 'GET' && (p === '/shiflow/v1/accounts/open/records' || p === '/shiflow/v1/accounts/records')) {
      return jsonResponse(res, 200, { code: 0, body: { items: [], total: 0, records: [] } });
    }
    // agent_type 下发（优先原版复刻存档）
    if (method === 'GET' && p === '/shiflow/v1/sees/settings') {
      const imp = loadImportedSettings();
      const archived = u.searchParams.get('source') === 'open'
        ? (imp?.sees_settings_open?.body || imp?.sees_settings?.body)
        : (imp?.sees_settings?.body || imp?.sees_settings_open?.body);
      const body = archived && typeof archived === 'object' ? archived : { agent_type: AGENT_TYPES };
      return jsonResponse(res, 200, { code: 0, msg: 'ok', body });
    }
    // 任务体系：列表 / 创建 / 详情 / 更新 / 删除 / 置顶 / 日志状态
    if (method === 'GET' && p === '/shiflow/v1/sees/get_all_task') {
      return handleTaskList(res, u.searchParams);
    }
    if (method === 'POST' && p === '/shiflow/v1/sees/tasks') {
      return handleTaskCreate(res, await readBody(req));
    }
    const taskMatch = p.match(/^\/shiflow\/v1\/sees\/tasks\/([^/]+)(\/pin)?$/);
    if (taskMatch) {
      const [, id, pin] = taskMatch;
      if (pin && method === 'PUT') {
        const tasks = loadTasks();
        const t = findTask(tasks, id);
        if (t) { t.pinned = true; t.updated_at = isoNow(); saveTasks(tasks); }
        return jsonResponse(res, 200, { code: 0, msg: 'ok', body: {} });
      }
      if (method === 'GET') return handleTaskDetail(res, id);
      if (method === 'PUT') return handleTaskUpdate(res, id, await readBody(req));
      if (method === 'DELETE') return handleTaskDelete(res, id);
    }
    const taskLogMatch = p.match(/^\/shiflow\/v1\/sees\/task_logs\/([^/]+)\/status$/);
    if (taskLogMatch && method === 'PUT') {
      log(`【tasks】任务日志状态回报 logId=${taskLogMatch[1]}（本地 mock 收下）`);
      return jsonResponse(res, 200, { code: 0, msg: 'ok', body: {} });
    }
    // 聊天历史
    if (method === 'GET' && p === '/shiflow/v1/sees/chat_records') {
      return handleChatRecords(res, u.searchParams);
    }
    if (method === 'GET' && p === '/shiflow/v1/sees/chat_records/export') {
      return handleChatRecordsExport(res, u.searchParams);
    }
    // 健康检查
    if (method === 'GET' && (p === '/' || p === '/health')) {
      return jsonResponse(res, 200, { code: 0, body: { status: 'ok', name: 'liaoji-local-server', time: now() } });
    }
    // 侧边栏校准数据（biz 跳未读双击位置用）
    if (method === 'GET' && p === '/rail/calibration') {
      try { return jsonResponse(res, 200, { code: 0, body: JSON.parse(fs.readFileSync(RAIL_CAL_FILE, 'utf8')) }); }
      catch { return jsonResponse(res, 200, { code: 0, body: { ok: false } }); }
    }
    // 兜底：未实现端点统一返回成功空 body 并记录，方便后续补
    log(`【未实现端点】${method} ${p}${u.search} -> 返回 {code:0,body:{}}`);
    return jsonResponse(res, 200, { code: 0, body: {} });
  } catch (e) {
    log(`【服务器错误】${method} ${p}:`, e);
    if (!res.headersSent) return jsonResponse(res, 500, { code: 500, msg: String(e.message || e) });
    try { res.end(); } catch { }
  }
});

// ---------- WebSocket：/ws/shiflow/tasks 本地占位（握手+挂着，避免客户端连真实云端/重连风暴） ----------
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
server.on('upgrade', (req, socket) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname !== '/ws/shiflow/tasks') {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  log('【WS】客户端已连接 /ws/shiflow/tasks（本地占位，保持连接不推送）');
  socket.setNoDelay(true);
  let buf = Buffer.alloc(0);
  const sendFrame = (opcode, payload) => {
    const len = payload.length;
    let head;
    if (len < 126) head = Buffer.from([0x80 | opcode, len]);
    else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(len, 2); }
    else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
    socket.write(Buffer.concat([head, payload]));
  };
  socket.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);
    // 解析客户端帧（必带掩码）
    for (;;) {
      if (buf.length < 2) return;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      const maskOff = off, dataOff = off + (masked ? 4 : 0);
      if (buf.length < dataOff + len) return;
      let payload = buf.subarray(dataOff, dataOff + len);
      if (masked) {
        const mask = buf.subarray(maskOff, maskOff + 4);
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      }
      buf = buf.subarray(dataOff + len);
      if (opcode === 0x8) { // close
        try { sendFrame(0x8, Buffer.alloc(0)); } catch { }
        socket.end();
        return;
      } else if (opcode === 0x9) { // ping -> pong
        try { sendFrame(0xA, payload); } catch { }
      } else if (opcode === 0x1) { // text
        const text = payload.toString('utf8').slice(0, 200);
        log('【WS】收到消息:', text);
      }
      // 二进制/其它帧忽略
    }
  });
  socket.on('error', () => { });
  socket.on('close', () => log('【WS】连接关闭'));
});


// ---------- 夜间节律：22:00~08:00 每半小时暂停 60s 再启动（防封号），走客户端技能端口 ----------
let __lastNightAction = '';
setInterval(async () => {
  const d = new Date(); const hh = d.getHours(); const mm = d.getMinutes();
  if (!(hh >= 22 || hh < 8)) return;
  if (mm !== 0 && mm !== 30) return;
  const key = `${d.toDateString()} ${hh}:${mm}`;
  if (__lastNightAction === key) return;
  __lastNightAction = key;
  const ports = [12680, 12681];
  for (const port of ports) {
    try {
      const st = await fetch(`http://127.0.0.1:${port}/skill/status`, { signal: AbortSignal.timeout(3000) }).then(r => r.json());
      if (!st || st.status !== 'running') return;
      log(`【夜间节律】${hh}:${String(mm).padStart(2, '0')} 暂停引擎 60 秒…`);
      await fetch(`http://127.0.0.1:${port}/skill/pause`, { method: 'POST', signal: AbortSignal.timeout(5000) }).catch(() => { });
      setTimeout(async () => {
        try { await fetch(`http://127.0.0.1:${port}/skill/start`, { method: 'POST', signal: AbortSignal.timeout(5000) }); log('【夜间节律】已恢复引擎'); } catch { }
      }, 60000);
      return;
    } catch { }
  }
}, 30000);

const args = parseArgs();
server.listen(args.port, args.host, () => {
  log(`聊机本地 AI 服务器已启动: http://${args.host}:${args.port}`);
  log(`LLM: doubao视觉=${CONFIG.llm?.doubao?.model_vision || CONFIG.llm?.doubao?.model}, doubao文本=${CONFIG.llm?.doubao?.model_text || CONFIG.llm?.doubao?.model} (fallback=${CONFIG.llm?.doubao?.model_fallback || '无'}), deepseek=${CONFIG.llm?.deepseek?.model}`);
  log(`聊天记录沉淀: ${RECORDS_FILE}`);
  if (CONFIG.watchdog_enabled !== false) log('误触自救看门狗已开启（15s 自检：遮挡拉回 / 误开功能页点回消息）');
  else log('看门狗自动自救已关闭（watchdog_enabled=false）：遮挡时只弹窗提醒人工置顶，不做任何自动操作');
  setAiCursor(false); // 看门狗关闭时恢复系统默认鼠标（AI 圆圈光标的热点不贴合点击位置，别留着）
});
setInterval(watchdogTick, 15000);
