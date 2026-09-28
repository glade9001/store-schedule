#!/usr/bin/env node
/**
 * 週次函式對拍：各頁各自一份的 weekStrOfDate／getWeekDates／getWeekDatesFromStr／weekStringToDate／week1MondayOf
 *
 * 為什麼需要：這幾支在 5～6 個檔案各抄一份（頁面沒有共用的 import 機制），
 * 2026-08 曾有舊公式「每個週六、週日都算成下一週」漏在其中幾份。現在全部正確，
 * 這支確保之後改其中一份時不會又長歪。
 *
 * 做法：從每個檔案抽出同名函式，在乾淨的 sandbox 求值，對 2020～2032 每一天／每一週比對：
 *   ・weekStrOfDate 一律跟 shift-utils.js 的 shiftWeekStr（權威版本）比
 *   ・其他同名函式：所有檔案的輸出必須彼此完全相同
 * 用法：node tools/check-week-fns.js（改任何一份週次函式後務必跑）
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');

const NAMES = ['week1MondayOf', 'weekStrOfDate', 'getWeekDates', 'getWeekDatesFromStr', 'weekStringToDate'];

/** 抽出檔案裡指定名稱的函式原始碼（允許縮排，例如 salary-calc.js 包在模組裡） */
function extract(src, name) {
  const re = new RegExp('(?:^|\\n)[ \\t]*function\\s+' + name + '\\s*\\(', 'g');
  const m = re.exec(src);
  if (!m) return null;
  const startIdx = src.indexOf('function', m.index);
  const open = src.indexOf('{', m.index + m[0].length - 1);
  let depth = 0, i = open;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(startIdx, i + 1);
}

function sandbox(code) {
  const ctx = { Date, Math, String, Number, parseInt, parseFloat, Array, Object, JSON, isNaN };
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  return ctx;
}

// 權威版本
const su = sandbox(fs.readFileSync(path.join(ROOT, 'shift-utils.js'), 'utf8'));
if (typeof su.shiftWeekStr !== 'function') { console.error('shift-utils.js 找不到 shiftWeekStr'); process.exit(2); }

// 各檔案的版本
const files = fs.readdirSync(ROOT).filter(f => f.endsWith('.js') && !f.startsWith('_'));
const impl = {}; // name → [{file, fn}]
for (const f of files) {
  const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
  const parts = NAMES.map(n => extract(src, n)).filter(Boolean);
  if (!parts.length) continue;
  let ctx;
  try { ctx = sandbox(parts.join('\n')); } catch (e) { console.log(`⚠️ ${f} 無法單獨載入：${e.message}`); continue; }
  NAMES.forEach(n => { if (typeof ctx[n] === 'function' && extract(src, n)) (impl[n] = impl[n] || []).push({ file: f, fn: ctx[n] }); });
}

const norm = v => JSON.stringify(v, (k, x) => (x instanceof Date ? 'D:' + x.getFullYear() + '-' + (x.getMonth() + 1) + '-' + x.getDate() : x));
let fail = 0;
const report = (name, file, input, got, want) => { if (fail++ < 20) console.log(`✗ ${name}（${file}）輸入 ${input}：得到 ${got}，應為 ${want}`); };

// 1) weekStrOfDate vs shiftWeekStr：每一天
const days = [];
for (let d = new Date(2020, 0, 1); d <= new Date(2032, 11, 31); d.setDate(d.getDate() + 1)) days.push(new Date(d));
(impl.weekStrOfDate || []).forEach(({ file, fn }) => {
  for (const d of days) {
    const ds = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    let got; try { got = fn(new Date(d)); } catch (e) { got = '例外 ' + e.message; }
    const want = su.shiftWeekStr(ds);
    if (got !== want) { report('weekStrOfDate', file, ds, got, want); }
  }
});

// 2) 其他同名函式：各檔輸出彼此一致
const years = []; for (let y = 2020; y <= 2032; y++) years.push(y);
const weeks = []; years.forEach(y => { for (let w = 1; w <= 53; w++) weeks.push(`${y}-W${String(w).padStart(2, '0')}`); });
const inputs = { week1MondayOf: years, getWeekDates: weeks, getWeekDatesFromStr: weeks, weekStringToDate: weeks };
Object.entries(inputs).forEach(([name, list]) => {
  const vs = impl[name] || [];
  if (vs.length < 2) return;
  const [ref, ...rest] = vs;
  rest.forEach(({ file, fn }) => {
    for (const x of list) {
      let a, b;
      try { a = norm(ref.fn(x)); } catch (e) { a = '例外 ' + e.message; }
      try { b = norm(fn(x)); } catch (e) { b = '例外 ' + e.message; }
      if (a !== b) report(name, file + ' vs ' + ref.file, x, b, a);
    }
  });
});

Object.entries(impl).forEach(([n, v]) => console.log(`  ${n}：${v.length} 份（${v.map(x => x.file).join('、')}）`));
console.log(fail ? `\n❌ ${fail} 處不一致` : `\n✅ 全部一致（weekStrOfDate 比對 ${days.length} 天；其他函式 ${weeks.length} 週／${years.length} 年）`);
process.exit(fail ? 1 : 0);
