#!/usr/bin/env node
// 回測：拿已經過去的週，把「自動排班的人」的格子清空，只留手動排的人與劃休，讓草稿重排，
// 再跟店長實際排的比較（缺人、待補、加班、工讀時數、法規）。只讀資料庫、不寫入。
//
// 用法：
//   node tools/autosched/backtest.js --store 美德 --from 2026-W26 --to 2026-W38
//   選項：--cache  --weights '{"gapDay":12000}'  --season（打開寒暑假分季，暑假週用寒暑假班別）
//         --infer（不用存好的設定，改用歷史推算——評估還沒設定的門市時用）
// ⚠️ 設定是「現在」的：可上班別、每人上限都照現在的，較早的週結果只能參考；要帶到職日（已處理）。

const L = require('./lib');

function evalWeek(ctx, data, weeks, cfg, week, rows, fixed, ptNames) {
  const DAYS = ctx.asDayNames();
  const mon = ctx.asWeekMonday(week), prevW = ctx.shiftWeekStr(ctx.shiftDateAdd(mon, -7));
  const cov = DAYS.map(() => new Array(48).fill(0));
  const add = (di, sh) => { ctx.asShiftSlots(sh).forEach(i => cov[di][i]++); if (di < 6) ctx.asShiftSpillSlots(sh).forEach(i => cov[di + 1][i]++); };
  (weeks[prevW] || []).filter(r => r.day === '週日' && ctx.asIsHomeRecord(r) && ctx.asIsWorkShift(r.shift) && !String(r.name).startsWith('🆘'))
    .forEach(r => ctx.asShiftSpillSlots(r.shift).forEach(i => cov[0][i]++));
  fixed.forEach(f => add(f.di, f.shift));
  const m = { shortMin: 0, ftOT: 0, ptH: 0, rest: 0, day6: 0, day7: 0 };
  for (const [n, row] of Object.entries(rows)) {
    let wk = 0, run = 0, lastEnd = null;
    const prev = (weeks[prevW] || []).filter(r => r.name === n);
    for (let k = 6; k >= 0; k--) { const pr = prev.find(x => x.day === DAYS[k]); if (pr && ctx.asIsWorkShift(pr.shift)) run++; else break; }
    const ps = prev.find(x => x.day === '週日' && ctx.asIsWorkShift(x.shift)); if (ps) lastEnd = -24 + ctx.shiftSpan(ps.shift).endH;
    row.forEach((sh, di) => {
      if (!ctx.asIsWorkShift(sh)) { run = 0; return; }
      add(di, sh); const h = ctx.shiftTotalHours(sh); wk += Math.min(h, 8); run++;
      if (run >= 7) m.day7++; else if (run === 6) m.day6++;
      const sp = ctx.shiftSpan(sh), st = di * 24 + sp.startH;
      if (lastEnd != null && st - lastEnd > 0 && st - lastEnd < 11) m.rest++;
      lastEnd = di * 24 + sp.endH;
      if (ptNames.has(n)) m.ptH += h; else if (h > 8) m.ftOT += h - 8;
    });
    if (!ptNames.has(n) && wk > 40) m.ftOT += wk - 40;
  }
  DAYS.forEach((d, di) => {
    const bands = cfg.demand[d] || [];
    const mn = new Array(48).fill(0);
    bands.forEach(b => { const bm = b.min == null ? b.n : Math.min(b.min, b.n); for (let h = b.s; h < b.e; h += 0.5) { const i = Math.round((h - 7) * 2); mn[i] = Math.max(mn[i], bm); } });
    for (let i = 0; i < 48; i++) if (cov[di][i] < mn[i]) m.shortMin += (mn[i] - cov[di][i]) / 2;
  });
  return m;
}

async function main() {
  const args = L.parseArgs(process.argv.slice(2));
  if (!args.store || !args.from || !args.to) { console.log('用法：node tools/autosched/backtest.js --store 美德 --from 2026-W26 --to 2026-W38 [--cache] [--weights JSON] [--season] [--infer]'); process.exit(1); }
  const ctx = L.loadCore();
  if (args.season) vm_setSeason(ctx);
  const data = await L.loadStore(args.store, { useCache: !!args.cache });
  let cfg = data.cfg;
  const empsAll = L.buildEmps(data, '');
  if (args.infer || !cfg) {
    const hist = {}; Object.keys(data.weeks).forEach(w => { if (w <= args.to) hist[w] = data.weeks[w]; });
    const base = ctx.asDefaultConfig(), inf = ctx.asInferFromHistory(hist, empsAll, base.seasons, {});
    cfg = { ...base, demand: inf.demand, staff: inf.staff };
    console.log('（用歷史推算的設定；拿答案考自己，結果偏樂觀）');
  }
  const weights = args.weights ? JSON.parse(args.weights) : undefined;
  const holidays = ctx.builtinHolidayMap();
  const ptNames = new Set(empsAll.filter(e => e.payAsPartTime || e.role === '工讀').map(e => e.name));
  const auto = n => cfg.staff[n] && cfg.staff[n].auto;
  const DAYS = ctx.asDayNames();
  const tot = { a: {}, d: {} };
  let gapA = 0, gapD = 0;
  for (const week of L.weekRange(ctx, args.from, args.to)) {
    const actual = data.weeks[week] || [];
    const weeks = { ...data.weeks, [week]: actual.filter(r => !auto(r.name) && !String(r.name).startsWith('🆘')) };
    const res = ctx.asGenerateDraft({ weekStr: week, cfg, emps: empsAll, weeks, leaves: data.leaves,
      catalog: L.catalogBefore(ctx, data, week), holidays, opt: weights ? { weights } : {} });
    const fixed = weeks[week].filter(r => DAYS.includes(r.day) && ctx.asIsHomeRecord(r) && ctx.asIsWorkShift(r.shift)).map(r => ({ di: DAYS.indexOf(r.day), shift: r.shift }));
    const dRows = {}, aRows = {};
    res.people.forEach((n, pi) => {
      dRows[n] = res.state[pi];
      aRows[n] = DAYS.map(d => { const r = actual.find(x => x.name === n && x.day === d && ctx.asIsHomeRecord(x)); return r ? String(r.shift || '') : ''; });
    });
    const A = evalWeek(ctx, data, data.weeks, cfg, week, aRows, fixed, ptNames);
    const D = evalWeek(ctx, data, data.weeks, cfg, week, dRows, fixed, ptNames);
    const ga = actual.filter(r => String(r.name).startsWith('🆘') && ctx.asIsWorkShift(r.shift)).reduce((s, r) => s + ctx.shiftTotalHours(r.shift), 0);
    const gd = res.gaps.reduce((s, g) => s + (g.e - g.s), 0);
    gapA += ga; gapD += gd;
    for (const k in A) { tot.a[k] = (tot.a[k] || 0) + A[k]; tot.d[k] = (tot.d[k] || 0) + D[k]; }
    console.log(`${week}  缺人 實${String(A.shortMin).padStart(5)}h 草${String(D.shortMin).padStart(5)}h｜待補 實${String(ga).padStart(4)} 草${String(gd).padStart(4)}｜正職加班 實${String(A.ftOT).padStart(3)} 草${String(D.ftOT).padStart(3)}｜工讀 實${String(A.ptH).padStart(5)} 草${String(D.ptH).padStart(5)}`);
  }
  const f = k => `實際 ${Math.round(tot.a[k])}　草稿 ${Math.round(tot.d[k])}`;
  console.log('\n合計');
  console.log('缺人時數（低於最少人數）', f('shortMin'));
  console.log('開🆘待補時數            ', `實際 ${Math.round(gapA)}　草稿 ${Math.round(gapD)}`);
  console.log('正職加班時數            ', f('ftOT'));
  console.log('工讀總時數              ', f('ptH'));
  console.log('輪班間隔不足 11 小時    ', f('rest'));
  console.log('連上第 6 天／第 7 天    ', `實際 ${tot.a.day6}/${tot.a.day7}　草稿 ${tot.d.day6}/${tot.d.day7}`);
}

// 回測暑假週時可打開寒暑假分季（網站目前關閉）
function vm_setSeason(ctx) { require('vm').runInContext('asSeasonsEnabled=function(){return true;}', ctx); }

main().catch(e => { console.error(e.message); process.exit(1); });
