// 从 minified biz/index.js 提取关键词上下文
const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '..', 'biz', 'index.js');
const data = fs.readFileSync(file, 'utf8');
const keyword = process.argv[2];
const before = parseInt(process.argv[3] || '400', 10);
const after = parseInt(process.argv[4] || '800', 10);
const maxHits = parseInt(process.argv[5] || '5', 10);
let idx = 0, hits = 0;
while (hits < maxHits) {
  const i = data.indexOf(keyword, idx);
  if (i === -1) break;
  console.log(`\n===== [命中 ${hits + 1}] 偏移 ${i} =====`);
  console.log(data.slice(Math.max(0, i - before), Math.min(data.length, i + after)));
  idx = i + keyword.length;
  hits++;
}
console.log(`\n[共命中 ${hits} 次，全文件出现 ${data.split(keyword).length - 1} 次]`);
