#!/usr/bin/env node
// 連續試排：從某週排到某週，每週的草稿當成已排好再排下一週（跟店長每週按「產生草稿」一樣），
// 最後列出每週待補、整段統計，以及涵蓋月份的人事成本。只讀資料庫、不寫入。
//
// 用法：
//   node tools/autosched/simulate.js --store 美德 --from 2026-W41 --to 2026-W49
//   選項：--cache（用上次抓的資料，不重抓）  --weights '{"gapDay":12000}'（覆寫權重）
//         --salary 2026-09（正職底薪取哪個月的薪資記錄，預設本月或上月最近一個有記錄的）  --quiet（只印統計）

const L = require('./lib');

async function simulate(args, ctx, data) {
  const weights = args.weights ? JSON.parse(args.weights) : undefined;
  const salYm = pickSalaryMonth(args, data);
  const weeks = {}; Object.entries(data.weeks).forEach(([k, v]) => { weeks[k] = v.slice(); });
  const emps = L.buildEmps(data, salYm);
  const holidays = ctx.builtinHolidayMap();
  const list = L.weekRange(ctx, args.from, args.to);
  const sum = { count: 0, hours: 0, short: 0, dbl: 0, rows: 0, multiDays: 0, ms: 0 };
  const lines = [];
  for (const w of list) {
    const t = Date.now();
    const res = ctx.asGenerateDraft({ weekStr: w, cfg: data.cfg, emps, weeks, leaves: data.leaves,
      catalog: L.catalogBefore(ctx, data, w), holidays, opt: weights ? { weights } : {} });
    const ms = Date.now() - t;
    const g = L.gapStats(res.gaps);
    Object.keys(g).forEach(k => { sum[k] += g[k]; }); sum.ms += ms;
    lines.push(`${w}  待補 ${String(g.count).padStart(2)} 格／${String(g.hours).padStart(4)}h  列數 ${g.rows}  ${(ms / 1000).toFixed(1)}s  ${res.gaps.map(x => x.day.slice(1) + x.shift).join(' ')}`);
    L.applyDraftToWeek(ctx, weeks, w, res);
  }
  // 涵蓋月份的成本
  const months = [...new Set(list.flatMap(w => [0, 6].map(i => ctx.shiftDateAdd(ctx.asWeekMonday(w), i).slice(0, 7))))];
  const costs = months.map(m => L.monthCost(ctx, data, weeks, m, { ftFallback: salYm }));
  return { lines, sum, costs, weeks };
}

function ymOffset(n) {
  const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() + n);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}
function prevMonth() { return ymOffset(-1); }
/** 正職底薪用哪個月：有指定就用指定的，否則用「本月或上月」裡最近一個有薪資記錄的（人員身分會變，太舊的月份會算錯） */
function pickSalaryMonth(args, data) {
  if (args.salary) return args.salary;
  for (const ym of [ymOffset(0), ymOffset(-1)]) if ((data.salary[ym] || []).length) return ym;
  return ymOffset(-1);
}

function printCosts(costs) {
  console.log('\n月份      天數  正職薪水    工讀薪資＋勞退  國假加給  正職加班(時數/金額)  小計        待補(時數/若找工讀補)  含待補合計  每天');
  costs.forEach(o => console.log(`${o.ym}  ${o.days}   ${L.money(o.ftPay).padStart(9)}  ${L.money(o.ptPay).padStart(12)}  ${L.money(o.holPay).padStart(8)}  ${String(Math.round(o.otHours)).padStart(4)}h/${L.money(o.otPay).padStart(7)}  ${L.money(o.subtotal).padStart(9)}  ${String(Math.round(o.gapHours)).padStart(4)}h/${L.money(o.gapPay).padStart(8)}  ${L.money(o.total).padStart(9)}  ${L.money(o.total / o.days)}`));
  console.log('（正職＝底薪＋全勤＋公司勞退；工讀含勞退 6%；都不含勞健保公司負擔。月份沒排滿的天數成本會偏低）');
}

async function main() {
  const args = L.parseArgs(process.argv.slice(2));
  if (!args.store || !args.from || !args.to) { console.log('用法：node tools/autosched/simulate.js --store 美德 --from 2026-W41 --to 2026-W49 [--cache] [--weights JSON] [--salary YYYY-MM]'); process.exit(1); }
  const ctx = L.loadCore();
  const data = await L.loadStore(args.store, { useCache: !!args.cache, salaryMonths: args.salary ? [args.salary] : [ymOffset(0), ymOffset(-1)] });
  if (!data.cfg) { console.log(`${args.store} 還沒有自動排班設定`); process.exit(1); }
  const r = await simulate(args, ctx, data);
  if (!args.quiet) r.lines.forEach(l => console.log(l));
  const s = r.sum;
  console.log(`\n合計：待補 ${s.count} 格／${s.hours}h｜碎待補 ${s.short}｜同時段 2 格以上 ${s.dbl}h｜待補列數 ${s.rows}｜一天 2 人以上支援 ${s.multiDays} 天｜${(s.ms / 1000).toFixed(1)}s`);
  console.log(`（正職底薪取 ${pickSalaryMonth(args, data)} 的薪資記錄）`);
  printCosts(r.costs);
}

if (require.main === module) main().catch(e => { console.error(e.message); process.exit(1); });
module.exports = { simulate, prevMonth, ymOffset, pickSalaryMonth };
