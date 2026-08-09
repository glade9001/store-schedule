#!/usr/bin/env node
/**
 * 重構安全網：抓「呼叫了但整頁都找不到定義」的函式名。
 *
 * 目的很窄，就是擋住重構最致命的那個失誤——
 *   把本地副本刪掉、卻忘了載入（或載入順序錯了）共用檔 → 頁面按下去才報 xxx is not defined。
 *
 * 設計上刻意「寧可誤報、不可漏報」：用正則擷取而非 AST，因此會有一些本來就存在的誤報。
 * 這不影響用途——真正看的是「跟基準線相比有沒有新增」，穩定的誤報會被基準線吸收。
 *
 * 用法：
 *   node tools/check-globals.js            # 印出現況報告
 *   node tools/check-globals.js --save     # 將現況存成基準線 tools/globals-baseline.json
 *   node tools/check-globals.js --check    # 與基準線比對，有新增就 exit 1
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const BASELINE = path.join(__dirname, 'globals-baseline.json');

// 瀏覽器 / 標準內建 / 第三方 CDN 全域，這些不算未定義
const KNOWN = new Set([
  'window','document','console','navigator','location','history','screen','localStorage','sessionStorage',
  'Math','Date','JSON','Object','Array','String','Number','Boolean','Promise','Set','Map','WeakMap','WeakSet',
  'Symbol','Proxy','Reflect','BigInt','RegExp','Error','TypeError','RangeError','Intl','Function',
  'parseInt','parseFloat','isNaN','isFinite','encodeURIComponent','decodeURIComponent','encodeURI','decodeURI',
  'setTimeout','setInterval','clearTimeout','clearInterval','queueMicrotask','requestAnimationFrame',
  'alert','confirm','prompt','fetch','atob','btoa','structuredClone',
  'XMLHttpRequest','FormData','Blob','File','FileReader','URL','URLSearchParams','AbortController',
  'Image','Audio','Event','CustomEvent','MutationObserver','IntersectionObserver','ResizeObserver',
  'ArrayBuffer','Uint8Array','Int8Array','Float32Array','DataView','TextEncoder','TextDecoder',
  'firebase','XLSX','html2canvas','Chart','jspdf','QRCode',
  // 語法關鍵字（會被 IDENT( 誤抓）
  'if','for','while','switch','catch','return','typeof','function','new','do','else','delete','void',
  'in','of','instanceof','await','async','yield','throw','case','with','super','this','import','export',
]);

/** 取出一個 HTML 的：外部本地 script 路徑、inline script 內容、inline 事件處理器內容 */
function extractHtml(file) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const externals = [];
  const scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m, inline = [];
  while ((m = scriptRe.exec(src))) {
    const attrs = m[1] || '';
    const srcAttr = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(attrs);
    if (srcAttr) {
      const p = srcAttr[1];
      if (!/^https?:|^\/\//i.test(p)) externals.push(p.replace(/^\.\//, '').split('?')[0]);
    } else {
      inline.push(m[2]);
    }
  }
  // HTML 屬性裡的 onclick="..." 等，也是呼叫點
  const handlers = [];
  const hRe = /\son[a-z]+\s*=\s*("([^"]*)"|'([^']*)')/gi;
  while ((m = hRe.exec(src))) handlers.push(m[2] || m[3] || '');
  return { externals, inline, handlers };
}

/**
 * 去掉字串／註解／正則字面值，只留下真正的程式碼。
 * 必須逐字掃描：這些檔案大量使用巢狀 ${} 的樣板字串，用正則配對反引號會吞掉真實程式碼
 * （實測會讓 `async function doPunch(` 這種定義整段消失，導致誤判成未定義）。
 * 樣板字串內的 ${...} 要保留，因為裡面常有 onclick 呼叫。
 */
function strip(code) {
  let out = '';
  let i = 0;
  const n = code.length;
  const tmplStack = []; // 每層樣板字串裡 ${} 的大括號深度
  let prevSig = ''; // 前一個有意義的字元，用來判斷 / 是除號還是正則
  const blank = (s) => s.replace(/[^\n]/g, ' ');
  while (i < n) {
    const c = code[i], c2 = code[i + 1];
    // ⚠️ 樣板字串的「文字部分」必須最優先處理：那裡的 " ' // 都只是文字。
    // 否則 `<input type="date" data-emp="${x.replace(/"/g,'')}">` 這種寫法會讓引號配對錯位，
    // 掃描器從此失準、把後面成片的真實程式碼抹掉（實測 home.html 曾因此遺失 55 個定義）。
    if (tmplStack.length > 0 && tmplStack[tmplStack.length - 1] === 0) {
      if (c === '\\') { out += '  '; i += 2; continue; }
      if (c === '`') { tmplStack.pop(); out += ' '; i++; continue; }
      if (c === '$' && c2 === '{') { tmplStack[tmplStack.length - 1] = 1; out += '  '; i += 2; prevSig = '{'; continue; }
      out += c === '\n' ? '\n' : ' '; i++; continue;
    }
    // 行註解
    if (c === '/' && c2 === '/') { const e = code.indexOf('\n', i); const j = e < 0 ? n : e; out += blank(code.slice(i, j)); i = j; continue; }
    // 區塊註解
    if (c === '/' && c2 === '*') { const e = code.indexOf('*/', i + 2); const j = e < 0 ? n : e + 2; out += blank(code.slice(i, j)); i = j; continue; }
    // 引號字串
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && code[j] !== c) { if (code[j] === '\\') j++; j++; }
      out += blank(code.slice(i, Math.min(j + 1, n))); i = j + 1; prevSig = 'x'; continue;
    }
    // 正則字面值：/ 前面是運算子/開括號才算，排除除法
    if (c === '/' && /[(,=:[!&|?{};+\-*%~^<>]/.test(prevSig)) {
      let j = i + 1, inClass = false, ok = false;
      while (j < n) {
        const d = code[j];
        if (d === '\\') { j += 2; continue; }
        if (d === '\n') break;
        if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) { ok = true; break; }
        j++;
      }
      if (ok) { while (j + 1 < n && /[a-z]/.test(code[j + 1])) j++; out += blank(code.slice(i, j + 1)); i = j + 1; prevSig = 'x'; continue; }
    }
    // 樣板字串開始（走到這裡代表不在樣板文字模式，故必為開啟）
    if (c === '`') { tmplStack.push(0); out += ' '; i++; continue; }
    if (tmplStack.length) {
      // 在 ${} 內：追蹤大括號深度，歸零就回到文字部分
      if (c === '{') tmplStack[tmplStack.length - 1]++;
      else if (c === '}') { tmplStack[tmplStack.length - 1]--; if (tmplStack[tmplStack.length - 1] === 0) { out += ' '; i++; continue; } }
    }
    out += c;
    if (!/\s/.test(c)) prevSig = c;
    i++;
  }
  return out;
}

function definedNames(code) {
  const out = new Set();
  let m;
  const fnRe = /\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/g;
  while ((m = fnRe.exec(code))) out.add(m[1]);
  // window.X = ... / globalThis.X = ... / 裸賦值 X = function|async|(...)=>
  const winRe = /\b(?:window|globalThis)\s*\.\s*([A-Za-z_$][\w$]*)\s*=/g;
  while ((m = winRe.exec(code))) out.add(m[1]);
  const bareRe = /(^|[;{}\n])\s*([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^()]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/g;
  while ((m = bareRe.exec(code))) out.add(m[2]);
  // const/let/var 宣告：需處理一行多個宣告 const a=1, b=2 與解構 const {a,b}=x
  const declRe = /\b(?:const|let|var)\s+/g;
  while ((m = declRe.exec(code))) {
    const end = code.indexOf(';', m.index);
    const nl = code.indexOf('\n', m.index);
    const stop = Math.min(end < 0 ? code.length : end, nl < 0 ? code.length : nl);
    const seg = code.slice(m.index + m[0].length, stop);
    (seg.match(/[A-Za-z_$][\w$]*/g) || []).forEach((t) => out.add(t));
  }
  // class X
  const clsRe = /\bclass\s+([A-Za-z_$][\w$]*)/g;
  while ((m = clsRe.exec(code))) out.add(m[1]);
  // 具名函式參數（避免把回呼參數當未定義）
  // 單一參數不加括號的箭頭函式：x => ...（如 new Promise(resolve => {...})）
  const oneArgRe = /(^|[^\w$.])([A-Za-z_$][\w$]*)\s*=>/g;
  while ((m = oneArgRe.exec(code))) out.add(m[2]);
  const paramRe = /\(([^()]*)\)\s*=>/g;
  while ((m = paramRe.exec(code))) {
    m[1].split(',').forEach((p) => {
      const t = p.trim().replace(/[=.].*$/, '').replace(/[{}[\]\s]/g, '');
      if (/^[A-Za-z_$][\w$]*$/.test(t)) out.add(t);
    });
  }
  const fnParamRe = /\bfunction\s*\*?\s*[A-Za-z_$]?[\w$]*\s*\(([^()]*)\)/g;
  while ((m = fnParamRe.exec(code))) {
    m[1].split(',').forEach((p) => {
      const t = p.trim().replace(/[=.].*$/, '').replace(/[{}[\]\s]/g, '');
      if (/^[A-Za-z_$][\w$]*$/.test(t)) out.add(t);
    });
  }
  return out;
}

/** 被呼叫的名字：IDENT( ，但排除 .method( 與 new 之後 */
function calledNames(code) {
  const out = new Set();
  const re = /(^|[^\w$.])([A-Za-z_$][\w$]*)\s*\(/g;
  let m;
  while ((m = re.exec(code))) out.add(m[2]);
  return out;
}

function analyze(file) {
  const { externals, inline, handlers } = extractHtml(file);
  let code = '';
  const missingExternals = [];
  for (const ex of externals) {
    const p = path.join(ROOT, ex);
    if (fs.existsSync(p)) code += '\n' + fs.readFileSync(p, 'utf8');
    else missingExternals.push(ex);
  }
  code += '\n' + inline.join('\n');
  const stripped = strip(code);
  const defined = definedNames(stripped);
  const called = calledNames(stripped);
  // 事件處理器另外算（那裡只會呼叫、不會定義）
  handlers.forEach((h) => calledNames(strip(h)).forEach((n) => called.add(n)));

  const undef = [...called].filter((n) => !defined.has(n) && !KNOWN.has(n)).sort();
  return { file, externals, missingExternals, undef, definedCount: defined.size };
}

function syntaxCheck(file) {
  const { inline } = extractHtml(file);
  try {
    new (require('vm').Script)(inline.join('\n;\n'));
    return null;
  } catch (e) {
    return e.message;
  }
}

const files = fs.readdirSync(ROOT).filter((f) => f.endsWith('.html')).sort();
const report = {};
let syntaxErrors = [];
for (const f of files) {
  const r = analyze(f);
  report[f] = r.undef;
  const se = syntaxCheck(f);
  if (se) syntaxErrors.push(`${f}: ${se}`);
  if (r.missingExternals.length) syntaxErrors.push(`${f}: 載入了不存在的檔案 ${r.missingExternals.join(', ')}`);
}

const mode = process.argv[2] || '';
if (mode === '--save') {
  fs.writeFileSync(BASELINE, JSON.stringify(report, null, 2) + '\n');
  console.log(`已寫入基準線：${path.relative(ROOT, BASELINE)}`);
  console.log(`檔案數 ${files.length}，可疑名稱合計 ${Object.values(report).flat().length} 個`);
  process.exit(0);
}

if (mode === '--check') {
  if (!fs.existsSync(BASELINE)) { console.error('找不到基準線，請先跑 --save'); process.exit(2); }
  const base = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
  let bad = 0;
  for (const f of files) {
    const now = report[f] || [], was = base[f] || [];
    const added = now.filter((n) => !was.includes(n));
    if (added.length) { bad++; console.error(`❌ ${f} 新增未定義呼叫：${added.join(', ')}`); }
  }
  for (const f of Object.keys(base)) if (!files.includes(f)) console.error(`⚠️  ${f} 已不存在`);
  syntaxErrors.forEach((e) => { bad++; console.error(`❌ ${e}`); });
  if (bad) { console.error(`\n共 ${bad} 項問題 —— 這通常代表刪了本地副本卻沒載入共用檔。`); process.exit(1); }
  console.log(`✅ ${files.length} 個頁面全部通過（無新增未定義呼叫、語法正常）`);
  process.exit(0);
}

// 預設：印報告
console.log(`掃描 ${files.length} 個 HTML\n`);
for (const f of files) {
  const u = report[f];
  console.log(`${u.length ? '•' : '✓'} ${f.padEnd(24)} 可疑 ${String(u.length).padStart(3)} 個${u.length ? '：' + u.slice(0, 12).join(', ') + (u.length > 12 ? ' …' : '') : ''}`);
}
if (syntaxErrors.length) { console.log('\n語法/載入問題：'); syntaxErrors.forEach((e) => console.log('  ❌ ' + e)); }
console.log(`\n合計可疑名稱 ${Object.values(report).flat().length} 個（含誤報；用 --save 建立基準線後改看差異）`);
