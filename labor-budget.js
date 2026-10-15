// 本月人事「工時上限」（打平後再讓加盟主留一定比例）：排班頁一行燈號＋加盟主儀表板三店對照共用。
// 來源：stores/{店}/pnl（經營報酬，未稅）＋ perfSnapshot（實際人事成本，含雇主負擔）＋ config/autoSchedule（最低人力）。
//
// 算法（2026-10-10 試算回測過，見專案記憶 project_pnl）：
//   經營報酬 ＋ 加回盤損 ＋ 加回電費 ≈ a ＋ b × 營業淨額（各店自己的歷史月份回歸）
//   本月人事預算 ＝（a ＋ b × 預估營收 − 本月電費 ＋ 盤損月攤）×（1 − 營業稅）×（1 − 加盟主比例）− 其他固定支出
//   預估營收＝最近 3 個月平均（回測誤差約 ±4%，比「去年同月」準）；電費用去年同月（季節差很大）
//   時數上限 ＝ 近 3 月實際時數 ＋（預算 − 近 3 月實際人事）÷ 工讀平均時薪
//     ⚠️ 用工讀時薪換算而不是平均時薪：正職月薪固定，多排／少排的只有工讀時數。
// 營業稅：經營報酬是未稅金額。發票是加盟主開給統一超商（買受人）的三聯式，總計＝經營報酬×1.05，
//    總部按發票總計付款，那 5% 再由加盟主報 401 繳給國稅局 → 代收代付，不影響兩平（2026-10-11 依發票確認）。
//    若哪天確認總部只撥未稅金額、稅要自己吸收，把 LB_TAX 改成 0.05 即可。
// 店長看得到時數、燈號與人事成本（整月推估 vs 人事上限，使用者 2026-10-11 加）；經營報酬、加盟主比例只在儀表板。
// 本檔頂層只用 function 與 var（前綴 lb），避免跟頁面撞名。

var LB_PERF_EXCLUDE = { '2026-04': 1 }; // 同 performance-page.js：系統剛上線那個月薪資不完整
var LB_SALES_ERR = 0.04;                // 營收預估誤差（回測 7～9 月平均約 3.5～4.6%）
// 月中用本月實際營業額重估（2026-10-11 回測美德 12 個月）：近 3 月平均誤差 4.2%；本月目前日均×天數
// 第 5 天 4.8%（反而較差）、第 10 天 2.7%、第 15 天 2.2%、第 20 天 1.9% → 滿 10 天才換。
var LB_LIVE_MIN_DAYS = 10;
// 工讀的公司負擔（勞保、健保、勞退）÷（時薪×時數）：各店用自己近 3 個月的工讀薪資算（lbPtBurden，使用者 2026-10-11）；
// 讀不到薪資時才用這個預設（三店 2026-07～09 實測：美德 15.1%、聯鑫 17.1%、錦花 17.7%，合計 16.5%）
var LB_PT_BURDEN = 0.16;
var LB_SALES_ERR_LIVE = 0.03;
var LB_MIN_MONTHS = 8;                  // 損益少於 8 個月不做回歸
var LB_TAX = 0;                         // 營業稅由總部隨發票付、加盟主轉繳 → 不影響（見檔頭）
// PDS（平均每日營業額）用含稅表示，跟日結單、每日營業頁一致（使用者 2026-10-11）。
// PDS＝後台三班帳務分析表的「PSD 含代銷隨取」（＝日結單 111 本日實際銷貨收入）。
// 實測（2026-10-11，美德 7/8/9 月每日加總 ÷ 損益表營業淨額）：0.9795／0.9749／0.9792 → 0.978。
// 營業淨額並不是「PSD 未稅」（原本假設 ×1.05 會高估約 7%）。
// 差 2% 的來源（美德 9 月損益表營業收入明細）：營業淨額 ≈ PSD − 營業稅（內含稅，約 4.4%）＋ 代收售／受託代銷手續費（約 6.4%）。
// 比例會隨代收量變動 → 每店每月自動校正（lbPdsRatio），還沒有完整月份的店才用這個預設值。
var LB_PDS_RATIO = 0.978;
var LB_PDS_MONTHS = 3;     // 用最近 3 個完整月份（金額加權）
var LB_PDS_DRIFT = 0.03;   // 最新一個月跟前幾個月差超過 3% → 儀表板提醒（扣掉大單後正常月份仍會差到 ±1.5%，1% 會一直響；漏打一位數、少輸入幾天都會超過 3%）
// 大單日：客單 > 期間客單中位數 × 1.35（2026-10-11 美德 15 個月實測）。偶爾有幾天客單 150～260 的大單，
// 多出的金額幾乎不會反映在損益表營業淨額 → 比例會跳到 1.05～1.09；扣掉後只剩 0.968～1.013。
// 使用者不知道大單是什麼，所以只按資料處理：校正、業績進度都扣掉「比平常多出的金額」。
// ⚠️ 只對「大單不進損益表」的店扣（lbBigOn 每店自動判斷）：聯鑫週日大單有進損益表，不扣。
var LB_BIG_TICKET = 1.35;
var LB_OFF = ['排休', '指休', '特休', '補休', '清空', ''];

function lbYm(y, m) { return y + '-' + String(m).padStart(2, '0'); }
function lbAddMonth(ym, k) {
  var y = +ym.slice(0, 4), m = +ym.slice(5, 7) - 1 + k;
  return lbYm(y + Math.floor(m / 12), ((m % 12) + 12) % 12 + 1);
}
function lbDaysIn(ym) { return new Date(+ym.slice(0, 4), +ym.slice(5, 7), 0).getDate(); }

function lbFit(xs, ys) {
  var n = xs.length, mx = 0, my = 0, sxy = 0, sxx = 0;
  for (var i = 0; i < n; i++) { mx += xs[i] / n; my += ys[i] / n; }
  for (var j = 0; j < n; j++) { sxy += (xs[j] - mx) * (ys[j] - my); sxx += (xs[j] - mx) * (xs[j] - mx); }
  if (!sxx) return null;
  var b = sxy / sxx;
  return { a: my - b * mx, b: b };
}

/** 工讀平均時薪（在職、有填時薪）；沒有就回 null */
function lbPartTimeWage(employees, burden) {
  var ws = (employees || []).filter(function (e) {
    return e && !['離職', '調走'].includes(e.status) && (e.payAsPartTime || String(e.role || '').includes('工讀')) && +e.wage > 0;
  }).map(function (e) { return +e.wage; });
  // 要加上公司負擔（勞保、健保、勞退）（2026-10-11 使用者確認修正）。只影響「比近 3 月多／少的人事」換算成的時數，
  // 10 月實際差：美德 −17h、聯鑫 −6h、錦花 +19h（人事上限低於近 3 月時，貴的時薪換算出的減少時數變少）
  return ws.length ? ws.reduce(function (s, x) { return s + x; }, 0) / ws.length * (1 + (burden != null ? burden : LB_PT_BURDEN)) : null;
}

/**
 * @param pnl  { 'YYYY-MM': pnl doc }
 * @param perf { 'YYYY-MM': perfSnapshot doc }
 * @param opts { ptWage, other（每月其他固定支出）, ownerPct（加盟主要留的經營報酬比例，0.05＝5%）}
 * @returns 模型，或 { err: '原因' }
 */
function lbBuildModel(pnl, perf, opts) {
  opts = opts || {};
  var ms = Object.keys(pnl || {}).filter(function (m) {
    var p = pnl[m]; return p && +p.netSales > 0 && p.operatingReward != null && p.operatingReward !== '';
  }).sort();
  if (ms.length < LB_MIN_MONTHS) return { err: '損益資料不足 ' + LB_MIN_MONTHS + ' 個月' };
  var xs = [], ys = [], invSum = 0;
  ms.forEach(function (m) {
    var p = pnl[m], inv = +p.invResult || 0;
    invSum += inv;
    xs.push(+p.netSales);
    ys.push(+p.operatingReward - inv + (+p.elecCost || 0));
  });
  var f = lbFit(xs, ys);
  if (!f || !(f.b > 0)) return { err: '損益資料波動太小，算不出關係' };
  var pm = Object.keys(perf || {}).filter(function (m) {
    return !LB_PERF_EXCLUDE[m] && perf[m] && +perf[m].totalHours > 0 && +perf[m].laborCost > 0;
  }).sort().slice(-3);
  if (!pm.length) return { err: '還沒有人事成本資料' };
  var H0 = 0, L0 = 0;
  pm.forEach(function (m) { H0 += +perf[m].totalHours / pm.length; L0 += +perf[m].laborCost / pm.length; });
  var w = +opts.ptWage > 0 ? +opts.ptWage : L0 / H0; // 沒有工讀時薪就退回平均時薪
  return { a: f.a, b: f.b, invAvg: invSum / ms.length, months: ms, pnl: pnl, H0: H0, L0: L0, perfMonths: pm, w: w, other: +opts.other || 0, ownerPct: +opts.ownerPct || 0 };
}

/** 某月的預估：營收、人事預算、時數上限（含 ±誤差範圍）、兩平營收 */
function lbPlan(model, ym, live) {
  if (!model || model.err) return null;
  var prev = model.months.filter(function (m) { return m < ym; }).slice(-3);
  if (!prev.length) return null;
  var sales = prev.reduce(function (s, m) { return s + +model.pnl[m].netSales; }, 0) / prev.length;
  // 月中有實際業績（lbLiveSales）→ 改用本月實際推估的營業淨額（雙向：業績好上限放寬、差就收緊，使用者 2026-10-11 選）
  var err = LB_SALES_ERR;
  if (live) { sales = live.sales; err = LB_SALES_ERR_LIVE; }
  var ly = model.pnl[lbAddMonth(ym, -12)];
  var elec = ly && +ly.elecCost > 0 ? +ly.elecCost
    : model.months.reduce(function (s, m) { return s + (+model.pnl[m].elecCost || 0); }, 0) / model.months.length;
  // 加盟主先留 ownerPct（可分配的經營報酬 × 比例），剩下才是人事預算（使用者 2026-10-11：上限要讓加盟主有賺，不是打平）
  var poolAt = function (S) { return (model.a + model.b * S - elec + model.invAvg) * (1 - LB_TAX); };
  var budgetAt = function (S) { return poolAt(S) * (1 - model.ownerPct) - model.other; };
  var capAt = function (S) { return model.H0 + (budgetAt(S) - model.L0) / model.w; };
  return {
    ym: ym, salesFrom: prev, live: live || null, sales: sales, elec: elec, ownerTake: poolAt(sales) * model.ownerPct,
    budget: budgetAt(sales),
    cap: capAt(sales), capLo: capAt(sales * (1 - err)), capHi: capAt(sales * (1 + err)),
    beSales: ((model.L0 + model.other) / (1 - LB_TAX) - model.a + elec - model.invAvg) / model.b,
    // 人事為 L、加盟主留 pct 時，營業淨額要做到多少（budgetAt 的反函式）
    salesFor: function (L, pct) { return ((L + model.other) / ((1 - LB_TAX) * (1 - (pct || 0))) - model.a + elec - model.invAvg) / model.b; }
  };
}

/** 'YYYY-Www' ＋ '週一'… → 'YYYY-MM-DD'（ISO 週，週一為一週開始） */
function lbRecDate(week, day) {
  var di = ['週一', '週二', '週三', '週四', '週五', '週六', '週日'].indexOf(day);
  var m = /^(\d{4})-W(\d{1,2})$/.exec(week || '');
  if (di < 0 || !m) return null;
  var y = +m[1], jan4 = new Date(y, 0, 4), dw = jan4.getDay() || 7;
  var d = new Date(y, 0, 4 - dw + 1 + (+m[2] - 1) * 7 + di);
  return lbYm(d.getFullYear(), d.getMonth() + 1) + '-' + String(d.getDate()).padStart(2, '0');
}

/**
 * 本店該月已排時數（口徑同 functions computeMonthSnapshots：本店的班＋🆘 列；外派別店的不算）
 * ⚠️ 🆘待補（還沒人認領）也算：那是確定要有人上的班。
 * ⚠️「排到哪天」只算排得像樣的日子（當天時數 ≥ 平常一天的 4 成）：下週通常只有零星幾格預排，
 *    若拿最後一格的日期當進度，按比例的上限會被拉高、燈號誤判成綠燈（2026-10-11 美德實例）。
 * @param records 本店各週 records，每筆要有 week
 * @param dayAvg  平常一天的時數（近 3 月實際時數 ÷ 30）；沒給就不篩
 * @returns { hours（只含排得像樣的日子）, lastDate（排到哪天，'YYYY-MM-DD' 或 null）, days（像樣的天數） }
 */
function lbScheduledHours(records, ym, dayAvg) {
  var byDay = {};
  (records || []).forEach(function (r) {
    if (!r || r.name === '門市備註' || LB_OFF.includes(String(r.shift || '').trim())) return;
    var loc = r.location || '';
    if (loc && loc !== '本店') return;
    var dt = lbRecDate(r.week, r.day);
    if (!dt || dt.slice(0, 7) !== ym) return;
    var h = parseFloat(r.actualHours || 0);
    if (h > 0) byDay[dt] = (byDay[dt] || 0) + h;
  });
  var hours = 0, last = null, days = 0, th = dayAvg > 0 ? dayAvg * 0.4 : 0;
  Object.keys(byDay).forEach(function (dt) {
    if (byDay[dt] < th) return;
    hours += byDay[dt]; days++;
    if (!last || dt > last) last = dt;
  });
  return { hours: hours, lastDate: last, days: days };
}

/** 自動排班設定的最低人數 → 該月最低需要時數；沒設定回 null */
function lbMinHours(asCfg, ym) {
  if (!asCfg || !asCfg.demand || typeof asDemandSlots !== 'function') return null;
  var names = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];
  var perDay = {}, any = false;
  names.forEach(function (d) {
    var mn = asDemandSlots(asCfg.demand[d] || []).min;
    perDay[d] = mn.reduce(function (s, x) { return s + x; }, 0) * 0.5;
    if (perDay[d] > 0) any = true;
  });
  if (!any) return null;
  var y = +ym.slice(0, 4), mo = +ym.slice(5, 7) - 1, tot = 0;
  for (var day = 1; day <= lbDaysIn(ym); day++) tot += perDay[names[new Date(y, mo, day).getDay()]];
  return tot;
}

/**
 * 燈號：已排時數跟「按已排天數比例攤的上限」比
 *   green＝低於範圍下緣、yellow＝在誤差範圍內、red＝超過範圍上緣
 */
function lbLight(plan, sched, ym) {
  if (!plan || !sched || !sched.lastDate) return null;
  var frac = sched.days / lbDaysIn(ym);
  var lo = plan.capLo * frac, hi = plan.capHi * frac;
  var level = sched.hours > hi ? 'red' : sched.hours > lo ? 'yellow' : 'green';
  return { level: level, frac: frac, loP: lo, hiP: hi, capP: plan.cap * frac };
}

/** config/laborBudget.ownerPct 存的是百分比數字（5＝5%），沒設定＝0（打平） */
function lbOwnerPct(c) { var v = +(c && c.ownerPct); return v > 0 && v < 100 ? v / 100 : 0; }

/**
 * 找出大單日。days：{ 'YYYY-MM-DD': {sales, customers} }（傳整段當基準，至少 7 天有來客才判斷）
 * @returns { base（平常日均營業額）, big: { date: { excess（比平常多出的金額）, ticket } } }
 */
function lbBigDays(days, on) {
  if (on === false) return { base: null, big: {} }; // 這家店不扣大單（lbPdsRatio 的 bigOn）
  var ds = Object.keys(days || {}).filter(function (d) { var x = days[d]; return x && x.sales != null && +x.customers > 0; });
  if (ds.length < 7) return { base: null, big: {} };
  var tk = ds.map(function (d) { return +days[d].sales / +days[d].customers; }).sort(function (a, b) { return a - b; });
  var k = tk.length >> 1, med = tk.length % 2 ? tk[k] : (tk[k - 1] + tk[k]) / 2;
  var bigD = ds.filter(function (d) { return +days[d].sales / +days[d].customers > med * LB_BIG_TICKET; });
  var normal = ds.filter(function (d) { return bigD.indexOf(d) < 0; });
  var base = normal.reduce(function (t, d) { return t + +days[d].sales; }, 0) / normal.length;
  var big = {};
  bigD.forEach(function (d) { var ex = +days[d].sales - base; if (ex > 0) big[d] = { excess: ex, ticket: +days[d].sales / +days[d].customers }; });
  return { base: base, big: big };
}

/**
 * PDS 換算比例（每日營業額加總 ÷ 損益表營業淨額），每月自動校正（使用者 2026-10-11）
 * 每日加總先扣掉大單多出的金額（lbBigDays）。
 * 完整月＝那個月每天都有輸入 dailySales.sales，而且損益表 netSales 已輸入。
 * @param daily { 'YYYY-MM-DD': dailySales 文件 }
 * @returns { ratio, auto（是否實測）, months:[{ym,psd,net,r}], drift（最新月偏離 >1% 時 {ym,r,prev}） }
 */
function lbPdsRatio(daily, pnl) {
  var byM = {};
  Object.keys(daily || {}).forEach(function (d) {
    var x = daily[d]; if (!x || x.sales == null || x.sales === '') return;
    var b = byM[d.slice(0, 7)] = byM[d.slice(0, 7)] || { s: 0, n: 0, days: {} };
    b.s += +x.sales; b.n++; b.days[d] = x;
  });
  Object.keys(byM).forEach(function (m) {
    var bg = lbBigDays(byM[m].days).big, ex = 0;
    Object.keys(bg).forEach(function (d) { ex += bg[d].excess; });
    byM[m].big = ex;
  });
  var full = Object.keys(byM).filter(function (m) { return byM[m].n >= lbDaysIn(m) && pnl && pnl[m] && +pnl[m].netSales > 0; }).sort();
  var bigOn = lbBigOn(full.map(function (m) { return { s: byM[m].s, big: byM[m].big, net: +pnl[m].netSales }; }));
  var months = full.slice(-LB_PDS_MONTHS).map(function (m) { var ps = byM[m].s - (bigOn ? byM[m].big : 0); return { ym: m, psd: ps, big: bigOn ? byM[m].big : 0, net: +pnl[m].netSales, r: ps / +pnl[m].netSales }; });
  if (!months.length) return { ratio: LB_PDS_RATIO, auto: false, months: [], drift: null, bigOn: bigOn };
  var sum = function (a, k) { return a.reduce(function (t, x) { return t + x[k]; }, 0); };
  var drift = null;
  if (months.length >= 2) {
    var last = months[months.length - 1], prev = months.slice(0, -1), pr = sum(prev, 'psd') / sum(prev, 'net');
    if (Math.abs(last.r - pr) > LB_PDS_DRIFT) drift = { ym: last.ym, r: last.r, prev: pr };
  }
  // 偏掉的那個月先不算進比例（多半是某天營業額打錯，一天多打一位數就會把比例拉到 1.09）；改正後自動恢復
  var use = drift ? months.slice(0, -1) : months;
  return { ratio: sum(use, 'psd') / sum(use, 'net'), auto: true, months: use, drift: drift, bigOn: bigOn };
}
/**
 * 這家店要不要扣大單（2026-10-15）：看「扣」跟「不扣」哪一種的每月比例（PSD ÷ 營業淨額）比較穩。
 * 美德的大單幾乎不進損益表（扣了比較穩）；聯鑫週日 30～55 萬的大單約 107% 進損益表，
 * 扣了反而讓比例在 0.89～1.11 亂跳（不扣 1.045～1.081）。完整月份不到 4 個照舊扣。
 * @param ms [{ s（月營業額）, big（大單多出）, net }]
 */
function lbBigOn(ms) {
  if (ms.length < 4) return true;
  var sd = function (f) {
    var r = ms.map(f), m = r.reduce(function (a, b) { return a + b; }, 0) / r.length;
    return Math.sqrt(r.reduce(function (t, x) { return t + (x - m) * (x - m); }, 0) / r.length) / m;
  };
  return sd(function (x) { return (x.s - x.big) / x.net; }) <= sd(function (x) { return x.s / x.net; });
}
/**
 * 本月實際業績推估整月營業淨額：（已輸入天數的營業額，扣大單）÷ 天數 × 整月天數 ÷ 換算比例
 * 輸入不滿 LB_LIVE_MIN_DAYS 天回 null（照舊用近 3 月平均）。
 */
function lbLiveSales(daily, ym, ratio, bigOn) {
  var prevYm = lbAddMonth(ym, -1), win = {}, ds = [];
  Object.keys(daily || {}).forEach(function (d) {
    var m = d.slice(0, 7); if (m !== ym && m !== prevYm) return;
    win[d] = daily[d];
    if (m === ym && daily[d] && daily[d].sales != null && daily[d].sales !== '') ds.push(d);
  });
  if (ds.length < LB_LIVE_MIN_DAYS || !(ratio > 0)) return null;
  var big = lbBigDays(win, bigOn).big, cum = 0;
  ds.forEach(function (d) { cum += +daily[d].sales - (big[d] ? big[d].excess : 0); });
  var n = lbDaysIn(ym);
  return { days: ds.length, n: n, last: ds.sort()[ds.length - 1], psd: cum, sales: cum / ds.length * n / ratio };
}

/**
 * 本店工讀的公司負擔比例：近 3 個月薪資記錄（stores/{店}/salary/{YYYY-MM}）中 role＝工讀 的
 * Σ(laborEr＋healthEr＋pensionEr) ÷ Σ(時薪×時數)。讀不到或時數太少回 null（用 LB_PT_BURDEN）。
 */
function lbPtBurden(db, store) {
  var d = new Date(), ref = db.collection('stores').doc(store).collection('salary'), yms = [];
  for (var k = 1; k <= 3; k++) { var x = new Date(d.getFullYear(), d.getMonth() - k, 1); yms.push(lbYm(x.getFullYear(), x.getMonth() + 1)); }
  return Promise.all(yms.map(function (ym) { return ref.doc(ym).get().catch(function () { return null; }); })).then(function (snaps) {
    var er = 0, base = 0;
    snaps.forEach(function (sn) {
      if (!sn || !sn.exists) return;
      (sn.data().records || []).forEach(function (r) {
        if (!r || r.role !== '工讀' || !(+r.hours > 0) || !(+r.wage > 0)) return;
        er += (+r.laborEr || 0) + (+r.healthEr || 0) + (+r.pensionEr || 0); base += +r.wage * +r.hours;
      });
    });
    return base >= 20000 ? er / base : null; // 至少約 100 小時才算數
  });
}

/** 讀最近 6 個月的每日營業（夠找出 3 個完整月；損益表晚一個月才輸入） */
function lbLoadDaily(db, store) {
  var d = new Date(), from = new Date(d.getFullYear(), d.getMonth() - 6, 1);
  var id = lbYm(from.getFullYear(), from.getMonth() + 1) + '-01';
  return db.collection('stores').doc(store).collection('dailySales')
    .where(firebase.firestore.FieldPath.documentId(), '>=', id).get()
    .then(function (snap) { var o = {}; snap.forEach(function (x) { o[x.id] = x.data(); }); return o; })
    .catch(function () { return {}; });
}

/** 讀一家店算燈號需要的資料（employees 已有就傳進來省一次讀取） */
function lbLoadStore(db, store, employees) {
  var ref = db.collection('stores').doc(store);
  var toMap = function (snap) { var o = {}; if (snap) snap.forEach(function (d) { o[d.id] = d.data(); }); return o; };
  return Promise.all([
    ref.collection('pnl').get().catch(function () { return null; }),
    ref.collection('perfSnapshot').get().catch(function () { return null; }),
    ref.collection('config').doc('autoSchedule').get().catch(function () { return null; }),
    ref.collection('config').doc('laborBudget').get().catch(function () { return null; }),
    employees ? Promise.resolve(null) : ref.collection('employees').get().catch(function () { return null; }),
    lbLoadDaily(db, store),
    lbPtBurden(db, store)
  ]).then(function (r) {
    var emps = employees || [];
    if (r[4]) r[4].forEach(function (d) { emps.push(Object.assign({ name: d.id }, d.data())); });
    var lbc = r[3] && r[3].exists ? r[3].data() : {};
    var pnl = toMap(r[0]);
    var model = lbBuildModel(pnl, toMap(r[1]), { ptWage: lbPartTimeWage(emps, r[6]), other: +lbc.otherMonthly || 0, ownerPct: lbOwnerPct(lbc) });
    return { store: store, model: model, pds: lbPdsRatio(r[5], pnl), daily: r[5], burden: r[6], asCfg: r[2] && r[2].exists ? r[2].data() : null, otherMonthly: +lbc.otherMonthly || 0, ownerPct: lbOwnerPct(lbc) };
  });
}

/**
 * 照目前排法推估整月人事成本：已排時數按已排天數放大成整月 → 近 3 月實際人事 ＋ 時數差 × 工讀時薪
 * （同上限的換算方式，兩個金額才能直接比）
 */
function lbProjectedCost(model, sched, ym) {
  if (!model || model.err || !sched || !sched.days) return null;
  var full = sched.hours * lbDaysIn(ym) / sched.days;
  return model.L0 + (full - model.H0) * model.w;
}

/** 一家店某月的完整結果（排班頁、儀表板都用這個） */
function lbEvaluate(loaded, records, ym) {
  var R0 = loaded.pds ? loaded.pds.ratio : LB_PDS_RATIO;
  var plan = lbPlan(loaded.model, ym, loaded.daily ? lbLiveSales(loaded.daily, ym, R0, loaded.pds ? loaded.pds.bigOn : true) : null);
  var m = loaded.model, sched = lbScheduledHours(records, ym, m && !m.err ? m.H0 / 30 : 0);
  var proj = lbProjectedCost(m, sched, ym), days = lbDaysIn(ym);
  var R = loaded.pds ? loaded.pds.ratio : LB_PDS_RATIO;
  var pds = function (S) { return S / days * R; };
  return {
    ym: ym, plan: plan, sched: sched, light: lbLight(plan, sched, ym), minH: lbMinHours(loaded.asCfg, ym), projCost: proj,
    // 兩平 PDS：近 3 月人事、不留加盟主比例；達標 PDS：照目前排法的人事、扣掉加盟主比例（還沒排班就用近 3 月人事）
    bePds: plan ? pds(plan.beSales) : null,
    targetPds: plan ? pds(plan.salesFor(proj != null ? proj : m.L0, m.ownerPct)) : null,
    // 照目前排法的兩平（目標利潤率 0%）：首頁看板三段色用，跟達標同一個人事口徑（bePds 用的是近 3 月人事）
    beSchedPds: plan ? pds(plan.salesFor(proj != null ? proj : m.L0, 0)) : null,
    salesPds: plan ? pds(plan.sales) : null,
    pdsInfo: loaded.pds || { ratio: LB_PDS_RATIO, auto: false, months: [], drift: null },
    err: loaded.model.err || (plan ? '' : '資料不足')
  };
}

var LB_COLORS = { green: ['#e6f4ea', '#137333', '🟢'], yellow: ['#fef7e0', '#a15c00', '🟡'], red: ['#fce8e6', '#c5221f', '🔴'] };
