// ===== daily.js（2026-10-16 從 index.js 拆出來；程式原文照搬、只加 require／exports 接線）=====
// 拆法：只有這個功能用到的放這裡，兩個以上功能用到的放 common.js。新增共用小函式請放 common.js。
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { onDocumentWritten, onDocumentCreated, onDocumentWrittenWithAuthContext } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { LINE_TOKEN, VAPID_PRIVATE, WEEK_DAYS, deliverToPeople, linePush, loadPushIndex, maintenanceOn, notifyOneEmp, notifyStoreManagers, pushFromText, sendPushToUids, taipeiYM, weekMondayDate, weekStrOfTp } = require("./common");
// 以「台北時區」取得今天 YYYY-MM-DD
function taipeiTodayStr() {
  return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
}

// ===== 薪資簽收提醒：每日檢查，對「已發布可查看但未簽收」者每 2 天提醒一次（2026-07 起，直到簽收）
//      管道由 deliverToPeople 決定：有開推播的只收推播，沒開的才發 LINE =====
// 發薪提醒日：5 號，遇週末/國定假日順延到下一個工作日(週末→週一)
async function salaryReminderDay(db, year, month) {
  const hs = await db.collection("settings").doc("holidays").collection("years").doc(String(year)).get().catch(() => null);
  const holidays = (hs && hs.exists && hs.data().dates) ? hs.data().dates : {};
  for (let day = 5; day <= 20; day++) {
    const dateStr = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    if (dow !== 0 && dow !== 6 && !holidays[dateStr]) return day;
  }
  return 5;
}
// 離職者存取期限＝最後薪資發放月月底(與 auth.js 一致)：1號離職→當月底；2號+→次月底
function resignAccessUntil(retireDate) {
  const p = String(retireDate || "").split("-").map(Number);
  if (p.length !== 3) return null;
  let [y, m, d] = p;
  if (d !== 1) { m += 1; if (m > 12) { m = 1; y += 1; } }
  const lastDay = new Date(y, m, 0).getDate();
  return `${y}-${String(m).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
}
const SALARY_ACK_REMIND_DAYS = 7;   // 兩次提醒最短間隔
const SALARY_ACK_MAX_REMINDS = 3;   // 每個薪資月份最多提醒幾次
// 15:00 由 scheduledDailyReminders 呼叫（重試設定也移到那支）
const salaryAckReminder = (
  async () => {
    const db = getFirestore();
    const token = LINE_TOKEN.value();
    const vapid = VAPID_PRIVATE.value();
    const ACK_START = "2026-07";
    const nowYM = taipeiYM();
    // 需簽收月份：ACK_START ~ (當月-1)，即已可查看的月份(M 月薪資 M+1 才可看)
    const months = [];
    { let [y, m] = ACK_START.split("-").map(Number);
      for (let i = 0; i < 36; i++) {
        const ym = `${y}-${String(m).padStart(2, "0")}`;
        if (ym >= nowYM) break;
        months.push(ym);
        m++; if (m > 12) { m = 1; y++; }
      } }
    if (!months.length) return;
    const NOW = Date.now();
    const nowDay = new Date(Date.now() + 8 * 3600000).getUTCDate(); // 台北日
    const [rY, rM] = nowYM.split("-").map(Number);
    const remDay = await salaryReminderDay(db, rY, rM); // 本月發薪提醒日(5號或順延)
    // 離職者：不再發任何 LINE；並收集資訊供「離職註記自動標」
    const todayTp = taipeiTodayStr(); // 生效日比對用（提前登記者在生效日前仍在職）
    const resignedInfo = {}; // empName -> {store, retireDate, effective}
    const cfgR = await db.collection("settings").doc("globalConfig").get().catch(() => null);
    for (const st of ((cfgR && cfgR.exists ? cfgR.data().stores : []) || [])) {
      const es = await db.collection("stores").doc(st).collection("employees").get().catch(() => null);
      // 生效日還沒到的（提前登記）仍在職，照常提醒；到職最後一天為止都要收得到薪資簽收通知
      if (es) es.forEach((d) => {
        const e = d.data() || {};
        if (e.status !== "離職") return;
        const rd = e.retireDate || "";
        resignedInfo[d.id] = { store: st, retireDate: rd, effective: !rd || todayTp >= rd };
      });
    }
    const bindSnap = await db.collection("lineBindings").get();
    const uidByName = {}; bindSnap.forEach((d) => { const b = d.data(); if (b.empName && b.uid) uidByName[b.empName] = b.uid; });
    // 收件人＝綁 LINE 的人 ∪ 開了推播的人（2026-09-15：推播優先、LINE 補位，只開推播沒綁 LINE 的人也要提醒）
    const pushIdx = await loadPushIndex(db);
    const cands = {};
    bindSnap.forEach((d) => { const b = d.data(); if (b.uid && b.empName && b.store) cands[b.uid] = b; });
    const pushOnlyUids = [...pushIdx.uids].filter((u) => !cands[u]);
    for (const u of pushOnlyUids) {
      const us = await db.collection("users").doc(u).get().catch(() => null);
      const x = us && us.exists ? us.data() : null;
      if (x && x.empName && x.store) { cands[u] = { uid: u, empName: x.empName, store: x.store, displayName: x.displayName || "" }; uidByName[x.empName] = uidByName[x.empName] || u; }
    }
    for (const b of Object.values(cands)) {
      if (!b.uid || !b.empName || !b.store) continue;
      if (resignedInfo[b.empName] && resignedInfo[b.empName].effective) continue; // 已生效的離職者不再提醒
      const disp = b.displayName || b.empName;
      for (const ym of months) {
        // 5 號發薪(遇假日順延)：ym 月薪資於「次月發薪提醒日」才提醒(cron 15:00)，提醒日前不提醒
        const [yy, mm2] = ym.split("-").map(Number);
        const payYM = mm2 === 12 ? `${yy + 1}-01` : `${yy}-${String(mm2 + 1).padStart(2, "0")}`;
        if (payYM === nowYM && nowDay < remDay) continue;
        const salSnap = await db.collection("stores").doc(b.store).collection("salary").doc(ym).get().catch(() => null);
        if (!salSnap || !salSnap.exists) continue;
        const sd = salSnap.data();
        if ((sd.status || "draft") !== "published") continue;
        const rec = (sd.records || []).find((r) => r.empName === b.empName);
        if (!rec) continue;
        const ackSnap = await db.collection("salaryAck").doc(`${b.uid}_${ym}`).get().catch(() => null);
        const signed = ackSnap && ackSnap.exists && (ackSnap.data().signedPayHash || "") === (rec.payHash || "");
        if (signed) continue;
        // 7 天節流 + 每個月份最多提醒 3 次（留 1h 緩衝避免每日排程邊界誤判）
        // 2026-08-17 由 2 天放寬成 3 天；2026-09-02 額度預算化再放寬成 7 天並加總次數上限——
        // 沒上限的話，一個從不簽收的人會無限期每 3 天吃掉一則。3 次還不簽就不是通知的問題了，
        // 交給店長（scheduledManagerDigest 會列未簽收名單）當面處理。
        const remRef = db.collection("salaryAckReminder").doc(`${b.uid}_${ym}`);
        const remSnap = await remRef.get().catch(() => null);
        const rem = (remSnap && remSnap.exists) ? remSnap.data() : {};
        const lastAt = rem.lastAt || 0;
        const times = rem.times || 0;
        if (times >= SALARY_ACK_MAX_REMINDS) continue;
        if (NOW - lastAt < SALARY_ACK_REMIND_DAYS * 86400000 - 3600000) continue;
        if (pushIdx.uids.has(b.uid)) {
          await sendPushToUids(db, [b.uid], { title: `✍️ ${ym} 薪資還沒簽收`, body: `${disp}，點這裡完成簽收（第 ${times + 1}/${SALARY_ACK_MAX_REMINDS} 次提醒）`, url: `my-salary.html?month=${ym}`, tag: `salary-ack-${ym}` }, vapid);
        } else if (b.lineUserId) {
          await linePush(b.lineUserId, `💰 ${disp}，你的 ${ym} 薪資已發布但尚未「簽收」。\n請開啟 App →「查看薪水」完成簽名簽收。\n（第 ${times + 1}/${SALARY_ACK_MAX_REMINDS} 次提醒，簽收後即停止）`, token);
        } else continue;
        await remRef.set({ uid: b.uid, ym, empName: b.empName, lastAt: NOW, times: times + 1 }, { merge: true });
      }
    }

    // 離職註記自動標：離職者「存取期限已過」仍未簽的已發布薪資 → 標「離職註記·免簽」讓簽收結案(不用再簽)
    const todayStr = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
    for (const [name, info] of Object.entries(resignedInfo)) {
      const until = resignAccessUntil(info.retireDate);
      if (!until || todayStr <= until) continue; // 期限內：仍讓他自己簽
      let uid = uidByName[name];
      if (!uid) { const us = await db.collection("users").where("empName", "==", name).limit(1).get().catch(() => null); if (us && !us.empty) uid = us.docs[0].id; }
      if (!uid) continue;
      for (const ym of months) {
        const salSnap = await db.collection("stores").doc(info.store).collection("salary").doc(ym).get().catch(() => null);
        if (!salSnap || !salSnap.exists || (salSnap.data().status || "draft") !== "published") continue;
        const rec = (salSnap.data().records || []).find((r) => r.empName === name);
        if (!rec) continue;
        const ackRef = db.collection("salaryAck").doc(`${uid}_${ym}`);
        const ackSnap = await ackRef.get().catch(() => null);
        if (ackSnap && ackSnap.exists && (ackSnap.data().signedPayHash || "") === (rec.payHash || "")) continue; // 已簽/已註記
        await ackRef.set({
          uid, empName: name, store: info.store, month: ym,
          signedPayHash: (rec.payHash || ""), signedAt: new Date().toISOString(),
          resignedNote: true, note: "離職註記·免簽（系統自動）",
        }, { merge: true });
      }
    }
  }
);

// 每日 09:00：當期(上個月)未輸入且今天≥7號 → 提醒該店店長，直到完成為止
// 經營績效發送日推算：從1號起數工作日(跳週六日+國定假日)，第3個工作天的「隔一個日曆天」= 發送日(當月起才提醒)
async function pnlSendDay(db, year, month) {
  const hs = await db.collection("settings").doc("holidays").collection("years").doc(String(year)).get().catch(() => null);
  const holidays = (hs && hs.exists && hs.data().dates) ? hs.data().dates : {};
  let count = 0;
  for (let day = 1; day <= 40; day++) {
    const dateStr = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay(); // 0=日..6=六
    if (dow === 0 || dow === 6 || holidays[dateStr]) continue; // 週末/國定假日不算工作日
    count++;
    if (count === 3) return day + 1; // 第3個工作天的隔一個日曆天
  }
  return 4;
}
// ✂️ scheduledPnlReminder 已整支移除（2026-09-02 額度預算化）。
//    它「沒填就每天念到填為止」而且沒有次數上限——錦花從 2025-08 起就沒輸入過，
//    等於每月固定燒掉約 25 則在同一件事上。已改成 scheduledManagerDigest 裡的一個區塊
//    （一樣每天提醒，但跟其他待辦共用同一則，不再額外占額度）。
//    pnlSendDay() 保留，摘要要用它推算「公司提供報表日」。
//    ⚠️ deploy 時 Firebase 會問是否刪除這支雲端函式，答 yes。

// ===== 系統維護結束（enabled true→false）→ LINE 通知所有登記「完成後通知我」的使用者，並清除登記 =====
exports.onMaintenanceEnded = onDocumentWritten(
  { document: "settings/maintenance", region: "asia-east1", secrets: [LINE_TOKEN, VAPID_PRIVATE] },
  async (event) => {
    const before = event.data.before.exists ? event.data.before.data() : {};
    const after = event.data.after.exists ? event.data.after.data() : {};
    if (!(before.enabled === true && after.enabled === false)) return; // 只在「維護→關閉」
    const db = getFirestore();
    const token = { line: LINE_TOKEN.value(), vapid: VAPID_PRIVATE.value() };
    const snap = await db.collection("maintenanceNotify").get().catch(() => null);
    if (!snap) return;
    const endedAt = new Date().toISOString();
    for (const d of snap.docs) {
      const rec = d.data();
      const disp = rec.displayName || rec.empName || "";
      const r = await deliverToPeople(db, [{ uid: d.id, empName: rec.empName || "", store: rec.store || "" }],
        `✅ 系統維護已完成${disp ? "，" + disp : ""}，現在可以正常登入使用了！`, token,
        { urgent: true, push: { title: "✅ 系統維護已完成", body: `${disp ? disp + "，" : ""}現在可以正常登入使用了`, url: "home.html", tag: "maintenance-ended" } });
      const bound = r.line > 0;
      // 歸檔到歷史(可日後查誰登記等候)，再刪除登記
      await db.collection("maintenanceNotifyLog").add({
        uid: d.id, empName: rec.empName || "", displayName: rec.displayName || "", store: rec.store || "",
        registeredAt: rec.at || "", notifiedAt: endedAt, lineNotified: bound, pushNotified: r.push > 0,
      }).catch(() => {});
      await d.ref.delete().catch(() => {}); // 通知後清除登記
    }
  }
);

// ============ 打卡/出勤 phase2 ============

// 台北 HH:MM
function tpHM(iso, ts) {
  const t = iso ? new Date(iso) : (ts && ts.toDate ? ts.toDate() : new Date());
  return new Date(t.getTime() + 8 * 3600000).toISOString().slice(11, 16);
}

// ===== 缺卡提醒（員工）：每日 20:00 掃未補清單，每人最多 7 天一則 =====
// 為什麼是節流而不是「每天彙整一則」：缺卡幾乎都是「一個人一天一張」，8 月實測 164 張缺卡
// 對應 163 個「人×日」，改成每日彙整只省得到 1 則。唯一有效的省法是拉長間隔——
// 每 7 天一則 → 52 則/月（省 112）。訊息一次列出「目前所有未補的班」，所以不會漏，只是最晚
// 7 天才知道；月結前的把關交給店長（scheduledManagerDigest 每天都會列未補清單）。
// 7 天 → 10 天（2026-09-02 收尾）：保留 onPnlSubmitted 的跨店經營績效通知（那是刻意的管理設計，
// 不是技術冗餘）後預算只剩 1 則餘裕，從這裡騰空間最便宜——店長的每日摘要天天都會列缺卡未補，
// 員工端這條只是備援，拉長到 10 天不會讓任何一筆缺卡沒人管。
const MISS_REMIND_DAYS = 7;   // 2026-09-07 用戶指示：一週發一次
// 20:00 由 scheduledDailyReminders 呼叫
const missClockReminder = (
  async () => {
    const db = getFirestore();
    if (await maintenanceOn(db)) return;
    const cfg = await db.collection("settings").doc("globalConfig").get().catch(() => null);
    const conf = cfg && cfg.exists ? cfg.data() : {};
    const stores = (conf.stores || []).filter((s) => s && s !== "人力支援");
    const attnSince = (conf.clockIn && conf.clockIn.attnSince) || "";
    const token = { line: LINE_TOKEN.value(), vapid: VAPID_PRIVATE.value() };
    const md = (d) => `${+d.slice(5, 7)}/${+d.slice(8, 10)}`;
    const TP_YM = taipeiYM();
    // empName -> { homeStore, items:[{date, text}] }
    const pending = {};
    for (const store of stores) {
      const snap = await db.collection("stores").doc(store).collection("attendance")
        .where("type", "==", "缺卡").get().catch(() => null);
      if (!snap) continue;
      snap.forEach((d) => {
        const r = d.data() || {};
        if (r.voided) return;                              // 已補登/已註銷
        const ds = r.date || "";
        if (!ds || (attnSince && ds < attnSince)) return;   // 提醒起始日之前的不再催
        if (ds.slice(0, 7) !== TP_YM) return;               // 2026-09-07：只催當月份，跨月的舊缺卡交給店長摘要處理
        const emp = r.empName;
        if (!emp) return;
        const p = pending[emp] || (pending[emp] = { homeStore: r.homeStore || store, items: [] });
        p.items.push({ date: ds, text: `${md(ds)} ${store} ${r.shift || ""} ${r.note || "缺卡"}`.replace(/\s+/g, " ").trim() });
      });
    }
    const NOW = Date.now();
    for (const [emp, p] of Object.entries(pending)) {
      if (!p.items.length) continue;
      const ref = db.collection("missClockRemind").doc(emp);
      const snap = await ref.get().catch(() => null);
      const lastAt = (snap && snap.exists) ? (snap.data().lastAt || 0) : 0;
      // 留 1h 緩衝，避免每日排程的邊界誤差讓第 7 天被跳掉
      if (NOW - lastAt < MISS_REMIND_DAYS * 86400000 - 3600000) continue;
      p.items.sort((a, b) => a.date.localeCompare(b.date));
      const list = p.items.slice(0, 20).map((x) => "・" + x.text).join("\n")
        + (p.items.length > 20 ? `\n…等共 ${p.items.length} 筆` : "");
      const ok = await notifyOneEmp(db, emp, p.homeStore,
        `🔴 你本月有 ${p.items.length} 筆缺卡尚未補登\n${list}\n\n如有出勤請盡快申請補登，未補登會影響工時與薪資計算。\n（每週提醒一次，補完即停）\n\n👉 立即補登：https://glade9001.github.io/store-schedule/my-attendance.html`,
        token,
        { push: { title: `🔴 本月有 ${p.items.length} 筆缺卡還沒補登`, body: p.items.slice(0, 4).map((x) => x.text).join("\n") + (p.items.length > 4 ? `\n…等共 ${p.items.length} 筆` : "") + "\n未補登會影響工時與薪資，點這裡補登", url: "my-attendance.html", tag: "miss-clock" } });
      // 沒綁定 LINE 的人也要記時間，否則每天都會重掃重試一次
      await ref.set({ empName: emp, lastAt: NOW, count: p.items.length, sent: !!ok }, { merge: true }).catch(() => {});
    }
  }
);

// ===== 店長每日待辦摘要：每天 17:00 一則，沒事就不發 =====
// 2026-09-02 額度預算化。取代原本六條各自為政的店長端通知（8 月合計約 236 則）：
//   補登申請待審 170、pnl 未輸入 ~25、上週出勤彙整 13、加班申請待審 9、月底結帳 4、跨店支援另計。
// 店長要做的事（審補登、催缺卡、輸損益、月底結帳）本來就是批次工作，沒有一件需要三分鐘內反應，
// 合併後降到「3 店長 × 有事的日子」約 60 則/月。
// 保留一條例外：跨店支援請求仍即時發（onSupportRequest）——那是要別店的人明天到班，等不到 17:00。
// 17:00 由 scheduledDailyReminders 呼叫
const managerDigest = (
  async () => {
    const db = getFirestore();
    if (await maintenanceOn(db)) return;
    const token = { line: LINE_TOKEN.value(), vapid: VAPID_PRIVATE.value() };
    const cfg = await db.collection("settings").doc("globalConfig").get().catch(() => null);
    const conf = cfg && cfg.exists ? cfg.data() : {};
    const stores = (conf.stores || []).filter((s) => s && s !== "人力支援");
    const attnSince = (conf.clockIn && conf.clockIn.attnSince) || "";
    const nowTp = new Date(Date.now() + 8 * 3600000);
    const today = nowTp.toISOString().slice(0, 10);
    const isMonday = nowTp.getUTCDay() === 1;
    const lastDay = new Date(Date.UTC(nowTp.getUTCFullYear(), nowTp.getUTCMonth() + 1, 0)).getUTCDate();
    const isMonthEnd = nowTp.getUTCDate() === lastDay;
    const md = (d) => `${+d.slice(5, 7)}/${+d.slice(8, 10)}`;
    const MAX_LINES = 15; // 一則裡每個區塊最多列 15 行，其餘只給總數（LINE 單則上限 5000 字）
    const listOf = (arr) => arr.sort((a, b) => (a.d || "").localeCompare(b.d || ""))
      .slice(0, MAX_LINES).map((x) => "・" + x.t).join("\n")
      + (arr.length > MAX_LINES ? `\n…等共 ${arr.length} 筆` : "");

    // 經營績效：到期月份與「開始要求輸入」的日子（沿用原 scheduledPnlReminder 的推算）
    const provideDay = await pnlSendDay(db, nowTp.getUTCFullYear(), nowTp.getUTCMonth() + 1);
    const pd = new Date(Date.UTC(nowTp.getUTCFullYear(), nowTp.getUTCMonth(), 1)); pd.setUTCMonth(pd.getUTCMonth() - 1);
    const pnlDueMonth = `${pd.getUTCFullYear()}-${String(pd.getUTCMonth() + 1).padStart(2, "0")}`;
    const pnlDue = nowTp.getUTCDate() >= provideDay + 1 && pnlDueMonth >= "2025-07";
    // 薪資未簽收：只看「最近一個已可查看的月份」，更早的交給店長自己在薪資頁看
    const ackYM = (() => {
      const d = new Date(Date.UTC(nowTp.getUTCFullYear(), nowTp.getUTCMonth(), 1)); d.setUTCMonth(d.getUTCMonth() - 1);
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    })();
    // empName -> [uid]，一次讀完全部，別在門市迴圈裡對每個人各查一次。
    // ⚠️ 存成陣列而不是單一 uid：users 實際上有同名重複帳號（2026-09-02 盤點發現某員工有兩份，
    //    同店同工號），只取第一個有可能取到那個沒人在用的孤兒 uid → 明明簽收了卻被列成未簽收。
    const uidsByName = {};
    const allUsers = await db.collection("users").get().catch(() => null);
    if (allUsers) allUsers.forEach((d) => {
      const u = d.data() || {};
      if (u.empName) (uidsByName[u.empName] = uidsByName[u.empName] || []).push(d.id);
    });

    for (const store of stores) {
      const blocks = [];

      // 1. 補登/修改申請待審（不限日期：躺著沒審對員工最不利）
      const reqSnap = await db.collection("stores").doc(store).collection("attendanceRequests")
        .where("status", "==", "pending").get().catch(() => null);
      const reqs = [];
      if (reqSnap) reqSnap.forEach((d) => {
        const r = d.data() || {};
        const dn = r.displayName || r.empName || "";
        reqs.push({ d: r.targetDate || "", t: `${dn} ${r.targetDate || ""} ${r.punchType || ""} ${r.requestedTime || ""}｜${r.reason || "—"}`.replace(/\s+/g, " ").trim() });
      });
      if (reqs.length) blocks.push(`📝 補登待審 ${reqs.length} 筆\n${listOf(reqs)}`);

      // 2. 加班申請待審（同樣不限日期：未審核＝超時不計工時，躺越久對員工越不利）
      const otSnap = await db.collection("stores").doc(store).collection("attendance")
        .where("otStatus", "==", "pending").get().catch(() => null);
      const ot = [];
      if (otSnap) otSnap.forEach((d) => {
        const r = d.data() || {};
        if (r.voided) return;
        const dn = r.displayName || r.empName || "";
        const ds = r.date || "";
        ot.push({ d: ds, t: `${dn} ${ds ? md(ds) : ""} ${r.type || ""} ${tpHM(r.deviceTs, r.ts)}｜${r.otContent || "—"}`.replace(/\s+/g, " ").trim() });
      });
      if (ot.length) blocks.push(`📝 加班待審 ${ot.length} 筆　未審核＝超時不計工時\n${listOf(ot)}`);

      // 3. 缺卡未補（員工端只有每 7 天一則，店長這裡是月結前的最後把關）
      // ⚠️ 明細只列近 14 天。實測 2026-09-02 三店累積 54/44/31 筆未補，全列出來每天都是同一批舊資料，
      //    摘要會直接變成沒人看的雜訊（README 已記過這個教訓：清單一有雜訊，真正該補的也會被忽略）。
      //    更舊的只用一行講總數，要處理就到出勤管理頁。
      const MISS_DETAIL_DAYS = 14;
      const cutoff = new Date(nowTp.getTime() - MISS_DETAIL_DAYS * 86400000).toISOString().slice(0, 10);
      const missSnap = await db.collection("stores").doc(store).collection("attendance")
        .where("type", "==", "缺卡").get().catch(() => null);
      const miss = []; let missOld = 0;
      if (missSnap) missSnap.forEach((d) => {
        const r = d.data() || {};
        if (r.voided) return;
        const ds = r.date || "";
        if (!ds || (attnSince && ds < attnSince)) return;
        if (ds < cutoff) { missOld++; return; }
        const dn = r.displayName || r.empName || "";
        miss.push({ d: ds, t: `${dn} ${md(ds)} ${r.shift || ""} ${r.note || "缺卡"}`.replace(/\s+/g, " ").trim() });
      });
      if (miss.length || missOld) {
        let b = miss.length
          ? `🔴 缺卡未補 ${miss.length} 筆（近 ${MISS_DETAIL_DAYS} 天）　請提醒員工補登\n${listOf(miss)}`
          : `🔴 缺卡未補（近 ${MISS_DETAIL_DAYS} 天無新增）`;
        if (missOld) b += `\n・另有 ${missOld} 筆超過 ${MISS_DETAIL_DAYS} 天仍未補，請至出勤管理清理`;
        blocks.push(b);
      }

      // 4. 上週出勤異常（遲到/早退）：維持每週一彙整，不必天天重複同一批
      if (isMonday) {
        const monTp = new Date(nowTp.getTime() - 7 * 86400000);
        let mon = monTp.toISOString().slice(0, 10);
        const sun = new Date(monTp.getTime() + 6 * 86400000).toISOString().slice(0, 10);
        if (attnSince && attnSince > mon) mon = attnSince;
        if (mon <= sun) {
          const aSnap = await db.collection("stores").doc(store).collection("attendance")
            .where("date", ">=", mon).where("date", "<=", sun).get().catch(() => null);
          const anom = [];
          if (aSnap) aSnap.forEach((d) => {
            const r = d.data() || {};
            if (r.voided) return;
            if (r.status !== "遲到" && r.status !== "早退") return;
            const dn = r.displayName || r.empName || "";
            const tail = r.status === "遲到" ? `遲到 ${r.lateMin || ""} 分` : "早退";
            anom.push({ d: r.date, t: `${dn} ${md(r.date)} ${r.type} ${tpHM(r.deviceTs, r.ts)}（${tail}）` });
          });
          if (anom.length) blocks.push(`⚠️ 上週出勤異常 ${anom.length} 筆（${md(mon)}–${md(sun)}）\n${listOf(anom)}`);
        }
      }

      // 4-2. 本月補登概況（2026-09-16）：逐筆審核看不出「誰一直補」，97.5% 全准就是這樣來的。
      //      只在每週一與每月 1 號發，避免天天重複同一份名單。
      const dow = new Date(Date.now() + 8 * 3600000).getUTCDay();
      const dom = new Date(Date.now() + 8 * 3600000).getUTCDate();
      if (dow === 1 || dom === 1) {
        const ym = taipeiYM();
        const rqSnap = await db.collection("stores").doc(store).collection("attendanceRequests")
          .where("targetDate", ">=", `${ym}-01`).where("targetDate", "<=", `${ym}-31`).get().catch(() => null);
        const byEmp = {}; let claim = 0; const byReason = {};
        if (rqSnap) rqSnap.forEach((d) => {
          const r = d.data() || {};
          const dn = r.displayName || r.empName || "";
          byEmp[dn] = (byEmp[dn] || 0) + 1;
          if (r.claimOnTime) claim++;
          const rc = r.reasonCode || "(未分類)";
          byReason[rc] = (byReason[rc] || 0) + 1;
        });
        const total = Object.values(byEmp).reduce((a, b) => a + b, 0);
        if (total) {
          const top = Object.entries(byEmp).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([n, c]) => `・${n} ${c} 張`).join("\n");
          const rmap = { forgot: "忘記打卡", device: "手機沒帶/沒電", system: "打不進去", support: "支援他店不知在哪打", noshift: "沒排班但到場", wrongtime: "時間打錯", other: "其他" };
          const rtop = Object.entries(byReason).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, c]) => `${rmap[k] || k} ${c}`).join("、");
          blocks.push(`📋 ${+ym.slice(5)} 月補登 ${total} 張${claim ? `（其中 ${claim} 張自述準時）` : ""}\n${top}\n・主要原因：${rtop}`);
        }
      }

      // 5. 薪資未簽收（員工端提醒有 3 次上限，之後就靠店長當面處理）
      const salSnap = await db.collection("stores").doc(store).collection("salary").doc(ackYM).get().catch(() => null);
      if (salSnap && salSnap.exists && (salSnap.data().status || "draft") === "published") {
        const recs = salSnap.data().records || [];
        const unsigned = [];
        for (const r of recs) {
          if (!r || !r.empName) continue;
          const uids = uidsByName[r.empName] || [];
          if (!uids.length) continue;
          let signed = false;
          for (const uid of uids) {
            const ack = await db.collection("salaryAck").doc(`${uid}_${ackYM}`).get().catch(() => null);
            if (ack && ack.exists && (ack.data().signedPayHash || "") === (r.payHash || "")) { signed = true; break; }
          }
          if (!signed) unsigned.push(r.displayName || r.empName);
        }
        if (unsigned.length) blocks.push(`💰 ${+ackYM.slice(5)} 月薪資未簽收 ${unsigned.length} 人\n・${unsigned.join("、")}`);
      }

      // 6. 經營績效未輸入
      if (pnlDue) {
        const pSnap = await db.collection("stores").doc(store).collection("pnl").doc(pnlDueMonth).get().catch(() => null);
        if (!pSnap || !pSnap.exists) {
          blocks.push(`📊 尚未輸入 ${+pnlDueMonth.slice(5)} 月經營績效（損益表）\n・「更多管理 → 經營績效專區」，請於 10 號前完成`);
        }
      }

      // 7. 待補缺口（本週＋下週還沒有人認領的 🆘）
      // 2026-09-03 起「被支援店」不再收到跨店支援的即時通知（approved/filled/cancelled 都砍了），
      // 所以支援被取消、或開了缺口都沒人認領，那邊會完全無感。這個區塊就是那條路的替代：
      // 摘要本來就會發，列缺口不多花一則額度，而且比逐事件通知更接近店長真正要看的東西
      // ——「我現在還缺幾個人」，而不是「剛剛發生了什麼」。
      const gapWeeks = [weekStrOfTp(nowTp), weekStrOfTp(new Date(nowTp.getTime() + 7 * 86400000))];
      const gaps = [];
      for (const wk of gapWeeks) {
        const wSnap = await db.collection("stores").doc(store).collection("weeks").doc(wk).get().catch(() => null);
        if (!wSnap || !wSnap.exists) continue;
        for (const r of (wSnap.data().records || [])) {
          if (!r || !String(r.name || "").startsWith("🆘")) continue;
          if (r.supportEmp && r.approvalStatus === "approved") continue; // 已有人認領/核准
          const di = WEEK_DAYS.indexOf(r.day);
          let when = r.day || "";
          if (di >= 0) { const mo = weekMondayDate(wk); const dd = new Date(mo); dd.setDate(mo.getDate() + di); when = `${dd.getMonth() + 1}/${dd.getDate()}（${r.day}）`; }
          gaps.push({ d: wk + String(di), t: `${when} ${r.shift || ""}${r.approvalStatus === "pending" ? "　審核中" : ""}`.replace(/\s+/g, " ").trim() });
        }
      }
      if (gaps.length) blocks.push(`🆘 待補缺口 ${gaps.length} 格（本週＋下週）　尚無人支援\n${listOf(gaps)}`);

      // 8. 月底結帳（原 scheduledMonthEndReminder，改成掛在摘要裡）
      if (isMonthEnd) blocks.push("🧾 今天是月底：結帳 17:00、匯款 17:59 前\n・週轉金請勿超過留存上限");

      if (!blocks.length) continue; // 沒事就不發，別浪費額度
      const msg = `📋 ${store} 待辦摘要（${md(today)}）\n\n${blocks.join("\n\n")}\n\n👉 出勤管理：https://glade9001.github.io/store-schedule/attendance.html`;
      await notifyStoreManagers(db, store, msg, token,
        { push: pushFromText(`📋 ${store} 待辦摘要（${md(today)}）\n${blocks.join("\n\n")}`, { url: "attendance.html", tag: `digest-${store}` }) });
    }
  }
);

// ===== 門市備忘（客訂／留貨單）：結案 14 天後清掉客人電話（2026-09-25）=====
// 個資最小化：取貨結案後電話已無用途，留著只是風險。只清 phone，其餘紀錄（誰、何時推進）保留。
const MEMO_PHONE_KEEP_DAYS = 14;
async function memoPhoneCleanup(db) {
    const cutoff = Date.now() - MEMO_PHONE_KEEP_DAYS * 86400000;
    const snap = await db.collection("storeMemos").where("status", "==", 3).get();
    let n = 0;
    const batch = db.batch();
    snap.forEach((d) => {
      const m = d.data();
      if (m.phone && typeof m.closedAt === "number" && m.closedAt < cutoff) {
        batch.update(d.ref, { phone: "", phoneClearedAt: Date.now() });
        n++;
      }
    });
    if (n) await batch.commit();
    console.log(`memo phone cleanup: ${n} cleared`);
}

// ===== 每日提醒（2026-10-15 合併：原 scheduledSalaryAckReminder 15:00／scheduledManagerDigest 17:00／scheduledMissClockReminder 20:00）=====
// Cloud Scheduler 按排程個數收費，三支併成一個排程；發送時間與內容都不變，依台北時間的「整點」決定跑哪一件。
// ⚠️ 要改其中一件的時間：schedule 的小時清單＋ DAILY_REMINDERS 的鍵要一起改。
// 重試（retryCount 3，重試間隔是秒級，不會跨到下一個整點）：
//   - 雲端沒機器、還沒開始跑就失敗 → 三件都會重試（原本只有薪資簽收有重試，其餘直接少一天）
//   - 程式跑到一半出錯 → 只有薪資簽收照原本重試；店長摘要／缺卡提醒原本就不重試（重跑可能重複發），維持不重試
const DAILY_REMINDERS = {
  15: { run: salaryAckReminder, retry: true },
  17: { run: managerDigest, retry: false },
  20: { run: missClockReminder, retry: false },
};
exports.scheduledDailyReminders = onSchedule(
  { schedule: "0 15,17,20 * * *", timeZone: "Asia/Taipei", region: "asia-east1", secrets: [LINE_TOKEN, VAPID_PRIVATE], retryCount: 3 },
  async () => {
    const hour = new Date(Date.now() + 8 * 3600000).getUTCHours();
    const job = DAILY_REMINDERS[hour];
    if (!job) { console.warn("[dailyReminders] 這個整點沒有要跑的提醒", hour); return; }
    try { await job.run(); } catch (e) {
      console.error(`[dailyReminders] ${hour}:00 失敗`, e);
      if (job.retry) throw e;
    }
  }
);

// ===== 每天 04:30 清理（2026-10-15 合併：原 scheduledMemoPhoneCleanup＋scheduledGbPurge）=====
// Cloud Scheduler 每個帳戶只有 3 個免費排程、之後按個數收費，同時間的清理併成一支。
// 兩件事各自 try/catch，一件失敗不影響另一件；有失敗最後再丟出，讓 log 標成錯誤。
exports.scheduledDailyCleanup = onSchedule(
  { schedule: "30 4 * * *", timeZone: "Asia/Taipei", region: "asia-east1" },
  async () => {
    const db = getFirestore();
    const errors = [];
    try { await memoPhoneCleanup(db); } catch (e) { console.error("[dailyCleanup] memo", e); errors.push(e); }
    try {
      const rep = await require("./groupbuy").purgeOldGb(db, { dry: false });
      console.log("[gbPurge]", JSON.stringify({ campaigns: rep.campaigns.length, orders: rep.orders, pending: rep.pending, postMap: rep.postMap }));
    } catch (e) { console.error("[dailyCleanup] gbPurge", e); errors.push(e); }
    if (errors.length) throw errors[0];
  }
);
