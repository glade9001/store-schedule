// ===== common.js（2026-10-16 從 index.js 拆出來；程式原文照搬、只加 require／exports 接線）=====
// 拆法：只有這個功能用到的放這裡，兩個以上功能用到的放 common.js。新增共用小函式請放 common.js。
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { defineSecret } = require("firebase-functions/params");
const webpush = require("web-push");

// 店長以上才可重設他人密碼（與前端 canManageEmployee 一致）
const ALLOWED_PERMS = ["manager", "owner", "admin"];

// ===== LINE 通知：綁定 webhook（綁定碼版）=====
// 金鑰用 Secret（部署時設定，不進程式碼/前端）：
//   firebase functions:secrets:set LINE_CHANNEL_ACCESS_TOKEN
//   firebase functions:secrets:set LINE_CHANNEL_SECRET

const LINE_TOKEN = defineSecret("LINE_CHANNEL_ACCESS_TOKEN");

// ===== PWA 推播核心（2026-09-15；說明見檔案最下方「PWA 推播」區）=====
// 放在這裡是因為各通知函式的 secrets 選項在載入時就要用到 VAPID_PRIVATE
const VAPID_PRIVATE = defineSecret("WEB_PUSH_VAPID_PRIVATE");
const VAPID_PUBLIC = "BGhmoFm3LcXdHVJf0Abc6b5WtJzx25nktsKM01MQ7zUf6otCr6kOaTnGVQ0qUbGtuQf5W15muw55rRcfzZZi3cA";
const VAPID_SUBJECT = "https://store-schedule-3b056.web.app";

// 送給指定 uid 的所有裝置；推播服務回 404/410＝訂閱已失效（解除安裝、清除網站資料）→ 順手刪掉
async function sendPushToUids(db, uids, payload, privateKey) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, privateKey);
  const body = JSON.stringify(payload);
  let sent = 0, failed = 0, removed = 0;
  for (const uid of [...new Set(uids)].filter(Boolean)) {
    const subs = await db.collection("pushSubs").where("uid", "==", uid).get();
    // 同一個人、同一種平台有好幾份訂閱（通常是 github.io 與 web.app 各訂一份＝同一台手機）→ 只送最近用過的那份，避免同一則收兩次
    const ms = (t) => (t && t.toMillis ? t.toMillis() : 0);
    const latest = {};
    subs.docs.forEach((d) => {
      const k = d.data().platform || "?";
      if (!latest[k] || ms(d.data().lastSeenAt) > ms(latest[k].data().lastSeenAt)) latest[k] = d;
    });
    for (const d of Object.values(latest)) {
      const s = d.data();
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, body, { TTL: 3600 });
        sent++;
        await d.ref.update({ lastPushAt: FieldValue.serverTimestamp() }).catch(() => {});
      } catch (e) {
        if (e.statusCode === 404 || e.statusCode === 410) { await d.ref.delete().catch(() => {}); removed++; }
        else { failed++; console.warn("[push] 送出失敗", uid, e.statusCode, e.body || e.message); }
      }
    }
  }
  return { sent, failed, removed };
}


// LINE API 呼叫的共同善後：非 2xx 也要出聲。
// ⚠️ 舊版只有 .catch()，那只接得到網路層錯誤 —— HTTP 429（免費方案 200 則/月用罄）
//    完全不會 throw，於是「通知整批消失」卻連一行 log 都沒有（2026-08-17 才發現）。
//    額度類錯誤另外寫 notifyFailures，讓人查得到是哪天開始斷的。
async function lineCall(kind, url, payload, token, meta) {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
    });
    if (res.ok) return true;
    const body = await res.text().catch(() => "");
    console.error(`${kind} 失敗 HTTP ${res.status}`, body.slice(0, 300), meta || "");
    // 429=額度用罄／頻率限制，401/403=金鑰失效 → 這幾種是「全站性」故障，留檔備查
    if ([401, 403, 429].includes(res.status)) {
      await getFirestore().collection("notifyFailures").add({
        kind, status: res.status, body: body.slice(0, 500),
        to: (meta && meta.to) || null, at: new Date().toISOString(),
        ts: FieldValue.serverTimestamp(),
      }).catch(() => {});
    }
    return false;
  } catch (e) {
    console.error(`${kind} 失敗（網路層）`, e);
    return false;
  }
}

// 推播給單一 lineUserId（供之後事件通知共用）
async function linePush(lineUserId, text, token) {
  return lineCall("linePush", "https://api.line.me/v2/bot/message/push",
    { to: lineUserId, messages: [{ type: "text", text }] }, token, { to: lineUserId });
}

// ===== 通知通道：推播優先、LINE 補位（2026-09-15 使用者定案）=====
// ・原本就走 LINE 的通知：收件人有開推播 → 只發推播；沒開 → 照舊發 LINE（開推播的人越多，LINE 額度越省）
// ・當初為了省 LINE 額度砍掉、這次恢復的通知（班表已發布、下班打卡提醒、補登結果）：pushOnly，沒開推播就不發
// ・22:00–08:00 的一般推播先進 pushQueue，08:00 後由 scheduledScheduleNotifyFlush 送出；跟班別綁定的打卡提醒 urgent 不受限
// 收件人對應：pushSubs 文件本身帶 empName／store（pushSubscribe 時寫入），不必另讀 users。
function taipeiHour() { return new Date(Date.now() + 8 * 3600000).getUTCHours(); }
function inQuietHours() { const h = taipeiHour(); return h >= 22 || h < 8; }

// 讀一次 pushSubs → { uids:Set, uidByEmp:{empName:[{uid,store}]} }（同一次執行內重用）
let _pushIdxCache = null; // 同一個執行個體 60 秒內重用（一次事件常會呼叫好幾個通知函式）
async function loadPushIndex(db) {
  if (_pushIdxCache && Date.now() - _pushIdxCache.at < 60000) return _pushIdxCache.idx;
  const idx = await _loadPushIndex(db);
  _pushIdxCache = { at: Date.now(), idx };
  return idx;
}
async function _loadPushIndex(db) {
  const snap = await db.collection("pushSubs").get().catch(() => null);
  const uids = new Set(); const uidByEmp = {};
  if (snap) snap.forEach((d) => {
    const x = d.data() || {};
    if (!x.uid) return;
    uids.add(x.uid);
    if (x.empName) {
      const list = (uidByEmp[x.empName] = uidByEmp[x.empName] || []);
      if (!list.some((y) => y.uid === x.uid)) list.push({ uid: x.uid, store: x.store || "", permission: x.permission || "employee" });
    }
  });
  return { uids, uidByEmp };
}
function pushUidOf(idx, empName, store) {
  const list = (idx && idx.uidByEmp[empName]) || [];
  const hit = list.find((x) => x.store === store) || list[0];
  return hit ? hit.uid : null;
}
// LINE 文字 → 推播（第一行當標題、其餘當內文）
function pushFromText(text, extra) {
  const lines = String(text || "").split("\n");
  const title = (lines.shift() || "莉學商行").trim();
  const body = lines.join("\n").replace(/\n{2,}/g, "\n").trim().slice(0, 600);
  return Object.assign({ title, body, url: "home.html" }, extra || {});
}
// 送一則推播；非緊急且在夜間 → 排隊到 08:00
async function sendOrQueuePush(db, uids, payload, vapid, urgent) {
  const list = [...new Set(uids)].filter(Boolean);
  if (!list.length || !vapid) return { sent: 0 };
  if (!urgent && inQuietHours()) {
    await db.collection("pushQueue").add({ uids: list, payload, createdAt: FieldValue.serverTimestamp() });
    return { queued: list.length };
  }
  return sendPushToUids(db, list, payload, vapid);
}
// keys 相容舊呼叫：字串＝只有 LINE token；物件＝{ line, vapid }
function notifyKeys(token) { return typeof token === "string" ? { line: token } : (token || {}); }

// 第二批（2026-09-15）共用：對一群人發同一則通知，每個人各自決定走推播或 LINE
// people：[{ uid?, empName?, store? }]（有 uid 用 uid 對；只有 empName 就用 pushSubs／lineBindings 的 empName 對，偏好同店）
// opts.push：推播內容（物件；省略則由 text 轉換）、opts.url／tag：轉換時附上、opts.urgent：夜間也立刻送
// 回傳 { push, line }
async function deliverToPeople(db, people, text, token, opts) {
  const keys = notifyKeys(token); const o = opts || {};
  const out = { push: 0, line: 0 };
  const idx = keys.vapid ? await loadPushIndex(db) : null;
  const pushUids = []; const seen = new Set();
  for (const p of people || []) {
    const key = p.uid || `${p.empName}|${p.store || ""}`;
    if (!key || seen.has(key)) continue; seen.add(key);
    let uid = null;
    if (idx) uid = (p.uid && idx.uids.has(p.uid)) ? p.uid : (p.empName ? pushUidOf(idx, p.empName, p.store || "") : null);
    if (uid) { if (!pushUids.includes(uid)) { pushUids.push(uid); out.push++; } continue; }
    if (!keys.line) continue;
    let lineUserId = null;
    if (p.uid) {
      const b = await db.collection("lineBindings").doc(p.uid).get().catch(() => null);
      if (b && b.exists) lineUserId = b.data().lineUserId || null;
    }
    if (!lineUserId && p.empName) {
      const snap = await db.collection("lineBindings").where("empName", "==", p.empName).get().catch(() => null);
      if (snap && !snap.empty) {
        const arr = []; snap.forEach((d) => arr.push(d.data()));
        const b = arr.find((x) => x.store === p.store) || arr[0];
        lineUserId = (b && b.lineUserId) || null;
      }
    }
    if (lineUserId && await linePush(lineUserId, text, keys.line)) out.line++;
  }
  if (pushUids.length) {
    const payload = o.push || pushFromText(text, { url: o.url || "home.html", ...(o.tag ? { tag: o.tag } : {}) });
    await sendOrQueuePush(db, pushUids, payload, keys.vapid, !!o.urgent);
  }
  return out;
}

// 依 empName 找 LINE 綁定（優先同 store）並推播；buildText(displayName, empName)→訊息
// 系統維護模式：開啟時，班表相關的 LINE 通知全部暫停（避免維護/整理時狂發）
async function maintenanceOn(db) {
  const d = await db.collection("settings").doc("maintenance").get().catch(() => null);
  return !!(d && d.exists && d.data().enabled);
}
// opts：{ push:(name,emp)=>推播內容（省略則由文字轉換）, pushOnly:true＝沒開推播就不發 LINE, urgent }
// 回傳 { push, line }：實際走推播／LINE 的人數
async function notifyEmployees(db, empNames, store, buildText, token, opts) {
  const names = [...new Set((empNames || []).filter(Boolean))];
  const o = opts || {}; const keys = notifyKeys(token);
  const out = { push: 0, line: 0 };
  if (!names.length) return out;
  const idx = keys.vapid ? await loadPushIndex(db) : null;
  const byEmp = {};
  if (!o.pushOnly && keys.line) {
    const snap = await db.collection("lineBindings").get();
    snap.forEach((d) => {
      const b = d.data();
      if (!b.empName || !b.lineUserId) return;
      (byEmp[b.empName] = byEmp[b.empName] || []).push(b);
    });
  }
  const pushGroups = new Map(); // 內容相同的人合併成一次 sendOrQueuePush（夜間只排一筆佇列）
  for (const emp of names) {
    const list = byEmp[emp] || [];
    const b = list.find((x) => x.store === store) || list[0];
    const name = (b && b.displayName) || emp;
    const uid = idx ? pushUidOf(idx, emp, store) : null;
    if (uid) {
      const payload = o.push ? o.push(name, emp) : pushFromText(buildText(name, emp));
      const k = JSON.stringify(payload);
      (pushGroups.get(k) || pushGroups.set(k, { payload, uids: [] }).get(k)).uids.push(uid);
      out.push++;
      continue;
    }
    if (o.pushOnly || !b || !keys.line) continue;
    await linePush(b.lineUserId, buildText(name, emp), keys.line);
    out.line++;
  }
  for (const g of pushGroups.values()) await sendOrQueuePush(db, g.uids, g.payload, keys.vapid, o.urgent);
  return out;
}

// ===== 個人週班表文字（條列每日一行）=====
const WEEK_DAYS = ["週一", "週二", "週三", "週四", "週五", "週六", "週日"];
// 週一日期（簡單週字串，對應 schedule-V2 weeks doc）
function weekMondayDate(wStr) {
  const [y, w] = String(wStr).split("-W");
  const yr = parseInt(y), wk = parseInt(w);
  const d = new Date(yr, 0, 1);
  const day = d.getDay();
  d.setDate(d.getDate() + (wk - 1) * 7);
  d.setDate(d.getDate() + (day <= 4 ? 1 - day : 8 - day));
  return d;
}

// 修復 Firestore v2 觸發器參數的中文亂碼（UTF-8 被當 latin1 解碼）
// 例：「聯鑫」→「è¯é«」。已是正確 CJK 則原樣返回（安全雙向）。
function fixStoreName(s) {
  if (typeof s !== "string" || !s) return s;
  // 已含 CJK 且無 latin1 高位字元 → 視為正確，不動
  if (/[\u0100-\uFFFF]/.test(s) && !/[\u0080-\u00FF]/.test(s)) return s;
  if (/[\u0080-\u00FF]/.test(s)) {
    try {
      const fixed = Buffer.from(s, "latin1").toString("utf8");
      if (!fixed.includes("\uFFFD")) return fixed;
    } catch (e) { /* keep original */ }
  }
  return s;
}

// 台北時區今日年月 YYYY-MM
function taipeiYM() {
  return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 7);
}

// 通知某店店長（permission=manager 且 store 相符）的 LINE 綁定
// 通知某店「店長」——依門市員工 role=店長 判斷（涵蓋登入權限為 admin/owner 但職務是店長者，如美德楷岳），
// 不再只看 users.permission==manager（會漏掉兼任店長的 admin/owner）。
async function notifyStoreManagers(db, store, text, token, opts) {
  const es = await db.collection("stores").doc(store).collection("employees").get().catch(() => null);
  if (!es) return { push: 0, line: 0 };
  const leads = [];
  es.forEach((d) => { const e = d.data() || {}; if (e.role === "店長" && !["離職", "調走"].includes(e.status)) leads.push(d.id); });
  return deliverToPeople(db, leads.map((empName) => ({ empName, store })), text, token, opts);
}

// ✂️ onSupportRequest（跨店支援請求／取消 → 通知店長）已整支移除（2026-09-07 用戶指示取消發送）。
//    支援的申請與審核狀態在排班頁與待補看板上看得到，不再另發 LINE。
// ===== 月加班累計預警（優先2）=====
// 某店某月每位員工的工時與加班（公式同 salary-calc calcEmpHours：每日 max(0,h-8)，isOT 或日>8h；跳過休假/時薪；去重同員工同日）
async function monthWorkedByEmp(db, store, ym) {
  const [y, m] = ym.split("-").map(Number);
  const lastDay = new Date(y, m, 0).getDate();
  const weekSet = new Set();
  for (let d = 1; d <= lastDay; d++) weekSet.add(weekStrOfTp(new Date(Date.UTC(y, m - 1, d))));
  const byEmpDay = {}; // emp -> { dateKey: {h,ot} }
  for (const wk of weekSet) {
    const snap = await db.collection("stores").doc(store).collection("weeks").doc(wk).get().catch(() => null);
    if (!snap || !snap.exists) continue;
    const mon = weekMondayDate(wk);
    for (const r of (snap.data().records || [])) {
      if (!r || !r.name || String(r.name).startsWith("🆘") || r.name === "門市備註") continue;
      if (r.isHourly) continue;
      const sh = r.shift;
      if (!sh || ["排休", "指休", "特休", "補休", "清空"].includes(sh)) continue;
      const dIdx = WEEK_DAYS.indexOf(r.day);
      if (dIdx < 0) continue;
      const cd = new Date(mon); cd.setDate(mon.getDate() + dIdx);
      if (cd.getFullYear() !== y || cd.getMonth() + 1 !== m) continue;
      const h = parseFloat(r.actualHours || 0);
      const ot = (r.isOT || h > 8) ? Math.max(0, h - 8) : 0;
      (byEmpDay[r.name] = byEmpDay[r.name] || {})[`${cd.getDate()}`] = { h, ot }; // 同員工同日去重（跨店雙記錄）
    }
  }
  const out = {};
  for (const emp in byEmpDay) {
    let hours = 0, ot = 0;
    for (const k in byEmpDay[emp]) { hours += byEmpDay[emp][k].h; ot += byEmpDay[emp][k].ot; }
    out[emp] = { hours, ot };
  }
  return out;
}

// ===== 週字串工具（雲端複刻前端）=====
// ✂️ isoWeekStr（ISO-8601，對應 leave-request.html dateToWeekStr ＝ leaveRequests.week）已移除：
//    唯一呼叫者是同日刪掉的 scheduledLeaveReminder。若日後又要「日期→leaveRequests.week」，
//    請從 git 取回本函式，不要拿下面的 weekStrOfTp 代用——兩者週界定義不同（見 commit 訊息）。
// weeks doc id 的正解：schedule-V2.html getWeekDates() 的精準反函式（每週以「週一」起算）。
// ⚠️ 舊的 simpleWeekStr（直接把「日期＋時間」套年度週次）已於 2026-08-09 全面移除——
//    它的週界會隨該年 1/1 是星期幾而變，且含時間的 Date 會讓天數帶小數而整個進位一週。
//    任何「日期 → 週字串」都必須走本函式，不要再自行推導。
// 傳入的是「台北牆上時間」的 Date（nowMs + 8h），故一律用 UTC getter 讀取，不受執行環境時區影響。
function week1MondayUTC(yr) {
  const d = new Date(Date.UTC(yr, 0, 1));
  const day = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() + (day <= 4 ? 1 - day : 8 - day));
  return d;
}
function weekStrOfTp(tpDate) {
  const s = new Date(tpDate);
  const mon = new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate()));
  mon.setUTCDate(mon.getUTCDate() - ((mon.getUTCDay() + 6) % 7));
  let yr = mon.getUTCFullYear();
  if (mon < week1MondayUTC(yr)) yr--; else if (mon >= week1MondayUTC(yr + 1)) yr++;
  const w = Math.round((mon - week1MondayUTC(yr)) / 604800000) + 1;
  return `${yr}-W${w < 10 ? "0" + w : w}`;
}
// 讀全域門市清單（settings/globalConfig.stores）
async function getAllStores(db) {
  const snap = await db.collection("settings").doc("globalConfig").get();
  const s = snap.exists ? snap.data() : {};
  return Array.isArray(s.stores) ? s.stores.filter(Boolean) : [];
}

// 回傳 true=推播成功、false=沒綁定或 LINE 拒收（呼叫端可據此決定要不要留痕/重試）
async function notifyOneEmp(db, empName, store, text, token, opts) {
  if (!empName) return false;
  const r = await deliverToPeople(db, [{ empName, store }], text, token, opts);
  return (r.push + r.line) > 0;
}

// A. 打卡事件 → 成功回執給員工；異常(遲到/早退)加通知店長(接收店+原店)
// ✂️ onClockPunch 已整支移除（2026-09-02）。它最後只剩「加班申請待審→店長」一種推播，
//    而那已改由 scheduledManagerDigest 每天撈 otStatus==pending 一起催（躺著沒審會被持續提醒，
//    比「當下一則、之後石沉大海」更不容易漏）。留著等於每筆打卡都白觸發一次函式。
//    更早之前砍掉的：打卡成功回執（2026-08-17，8/1–8/17 就吃掉 95 則）、遲到/早退即時通知店長。
//    ⚠️ deploy 時 Firebase 會問是否刪除這支雲端函式，答 yes。

// A-2. 打卡／補登成立 → 自動註銷對應的缺卡標記（2026-08-28）
// 為什麼需要：缺卡標記是排程在「班別結束後 2 小時」寫下的，但之後不論員工自己補打（下班配對
// 視窗到 +3h，比 2h 晚）、店長核准補登申請、或店長直接改一筆卡，都沒有任何一條路會回頭動那張
// 標記。8 月實測 184 筆有效缺卡裡有 36 筆（19%）其實早就補齊了，卻還掛在員工首頁紅字與店長
// 清單上。清單一旦五分之一是雜訊就沒人願意看，剩下真正該補的也會跟著被忽略。
// 為什麼掛 trigger 而不是寫在各補登按鈕裡：來源有 app／offline／店長核准／店長直接改四條路，
// 各自實作一份必然漏掉一條，而且未來新增第五條時沒人會記得補。
function addDaysStr(ds, n) {
  const d = new Date(`${ds}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

module.exports = { ALLOWED_PERMS, LINE_TOKEN, VAPID_PRIVATE, VAPID_PUBLIC, VAPID_SUBJECT, sendPushToUids, lineCall, linePush, taipeiHour, inQuietHours, _pushIdxCache, loadPushIndex, _loadPushIndex, pushUidOf, pushFromText, sendOrQueuePush, notifyKeys, deliverToPeople, maintenanceOn, notifyEmployees, WEEK_DAYS, weekMondayDate, fixStoreName, taipeiYM, notifyStoreManagers, monthWorkedByEmp, week1MondayUTC, weekStrOfTp, getAllStores, notifyOneEmp, addDaysStr };
