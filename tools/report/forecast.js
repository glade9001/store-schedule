// 經營報酬預測：用線上 labor-budget.js 算某月預估、或比對實際（唯讀資料檔）。
// 用法：node tools/report/forecast.js <data.json> 2026-11
// data.json：{ 店名: { pnl:{ym:doc}, dailySales:{date:doc} } }（Firestore 撈出來的格式）。
// 現行＝a＋b×營業淨額−去年同月電費；半校正＝加上近 3 月殘差÷2，電費改去年同月×近 3 月年增。都是「沒有盤點」的經營報酬。
const fs = require('fs'), vm = require('vm'), path = require('path');
const root = path.join(__dirname, '..', '..');
const ctx = { console }; vm.createContext(ctx);
for (const f of ['leave-rules.js', 'labor-budget.js']) vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), ctx);
const { lbPdsRatio, lbLiveSales, lbFit, lbAddMonth, LB_LIVE_BLEND } = ctx;
const [file, ym] = process.argv.slice(2);
const D = JSON.parse(fs.readFileSync(file));
const y = p => +p.operatingReward - (+p.invResult || 0) + (+p.elecCost || 0);
const f = x => Math.round(x).toLocaleString('en-US');
for (const s of Object.keys(D)) {
  const P = {}; Object.keys(D[s].pnl).filter(m => m < ym).forEach(m => { P[m] = D[s].pnl[m]; });
  const ms = Object.keys(P).sort(), last3 = ms.slice(-3), dl = {};
  Object.keys(D[s].dailySales).filter(d => d.slice(0, 7) <= ym).forEach(d => { dl[d] = D[s].dailySales[d]; });
  const pds = lbPdsRatio(dl, P), live = lbLiveSales(dl, ym, pds.ratio, pds.bigOn);
  const sales = live ? live.sales : last3.reduce((t, m) => t + +P[m].netSales, 0) / 3;
  const fit = lbFit(ms.map(m => +P[m].netSales), ms.map(m => y(P[m])));
  const resid = last3.reduce((t, m) => t + y(P[m]) - fit.a - fit.b * +P[m].netSales, 0) / 3;
  const ly = +(P[lbAddMonth(ym, -12)] || {}).elecCost || 0;
  let a = 0, b = 0; last3.forEach(m => { const l = P[lbAddMonth(m, -12)]; if (l) { a += +P[m].elecCost; b += +l.elecCost; } });
  const now = fit.a + fit.b * sales - ly, half = fit.a + fit.b * sales + resid / 2 - ly * (b ? a / b : 1);
  const act = D[s].pnl[ym];
  console.log(s, '營業淨額', f(sales), live ? `（每日 ${live.days} 天）` : '（近 3 月平均）', '現行', f(now), '半校正', f(half),
    act ? `實際 ${f(+act.operatingReward - (+act.invResult || 0))} 誤差 現行 ${f(now - (+act.operatingReward - (+act.invResult || 0)))} 半校正 ${f(half - (+act.operatingReward - (+act.invResult || 0)))}` : '');
}
