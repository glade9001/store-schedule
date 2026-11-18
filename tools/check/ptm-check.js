// 部分工時月薪公式驗算：node tools/check/ptm-check.js
// 情境都用合約數字手算過（月薪 24,000、約定 15 天 → 日薪 1,600、時薪 200）
const fs = require('fs'), vm = require('vm'), assert = require('assert');
const ctx = { window: {} }; vm.createContext(ctx);
vm.runInContext(fs.readFileSync(__dirname + '/../../salary-calc.js', 'utf8'), ctx);
const S = ctx.window.SalaryCalc;
const DAY = ['週一','週二','週三','週四','週五','週六','週日'];
// 2026-11 的週次：W45(11/2)～W48(11/23)＋W44 的 11/1(週日)、W49 的 11/30(週一)
function sched(days) { // days: [[ '2026-W45', '週一', 8, '早班' ], ...]
  const out = {};
  days.forEach(([ws, day, h, shift = '早班', extra = {}]) => { (out[ws] = out[ws] || []).push({ name: 'A', day, shift, actualHours: h, ...extra }); });
  return out;
}
const weeks = ['2026-W45', '2026-W46', '2026-W47'];
const fifteen = []; weeks.forEach(w => DAY.slice(0, 5).forEach(d => fifteen.push([w, d, 8]))); // 15 天 × 8h
const run = (days, recExtra = {}, holidays = {}) => {
  const rec = { ptm: { monthly: 24000, agreedDays: 15, waiveDays: 0 }, ...recExtra };
  const parts = S.calcPtmParts('A', { scheduleData: sched(days), currentMonth: '2026-11', holidays });
  return { b: S.ptmBreakdown(rec, parts), gross: S.grossFromParts(rec, { role: '工讀', ptmParts: parts }) };
};
let n = 0; const ok = (m) => console.log(`✓ ${++n}. ${m}`);

let r = run(fifteen); assert.equal(r.gross, 24000); assert.equal(r.b.dayRate, 1600); assert.equal(r.b.hourRate, 200); ok('剛好 15 天 → 24,000');
r = run([...fifteen, ['2026-W48', '週一', 8], ['2026-W48', '週二', 8]]); assert.equal(r.gross, 27200); ok('17 天 → 24,000 ＋ 2×1,600 = 27,200');
r = run(fifteen.slice(0, 13)); assert.equal(r.gross, 20800); ok('13 天 → 24,000 − 2×1,600 = 20,800');
r = run(fifteen.slice(0, 13), { ptm: { monthly: 24000, agreedDays: 15, waiveDays: 1 } }); assert.equal(r.gross, 22400); ok('13 天、店家沒排 1 天不扣 → 22,400');
r = run(fifteen.slice(0, 13), { ptm: { monthly: 24000, agreedDays: 15, waiveDays: 5 } }); assert.equal(r.gross, 24000); ok('不扣天數填太多也不會超過 24,000');
r = run([...fifteen.slice(0, 13), ['2026-W48', '週一', 0, '特休'], ['2026-W48', '週二', 0, '補休']]); assert.equal(r.gross, 24000); ok('13 天上班＋特休 1＋補休 1 → 24,000（請特補休不扣）');
r = run([...fifteen.slice(0, 14), ['2026-W48', '週一', 11]]); assert.equal(r.gross, 24000 + Math.round(2 * 200 * 4 / 3) + Math.round(1 * 200 * 5 / 3)); ok('某天上 11 小時 → 前 2h ×4/3（533）＋第 3h ×5/3（333）');
r = run(fifteen, {}, { '2026-11-02': '測試假日' }); assert.equal(r.gross, 25600); ok('國定假日（11/2 有上班）另加 1 日 → 25,600');
r = run([...fifteen.slice(0, 14), ['2026-W48', '週一', 4]]); assert.equal(r.gross, 24000 - 800); ok('有一天只上 4 小時 → 扣 4h×200 = 800');
r = run(fifteen, { otherBonus: 500, otherBonusNote: '測試', personalSickLeave: 300 }); assert.equal(r.gross, 24200); ok('其他獎金 +500、事病假扣款 −300 → 24,200');
r = run(fifteen, { ptm: { monthly: 25200, agreedDays: 15 } }); assert.equal(r.gross, 25200); assert.equal(r.b.hourRate, 210); ok('116 年月薪 25,200 → 時薪 210');
assert.equal(S.ptmMonthlyFor({ monthly: [{ from: '2026-11', amount: 24000 }, { from: '2027-01', amount: 25200 }] }, '2026-12'), 24000);
assert.equal(S.ptmMonthlyFor({ monthly: [{ from: '2026-11', amount: 24000 }, { from: '2027-01', amount: 25200 }] }, '2027-01'), 25200); ok('12 月用 24,000、隔年 1 月起自動換 25,200');
// 跨店支援：別店以支援身分記錄（name 是佔位、supportEmp 指向本人）也要算
const sup = sched(fifteen.slice(0, 14)); sup['2026-W48'] = [{ name: '支援', supportEmp: '美德-A', day: '週一', shift: '早班', actualHours: 8 }];
assert.equal(S.grossFromParts({ ptm: { monthly: 24000, agreedDays: 15 } }, { ptmParts: S.calcPtmParts('A', { scheduleData: sup, currentMonth: '2026-11', holidays: {} }) }), 24000); ok('去別店支援的那天也算出勤');
// 沒有 ptm 的人（一般工讀、正職）公式完全不變
assert.equal(S.grossFromParts({ wage: 200 }, { role: '工讀', totalH: 120 }), 24000); ok('一般工讀不受影響');
// 投保級距差額
assert.equal(S.insExtraFor({ laborEr: 2300, healthEr: 1500, pension: 1770 }, { laborEr: 1870, healthEr: 1220, pension: 1440 }), 1040); ok('級距差額＝公司多付的勞保＋健保＋勞退');
assert.equal(S.calcDeduct({ laborInsurance: 600, healthInsurance: 400, insExtraDeduct: 1040 }), 2040); ok('差額會進代扣');
console.log(`\n全部 ${n} 項通過`);
