// ④ 資料健檢（正式資料、唯讀）：只抓「一定不該發生」的不一致；提醒類只列警告。也是「資料健檢員」每月跑的那支。
// 來源：2026-10-15 盤點實際抓到的問題（國定假日補休被吃掉、統計欄漂、特休批次沒建、團購份數）。
const fs = require('fs'), path = require('path'), vm = require('vm');
const { ROOT, list, group, getDoc, fakeDb, ok, bad, warn, tag } = require('./lib');
const STORES = ['美德', '聯鑫', '錦花'];
const WD = ['週一', '週二', '週三', '週四', '週五', '週六', '週日'];
const OFF = ['排休', '指休', '特休', '補休', '清空', ''];

async function groupbuy() {
  const camps = await list('gb_campaigns'), orders = await list('gb_orders');
  const sum = {}, byStore = {};
  orders.forEach(o => { const d = o.data; if (!['active', 'picked_up'].includes(d.status)) return;
    sum[d.campaign_id] = (sum[d.campaign_id] || 0) + (d.qty || 0);
    const b = byStore[d.campaign_id] = byStore[d.campaign_id] || {}; b[d.store] = (b[d.store] || 0) + (d.qty || 0); });
  const issues = [];
  camps.forEach(c => { const d = c.data; if (d.purged_at) return;
    const real = sum[c.id] || 0;
    if ((d.ordered_qty || 0) !== real) issues.push(`${d.title || c.id} 已訂 ${d.ordered_qty || 0}、訂單合計 ${real}`);
    if (d.stock != null && real > d.stock) issues.push(`${d.title || c.id} 超賣 ${real}>${d.stock}`);
    const obs = d.ordered_by_store || {}, rb = byStore[c.id] || {};
    for (const k of new Set([...Object.keys(obs), ...Object.keys(rb)])) if ((obs[k] || 0) !== (rb[k] || 0)) { issues.push(`${d.title || c.id} ${k} 份數 ${obs[k] || 0}≠${rb[k] || 0}`); break; } });
  issues.length ? bad('團購份數與訂單', issues.join('；')) : ok('團購份數與訂單', camps.length + ' 檔');
}

// 特休／補休統計欄：用後端 recomputeLeaveStats 同一份程式（從 functions/leave.js 抽出來）唯讀重算，看有沒有漂
async function leaveStats() {
  const src = fs.readFileSync(path.join(ROOT, 'functions/leave.js'), 'utf8');
  const code = src.slice(src.indexOf('async function recomputeLeaveStats'), src.indexOf('const leaveStatsTrigger'));
  const changes = [];
  const db = fakeDb();
  db.runTransaction = async fn => fn({
    get: async r => r.where ? r.get() : r.get(),   // 集合有 where（collRef），文件沒有
    set: (r, d) => changes.push(r.path + ' ' + JSON.stringify(d)),
  });
  // fakeDb 的 collRef.get 回傳 docs 帶 ref；文件 snapshot 也帶 ref
  const ctx = { console, Promise, Date, parseInt, parseFloat, String, Math }; vm.createContext(ctx); vm.runInContext(code, ctx);
  const emps = new Set();
  for (const c of ['leaveLog', 'compUsage', 'annualUsage', 'leaveBatches']) (await group(c)).forEach(d => { const p = d.path.split('/'); if (p[0] === 'employees') emps.add(p[1]); });
  const y = String(new Date().getFullYear()), drift = [];
  for (const e of emps) { const n = changes.length; await ctx.recomputeLeaveStats(db, e, y); if (changes.length > n) drift.push(tag(e)); }
  drift.length ? bad('特休／補休統計欄', `${drift.length} 人和帳本不一致（後端觸發器應該要自動校正）：${drift.join('、')}`) : ok('特休／補休統計欄', emps.size + ' 人一致');
}

// 國定假日補休：已同步過的週（holidayCompSync），正職那天有上班就要有補休（發放−撤銷 > 0）
async function holidayComp() {
  const synced = await list('holidayCompSync');
  if (!synced.length) { ok('國定假日補休', '還沒有同步過的週'); return; }
  const net = {};
  (await group('leaveLog')).forEach(d => { const p = d.path.split('/'); if (p[0] !== 'employees') return;
    (d.data.records || []).forEach(r => { if (!(r.source === 'holiday' || String(r.note || '').includes('國定假日'))) return;
      const k = p[1] + '|' + r.date, n = parseFloat(r.days) || 1;
      net[k] = (net[k] || 0) + (r.type === 'comp_earn' ? n : r.type === 'comp_cancel' ? -n : 0); }); });
  const miss = [];
  for (const s of synced) {
    const { store, weekStr } = s.data;
    const g = []; (s.data.granted || []).forEach(x => g.push(x));
    for (const x of g) if (!((net[x.name + '|' + x.date] || 0) > 0)) miss.push(`${store} ${x.date} ${tag(x.name)}`);
  }
  miss.length ? bad('國定假日補休', '同步時發了、現在淨額卻 ≤0（之後被撤銷？）：' + miss.join('、')) : ok('國定假日補休', synced.length + ' 週已同步');
}

// 提醒類：正職週年後還沒建特休批次（首頁會持續提醒店長）
async function annualBatches() {
  const batches = {}; (await group('leaveBatches')).forEach(d => { const p = d.path.split('/'); (batches[p[1]] = batches[p[1]] || []).push(d.data.grantDate); });
  const hire = {}; (await group('leaves')).forEach(d => { const p = d.path.split('/'); if (d.data.hireDate && !hire[p[1]]) hire[p[1]] = d.data.hireDate; });
  const add = (ds, m) => { const d = new Date(ds + 'T00:00:00'); d.setMonth(d.getMonth() + m); return d; };
  const today = new Date(), late = [];
  for (const s of STORES) for (const e of await list(`stores/${s}/employees`)) {
    const x = e.data; if (['離職', '調走'].includes(x.status) || x.payAsPartTime || String(x.role || '').includes('工讀')) continue;
    const h = hire[e.id] || x.startDate; if (!h) continue;
    for (const m of [6, ...Array.from({ length: 30 }, (_, i) => 12 * (i + 1))]) {
      const a = add(h, m); if (a > today) break;
      if ((today - a) / 864e5 > 180) continue;
      if (!(batches[e.id] || []).some(g => g && Math.abs((new Date(g) - a) / 864e5) <= 31)) late.push(`${s} ${tag(e.id)} ${a.getFullYear()}-${String(a.getMonth() + 1).padStart(2, '0')}-${String(a.getDate()).padStart(2, '0')}`);
    }
  }
  late.length ? warn('正職特休批次', `${late.length} 筆週年到了還沒建：${late.join('、')}`) : ok('正職特休批次');
}

// 提醒類：近 30 天每日營業數字怪（客單 <20 或 >300、超過 100 萬）
async function dailySales() {
  const since = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10), odd = [];
  for (const s of STORES) for (const d of await list(`stores/${s}/dailySales`)) {
    if (d.id < since) continue; const x = d.data;
    const t = x.customers ? x.sales / x.customers : null;
    if (x.sales > 1e6 || (t != null && (t < 20 || t > 300))) odd.push(`${s} ${d.id} 營業額 ${x.sales}、來客 ${x.customers}`);
  }
  odd.length ? warn('每日營業數字', odd.join('；')) : ok('每日營業數字（近 30 天）');
}

// 特補休頁「存摺」（leave-passbook.js）的餘額要跟權威算法一致：
//   補休＝comp-avail.js（劃休頁、首頁用的同一份，含「國定假日還沒到」天數）；
//   特休（沒結清過的人）＝未結清批次天數 − 特休逐日帳本天數。
// 存摺是畫面上唯一的數字，跟別頁對不上店長就不知道該信哪個（2026-10-26 改版前就是這樣）。
async function passbook() {
  const L = require('./lib');
  const ctx = L.loadFront(['leave-rules.js', 'comp-avail.js', 'leave-passbook.js']);
  const now = new Date(), today = new Date(now - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10), Y = today.slice(0, 4);
  const names = new Set();
  for (const c of ['leaveBatches', 'annualUsage', 'compUsage', 'leaveLog']) (await group(c)).forEach(d => { const p = d.path.split('/'); if (p[0] === 'employees') names.add(p[1]); });
  const issues = [];
  for (const n of names) {
    const [bs, au, cu, ld, prev] = await Promise.all([list(`employees/${n}/leaveBatches`), list(`employees/${n}/annualUsage`), list(`employees/${n}/compUsage`),
      list(`employees/${n}/leaveLog`), getDoc(`employees/${n}/comp/${+Y - 1}`)]);
    const logs = []; ld.forEach(d => (d.data.records || []).forEach(r => logs.push({ ym: d.id, ...r })));
    const B = bs.map(b => ({ id: b.id, ...b.data })), use = x => x.map(u => u.data.date ? u.data : { date: u.id });
    const A = ctx.pbAnnualBook({ batches: B, usage: use(au), logs, schedule: [], today });
    const C = ctx.pbCompBook({ logs, usage: use(cu), prev: prev ? prev.data : {}, year: Y, today });
    const av = await ctx.caCompAvailability(n);
    if (C.balance !== av.balance || C.pending !== av.balance - av.effective) issues.push(`${tag(n)} 補休 存摺 ${C.balance}≠${av.balance}`);
    if (!B.some(b => b.settled)) { const want = B.reduce((s, b) => s + (+b.days || 0), 0) - au.length; if (A.balance !== want) issues.push(`${tag(n)} 特休 存摺 ${A.balance}≠${want}`); }
  }
  issues.length ? bad('特補休存摺餘額', issues.join('；')) : ok('特補休存摺餘額', names.size + ' 人與劃休頁／帳本一致');
}

module.exports = async function run() {
  console.log('④ 資料健檢（正式資料、唯讀）');
  await groupbuy(); await leaveStats(); await holidayComp(); await annualBatches(); await passbook(); await dailySales();
};
if (require.main === module) module.exports().then(() => require('./lib').done(), e => { console.error(e); process.exit(1); });
