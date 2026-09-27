/**
 * 聊机·聊天记录分析 - 零依赖 Node 静态服务器 + LLM API 代理
 * 用法: node server.js [--port 7100] [--host 127.0.0.1]
 *   也兼容 --port=7100 --host=0.0.0.0 写法
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const ROOT = __dirname;

// ---------- 命令行参数解析 ----------
function parseArgs(argv) {
  const opts = { port: 7100, host: '127.0.0.1' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port' && argv[i + 1]) { opts.port = parseInt(argv[++i], 10); }
    else if (a.startsWith('--port=')) { opts.port = parseInt(a.slice(7), 10); }
    else if (a === '--host' && argv[i + 1]) { opts.host = argv[++i]; }
    else if (a.startsWith('--host=')) { opts.host = a.slice(7); }
  }
  if (!Number.isFinite(opts.port) || opts.port <= 0 || opts.port > 65535) {
    console.error('无效端口: ' + opts.port);
    process.exit(1);
  }
  return opts;
}

// ---------- 加载配置（含 API key，绝不下发浏览器） ----------
let CONFIG = null;
function loadConfig() {
  try {
    const raw = fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8');
    CONFIG = JSON.parse(raw);
  } catch (e) {
    console.error('读取 config.json 失败: ' + e.message);
    CONFIG = { default: 'deepseek', providers: {} };
  }
}
loadConfig();

// ---------- MIME ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xls': 'application/vnd.ms-excel; charset=utf-8',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.csv': 'text/csv; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8'
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 8 * 1024 * 1024) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ---------- 静态文件 ----------
function serveStatic(req, res, pathname) {
  if (pathname === '/') pathname = '/index.html';
  // 防目录穿越
  const safePath = path.normalize(pathname).replace(/^([.][.][/\\])+/, '');
  const filePath = path.join(ROOT, safePath);
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  // 禁止直接访问 config.json（含密钥）
  if (path.basename(filePath) === 'config.json') {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden'); return;
  }
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-store'
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

// ---------- LLM 代理 ----------
async function handleChat(req, res) {
  let payload;
  try {
    const raw = await readBody(req);
    payload = JSON.parse(raw);
  } catch (e) {
    sendJson(res, 400, { error: '请求体不是合法 JSON: ' + e.message });
    return;
  }
  const providerName = payload.provider || (CONFIG && CONFIG.default) || 'deepseek';
  const provider = CONFIG && CONFIG.providers && CONFIG.providers[providerName];
  if (!provider) {
    sendJson(res, 400, { error: '未知 provider: ' + providerName });
    return;
  }
  const messages = Array.isArray(payload.messages) ? payload.messages : null;
  if (!messages || messages.length === 0) {
    sendJson(res, 400, { error: '缺少 messages 数组' });
    return;
  }
  const body = {
    model: provider.model,
    messages,
    temperature: typeof payload.temperature === 'number' ? payload.temperature : 0.3,
    stream: false
  };
  if (payload.response_format) body.response_format = payload.response_format;
  if (payload.max_tokens) body.max_tokens = payload.max_tokens;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  try {
    const upstream = await fetch(provider.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + provider.apiKey
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const text = await upstream.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    if (!upstream.ok) {
      sendJson(res, upstream.status, { error: '上游 API 错误', status: upstream.status, detail: data });
      return;
    }
    sendJson(res, 200, data);
  } catch (e) {
    const msg = e.name === 'AbortError' ? '上游请求超时(120s)' : e.message;
    sendJson(res, 502, { error: '调用 LLM 失败: ' + msg });
  } finally {
    clearTimeout(timer);
  }
}

// ---------- 服务器 ----------
const opts = parseArgs(process.argv.slice(2));

const server = http.createServer((req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    res.writeHead(400); res.end('Bad Request'); return;
  }

  if (pathname === '/api/config' && req.method === 'GET') {
    const providers = CONFIG && CONFIG.providers ? Object.keys(CONFIG.providers) : [];
    sendJson(res, 200, { providers, default: (CONFIG && CONFIG.default) || providers[0] || null });
    return;
  }
  if (pathname === '/api/chat' && req.method === 'POST') {
    handleChat(req, res);
    return;
  }
  if (pathname.startsWith('/api/')) {
    sendJson(res, 404, { error: '未知 API' });
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405); res.end('Method Not Allowed'); return;
  }
  serveStatic(req, res, pathname);
});

server.listen(opts.port, opts.host, () => {
  console.log(`聊机·聊天记录分析 已启动: http://${opts.host}:${opts.port}/`);
  console.log(`可用模型: ${Object.keys(CONFIG.providers || {}).join(', ')} (默认 ${CONFIG.default})`);
});
