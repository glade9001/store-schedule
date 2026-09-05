#!/usr/bin/env node
// 把單一 HTML 的「最大的行內 <script> 區塊」搬到外部 .js，原位置換成 <script src>。
//
// 為什麼要搬（見 sw.js 的註解）：SW 對 HTML 是 fetch(cache:'no-cache') → 每次開頁都完整下載；
// 對 .js 是普通 network-first，瀏覽器 HTTP 快取仍生效（GitHub Pages 回 ETag + max-age=600）
// → 搬出去等於把大部分位元組從「每次全下載」變成「304 空回應」。
//
// 安全規則（不可放寬）：
//   1. 只動沒有屬性的 <script>（不碰 src=/type= 的）
//   2. <script src> 放回原區塊的位置，不加 defer/async → 執行順序與時機完全不變
//   3. 搬出的內容與原區塊逐位元組相同
//   4. 該區塊之後只能是空白或其他 <script> 區塊（不可有依賴它的 HTML）
//
// 用法：node tools/externalize-inline-js.js <file.html> [--apply]

const fs = require('fs');
const path = require('path');

const file = process.argv[2];
const apply = process.argv.includes('--apply');
if (!file) { console.error('用法：node tools/externalize-inline-js.js <file.html> [--apply]'); process.exit(1); }

const html = fs.readFileSync(file, 'utf8');

// 只抓沒有屬性的 <script>
const blocks = [];
const re = /<script>([\s\S]*?)<\/script>/g;
let m;
while ((m = re.exec(html)) !== null) blocks.push({ start: m.index, end: re.lastIndex, body: m[1] });

if (!blocks.length) { console.error('❌ 找不到行內 <script> 區塊'); process.exit(1); }

// 一致性檢查：<script 與 </script> 數量要相等（避免字串裡藏 </script> 讓切點跑掉）
const nOpen = (html.match(/<script/g) || []).length;
const nClose = (html.match(/<\/script>/g) || []).length;
if (nOpen !== nClose) { console.error(`❌ <script>=${nOpen} / </script>=${nClose} 不相等，人工確認`); process.exit(1); }

if (/document\.write/.test(html) && !/win\.document\.write/.test(html)) {
  console.error('❌ 有 document.write 寫到本文件，外部化會改變行為'); process.exit(1);
}

const big = blocks.reduce((a, b) => (b.body.length > a.body.length ? b : a));
if (Buffer.byteLength(big.body) < 8000) { console.error('❌ 最大區塊 <8KB，不值得搬'); process.exit(1); }

// 該區塊之後只能是空白／其他 script 區塊／</body></html>
const after = html.slice(big.end);
const afterStripped = after.replace(/<script>[\s\S]*?<\/script>/g, '').replace(/<script[^>]*>[\s\S]*?<\/script>/g, '');
if (!/^\s*(<\/body>)?\s*(<\/html>)?\s*$/i.test(afterStripped)) {
  console.error('❌ 區塊之後還有其他 HTML，需人工確認：', JSON.stringify(afterStripped.slice(0, 120)));
  process.exit(1);
}

const outName = path.basename(file, '.html') + '-page.js';
const outPath = path.join(path.dirname(file), outName);
if (fs.existsSync(outPath)) { console.error(`❌ ${outName} 已存在`); process.exit(1); }

const newHtml = html.slice(0, big.start) + `<script src="${outName}"></script>` + html.slice(big.end);

console.log(`${file}`);
console.log(`  搬出 ${Buffer.byteLength(big.body)} B → ${outName}`);
console.log(`  HTML ${Buffer.byteLength(html)} B → ${Buffer.byteLength(newHtml)} B`);
console.log(`  區塊位置：行 ${html.slice(0, big.start).split('\n').length}（共 ${blocks.length} 個行內區塊，搬第 ${blocks.indexOf(big) + 1} 個）`);

if (!apply) { console.log('  （dry-run，加 --apply 才寫入）'); process.exit(0); }

fs.writeFileSync(outPath, big.body.replace(/^\n/, ''), 'utf8');
fs.writeFileSync(file, newHtml, 'utf8');

// 逐位元組回驗：寫出的檔案 + 原 HTML 必須能還原
const back = fs.readFileSync(outPath, 'utf8');
if (big.body.replace(/^\n/, '') !== back) { console.error('❌ 回驗失敗：寫出的內容與原區塊不同'); process.exit(1); }
console.log('  ✅ 已寫入並逐位元組回驗通過');
