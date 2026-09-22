// 自動排班離線工具共用函式（回測、連續試排、調參）
//
// ⚠️ 這個 repo 是公開的：
//   - 程式碼裡不放任何金鑰。讀 Firestore 用 firebase-admin＋本機的 Google 預設登入（ADC），
//     第一次使用前在終端機執行：gcloud auth application-default login
//   - 從資料庫抓下來的資料（姓名、班表、薪資）只存在 tools/autosched/.cache/，已列入 .gitignore，不可提交
//   - 這些工具只讀資料庫，不寫入任何東西
//
// 排班核心（auto-schedule-core.js）、班別解析（shift-utils.js）、國定假日（holidays.js）
// 都直接載入網站用的同一份檔案，所以離線結果跟排班頁按「產生草稿」一致。

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');
const CACHE_DIR = path.join(__dirname, '.cache');
const PROJECT_ID = 'store-schedule-3b056';
const OFF = ['排休', '指休', '特休', '補休'];

/** 載入網站的排班核心到一個獨立環境，回傳可呼叫的函式集合 */
function loadCore() {
  const ctx = { console, Math, Date };
  vm.createContext(ctx);
  for (const f of ['holidays.js', 'shift-utils.js', 'auto-schedule-core.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
  }
  return ctx;
}

/** 解析 --key value / --flag 參數 */
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2), v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) out[k] = true; else { out[k] = v; i++; }
  }
  return out;
}

/**
 * 讀一家店的資料（只讀）。有快取且帶 useCache 就直接用快取。
 * @returns {{store, fetchedAt, weeks:{週:records[]}, emps:{名:資料}, cfg, shifts, leaves:[], salary:{YYYY-MM:records[]}}}
 */
async function loadStore(store, { useCache = false, fromWeek = '2026-W14', salaryMonths = [] } = {}) {
  const file = path.join(CACHE_DIR, encodeURIComponent(store) + '.json');
  if (useCache && fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const admin = require(path.join(ROOT, 'functions', 'node_modules', 'firebase-admin'));
  if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT_ID });
  const db = admin.firestore();
  const ref = db.collection('stores').doc(store);
  const FP = admin.firestore.FieldPath.documentId();
  const [wk, em, cfg, sh, lr] = await Promise.all([
    ref.collection('weeks').where(FP, '>=', fromWeek).get(),
    ref.collection('employees').get(),
    ref.collection('config').doc('autoSchedule').get(),
    ref.collection('config').doc('shifts').get(),
    ref.collection('leaveRequests').get(),
  ]);
  const data = { store, fetchedAt: new Date().toISOString(), weeks: {}, emps: {}, cfg: cfg.exists ? cfg.data() : null,
    shifts: sh.exists ? (sh.data().shifts || []) : [], leaves: [], salary: {} };
  wk.forEach(d => { data.weeks[d.id] = d.data().records || []; });
  em.forEach(d => { data.emps[d.id] = d.data(); });
  lr.forEach(d => { data.leaves.push(d.data()); });
  for (const ym of salaryMonths) {
    const s = await ref.collection('salary').doc(ym).get();
    if (s.exists) data.salary[ym] = s.data().records || [];
  }
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data));
  return data;
}

/**
 * 在職員工 → 草稿要的格式。底薪／時薪優先用指定月份的薪資記錄（跟排班頁一樣讀不到就用員工資料）。
 */
function buildEmps(data, salaryYm) {
  const sal = {};
  (data.salary[salaryYm] || []).forEach(r => { sal[r.empName] = r; });
  return Object.entries(data.emps)
    .filter(([n, e]) => !n.startsWith('🆘') && !['離職', '調走'].includes(e.status))
    .map(([n, e]) => ({
      name: n, role: e.role, payAsPartTime: !!e.payAsPartTime,
      wage: +(sal[n]?.wage || e.wage || 0), base: +(sal[n]?.baseSalary || 0),
      startDate: e.startDate || '', departDate: e.status === '離職' ? (e.departDate || '') : '',
    }));
}

/** 班別目錄：跟排班頁一樣用「這週之前」的歷史（用過 3 次以上才收） */
function catalogBefore(ctx, data, week) {
  const hist = {};
  Object.keys(data.weeks).forEach(w => { if (w < week) hist[w] = data.weeks[w]; });
  return ctx.asBuildCatalog(data.shifts, hist, 3);
}

/** 一週的待補統計：格數、時數、2 小時以內的碎待補、同時段 2 格以上的時數、待補列數、一天 2 人以上支援的天數 */
function gapStats(gaps) {
  let hours = 0, short = 0, dbl = 0, rows = 0, multiDays = 0;
  gaps.forEach(g => { const h = g.e - g.s; hours += h; if (h <= 2) short++; });
  for (let di = 0; di < 7; di++) {
    const gs = gaps.filter(g => g.di === di);
    rows = Math.max(rows, gs.length);
    if (gs.length >= 2) multiDays++;
    for (let h = 7; h < 31; h += 0.5) if (gs.filter(g => g.s <= h && h < g.e).length >= 2) dbl += 0.5;
  }
  return { count: gaps.length, hours, short, dbl, rows, multiDays };
}

/** 把草稿結果寫進（記憶體裡的）週資料：只補空白格，待補當成一列一格記錄 */
function applyDraftToWeek(ctx, weeks, week, res) {
  const recs = (weeks[week] || []).slice();
  res.cells.forEach(c => {
    if (!recs.some(r => r.name === c.name && r.day === c.day && String(r.shift || '').trim()))
      recs.push({ name: c.name, day: c.day, shift: c.shift, location: '本店', actualHours: ctx.asIsWorkShift(c.shift) ? ctx.shiftTotalHours(c.shift) : 0 });
  });
  res.gaps.forEach((g, i) => recs.push({ name: '🆘草稿' + i, day: g.day, shift: g.shift, location: '本店', actualHours: g.e - g.s }));
  weeks[week] = recs;
}

/**
 * 某月的人事成本（同一套口徑）：
 *   正職＝底薪＋全勤＋公司勞退（取該月薪資記錄；沒有就用 ftFallback 那個月的）
 *   工讀＝時數×時薪×1.06（含勞退）、國定假日加給＝時數×時薪、正職加班＝(>8h/天＋正常工時>40/週)×底薪/240×1.34
 *   待補＝時數×196×1.06（假設用工讀補）；都不含勞健保公司負擔
 * 正職/工讀以「當月薪資記錄」判斷身分（有人月中轉工讀，用現況身分會重複計算）
 */
function monthCost(ctx, data, weeks, ym, { ftFallback } = {}) {
  const HOL = ctx.builtinHolidayMap();
  const salRecs = data.salary[ym] || data.salary[ftFallback] || [];
  const ftRecs = salRecs.filter(r => !r.payAsPartTime && r.role !== '工讀');
  const ftNames = new Set(ftRecs.map(r => r.empName));
  const ftPay = ftRecs.reduce((a, r) => a + (+r.baseSalary || 0) + (+r.fullAttendBonus || 0) + (+r.pensionEr || 0), 0);
  const baseOf = n => +(ftRecs.find(r => r.empName === n)?.baseSalary || 29500);
  const wageOf = n => +(salRecs.find(r => r.empName === n)?.wage || data.emps[n]?.wage || 196);
  const o = { ym, ftPay, ptHours: 0, ptPay: 0, holPay: 0, otHours: 0, otPay: 0, gapHours: 0, gapPay: 0 };
  const wkH = {};
  for (const [w, recs] of Object.entries(weeks)) for (const r of recs) {
    const dt = ctx.asRecordDate(w, r.day);
    if (!dt || dt.slice(0, 7) !== ym || !ctx.asIsHomeRecord(r) || !ctx.asIsWorkShift(r.shift)) continue;
    const h = parseFloat(r.actualHours) || ctx.shiftTotalHours(r.shift);
    if (String(r.name).startsWith('🆘')) { o.gapHours += h; o.gapPay += h * 196 * 1.06; continue; }
    if (ftNames.has(r.name)) {
      if (h > 8) { o.otHours += h - 8; o.otPay += (h - 8) * Math.ceil(baseOf(r.name) / 240) * 1.34; }
      const k = r.name + '|' + w; wkH[k] = (wkH[k] || 0) + Math.min(h, 8);
    } else {
      o.ptHours += h; o.ptPay += h * wageOf(r.name) * 1.06;
      if (HOL[dt]) o.holPay += h * wageOf(r.name);
    }
  }
  for (const [k, h] of Object.entries(wkH)) if (h > 40) { const n = k.split('|')[0]; o.otHours += h - 40; o.otPay += (h - 40) * Math.ceil(baseOf(n) / 240) * 1.34; }
  o.days = new Date(+ym.slice(0, 4), +ym.slice(5), 0).getDate();
  o.subtotal = o.ftPay + o.ptPay + o.holPay + o.otPay;
  o.total = o.subtotal + o.gapPay;
  return o;
}

/** 週次清單（含頭尾） */
function weekRange(ctx, from, to) {
  const out = [];
  let w = from;
  while (w <= to) { out.push(w); w = ctx.shiftWeekStr(ctx.shiftDateAdd(ctx.asWeekMonday(w), 7)); }
  return out;
}

const money = v => '$' + Math.round(v).toLocaleString('en-US');

module.exports = { ROOT, OFF, loadCore, parseArgs, loadStore, buildEmps, catalogBefore, gapStats, applyDraftToWeek, monthCost, weekRange, money };
