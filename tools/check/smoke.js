// ③ 畫面試算：在 Node 沙盒裡載入真正的前端檔，用正式資料（唯讀）把關鍵畫面算一遍，出錯或算出怪數字就不給過。
// 抓過的實例：首頁團購 var 提升讓整張卡片出錯（10/13～15 壞了兩天沒人發現）、聯鑫大單扣錯讓工時上限少 109h。
const vm = require('vm');
const { loadFront, ok, bad, warn, list } = require('./lib');
const STORES = ['美德', '聯鑫', '錦花'];
const pad = n => String(n).padStart(2, '0');
const now = new Date(), YM = `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
const finite = v => typeof v === 'number' && isFinite(v);

async function homeGroupbuy() {
  const camps = (await list('gb_campaigns')).filter(c => c.data.status === 'open').map(c => Object.assign({ id: c.id }, c.data));
  for (const u of [{ permission: 'employee', store: '美德' }, { permission: 'manager', store: '聯鑫' }, { permission: 'owner', store: '美德' }]) {
    const ctx = loadFront(['home-gb.js'], { currentUser: u });
    ctx.CAMPS = camps; vm.runInContext('hgCamps = CAMPS', ctx);
    try {
      ctx.hgRender();
      const html = ctx.els.hgBody ? ctx.els.hgBody.innerHTML : '';
      const live = camps.some(c => c.is_test !== true && c.end_time && c.end_time.toMillis() > Date.now());
      if (live && !/hg-row/.test(html)) bad(`首頁團購（${u.permission}）`, '有開放中的團購卻沒畫出任何一檔');
      else if (/NaN|undefined/.test(html)) bad(`首頁團購（${u.permission}）`, '畫面出現 NaN／undefined');
      else ok(`首頁團購（${u.permission}）`, (ctx.els.hgCount.textContent || '0 檔'));
    } catch (e) { bad(`首頁團購（${u.permission}）`, e.message); }
  }
}

async function laborBudget() {
  const ctx = loadFront(['shift-utils.js', 'labor-budget.js']);
  for (const s of STORES) {
    try {
      const L = await ctx.lbLoadStore(ctx.window.db, s);
      if (L.model && L.model.err) { warn(`工時上限 ${s}`, L.model.err); continue; }
      const ev = ctx.lbEvaluate(L, [], YM);
      if (ev.err || !ev.plan) { warn(`工時上限 ${s}`, ev.err || '資料不足'); continue; }
      const p = ev.plan, r = L.pds;
      if (![p.cap, p.budget, p.sales, ev.targetPds].every(finite)) bad(`工時上限 ${s}`, '算出非數字');
      else if (p.cap <= 0 || p.cap > 5000) bad(`工時上限 ${s}`, `上限 ${Math.round(p.cap)}h 不合理`);
      else if (r.auto && (r.ratio < 0.85 || r.ratio > 1.15)) bad(`工時上限 ${s}`, `PSD÷營業淨額比例 ${r.ratio.toFixed(3)} 超出 0.85～1.15（多半是營業額輸入錯或大單判斷錯）`);
      else ok(`工時上限 ${s}`, `上限 ${Math.round(p.cap)}h、比例 ${(r.ratio || 0).toFixed(3)}${r.auto ? '' : '（預設）'}${r.bigOn === false ? '、大單不扣' : ''}`);
    } catch (e) { bad(`工時上限 ${s}`, e.message); }
  }
}

async function dailySales() {
  for (const s of STORES) {
    const has = (await list(`stores/${s}/dailySales`)).some(d => d.id.startsWith(YM));
    if (!has) continue;
    try {
      const ctx = loadFront(['shift-utils.js', 'holidays.js', 'labor-budget.js', 'daily-sales-page.js']);
      vm.runInContext(`dsRole = 'lead'; dsMonth = '${YM}'; dsStoreName = '${s}';`, ctx);
      const html = await ctx.dsRenderAna(s, YM);
      if (/NaN|undefined|Infinity/.test(html.replace(/<svg[\s\S]*?<\/svg>/g, ''))) bad(`每日營業分析 ${s}`, '畫面出現 NaN／undefined');
      else if (!/業績進度/.test(html)) bad(`每日營業分析 ${s}`, '沒有業績進度卡');
      else ok(`每日營業分析 ${s}`);
    } catch (e) { bad(`每日營業分析 ${s}`, e.message); }
  }
}

async function compAvail() {
  const ctx = loadFront(['comp-avail.js']);
  const emps = new Set((await list('stores/美德/employees')).concat(await list('stores/聯鑫/employees'), await list('stores/錦花/employees'))
    .filter(e => !['離職', '調走'].includes(e.data.status)).map(e => e.id));
  let n = 0, neg = 0;
  for (const e of emps) {
    try { const r = await ctx.caCompAvailability(e); if (!finite(r.effective)) throw new Error('非數字'); if (r.effective < 0) neg++; n++; }
    catch (err) { bad('補休可用天數', err.message); return; }
  }
  neg ? warn('補休可用天數', `${neg} 人是負數（用超過，待下次發放抵銷）`) : null;
  ok('補休可用天數', n + ' 人');
}

async function holidays() {
  const ctx = loadFront(['holidays.js']);
  const t = ctx.builtinHolidayMap(), y = now.getFullYear();
  await ctx.syncHolidayMapInto(t, [y]);
  const n = Object.keys(t).filter(d => d.startsWith(String(y))).length;
  n >= 10 ? ok('國定假日（系統設定）', `${y} 年 ${n} 天`) : bad('國定假日（系統設定）', `${y} 年只有 ${n} 天，設定可能沒填`);
  if (now.getMonth() === 11) {
    const next = (await ctx.loadHolidayMap([y + 1])).source;
    next === 'builtin' ? warn('國定假日', `${y + 1} 年還沒在系統設定建立（12 月要更新）`) : null;
  }
}

module.exports = async function run() {
  console.log('③ 畫面試算（正式資料、唯讀）');
  await homeGroupbuy(); await laborBudget(); await dailySales(); await compAvail(); await holidays();
};
if (require.main === module) module.exports().then(() => require('./lib').done(), e => { console.error(e); process.exit(1); });
