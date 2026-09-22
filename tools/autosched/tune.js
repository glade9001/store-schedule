#!/usr/bin/env node
// 調參：用不同權重跑同一段連續試排，一行一組比較待補與成本。只讀資料庫、不寫入。
//
// 用法：
//   node tools/autosched/tune.js --store 美德 --from 2026-W41 --to 2026-W49 \
//     --sets '[["目前",{}],["gapDay 0",{"gapDay":0}],["gapDay 20000",{"gapDay":20000}]]'
//   第一次會抓資料，之後各組自動用快取。
// 成本口徑：9 週（或指定範圍）內 工讀時數×時薪×1.06＋正職加班費＋待補時數×196×1.06（假設用工讀補）
// ⚠️ 草稿有隨機起點，權重差一點的組別結果會有起伏，要看趨勢不要看單一數字。

const L = require('./lib');
const { simulate, ymOffset } = require('./simulate');

async function main() {
  const args = L.parseArgs(process.argv.slice(2));
  if (!args.store || !args.from || !args.to || !args.sets) { console.log("用法：node tools/autosched/tune.js --store 美德 --from 2026-W41 --to 2026-W49 --sets '[[\"名稱\",{權重}],...]'"); process.exit(1); }
  const ctx = L.loadCore();
  const data = await L.loadStore(args.store, { useCache: !!args.cache, salaryMonths: args.salary ? [args.salary] : [ymOffset(0), ymOffset(-1)] });
  const sets = JSON.parse(args.sets);
  for (const [name, w] of sets) {
    const r = await simulate({ ...args, weights: JSON.stringify(w) }, ctx, data);
    // 只算試排範圍內的成本：工讀＋加班＋待補（正職薪水固定，不影響比較）
    const cost = r.costs.reduce((a, o) => a + o.ptPay + o.holPay + o.otPay + o.gapPay, 0);
    const s = r.sum;
    console.log(`${String(name).padEnd(16)} 待補 ${s.count} 格/${s.hours}h 碎${s.short} 同時段2格${s.dbl}h 列數${s.rows} 一天多人${s.multiDays}天｜變動成本 ${L.money(cost)}｜${(s.ms / 1000).toFixed(0)}s`);
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
