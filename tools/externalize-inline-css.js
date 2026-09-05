#!/usr/bin/env node
// 把單一 HTML 的「最大的行內 <style> 區塊」搬到外部 .css，原位置換成 <link rel="stylesheet">。
// 與 externalize-inline-js.js 同一套理由與安全規則（見該檔頂部註解）。
//
// ⚠️ 前置條件：sw.js 的 fetch handler 必須讓 `.css` 走 network-first 分支。
//    掉到最後的 Cache First＝「最新 HTML 配舊樣式」，比 JS 版更難聯想到是快取問題。
//
// 安全規則：
//   1. 只動沒有屬性的 <style>
//   2. <link> 放回原區塊的位置 → 層疊順序完全不變
//   3. 搬出的內容與原區塊逐位元組相同
//   4. 拒絕含 url() 或 @import 的 CSS（相對路徑基準會從 HTML 變成 CSS 檔）
//
// 用法：node tools/externalize-inline-css.js <file.html> [--apply]

const fs = require('fs');
const path = require('path');

const file = process.argv[2];
const apply = process.argv.includes('--apply');
if (!file) { console.error('用法：node tools/externalize-inline-css.js <file.html> [--apply]'); process.exit(1); }

const html = fs.readFileSync(file, 'utf8');

const blocks = [];
const re = /<style>([\s\S]*?)<\/style>/g;
let m;
while ((m = re.exec(html)) !== null) blocks.push({ start: m.index, end: re.lastIndex, body: m[1] });
if (!blocks.length) { console.error('❌ 找不到行內 <style> 區塊'); process.exit(1); }

const nOpen = (html.match(/<style/g) || []).length;
const nClose = (html.match(/<\/style>/g) || []).length;
if (nOpen !== nClose) { console.error(`❌ <style>=${nOpen} / </style>=${nClose} 不相等`); process.exit(1); }

const big = blocks.reduce((a, b) => (b.body.length > a.body.length ? b : a));
if (Buffer.byteLength(big.body) < 8000) { console.error('❌ 最大區塊 <8KB：省下的位元組不值得多一次往返'); process.exit(1); }
if (/url\(|@import/.test(big.body)) { console.error('❌ CSS 含 url()/@import，相對路徑基準會改變'); process.exit(1); }

const outName = path.basename(file, '.html') + '-page.css';
const outPath = path.join(path.dirname(file), outName);
if (fs.existsSync(outPath)) { console.error(`❌ ${outName} 已存在`); process.exit(1); }

const newHtml = html.slice(0, big.start) + `<link rel="stylesheet" href="${outName}">` + html.slice(big.end);

console.log(`${file}`);
console.log(`  搬出 ${Buffer.byteLength(big.body)} B → ${outName}`);
console.log(`  HTML ${Buffer.byteLength(html)} B → ${Buffer.byteLength(newHtml)} B`);
console.log(`  區塊位置：行 ${html.slice(0, big.start).split('\n').length}（共 ${blocks.length} 個行內區塊）`);
if (!apply) { console.log('  （dry-run，加 --apply 才寫入）'); process.exit(0); }

fs.writeFileSync(outPath, big.body.replace(/^\n/, ''), 'utf8');
fs.writeFileSync(file, newHtml, 'utf8');
if (big.body.replace(/^\n/, '') !== fs.readFileSync(outPath, 'utf8')) { console.error('❌ 回驗失敗'); process.exit(1); }
console.log('  ✅ 已寫入並逐位元組回驗通過');
