// ===== salary.js（2026-10-16 從 index.js 拆出來；程式原文照搬、只加 require／exports 接線）=====
// 拆法：只有這個功能用到的放這裡，兩個以上功能用到的放 common.js。新增共用小函式請放 common.js。
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { onDocumentWritten, onDocumentCreated, onDocumentWrittenWithAuthContext } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { LINE_TOKEN, VAPID_PRIVATE, WEEK_DAYS, deliverToPeople, fixStoreName, getAllStores, monthWorkedByEmp, notifyEmployees, notifyOneEmp, notifyStoreManagers, taipeiYM, weekMondayDate, weekStrOfTp } = require("./common");
// 薪資可見性規則（同 my-salary.html）：M 月薪資要 M+1 月才可查看 → 即 month < 當前月
function salaryViewable(month) {
  return String(month) < taipeiYM(); // "YYYY-MM" 字串可直接比較
}
// 推薪資發布通知：薪資記錄員工欄位是 empName（buildDefaultRecord），對應 lineBindings.empName
async function notifySalary(db, store, data, month, token) {
  const empNames = (data.records || []).map((r) => r.empName);
  await notifyEmployees(
    db, empNames, store,
    (name) => `💰 ${name}，你的 ${month} 薪資已發布，可到 App 查看並簽收囉。`,
    token,
    { push: (name) => ({ title: `💰 ${month} 薪資已發布`, body: `${name}，點這裡查看並簽收`, url: `my-salary.html?month=${month}`, tag: `salary-${month}` }) }
  );
}

// 薪資發布 → 通知該月有記錄的員工（但需已到「可查看月份」才即時通知；
// 若在可查看月份前就發布，改由 scheduledMonthlySalaryNotify 於次月1號補發）
exports.onSalaryPublished = onDocumentWritten(
  { document: "stores/{store}/salary/{month}", region: "asia-east1", secrets: [LINE_TOKEN, VAPID_PRIVATE] },
  async (event) => {
    const before = event.data.before.exists ? event.data.before.data() : {};
    const after = event.data.after.exists ? event.data.after.data() : {};
    if (before.status === "published" || after.status !== "published") return; // 只在「變成 published」
    const month = event.params.month;
    if (!salaryViewable(month)) return; // 尚未到可查看月份 → 不即時通知（次月排程補發）
    const db = getFirestore();
    await notifySalary(db, fixStoreName(event.params.store), after, month, { line: LINE_TOKEN.value(), vapid: VAPID_PRIVATE.value() });
  }
);

// 找可審核者（加盟主/admin）的 LINE 綁定並推播
async function notifyApprovers(db, text, token, opts) {
  const uids = new Set();
  for (const p of ["owner", "admin"]) {
    const us = await db.collection("users").where("permission", "==", p).get().catch(() => null);
    if (us) us.forEach((d) => uids.add(d.id));
  }
  return deliverToPeople(db, [...uids].map((uid) => ({ uid })), text, token, opts);
}

// 店長送出薪資（status→submitted）→ 通知加盟主審核
exports.onSalarySubmitted = onDocumentWritten(
  { document: "stores/{store}/salary/{month}", region: "asia-east1", secrets: [LINE_TOKEN, VAPID_PRIVATE] },
  async (event) => {
    const before = event.data.before.exists ? event.data.before.data() : {};
    const after = event.data.after.exists ? event.data.after.data() : {};
    if (before.status === "submitted" || after.status !== "submitted") return; // 只在「剛送審」
    const store = fixStoreName(event.params.store);
    const month = event.params.month;
    const by = after.submittedBy || "店長";
    const db = getFirestore();
    await notifyApprovers(
      db,
      `📤 ${store} ${month} 薪資已由 ${by} 送出，請至 App 審核後發布。`,
      { line: LINE_TOKEN.value(), vapid: VAPID_PRIVATE.value() },
      { push: { title: `📤 ${store} ${month} 薪資待審核`, body: `${by} 已送出，請審核後發布`, url: "salary.html", tag: `salary-review-${store}-${month}` } }
    );
  }
);

// 加盟主退回薪資（submitted→draft 且 rejectedAt 為本次新設）→ 通知該店店長重新送審
// （與店長自己「收回」區分：收回不會動 rejectedAt）
exports.onSalaryRejected = onDocumentWritten(
  { document: "stores/{store}/salary/{month}", region: "asia-east1", secrets: [LINE_TOKEN, VAPID_PRIVATE] },
  async (event) => {
    const before = event.data.before.exists ? event.data.before.data() : {};
    const after = event.data.after.exists ? event.data.after.data() : {};
    if (!(before.status === "submitted" && after.status === "draft")) return;
    if (!after.rejectedAt || after.rejectedAt === before.rejectedAt) return; // 排除店長自己收回
    const store = fixStoreName(event.params.store);
    const month = event.params.month;
    const by = after.rejectedBy || "加盟主";
    const db = getFirestore();
    await notifyStoreManagers(
      db, store,
      `↩️ ${store} ${month} 薪資已被 ${by} 退回，請至 App 修改後重新送審。`,
      { line: LINE_TOKEN.value(), vapid: VAPID_PRIVATE.value() },
      { push: { title: `↩️ ${store} ${month} 薪資被退回`, body: `${by} 退回了，請修改後重新送審`, url: "salary.html", tag: `salary-review-${store}-${month}` } }
    );
  }
);

// ===== 月度聚合 doc（優先3/模組F）=====
// 薪資發布時寫入 stores/{store}/monthly/{ym} 快照，供加盟主儀表板快速讀取（免每次掃全 weeks+salary）。
// 守鐵則：以「已發布薪資快照」聚合；已發布月份鎖定不再變動。
// 計算並寫入某店某月的 monthly 聚合(供 onSalaryAggregate 觸發 & backfill 共用)
async function computeMonthlyAggregate(db, store, ym, salaryData) {
  const num = (v) => { const x = parseFloat(v); return isNaN(x) ? 0 : x; };
  let totalGross = 0, totalDeduct = 0, totalEr = 0;
  const head = { full: 0, part: 0, manager: 0 };
  for (const r of (salaryData.records || [])) {
    totalGross += num(r.grossAmt);
    totalDeduct += num(r.deductAmt);
    totalEr += num(r.laborEr) + num(r.healthEr) + num(r.pensionEr);
    const role = r.payAsPartTime ? "工讀" : (r.role || "");
    if (role === "工讀") head.part++;
    else if (role === "店長") head.manager++;
    else head.full++;
  }
  const worked = await monthWorkedByEmp(db, store, ym);
  let totalHours = 0, otHours = 0;
  for (const e in worked) { totalHours += worked[e].hours; otHours += worked[e].ot; }
  const doc = {
    store, month: ym,
    totalGross: Math.round(totalGross), totalDeduct: Math.round(totalDeduct),
    totalEr: Math.round(totalEr), totalCost: Math.round(totalGross + totalEr),
    totalHours: Math.round(totalHours * 10) / 10, otHours: Math.round(otHours * 10) / 10,
    costPerHour: totalHours > 0 ? Math.round((totalGross + totalEr) / totalHours) : 0,
    otRatio: totalHours > 0 ? Math.round(otHours / totalHours * 1000) / 10 : 0, // %
    headcount: head, source: "published", updatedAt: new Date().toISOString(),
  };
  await db.collection("stores").doc(store).collection("monthly").doc(ym).set(doc);
  return doc;
}

exports.onSalaryAggregate = onDocumentWritten(
  { document: "stores/{store}/salary/{month}", region: "asia-east1" },
  async (event) => {
    const before = event.data.before.exists ? event.data.before.data() : {};
    const after = event.data.after.exists ? event.data.after.data() : {};
    if (before.status === "published" || after.status !== "published") return; // 只在「剛發布」
    await computeMonthlyAggregate(getFirestore(), fixStoreName(event.params.store), event.params.month, after);
  }
);


// ✂️ scheduledLeaveReminder（劃休截止提醒）已整支移除（2026-09-07 用戶指示取消發送）。
//    原為每日 10:00 提醒「未劃休」者，屬善意提醒而非必要行動。
// ===== 班表自動發布（每週五 18:00 台北）：未手動發布者補通知 =====
// ✂️ scheduledAutoPublishNotify 已整支移除（2026-09-02 額度預算化）。
//    它是「店長沒手動發布時，週五 18:00 補推整週班表給全店」＝ onSchedulePublished 的排程版，
//    兩者一起砍。前端的 isAutoPublishedHome() 仍照舊把週五 18:00 後的下週視為已發布，
//    所以員工看得到班表這件事不受影響，只是不再用 LINE 通知。
//    ⚠️ deploy 時 Firebase 會問是否刪除這支雲端函式，答 yes。

// ===== 每月1號：補發「上個月薪資」通知（該月薪資此時起才可查看）=====
// 例：8/1 通知 7 月薪資（7 月發布但依規則 8 月才可看）。
exports.scheduledMonthlySalaryNotify = onSchedule(
  { schedule: "0 9 1 * *", timeZone: "Asia/Taipei", region: "asia-east1", secrets: [LINE_TOKEN, VAPID_PRIVATE] },
  async () => {
    const db = getFirestore();
    const token = { line: LINE_TOKEN.value(), vapid: VAPID_PRIVATE.value() };
    // 剛變成可查看的月份＝上個曆月（台北）
    const now = new Date(Date.now() + 8 * 3600000);
    const py = now.getUTCMonth() === 0 ? now.getUTCFullYear() - 1 : now.getUTCFullYear();
    const pm = now.getUTCMonth() === 0 ? 12 : now.getUTCMonth();
    const prevMonth = `${py}-${String(pm).padStart(2, "0")}`;
    const stores = await getAllStores(db);
    for (const store of stores) {
      const snap = await db.collection("stores").doc(store).collection("salary").doc(prevMonth).get();
      if (!snap.exists || (snap.data().status || "draft") !== "published") continue;
      await notifySalary(db, store, snap.data(), prevMonth, token);
    }
  }
);

// 通知「店長以上」(manager/owner/admin) 有綁定 LINE 者
async function notifyManagersAndAbove(db, text, token, opts) {
  const uids = new Set();
  for (const p of ["manager", "owner", "admin"]) {
    const us = await db.collection("users").where("permission", "==", p).get().catch(() => null);
    if (us) us.forEach((d) => uids.add(d.id));
  }
  return deliverToPeople(db, [...uids].map((uid) => ({ uid })), text, token, opts);
}

// ===== 月底提醒（每月最後一天 09:00）：LINE 通知店長以上「結帳/匯款時間、週轉金上限」=====
// ✂️ scheduledMonthEndReminder 已整支移除（2026-09-02 額度預算化）。
//    月底結帳是每月同一天的固定常規、不是例外事件，不值得單獨占一則；
//    已改成 scheduledManagerDigest 在該月最後一天的其中一個區塊。
//    ⚠️ deploy 時 Firebase 會問是否刪除這支雲端函式，答 yes。

// ===== 經營績效專區：完成即通知全體 + 每日提醒未輸入者 =====
function pnlMoney(n){ return Math.round(n || 0).toLocaleString("en-US"); }
function pnlPrevYM(month){ const [y, m] = month.split("-"); return `${parseInt(y) - 1}-${m}`; }
function pnlSig(d){
  if(!d) return "";
  return [d.netSales, d.badGoodsCost, d.invResult, d.noStocktake ? 1 : 0, d.grossMargin, d.elecCost, d.miscCost, d.cashDiff, d.operatingReward]
    .map(v => (v == null ? "" : v)).join("|");
}
function pnlInvLabel(d){
  if(!d || d.noStocktake || d.invResult == null) return "本月無盤點";
  if(d.invResult < 0) return `盤損 ${pnlMoney(-d.invResult)}元`;
  if(d.invResult > 0) return `盤盈 ${pnlMoney(d.invResult)}元`;
  return "0 元";
}
function buildPnlText(store, month, cur, prev){
  const [yr, mm] = month.split("-");
  const L = [`📊 ${store} ${yr}年${parseInt(mm)}月 經營績效`, ""];
  const upDown = (c, p, unit, goodUp, fmt) => {
    if(!prev || p == null) return "（同期無資料）";
    const d = c - p, abs = fmt(Math.abs(d));
    const better = goodUp ? d >= 0 : d <= 0;
    const word = goodUp ? (d >= 0 ? "成長" : "衰退") : (d <= 0 ? "減少" : "增加");
    return `（較同期${word} ${better ? "✅" : "❌"} ${abs}${unit}）`;
  };
  L.push(`營業淨額 ${pnlMoney(cur.netSales)}`, upDown(cur.netSales, prev && prev.netSales, "元", true, pnlMoney), "");
  L.push(`壞品 ${pnlMoney(cur.badGoodsCost)}元`, upDown(cur.badGoodsCost, prev && prev.badGoodsCost, "元", false, pnlMoney), "");
  let invCmp;
  if(!prev || prev.noStocktake || prev.invResult == null) invCmp = "（同期無盤點）";
  else if(cur.noStocktake || cur.invResult == null) invCmp = "（本月無盤點）";
  else invCmp = upDown(cur.invResult, prev.invResult, "元", true, pnlMoney);
  L.push(pnlInvLabel(cur), invCmp, "");
  L.push(`毛利 ${cur.grossMargin}%`, upDown(cur.grossMargin, prev && prev.grossMargin, "%", true, v => v.toFixed(2)), "");
  L.push(`門市電費 ${pnlMoney(cur.elecCost)}元`, upDown(cur.elecCost, prev && prev.elecCost, "元", false, pnlMoney), "");
  L.push(`雜支 ${pnlMoney(cur.miscCost)}元`, upDown(cur.miscCost, prev && prev.miscCost, "元", false, pnlMoney), "");
  const cashLabel = `現金短少 ${pnlMoney(cur.cashDiff)}元${cur.cashDiff > 0 ? "（短少）" : cur.cashDiff < 0 ? "（溢餘）" : ""}`;
  let cashCmp;
  if(!prev || prev.cashDiff == null) cashCmp = "（同期無資料）";
  else { const d = cur.cashDiff - prev.cashDiff; cashCmp = `（較同期${d >= 0 ? "增加" : "減少"} ${pnlMoney(Math.abs(d))}元）`; }
  L.push(cashLabel, cashCmp, "");
  L.push(`經營報酬 ${pnlMoney(cur.operatingReward)}元`, upDown(cur.operatingReward, prev && prev.operatingReward, "元", true, pnlMoney));
  return L.join("\n");
}
// ✂️ notifyStoreScopedManagers 已移除：唯一的呼叫者 scheduledPnlReminder 已併入每日摘要。

// 店長輸入/更新某月損益 → 與去年同期比較 → LINE 給全體店長+加盟主
exports.onPnlSubmitted = onDocumentWritten(
  { document: "stores/{store}/pnl/{month}", region: "asia-east1", secrets: [LINE_TOKEN, VAPID_PRIVATE] },
  async (event) => {
    const before = event.data.before.exists ? event.data.before.data() : null;
    const after = event.data.after.exists ? event.data.after.data() : null;
    if(!after) return; // 刪除不通知
    if([after.netSales, after.badGoodsCost, after.grossMargin, after.elecCost, after.miscCost, after.cashDiff, after.operatingReward].some(v => v == null)) return; // 必填不齊(含新欄位) → 不發；舊月份補填後才會通知
    if(pnlSig(before) === pnlSig(after)) return; // 內容沒變(只動 submittedAt 等) → 不重複發
    const store = fixStoreName(event.params.store);
    const month = event.params.month;
    const db = getFirestore();
    const ps = await db.collection("stores").doc(store).collection("pnl").doc(pnlPrevYM(month)).get().catch(() => null);
    if(!ps || !ps.exists) return; // 無去年同期資料(回填月份) → 不發送
    await notifyManagersAndAbove(db, buildPnlText(store, month, after, ps.data()), { line: LINE_TOKEN.value(), vapid: VAPID_PRIVATE.value() },
      { url: "performance.html", tag: `pnl-${store}-${month}` });
  }
);

// ===== 經營績效月快照：某月薪資發布 → 重算該月「全門市」perfSnapshot（含支援成本/工時）=====
async function computeMonthSnapshots(db, month) {
  const [y, mo] = month.split("-").map(Number);
  const lastDay = new Date(y, mo, 0).getDate();
  const weekSet = new Set();
  for (let d = 1; d <= lastDay; d++) weekSet.add(weekStrOfTp(new Date(Date.UTC(y, mo - 1, d))));
  const stores = await getAllStores(db);
  const OFF = ["排休", "指休", "特休", "補休", "清空", ""];
  const rate = {}, ownPay = {};
  for (const s of stores) {
    rate[s] = {};
    const es = await db.collection("stores").doc(s).collection("employees").get().catch(() => null);
    if (es) es.forEach((d) => { const o = d.data(); rate[s][d.id] = { role: o.role, wage: o.wage }; });
    const sd = await db.collection("stores").doc(s).collection("salary").doc(month).get().catch(() => null);
    if (sd && sd.exists && (sd.data().status || "draft") === "published") {
      let g = 0, er = 0;
      (sd.data().records || []).forEach((r) => {
        g += (r.grossAmt || 0); er += (r.laborEr || 0) + (r.healthEr || 0) + (r.pensionEr || 0);
        rate[s][r.empName] = rate[s][r.empName] || {}; rate[s][r.empName].role = r.role;
        if (/正職|店長|副店長|加盟主/.test(String(r.role || ""))) rate[s][r.empName].h = ((r.baseSalary || 0) + (r.fullAttendBonus || 0)) / 240;
      });
      ownPay[s] = g + er;
    }
  }
  const hourly = (s, p) => { const e = rate[s] && rate[s][p]; if (!e) return 0; if (e.h) return e.h; if (e.wage) return e.wage; return 0; };
  const ownH = {}, supIn = {}, supOut = {};
  stores.forEach((s) => { ownH[s] = 0; supIn[s] = { h: 0, c: 0 }; supOut[s] = { h: 0, c: 0 }; });
  for (const s of stores) {
    for (const w of weekSet) {
      const snap = await db.collection("stores").doc(s).collection("weeks").doc(w).get().catch(() => null);
      if (!snap || !snap.exists) continue;
      const mon = weekMondayDate(w);
      for (const r of (snap.data().records || [])) {
        if (!r || r.name === "門市備註" || !r.shift || OFF.includes(String(r.shift).trim())) continue;
        const di = WEEK_DAYS.indexOf(r.day); if (di < 0) continue;
        const dt = new Date(mon); dt.setDate(mon.getDate() + di);
        if (dt.getFullYear() !== y || dt.getMonth() + 1 !== mo) continue;
        const h = parseFloat(r.actualHours || 0);
        if (String(r.name || "").startsWith("🆘") && r.supportEmp) {
          const i = r.supportEmp.indexOf("-"); const home = r.supportEmp.slice(0, i), per = r.supportEmp.slice(i + 1);
          const c = hourly(home, per) * h; supIn[s].h += h; supIn[s].c += c;
          if (supOut[home]) { supOut[home].h += h; supOut[home].c += c; }
        } else if (!String(r.name || "").startsWith("🆘")) {
          const loc = r.location || ""; if (loc && loc !== "本店") continue;
          ownH[s] += h;
        }
      }
    }
  }
  for (const s of stores) {
    if (ownPay[s] == null) continue;
    const tot = ownH[s] + supIn[s].h; if (tot < 500) continue; // 殘月不寫
    const labor = ownPay[s] + supIn[s].c - supOut[s].c;
    await db.collection("stores").doc(s).collection("perfSnapshot").doc(month).set({
      store: s, month, totalHours: Math.round(tot), ownHours: Math.round(ownH[s]),
      supportInHours: Math.round(supIn[s].h), supportOutHours: Math.round(supOut[s].h),
      ownPayroll: Math.round(ownPay[s]), supportInCost: Math.round(supIn[s].c), supportOutCost: Math.round(supOut[s].c),
      laborCost: Math.round(labor), computedAt: new Date().toISOString(),
    }, { merge: true }).catch(() => {});
  }
}
exports.onSalaryPublishedSnapshot = onDocumentWritten(
  { document: "stores/{store}/salary/{month}", region: "asia-east1" },
  async (event) => {
    const before = event.data.before.exists ? event.data.before.data() : {};
    const after = event.data.after.exists ? event.data.after.data() : {};
    if (!(before.status !== "published" && after.status === "published")) return; // 只在「剛發布」
    await computeMonthSnapshots(getFirestore(), event.params.month);
  }
);

// 分享本月營運檢討：管理者按分享→LINE 通知各店店長＋加盟主，附 3 天有效連結(sharedReviews 前端已建)。
exports.shareMonthlyReview = onCall({ region: "asia-east1", secrets: [LINE_TOKEN, VAPID_PRIVATE] }, async (request) => {
  const auth = request.auth;
  if (!auth) throw new HttpsError("unauthenticated", "請先登入");
  const db = getFirestore();
  const uSnap = await db.collection("users").doc(auth.uid).get();
  const perm = uSnap.exists ? (uSnap.data().permission || "") : "";
  if (!["admin", "owner"].includes(perm)) throw new HttpsError("permission-denied", "僅加盟主／管理者可分享");
  const ym = String((request.data || {}).ym || "");
  const shareToken = String((request.data || {}).shareToken || "");
  if (!/^\d{4}-\d{2}$/.test(ym) || !shareToken) throw new HttpsError("invalid-argument", "參數錯誤");
  // 連結網域跟著「管理者當下開的網站」走（github.io / 未來 web.app 皆可），遷移零修改；限白名單防偽造
  let base = String((request.data || {}).baseUrl || "");
  if (!/^https:\/\/(glade9001\.github\.io\/store-schedule\/|store-schedule-3b056\.web\.app\/)/.test(base)) base = "https://glade9001.github.io/store-schedule/";
  const url = `${base}review.html?t=${shareToken}`;
  // 合格收件人：各店店長 + 加盟主（伺服器權威，只有這些人可被指定）
  const stores = (await getAllStores(db)).filter((s) => s !== "人力支援");
  let recips = [];
  for (const s of stores) {
    const es = await db.collection("stores").doc(s).collection("employees").get().catch(() => null);
    if (es) es.forEach((d) => { const e = d.data() || {}; if (["店長", "加盟主"].includes(e.role) && !["離職", "調走"].includes(e.status || "")) recips.push({ emp: d.id, store: s }); });
  }
  // 指定對象（複選）→ 只發給勾選且合格者；未指定→全部合格者
  const wanted = Array.isArray((request.data || {}).recipients) ? request.data.recipients.map(String) : [];
  if (wanted.length) recips = recips.filter((r) => wanted.includes(r.emp));
  const token = { line: LINE_TOKEN.value(), vapid: VAPID_PRIVATE.value() };
  const [yy, mm] = ym.split("-");
  const msg = `📋 ${yy}年${+mm}月 三店營運檢討\n\n加盟主已發布本月營運檢討報告，請點連結查看完整數據與檢討：\n${url}\n\n（此連結 3 天後自動失效）`;
  const sent = [], seen = new Set();
  for (const r of recips) {
    if (seen.has(r.emp)) continue; seen.add(r.emp);
    await notifyOneEmp(db, r.emp, r.store, msg, token,
      { urgent: true, push: { title: `📋 ${yy}年${+mm}月 三店營運檢討`, body: "加盟主已發布本月營運檢討，點這裡查看（連結 3 天後失效）", url, tag: `review-${ym}` } });
    sent.push(r.emp);
  }
  return { ok: true, count: sent.length };
});

// ============ PWA 推播（標準 Web Push，2026-09-15）============
// ===== 本人薪資（2026-10-10 薪資規則收緊，方案 A）=====
// 薪資一個月一份文件、records[] 含全店員工，原本員工端整份下載再前端過濾 → 開 console 就看得到全店同事薪資。
// firestore.rules 已改成 salary 只有店長（本店）／加盟主／admin 能直接讀；員工一律走這支，只拿得到自己那筆。
// 參數：months＝要查的月份（最多 36 個）；store＝只查這家門市；不給 store 時先查 prefer（預設本店）、再依序掃其他門市，
//       取第一家有本人記錄的。publishedOnly＝只認「已發布」的那份（首頁待簽收提醒用）。
// 回傳每個月份：{ ym, store, exists, status, rec }。rec＝本人那筆（沒有就 null）；
// status 一律回傳（補登表單要知道該店該月是否已送審，狀態本身不含個資）。
exports.getMySalary = onCall({ region: "asia-east1" }, async (request) => {
  const auth = request.auth;
  if (!auth) throw new HttpsError("unauthenticated", "請先登入");
  const db = getFirestore();
  const u = (await db.collection("users").doc(auth.uid).get()).data() || {};
  const empName = u.empName || "";
  if (!empName) throw new HttpsError("permission-denied", "查無使用者");
  const d = request.data || {};
  const months = Array.isArray(d.months) ? [...new Set(d.months.map(String))] : [];
  if (!months.length || months.length > 36 || months.some((m) => !/^\d{4}-\d{2}$/.test(m))) {
    throw new HttpsError("invalid-argument", "月份格式不正確");
  }
  const all = (await getAllStores(db)).filter((s) => s !== "人力支援");
  let order;
  if (d.store) {
    if (!all.includes(String(d.store))) throw new HttpsError("invalid-argument", "門市不存在");
    order = [String(d.store)];
  } else {
    const first = all.includes(String(d.prefer || "")) ? String(d.prefer) : (u.store || "");
    order = [first, ...all.filter((s) => s !== first)].filter(Boolean);
  }
  const items = [];
  for (const ym of months) {
    let first = null, hit = null;
    for (const st of order) {
      const snap = await db.collection("stores").doc(st).collection("salary").doc(ym).get().catch(() => null);
      const data = snap && snap.exists ? snap.data() : null;
      const one = {
        ym, store: st, exists: !!data,
        status: data ? (data.status || "draft") : "draft",
        rec: data ? ((data.records || []).find((r) => r && r.empName === empName) || null) : null,
      };
      if (d.publishedOnly && one.status !== "published") one.rec = null;
      if (!first) first = one;
      if (one.rec) { hit = one; break; }
    }
    items.push(hit || first);
  }
  return { empName, items };
});
