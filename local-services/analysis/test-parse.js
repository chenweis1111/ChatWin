/* 模拟前端解析逻辑，验证 sample.xls 解析正确性（Node 环境，用正则模拟 DOMParser 行为） */
'use strict';
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, 'samples', 'sample.xls');
const buf = fs.readFileSync(file);
console.log('文件大小:', buf.length, 'bytes');
console.log('BOM:', buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF ? '有 UTF-8 BOM ✓' : '无 BOM');
const text = buf.toString('utf8');

// 提取所有 <tr>...</tr>
const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
const cellRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
const stripTags = (s) => s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();

function parseTime(s) {
  const m = /(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?/.exec(s || '');
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
}

let headerSeen = false;
const records = [];
let m;
let rowCount = 0;
while ((m = trRe.exec(text))) {
  const rowHtml = m[1];
  const cells = [];
  let cm;
  cellRe.lastIndex = 0;
  while ((cm = cellRe.exec(rowHtml))) cells.push(stripTags(cm[1]));
  rowCount++;
  if (!headerSeen) {
    if (cells.some(c => c.includes('内容')) && cells.some(c => c.includes('时间'))) {
      headerSeen = true;
      console.log('表头:', JSON.stringify(cells));
    }
    continue;
  }
  if (cells.length < 3) continue;
  const t = parseTime(cells[4]);
  if (!t) { console.log('时间解析失败行:', JSON.stringify(cells)); continue; }
  records.push({ type: cells[0], chat: cells[1], nick: cells[2], content: cells[3], time: t, timeStr: cells[4] });
}

console.log('总行数(含表头):', rowCount);
console.log('解析记录数:', records.length);
console.log(records.length === 8336 ? '✓ 记录数 = 8336 符合预期' : '✗ 记录数不符合预期!');

if (records.length) {
  console.log('\n首条:', JSON.stringify(records[0]).slice(0, 300));
  console.log('末条:', JSON.stringify(records[records.length - 1]).slice(0, 300));
  const days = new Set(records.map(r => r.time.toISOString().slice(0, 10)));
  console.log('覆盖日期(UTC):', [...days].sort().join(', '));
  const types = {};
  records.forEach(r => types[r.type] = (types[r.type] || 0) + 1);
  console.log('会话类型分布:', JSON.stringify(types));
  // 验证时间字段完整性
  const bad = records.filter(r => isNaN(r.time.getTime()));
  console.log('无效时间记录数:', bad.length);
  // emoji 检查
  const withEmoji = records.filter(r => /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(r.content)).length;
  console.log('含 emoji 记录数:', withEmoji);
}
