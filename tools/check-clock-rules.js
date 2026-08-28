#!/usr/bin/env node
/**
 * 打卡判定規則對拍：shift-utils.js（前端） vs functions/index.js（後端）
 *
 * 為什麼需要：兩邊 runtime 不同，後端吃不到瀏覽器那支檔，所以必然有兩份實作。
 * 兩份實作靠「記得一起改」維持一致＝遲早會漂。這支把它變成自動檢查。
 *
 * 用法：node tools/check-clock-rules.js
 * 改 shift-utils.js 或 functions/index.js 的打卡規則後務必跑。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');

/** 從檔案原始碼中抽出指定的頂層函式，在乾淨的 sandbox 裡求值 */
function loadFns(file, names) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  let code = '';
  for (const n of names) {
    // 從 `function name(` 起，逐字元配對大括號取到函式結尾
    const re = new RegExp('(?:^|\\n)function\\s+' + n + '\\s*\\(', 'g');
    const m = re.exec(src);
    if (!m) throw new Error(`${file} 找不到函式 ${n}`);
    const open = src.indexOf('{', m.index + m[0].length - 1);
    let depth = 0, i = open;
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) break; }
    }
    code += src.slice(m.index, i + 1) + '\n';
  }
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(code + '\n;({' + names.map((n) => `${n}:${n}`).join(',') + '})', sandbox);
  return vm.runInContext('({' + names.map((n) => `${n}:${n}`).join(',') + '})', sandbox);
}

const NAMES = ['punchWindowMs', 'matchPunchShift', 'lateMinutesOf', 'punchLateStatus'];
const FE = loadFns('shift-utils.js', NAMES);
const BE = loadFns('functions/index.js', NAMES);

let checks = 0, fails = [];
const eq = (label, a, b) => { checks++; if (JSON.stringify(a) !== JSON.stringify(b)) fails.push(`${label}: 前端=${JSON.stringify(a)} 後端=${JSON.stringify(b)}`); };

// 1. 視窗常數
eq('punchWindowMs', FE.punchWindowMs(), BE.punchWindowMs());

// 2. 遲到分鐘 + 狀態：掃過每一秒的邊界（含負值＝提早到）
const base = Date.parse('2026-08-28T07:00:00+08:00');
for (let sec = -120; sec <= 900; sec++) {
  const t = base + sec * 1000;
  eq(`lateMinutesOf(+${sec}s)`, FE.lateMinutesOf(t, base), BE.lateMinutesOf(t, base));
}
for (let lm = 0; lm <= 40; lm++) for (const tol of [0, 5, 10, 15, null]) {
  eq(`punchLateStatus(${lm},${tol})`, FE.punchLateStatus(lm, tol), BE.punchLateStatus(lm, tol));
}

// 3. 配對視窗：單班／兩頭班／跨夜班，逐 5 分鐘掃 ±10 小時
const mk = (shift, sd, sh, eh) => ({ shift, shiftDate: sd, startMs: Date.parse(`${sd}T00:00:00+08:00`) + sh * 3600000,
                                     endMs: Date.parse(`${sd}T00:00:00+08:00`) + eh * 3600000 });
const SETS = [
  [mk('7-15', '2026-08-28', 7, 15)],
  [mk('23-07', '2026-08-28', 23, 31)],                                   // 跨夜
  [mk('7-11', '2026-08-28', 7, 11), mk('17-21', '2026-08-28', 17, 21)],  // 兩頭班
  [mk('23-07', '2026-08-27', 23, 31), mk('7-15', '2026-08-28', 7, 15)],  // 夜班收班 + 早班開班（最容易配錯）
  [],                                                                     // 無排班
];
for (const cands of SETS) {
  const anchor = cands.length ? cands[0].startMs : base;
  for (let min = -600; min <= 900; min += 5) {
    const t = anchor + min * 60000;
    for (const type of ['上班', '下班']) {
      const a = FE.matchPunchShift(cands, t, type);
      const b = BE.matchPunchShift(cands, t, type);
      eq(`matchPunchShift(${cands.map(c=>c.shift).join('+')||'無班'},${min}m,${type})`,
         a && { s: a.shift, d: a.shiftDate }, b && { s: b.shift, d: b.shiftDate });
    }
  }
}

if (fails.length) {
  console.error(`❌ 兩份實作不等價（${fails.length}/${checks} 筆不符）：`);
  fails.slice(0, 15).forEach((f) => console.error('   ' + f));
  if (fails.length > 15) console.error(`   …等共 ${fails.length} 筆`);
  process.exit(1);
}
console.log(`✅ 前後端打卡規則等價（${checks} 筆比對全數相符）`);
