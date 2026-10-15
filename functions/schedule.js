// ===== schedule.js（2026-10-16 從 index.js 拆出來；程式原文照搬、只加 require／exports 接線）=====
// 拆法：只有這個功能用到的放這裡，兩個以上功能用到的放 common.js。新增共用小函式請放 common.js。
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { onRequest } = require("firebase-functions/v2/https");
const { onDocumentWritten, onDocumentCreated, onDocumentWrittenWithAuthContext } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { ALLOWED_PERMS, LINE_TOKEN, VAPID_PRIVATE, WEEK_DAYS, addDaysStr, fixStoreName, getAllStores, inQuietHours, maintenanceOn, monthWorkedByEmp, notifyEmployees, notifyStoreManagers, sendPushToUids, week1MondayUTC, weekMondayDate, weekStrOfTp } = require("./common");
async function flushPushQueue(db, vapid) {
  if (!vapid || inQuietHours()) return;
  const snap = await db.collection("pushQueue").orderBy("createdAt").limit(200).get().catch(() => null);
  if (!snap) return;
  for (const d of snap.docs) {
    const q = d.data();
    await sendPushToUids(db, q.uids || [], q.payload || {}, vapid).catch((e) => console.warn("[pushQueue]", e.message));
    await d.ref.delete().catch(() => {});
  }
}
const WEEK_LABELS = ["一", "二", "三", "四", "五", "六", "日"];
// 某人某週的班表 map：day → 顯示字串（休 或 時段）；supportOut：{day:{store,shift}} 去他店支援的日子
function weekShiftMap(records, empName, supportOut) {
  const map = {}; const so = supportOut || {};
  const noteOf = (nt) => nt ? `　📝${String(nt).replace(/\s+/g, " ").trim()}` : "";
  for (const dn of WEEK_DAYS) {
    const r = (records || []).find((x) => x && x.name === empName && x.day === dn && x.shift && String(x.shift).trim() && !x.requestOff);
    if (r) map[dn] = String(r.shift).replace(/,/g, "、") + (r.location && r.location !== "本店" ? `（${r.location}）` : "") + noteOf(r.note);
    else if (so[dn]) map[dn] = `支援${so[dn].store} ${so[dn].shift}` + noteOf(so[dn].note); // 去他店支援(本店無班)→顯示支援，不再誤標「休」
    else map[dn] = "休";
  }
  return map;
}
// 掃其他門市當週待補格，找「本店員工去他店支援(approved)」→ {empName:{day:{store,shift}}}
async function supportOutByEmp(db, homeStore, weekStr) {
  const out = {};
  const cfg = await db.collection("settings").doc("globalConfig").get().catch(() => null);
  const stores = ((cfg && cfg.exists ? cfg.data().stores : []) || []).filter((s) => s && s !== homeStore && s !== "人力支援");
  const pre = `${homeStore}-`;
  for (const st of stores) {
    const wd = await db.collection("stores").doc(st).collection("weeks").doc(weekStr).get().catch(() => null);
    if (!wd || !wd.exists) continue;
    (wd.data().records || []).forEach((r) => {
      if (r && r.approvalStatus === "approved" && typeof r.supportEmp === "string" && r.supportEmp.startsWith(pre) && r.shift) {
        const emp = r.supportEmp.slice(pre.length);
        (out[emp] = out[emp] || {})[r.day] = { store: st, shift: r.shift, note: r.note || "" };
      }
    });
  }
  return out;
}
function weekScheduleText(records, empName, wStr, supportOut) {
  const mon = weekMondayDate(wStr);
  const map = weekShiftMap(records, empName, supportOut);
  return WEEK_DAYS.map((dn, i) => {
    const x = new Date(mon); x.setDate(mon.getDate() + i);
    return `${WEEK_LABELS[i]} ${x.getMonth() + 1}/${x.getDate()}　${map[dn]}`;
  }).join("\n");
}

// 取某店在職員工短名（employees doc id）
async function getActiveEmpNames(db, store) {
  const empsSnap = await db.collection("stores").doc(store).collection("employees").get();
  const out = [];
  empsSnap.forEach((d) => {
    const e = d.data();
    if (!["離職", "調走"].includes(e.status)) out.push(d.id);
  });
  return out;
}
// 註：「劃休開放時通知」已改為「截止前2天提醒未劃休者」的排程（見 scheduledLeaveReminder）。

// 排班發布（步驟5）→ 通知全店在職員工
// weekStr 格式 YYYY-Www，複刻前端 weekStringToDate 求週一，組 MM/DD～MM/DD
function weekRangeLabel(wStr) {
  try {
    const [y, w] = String(wStr).split("-W");
    const yr = parseInt(y), wk = parseInt(w);
    const d = new Date(yr, 0, 1);
    const day = d.getDay();
    d.setDate(d.getDate() + (wk - 1) * 7);
    d.setDate(d.getDate() + (day <= 4 ? 1 - day : 8 - day)); // 週一
    const sun = new Date(d); sun.setDate(d.getDate() + 6);
    const md = (x) => `${x.getMonth() + 1}/${x.getDate()}`;
    return `${md(d)}～${md(sun)}`;
  } catch (e) { return wStr; }
}

// ✂️ onSchedulePublished 已整支移除（2026-09-02 額度預算化）。
//    班表「發布」8 月約吃掉 77 則，是額度第二大宗，但它是每週固定時間的常規、完全可預期，
//    不符合「非預期且有期限」的推播門檻。改用 home.html 的首頁橫幅（homeNextWeekBanner）——
//    那裡本來就即時訂閱下週的 published，只是過去沒有主動講出來。
//    ⚠️「已發布之後又被改」才是非預期事件，那條保留（onScheduleChanged → 靜置 10 分鐘後彙整）。
//    ⚠️ deploy 時 Firebase 會問是否刪除這支雲端函式，答 yes。

// 已發布班表被異動（published→published 且 records 變動）→ 不即時發送，改「延遲通知」：
// 進 scheduleNotifyQueue 佇列，靜置滿 10 分鐘無新異動才由 scheduledScheduleNotifyFlush 彙整發送；
// 店長亦可用班表頁「立即通知」按鈕（flushScheduleNotify）即時送出。避免一改就發、通知過於頻繁。
exports.onScheduleChanged = onDocumentWritten(
  { document: "stores/{store}/weeks/{weekStr}", region: "asia-east1" },
  async (event) => {
    const before = event.data.before.exists ? event.data.before.data() : {};
    const after = event.data.after.exists ? event.data.after.data() : {};
    if (!(before.published === true && after.published === true)) return; // 僅已發布週的後續異動
    if (await maintenanceOn(getFirestore())) return; // 維護模式：不排入通知佇列
    const beforeRecs = before.records || [];
    const afterRecs = after.records || [];
    if (JSON.stringify(beforeRecs) === JSON.stringify(afterRecs)) return; // records 沒變（純 metadata 寫入）→ 略過
    const store = fixStoreName(event.params.store);
    const weekStr = event.params.weekStr;
    const db = getFirestore();
    const qref = db.collection("scheduleNotifyQueue").doc(`${store}__${weekStr}`);
    const qs = await qref.get().catch(() => null);
    const nowTs = FieldValue.serverTimestamp();
    if (qs && qs.exists) {
      await qref.update({ lastChangeAt: nowTs }); // 每次新異動 → 重置 10 分鐘靜置計時
    } else {
      // 首次進佇列：baseRecs＝本批異動前的班表，作為「淨變動」比對基準（連改多次只比首尾）
      await qref.set({ store, weekStr, baseRecs: JSON.stringify(beforeRecs), lastChangeAt: nowTs, createdAt: nowTs });
    }
  }
);

// ===== 班表分享連結（2026-10-11）=====
// 管理員在設定頁產生 scheduleShares/{token}，拿連結的人（加盟主／總部）免登入看三店「本週＋下週」班表。
// ・班表要登入才讀得到，所以分享頁不直接讀 Firestore，一律經 getScheduleShare 驗代碼後由後端交資料；
//   只交畫圖用得到的欄位（班別／備註／地點／支援），工號、時薪、員工檔其他欄位一律不出去。
// ・週次以「打開當下」計算，同一條連結每週自動換成新的本週＋下週。
// ・未發布（且未過週五 18:00 自動發布）的週只回「尚未發布」，不露草稿。
// ・連結永久有效，管理員撤銷（revoked=true）後立即失效（使用者 2026-10-11 定案）。
// 規則：scheduleShares 只有 admin 能讀寫；scheduleChanges 前端完全不能碰（catch-all 已排除兩者）。

// 一格的「顯示內容」指紋：只看產圖會畫出來的欄位。劃休申請(requestOff)等不影響畫面的不算異動。
function shareCellSig(r) {
  if (!r) return "";
  const sup = r.approvalStatus === "approved" ? (r.supportEmp || "") : "";
  return [r.shift || "", r.note || "", r.location || "", r.isOT === true ? 1 : 0, sup].join("|");
}
function shareCellMap(records) {
  const m = new Map(); // `${name}|${day}` → 第一筆（與產圖 records.find 相同取法）
  for (const r of (records || [])) {
    if (!r || !r.name || !r.day || r.name === "門市備註") continue;
    const k = `${r.name}|${r.day}`;
    if (!m.has(k)) m.set(k, r);
  }
  return m;
}
function shareCellText(r) {
  if (!r || !r.shift) return "空白";
  const sh = ["排休", "指休"].includes(r.shift) ? "休" : r.shift;
  return sh + (r.location && r.location !== "本店" ? `（${r.location}）` : "");
}
// 週一（UTC 午夜＝台北該日）——與 weekStrOfTp 同一套週次定義
function shareWeekMondayUTC(wStr) {
  const [y, w] = String(wStr).split("-W");
  const d = week1MondayUTC(parseInt(y));
  d.setUTCDate(d.getUTCDate() + (parseInt(w) - 1) * 7);
  return d;
}
// 前端 isAutoPublished：該週週一往前推到上週五 18:00（台北）之後視為已發布
function shareAutoPublished(wStr, nowMs) {
  return nowMs >= shareWeekMondayUTC(wStr).getTime() - 3 * 86400000 + 10 * 3600000;
}

// 發布後的班表被改 → 逐格記下「誰、哪一天、原本→改成、什麼時間、誰改的」
// ⚠️ 用 WithAuthContext 才拿得到修改者；Cloud Functions 自己寫的（Admin SDK）記成「系統」。
// ⚠️ 店名從 event.params 來會是 latin1 亂碼，一定要 fixStoreName（見 reference_cjk_encoding_traps）。
// ⚠️ arrayUnion 會吃掉完全相同的元素 → 每筆帶 at（毫秒）＋序號。
exports.onScheduleCellLog = onDocumentWrittenWithAuthContext(
  { document: "stores/{store}/weeks/{weekStr}", region: "asia-east1" },
  async (event) => {
    if (!event.data.before.exists || !event.data.after.exists) return;
    const before = event.data.before.data() || {};
    const after = event.data.after.data() || {};
    const weekStr = event.params.weekStr;
    const now = Date.now();
    const auto = shareAutoPublished(weekStr, now);
    // 改之前、改之後都已經是「看得到的班表」才算異動（發布那一下本身不算）
    if (!((before.published === true || auto) && (after.published === true || auto))) return;
    const bm = shareCellMap(before.records), am = shareCellMap(after.records);
    const keys = new Set([...bm.keys(), ...am.keys()]);
    const changed = [];
    for (const k of keys) {
      if (shareCellSig(bm.get(k)) === shareCellSig(am.get(k))) continue;
      const [name, day] = k.split("|");
      changed.push({ name, day, from: shareCellSig(bm.get(k)), to: shareCellSig(am.get(k)),
        fromText: shareCellText(bm.get(k)), toText: shareCellText(am.get(k)) });
    }
    if (!changed.length) return;
    const db = getFirestore();
    let by = "系統";
    if (event.authType === "app_user" && event.authId) {
      const u = await db.collection("users").doc(event.authId).get().catch(() => null);
      const ud = u && u.exists ? u.data() : {};
      by = ud.displayName || ud.empName || "未知使用者";
    }
    const store = fixStoreName(event.params.store);
    const items = changed.map((c, i) => ({ ...c, at: now, seq: i, by }));
    await db.collection("scheduleChanges").doc(`${store}__${weekStr}`).set({
      store, weekStr, updatedAt: now,
      items: FieldValue.arrayUnion(...items),
    }, { merge: true });
  }
);

// 分享頁讀資料：GET ?t=<token>
exports.getScheduleShare = onRequest({ region: "asia-east1" }, async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Cache-Control", "no-store");
  if (req.method === "OPTIONS") { res.set("Access-Control-Allow-Methods", "GET"); res.status(204).send(""); return; }
  if (req.method !== "GET") { res.status(405).json({ error: "method" }); return; }
  const token = String(req.query.t || "");
  if (!/^[A-Za-z0-9_-]{24,64}$/.test(token)) { res.status(404).json({ error: "invalid" }); return; }
  const db = getFirestore();
  const shareRef = db.collection("scheduleShares").doc(token);
  const share = await shareRef.get();
  if (!share.exists || share.data().revoked === true) { res.status(404).json({ error: "invalid" }); return; }
  shareRef.update({ lastViewedAt: Date.now(), views: FieldValue.increment(1) }).catch(() => {});

  const cfg = await db.collection("settings").doc("globalConfig").get().catch(() => null);
  const stores = ((cfg && cfg.exists ? cfg.data().stores : []) || []).filter((s) => s && s !== "人力支援");
  const now = Date.now();
  const tpNow = new Date(now + 8 * 3600000);
  const weekStrs = [weekStrOfTp(tpNow), weekStrOfTp(new Date(tpNow.getTime() + 7 * 86400000))];

  // 顯示名（account.displayName）：所有門市一次讀
  const accSnap = await db.collection("account").get().catch(() => null);
  const nameMapAll = {};
  if (accSnap) accSnap.forEach((d) => { const a = d.data(); if (a.empName && a.displayName) nameMapAll[a.empName] = a.displayName; });
  const empSnaps = await Promise.all(stores.map((s) => db.collection("stores").doc(s).collection("employees").get().catch(() => null)));
  const usedNames = new Set();

  const pick = (r) => ({
    name: r.name, day: r.day, shift: r.shift || "", note: r.note || "", location: r.location || "",
    supportEmp: r.supportEmp || "", approvalStatus: r.approvalStatus || "",
    actualHours: r.actualHours || 0, isOT: r.isOT === true,
  });

  const weeks = [];
  for (const wk of weekStrs) {
    const mon = shareWeekMondayUTC(wk);
    const dates = [], iso = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(mon.getTime() + i * 86400000);
      dates.push(`${d.getUTCMonth() + 1}/${d.getUTCDate()}`);
      iso.push(d.toISOString().slice(0, 10));
    }
    const monStr = iso[0], sunStr = iso[6];
    const [wkSnaps, chSnaps] = await Promise.all([
      Promise.all(stores.map((s) => db.collection("stores").doc(s).collection("weeks").doc(wk).get().catch(() => null))),
      Promise.all(stores.map((s) => db.collection("scheduleChanges").doc(`${s}__${wk}`).get().catch(() => null))),
    ]);
    const wkData = wkSnaps.map((s) => (s && s.exists ? s.data() : {}));
    const visible = wkData.map((d) => d.published === true || shareAutoPublished(wk, now));

    // 每店「淨異動」：同一格取最早的 from 與最後一次的時間／修改者；最後結果與原本相同（改回去）就不算
    // 待補格被認領／取消時，被派去支援的人在「他自己店」的那一格也要標（crossMarks，最後套上）
    const crossMarks = [];
    const netByStore = stores.map((s, si) => {
      const out = {};
      const items = (chSnaps[si] && chSnaps[si].exists ? chSnaps[si].data().items : []) || [];
      const cur = shareCellMap(wkData[si].records);
      const byKey = {};
      items.slice().sort((a, b) => (a.at - b.at) || (a.seq - b.seq)).forEach((it) => {
        const k = `${it.name}|${it.day}`;
        if (!byKey[k]) byKey[k] = { day: it.day, from: it.from, at: it.at, by: it.by };
        else { byKey[k].at = it.at; byKey[k].by = it.by; }
      });
      for (const k in byKey) {
        const c = byKey[k];
        const curRec = cur.get(k);
        if (c.from === shareCellSig(curRec)) continue;
        out[k] = { at: c.at, by: c.by };
        const oldSup = String(c.from).split("|")[4] || "";
        const newSup = curRec && curRec.approvalStatus === "approved" ? (curRec.supportEmp || "") : "";
        if (oldSup === newSup) continue;
        for (const sup of [oldSup, newSup]) {
          const dash = sup.indexOf("-");
          const hi = dash > 0 ? stores.indexOf(sup.slice(0, dash)) : -1;
          if (hi >= 0) crossMarks.push({ hi, key: `${sup.slice(dash + 1)}|${c.day}`, at: c.at, by: c.by });
        }
      }
      return out;
    });
    crossMarks.forEach(({ hi, key, at, by }) => {
      const prev = netByStore[hi][key];
      if (!prev || prev.at < at) netByStore[hi][key] = { at, by };
    });

    const storeOut = stores.map((s, si) => {
      const d = wkData[si];
      if (!visible[si]) return { store: s, visible: false };
      const records = (d.records || []).filter((r) => r && r.name && r.day).map(pick);
      // 他店記錄只留「派本店員工去支援且已核准」的格子——產圖只用它判斷 supportOut
      const cross = [];
      stores.forEach((os, oi) => {
        if (oi === si) return;
        (wkData[oi].records || []).forEach((r) => {
          if (r && r.approvalStatus === "approved" && typeof r.supportEmp === "string" && r.supportEmp.startsWith(`${s}-`)) {
            cross.push({ ...pick(r), _store: os, week: wk });
          }
        });
      });
      // 員工列：與排班頁「查閱班表」(loadEmpView) 同一套在職／調職判斷
      const emps = [];
      const published = d.published === true;
      if (empSnaps[si]) empSnaps[si].forEach((doc) => {
        const e = doc.data();
        const row = { name: doc.id, sortKey: e.sortKey || 0 };
        const status = e.status;
        if (!["離職", "調走"].includes(status)) {
          const dep = e.departDate, st = e.startDate;
          if (dep && st && dep < st) {
            if (monStr >= st || sunStr < dep || (dep >= monStr && dep <= sunStr)) emps.push(row);
            return;
          }
          if (st && sunStr < st) return;
          emps.push(row); return;
        }
        if (status === "離職") return;
        const eff = e.transferDate;
        if (!eff) return;
        if ((published && eff >= monStr) || eff > sunStr || (eff >= monStr && eff <= sunStr)) emps.push(row);
      });
      emps.sort((a, b) => a.sortKey - b.sortKey);
      records.forEach((r) => usedNames.add(r.name));
      cross.forEach((r) => { if (r.supportEmp) usedNames.add(r.supportEmp.split("-")[1] || ""); });
      emps.forEach((e) => usedNames.add(e.name));
      const changes = netByStore[si];
      const lastChangeAt = Object.values(changes).reduce((m, c) => Math.max(m, c.at), 0) || null;
      return {
        store: s, visible: true, published, publishedAt: d.publishedAt || null, publishedBy: d.publishedBy || "",
        records, cross, emps: emps.map((e) => ({ name: e.name })), changes, lastChangeAt,
      };
    });
    weeks.push({ weekStr: wk, dates, stores: storeOut });
  }
  const names = {};
  usedNames.forEach((n) => { if (nameMapAll[n]) names[n] = nameMapAll[n]; });
  res.json({ title: share.data().label || "", now, weeks, names });
});

// 彙整某週佇列 → 比對 baseRecs vs 目前班表，只通知「班次有淨變動」的在職員工
// force=true 是店長在班表頁按「立即通知」＝明示要發，不受每日上限限制。
async function flushScheduleQueueEntry(db, store, weekStr, baseRecs, token, force) {
  const wkSnap = await db.collection("stores").doc(store).collection("weeks").doc(weekStr).get();
  if (!wkSnap.exists || wkSnap.data().published !== true) return { sent: 0 };
  // 每店每天最多一輪自動異動通知（2026-09-02 額度預算化）：
  // 排班常常是同一天分好幾次修，每修一輪就整店發一次，8 月光班表就吃掉約 138 則。
  // 超過上限的異動不會消失——留在佇列外由隔天第一輪一起帶出（比對基準是「上次發送時的班表」）。
  const dayKey = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  const capRef = db.collection("scheduleNotifyDaily").doc(`${store}__${dayKey}`);
  if (!force) {
    const cap = await capRef.get().catch(() => null);
    if (cap && cap.exists) return { sent: 0, skipped: "daily-cap" };
  }
  const curRecs = wkSnap.data().records || [];
  const label = weekRangeLabel(weekStr);
  const active = new Set(await getActiveEmpNames(db, store));
  const changed = [];
  for (const emp of active) {
    if (JSON.stringify(weekShiftMap(baseRecs, emp)) !== JSON.stringify(weekShiftMap(curRecs, emp))) changed.push(emp);
  }
  if (!changed.length) return { sent: 0 };
  const so = await supportOutByEmp(db, store, weekStr);
  await notifyEmployees(
    db, changed, store,
    (name, emp) => `🔔 ${name}，${store} ${label} 班表有異動\n\n${weekScheduleText(curRecs, emp, weekStr, so[emp])}\n\n請至 App 確認最新班表`,
    token,
    { urgent: !!force, push: (name, emp) => ({ title: `🔔 ${label} 班表有異動`, body: weekScheduleText(curRecs, emp, weekStr, so[emp]), url: "schedule-V2.html", tag: `sched-${store}-${weekStr}` }) }
  );
  // 真的送出去才記上限（changed 為 0 時不佔用今天的名額）
  await capRef.set({ store, weekStr, at: new Date().toISOString(), sent: changed.length, force: !!force },
    { merge: true }).catch(() => {});
  return { sent: changed.length };
}
async function monthOtByEmp(db, store, ym) {
  const w = await monthWorkedByEmp(db, store, ym);
  const out = {};
  for (const e in w) out[e] = w[e].ot;
  return out;
}

// 班表變動 → 計算當月加班累計，跨越門檻(黃/紅/嚴重)且「等級升高」時，LINE 通知該店店長
exports.onScheduleOtWarning = onDocumentWritten(
  { document: "stores/{store}/weeks/{weekStr}", region: "asia-east1", secrets: [LINE_TOKEN, VAPID_PRIVATE] },
  async (event) => {
    const after = event.data.after.exists ? event.data.after.data() : null;
    if (!after) return; // 刪除不處理
    const before = event.data.before.exists ? event.data.before.data() : {};
    if (JSON.stringify(before.records || []) === JSON.stringify(after.records || [])) return; // records 沒變
    if (await maintenanceOn(getFirestore())) return; // 維護模式不發加班預警
    const store = fixStoreName(event.params.store);
    const weekStr = event.params.weekStr;
    const db = getFirestore();
    const token = { line: LINE_TOKEN.value(), vapid: VAPID_PRIVATE.value() };
    // 門檻（可在 settings/globalConfig.otThresholds 調整）
    const cfg = await db.collection("settings").doc("globalConfig").get().catch(() => null);
    const th = (cfg && cfg.exists && cfg.data().otThresholds) || {};
    const YELLOW = th.yellow || 40, RED = th.red || 46, SEVERE = th.severe || 54;
    const rank = { none: 0, yellow: 1, red: 2, severe: 3 };
    const levelOf = (h) => h >= SEVERE ? "severe" : h >= RED ? "red" : h >= YELLOW ? "yellow" : "none";
    const label = { yellow: `接近上限(黃，≥${YELLOW}h)`, red: `超過月上限(紅，≥${RED}h)`, severe: `嚴重(≥${SEVERE}h)` };
    // app 顯示名對照（account.empName → displayName）
    const accSnap = await db.collection("account").where("store", "==", store).get().catch(() => null);
    const dispMap = {};
    if (accSnap) accSnap.forEach((d) => { const a = d.data(); if (a.empName && a.displayName) dispMap[a.empName] = a.displayName; });
    const disp = (nm) => dispMap[nm] || nm;
    // 這週觸及的月份
    const mon = weekMondayDate(weekStr);
    const months = new Set();
    for (let i = 0; i < 7; i++) { const d = new Date(mon); d.setDate(mon.getDate() + i); months.add(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`); }
    for (const ym of months) {
      const otMap = await monthOtByEmp(db, store, ym);
      const alertRef = db.collection("stores").doc(store).collection("otAlerts").doc(ym);
      const prevSnap = await alertRef.get().catch(() => null);
      const prevLevels = (prevSnap && prevSnap.exists) ? (prevSnap.data().levels || {}) : {};
      const newLevels = {};
      const notify = [];
      for (const emp in otMap) {
        const lv = levelOf(otMap[emp]);
        newLevels[emp] = lv;
        if (lv !== "none" && rank[lv] > rank[prevLevels[emp] || "none"]) {
          notify.push({ emp, lv, h: Math.round(otMap[emp] * 10) / 10 });
        }
      }
      for (const t of notify) {
        await notifyStoreManagers(db, store, `⚠️ ${store} ${parseInt(ym.split("-")[1])}月加班預警：${disp(t.emp)} 本月加班已達 ${t.h}h（${label[t.lv]}，勞基法 §32 每月上限 46h），請留意排班。`, token,
          { push: { title: `⚠️ ${disp(t.emp)} 本月加班 ${t.h}h`, body: `${store} ${parseInt(ym.split("-")[1])}月・${label[t.lv]}（勞基法每月上限 46h），請留意排班`, url: "schedule-V2.html?mode=admin", tag: `ot-${store}-${ym}-${t.emp}` } });
      }
      await alertRef.set({ levels: newLevels, updatedAt: new Date().toISOString() });
    }
  }
);

// ===== 班表異動「延遲通知」排程：每 5 分鐘檢查佇列，靜置滿 10 分鐘無新異動才彙整發送 =====
exports.scheduledScheduleNotifyFlush = onSchedule(
  { schedule: "*/5 * * * *", timeZone: "Asia/Taipei", region: "asia-east1", secrets: [LINE_TOKEN, VAPID_PRIVATE] },
  async () => {
    const db = getFirestore();
    if (await maintenanceOn(db)) return; // 維護模式不彙整發送班表異動
    const token = { line: LINE_TOKEN.value(), vapid: VAPID_PRIVATE.value() };
    await flushPushQueue(db, token.vapid); // 夜間排隊的推播，08:00 後送出
    // 22:00–08:00 不自動發班表異動（LINE 與推播都一樣）：佇列留著，早上第一輪再發；店長按「立即通知」不受限
    if (inQuietHours()) return;
    const QUIET_MS = 10 * 60 * 1000;
    const now = Date.now();
    const qsnap = await db.collection("scheduleNotifyQueue").get().catch(() => null);
    if (!qsnap) return;
    for (const d of qsnap.docs) {
      const q = d.data();
      const last = q.lastChangeAt && q.lastChangeAt.toMillis ? q.lastChangeAt.toMillis() : 0;
      if (now - last < QUIET_MS) continue; // 尚未靜置滿 10 分鐘 → 等下輪
      const r = await flushScheduleQueueEntry(db, q.store, q.weekStr, JSON.parse(q.baseRecs || "[]"), token).catch(() => null);
      // 撞到每日上限 → 佇列**不刪**，baseRecs 原封不動留著，隔天第一輪再把「累積的淨變動」一起發。
      // 若這裡照刪，今天被擋下的異動就永遠不會有人被通知（隔天的基準會變成已改後的班表）。
      if (r && r.skipped === "daily-cap") continue;
      await d.ref.delete().catch(() => {});
    }
  }
);

// ===== 班表異動「立即通知」：店長於班表頁按下按鈕 → 馬上彙整發送並清空佇列（僅店長以上）=====
exports.flushScheduleNotify = onCall(
  { region: "asia-east1", secrets: [LINE_TOKEN, VAPID_PRIVATE] },
  async (request) => {
    const auth = request.auth;
    if (!auth) throw new HttpsError("unauthenticated", "請先登入");
    const db = getFirestore();
    const callerSnap = await db.collection("users").doc(auth.uid).get();
    const caller = callerSnap.data();
    if (!caller || !ALLOWED_PERMS.includes(caller.permission)) throw new HttpsError("permission-denied", "僅店長以上可用");
    const store = fixStoreName((request.data && request.data.store) || "");
    const weekStr = (request.data && request.data.weekStr) || "";
    if (!store || !weekStr) throw new HttpsError("invalid-argument", "缺少 store / weekStr");
    const token = { line: LINE_TOKEN.value(), vapid: VAPID_PRIVATE.value() };
    const qref = db.collection("scheduleNotifyQueue").doc(`${store}__${weekStr}`);
    const qs = await qref.get().catch(() => null);
    if (qs && qs.exists) {
      // 有待發異動 → 依 baseRecs 淨變動只通知有異動者
      // force=true：店長明示要發，不受「每店每天一輪」上限限制
      const res = await flushScheduleQueueEntry(db, store, weekStr, JSON.parse(qs.data().baseRecs || "[]"), token, true);
      await qref.delete().catch(() => {});
      return { ok: true, sent: res.sent || 0 };
    }
    // 無待發異動 → 直接把目前已發布班表推給全店在職員工
    const wkSnap = await db.collection("stores").doc(store).collection("weeks").doc(weekStr).get();
    if (!wkSnap.exists || wkSnap.data().published !== true) throw new HttpsError("failed-precondition", "此週尚未發布，無法通知");
    const curRecs = wkSnap.data().records || [];
    const label = weekRangeLabel(weekStr);
    const empNames = await getActiveEmpNames(db, store);
    const so = await supportOutByEmp(db, store, weekStr); // 跨店支援：顯示支援而非「休」
    await notifyEmployees(
      db, empNames, store,
      (name, emp) => `🔔 ${name}，${store} ${label} 班表有異動\n\n${weekScheduleText(curRecs, emp, weekStr, so[emp])}\n\n請至 App 確認最新班表`,
      token,
      { urgent: true, push: (name, emp) => ({ title: `🔔 ${label} 班表有異動`, body: weekScheduleText(curRecs, emp, weekStr, so[emp]), url: "schedule-V2.html", tag: `sched-${store}-${weekStr}` }) }
    );
    return { ok: true, sent: empNames.length };
  }
);

// ============ 推播第一批：恢復當初為省 LINE 額度砍掉的通知（2026-09-15，只發推播）============

// ── 班表已發布（手動發布當下；夜間排隊到 08:00）──
// 取代 2026-09-02 移除的 onSchedulePublished（LINE 版）。pushPublishSent 防止「取消發布→再發布」重複通知。
async function pushSchedulePublished(db, store, weekStr, records, vapid) {
  const sentRef = db.collection("pushPublishSent").doc(`${store}__${weekStr}`);
  const sent = await sentRef.get().catch(() => null);
  if (sent && sent.exists) return { skipped: "already" };
  const label = weekRangeLabel(weekStr);
  const empNames = await getActiveEmpNames(db, store);
  const so = await supportOutByEmp(db, store, weekStr);
  const r = await notifyEmployees(db, empNames, store, () => "", { vapid }, {
    pushOnly: true,
    push: (name, emp) => ({ title: `🗓️ ${store} ${label} 班表已發布`, body: weekScheduleText(records, emp, weekStr, so[emp]), url: "schedule-V2.html", tag: `sched-${store}-${weekStr}` }),
  });
  await sentRef.set({ store, weekStr, at: new Date().toISOString(), push: r.push }).catch(() => {});
  return r;
}

// ── 國定假日補休：班表「發布」時依班表發放／撤銷（使用者 2026-10-15 定案）──
// 原本是排班時每改一格就跳「是否發放」：草稿階段來回改，發放→撤銷→再發放時被「已發放過」擋掉
// （只看有沒有 comp_earn、沒扣 comp_cancel），2026 年有 16 班正職國定假日上班、補休淨額卻是 0。
// 改成：發布前不發；發布當下（手動發布 onSchedulePublishedPush／週五 18:00 自動發布 scheduledAutoPublishPush）
// 依班表把每位正職每個國定假日的補休淨額對齊成「有上班＝1、沒上班＝0」。發布後再改班，前端照舊逐格詢問。
// holidayCompSync/{店}__{週}：同步過的週自動發布時不再重跑（以免蓋掉發布後店長逐格的決定）。
// 補休的真相＝leaveLog 的 comp_earn − comp_cancel（comp-avail.js、leave-page 都這樣算）；每筆帶 ts，避免 arrayUnion 吃掉相同紀錄。
const HOL_OFF = ["排休", "指休", "特休", "補休", "清空", ""];
function weekMonStrOf(wStr) {
  const [y, w] = String(wStr).split("-W").map(Number);
  const d = week1MondayUTC(y);
  d.setUTCDate(d.getUTCDate() + (w - 1) * 7);
  return d.toISOString().slice(0, 10);
}
async function syncHolidayCompForWeek(db, store, weekStr, by, dryRun) {
  const mon = weekMonStrOf(weekStr), dates = WEEK_DAYS.map((_, i) => addDaysStr(mon, i));
  const years = [...new Set(dates.map((d) => d.slice(0, 4)))], hol = {};
  for (const y of years) {
    const hs = await db.collection("settings").doc("holidays").collection("years").doc(y).get().catch(() => null);
    Object.assign(hol, (hs && hs.exists && hs.data().dates) || {});
  }
  const holDays = dates.map((d, i) => ({ d, day: WEEK_DAYS[i], name: hol[d] })).filter((x) => x.name);
  if (!holDays.length) return null;
  const wk = await db.collection("stores").doc(store).collection("weeks").doc(weekStr).get().catch(() => null);
  if (!wk || !wk.exists) return null;
  // 「那天有沒有上班」看所有門市的班表：調店的人那週的班在舊店、跨店支援的班在對方店（🆘 列 supportEmp＝「本店-姓名」）。
  // 只看本店會把「在別店上班」誤判成沒上班而撤銷（2026-10-15 試跑抓到：調走的正職 9/25 在錦花上班，美德這邊被判撤銷）。
  const working = new Set();
  for (const st of (await getAllStores(db)).filter((x) => x !== "人力支援")) {
    const sw = st === store ? wk : await db.collection("stores").doc(st).collection("weeks").doc(weekStr).get().catch(() => null);
    ((sw && sw.exists && sw.data().records) || []).forEach((r) => {
      if (!r || HOL_OFF.includes(String(r.shift || "").trim())) return;
      if (r.name && !String(r.name).startsWith("🆘")) working.add(`${r.name}|${r.day}`);
      if (r.approvalStatus === "approved" && typeof r.supportEmp === "string" && r.supportEmp.includes("-")) working.add(`${r.supportEmp.slice(r.supportEmp.indexOf("-") + 1)}|${r.day}`);
    });
  }
  const recs = wk.data().records || [];
  const empSnap = await db.collection("stores").doc(store).collection("employees").get();
  const emps = {}; empSnap.forEach((d) => { emps[d.id] = d.data(); });
  const out = { granted: [], revoked: [] }, now = new Date().toISOString();
  for (const name of Object.keys(emps)) {
    const e = emps[name];
    if (e.payAsPartTime || String(e.role || "").includes("工讀")) continue; // 工讀不發補休（同前端 isPartTimeEmp）；加盟主照發（使用者 2026-10-15 確認）
    for (const h of holDays) {
      const r = recs.find((x) => x && x.name === name && x.day === h.day);
      const isWorking = working.has(`${name}|${h.day}`);
      const ym = h.d.slice(0, 7), yr = h.d.slice(0, 4);
      const empRef = db.collection("employees").doc(name), logRef = empRef.collection("leaveLog").doc(ym);
      const logSnap = await logRef.get().catch(() => null);
      let net = 0;
      ((logSnap && logSnap.exists && logSnap.data().records) || []).forEach((x) => {
        if (!x || x.date !== h.d || !(x.source === "holiday" || String(x.note || "").includes("國定假日"))) return;
        const n = parseFloat(x.days) || 1;
        if (x.type === "comp_earn") net += n; else if (x.type === "comp_cancel") net -= n;
      });
      const target = isWorking ? 1 : 0;
      if (net === target || (net > 1 && isWorking)) continue;
      const diff = target - net; // +1 發放、−1 撤銷（net 異常時一次補齊到 target）
      const type = diff > 0 ? "comp_earn" : "comp_cancel";
      const rec = { date: h.d, type, days: Math.abs(diff), source: "holiday", savedBy: by, ts: Date.now(),
        note: `${h.d} ${h.name} 國定假日補休${diff > 0 ? "" : "撤銷"}（班表發布時依班表${diff > 0 ? "發放" : "撤銷"}）` };
      (diff > 0 ? out.granted : out.revoked).push({ name, date: h.d, holiday: h.name, shift: r ? r.shift : "" });
      if (dryRun) continue;
      await logRef.set({ records: FieldValue.arrayUnion(rec) }, { merge: true });
      // 舊統計欄（會漂、計算不讀，只為跟前端逐格發放一致）
      const inc = FieldValue.increment(diff);
      await empRef.collection("comp").doc(yr).set({ earned: inc }, { merge: true }).catch(() => {});
      await empRef.collection("leaves").doc(yr).set({ earnedComp: inc, updatedAt: now }, { merge: true }).catch(() => {});
    }
  }
  if (dryRun) return out;
  await db.collection("holidayCompSync").doc(`${store}__${weekStr}`).set({ store, weekStr, at: now, by, ...out });
  if (out.granted.length || out.revoked.length) console.log("[holidayCompSync]", store, weekStr, JSON.stringify(out));
  return out;
}

exports.onSchedulePublishedPush = onDocumentWritten(
  { document: "stores/{store}/weeks/{weekStr}", region: "asia-east1", secrets: [VAPID_PRIVATE] },
  async (event) => {
    const before = event.data.before.exists ? event.data.before.data() : {};
    const after = event.data.after.exists ? event.data.after.data() : {};
    if (before.published === true || after.published !== true) return; // 只在「剛發布」
    const db = getFirestore();
    // 國定假日補休依班表同步（維護中也要做：這是員工權益，不是通知）；失敗不擋推播，週五自動發布時會補做
    await syncHolidayCompForWeek(db, fixStoreName(event.params.store), event.params.weekStr, after.publishedBy ? `班表發布（${after.publishedBy}）` : "班表發布")
      .catch((e) => console.error("[holidayCompSync]", event.params.weekStr, e));
    if (await maintenanceOn(db)) return;
    await pushSchedulePublished(db, fixStoreName(event.params.store), event.params.weekStr, after.records || [], VAPID_PRIVATE.value());
  }
);

// ── 週五 18:00 自動發布：店長沒手動發布的下週班表，前端此時起視為已發布（isAutoPublishedHome）→ 補推 ──
exports.scheduledAutoPublishPush = onSchedule(
  // retryCount：這支也負責國定假日補休同步，失敗要重跑（重跑安全：推播有 pushPublishSent、補休有 holidayCompSync 去重）
  { schedule: "0 18 * * 5", timeZone: "Asia/Taipei", region: "asia-east1", secrets: [VAPID_PRIVATE], retryCount: 3 },
  async () => {
    const db = getFirestore();
    if (await maintenanceOn(db)) return;
    const nextTp = new Date(Date.now() + 8 * 3600000 + 3 * 86400000); // 週五 +3 天＝下週一
    const weekStr = weekStrOfTp(nextTp);
    for (const store of (await getAllStores(db)).filter((s) => s !== "人力支援")) {
      const wd = await db.collection("stores").doc(store).collection("weeks").doc(weekStr).get().catch(() => null);
      if (!wd || !wd.exists) continue;
      const d = wd.data();
      // 國定假日補休：這週還沒依班表同步過（沒手動發布、或手動發布時同步失敗）→ 自動發布這一刻補做
      const synced = await db.collection("holidayCompSync").doc(`${store}__${weekStr}`).get().catch(() => null);
      if (!synced || !synced.exists) await syncHolidayCompForWeek(db, store, weekStr, "班表自動發布").catch((e) => console.error("[holidayCompSync]", store, weekStr, e));
      if (d.published === true) continue; // 已手動發布（當時已通知）
      if (!(d.records || []).some((r) => r && r.shift)) continue; // 空班表不發
      await pushSchedulePublished(db, store, weekStr, d.records || [], VAPID_PRIVATE.value());
    }
  }
);
