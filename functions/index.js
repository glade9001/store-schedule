// Cloud Functions — 莉學商行管理系統
// 目前僅含「店長以上重設員工登入密碼」功能。
// 前端無法改別人的 Firebase Auth 密碼，故由 Admin SDK 代為更新。
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");

admin.initializeApp();

// 店長以上才可重設他人密碼（與前端 canManageEmployee 一致）
const ALLOWED_PERMS = ["manager", "owner", "admin"];

// 與前端 auth.js 的 _padPwd 一致：補滿至 6 碼（Firebase Auth 最低長度）
const padPwd = (pwd) => String(pwd || "").padEnd(6, "0");
const toEmail = (empId) => `${String(empId).toLowerCase()}@lixue.internal`;

exports.adminResetPassword = onCall({ region: "asia-east1" }, async (request) => {
  const auth = request.auth;
  if (!auth) throw new HttpsError("unauthenticated", "請先登入");

  // 1) 驗證呼叫者權限（讀 users/{uid}.permission）
  const callerSnap = await admin.firestore().collection("users").doc(auth.uid).get();
  const caller = callerSnap.data();
  if (!caller || !ALLOWED_PERMS.includes(caller.permission)) {
    throw new HttpsError("permission-denied", "權限不足，需店長以上");
  }

  // 2) 參數驗證
  const empId = String(request.data?.empId || "").trim().toUpperCase();
  const rawPwd = String(request.data?.newPassword || "");
  if (!/^[A-Z][0-9]{5}$/.test(empId)) {
    throw new HttpsError("invalid-argument", "帳號格式錯誤（需 1 英文字母 + 5 碼數字）");
  }
  if (rawPwd.length < 6) {
    throw new HttpsError("invalid-argument", "密碼至少 6 碼");
  }
  const password = padPwd(rawPwd);
  const email = toEmail(empId);

  // 3) 更新 Auth 密碼；若該帳號尚未在 Auth 建立則直接建立
  let uid;
  let created = false;
  try {
    const userRecord = await admin.auth().getUserByEmail(email);
    await admin.auth().updateUser(userRecord.uid, { password });
    uid = userRecord.uid;
  } catch (e) {
    if (e.code === "auth/user-not-found") {
      const rec = await admin.auth().createUser({ email, password });
      uid = rec.uid;
      created = true;
    } else {
      throw new HttpsError("internal", e.message || "更新密碼失敗");
    }
  }

  // 4) 確保 users/{uid} 文件存在（修復 account/users 不同步）
  //    本人登入時 auth.js 的 _loadProfile 會讀 users/{uid}，缺這份文件就會回 null → 白畫面。
  //    用 Admin SDK 直接寫，繞過前端安全規則限制；缺的資料從 account（ID 欄位）補齊。
  let userDocRepaired = false;
  try {
    const db = admin.firestore();
    const userRef = db.collection("users").doc(uid);
    const userSnap = await userRef.get();
    if (!userSnap.exists) {
      let profile = {};
      const accQ = await db.collection("account").where("ID", "==", empId).limit(1).get();
      if (!accQ.empty) {
        const a = accQ.docs[0].data() || {};
        delete a.password;
        delete a.changeHistory;
        profile = a;
      }
      await userRef.set(
        { ...profile, ID: empId, pwdChanged: false, disabled: false },
        { merge: true }
      );
      userDocRepaired = true;
    }
  } catch (e2) {
    // 補建失敗不影響密碼重設本身，記錄即可
    console.error("users 文件補建失敗:", e2);
  }

  return { ok: true, created, uid, userDocRepaired };
});

// ===== 稽核：找出「能登入但 users 文件遺失」的員工（店長以上）=====
// dryRun=true（預設）只回報清單；dryRun=false 會順便自動補建 users/{uid}。
exports.auditUserDocs = onCall({ region: "asia-east1" }, async (request) => {
  const auth = request.auth;
  if (!auth) throw new HttpsError("unauthenticated", "請先登入");
  const db = admin.firestore();

  const callerSnap = await db.collection("users").doc(auth.uid).get();
  const caller = callerSnap.data();
  if (!caller || !ALLOWED_PERMS.includes(caller.permission)) {
    throw new HttpsError("permission-denied", "權限不足，需店長以上");
  }

  const dryRun = request.data?.dryRun !== false; // 預設只稽核不修
  const missing = [];
  let totalAuth = 0;

  // 逐頁掃描所有 Auth 帳號
  let pageToken;
  do {
    const res = await admin.auth().listUsers(1000, pageToken);
    for (const u of res.users) {
      // 只看本系統的內部帳號（xxx@lixue.internal）
      const email = u.email || "";
      if (!email.endsWith("@lixue.internal")) continue;
      totalAuth++;
      const empId = email.replace("@lixue.internal", "").toUpperCase();

      const userSnap = await db.collection("users").doc(u.uid).get();
      if (userSnap.exists) continue;

      // 缺 users 文件 → 從 account 撈名字/門市供辨識
      let empName = null;
      let store = null;
      const accQ = await db.collection("account").where("ID", "==", empId).limit(1).get();
      if (!accQ.empty) {
        const a = accQ.docs[0].data() || {};
        empName = a.empName || null;
        store = a.store || null;
      }

      const item = { empId, uid: u.uid, empName, store, hasAccount: !accQ.empty };

      if (!dryRun) {
        let profile = {};
        if (!accQ.empty) {
          const a = accQ.docs[0].data() || {};
          delete a.password;
          delete a.changeHistory;
          profile = a;
        }
        await db.collection("users").doc(u.uid).set(
          { ...profile, ID: empId, pwdChanged: false, disabled: false },
          { merge: true }
        );
        item.repaired = true;
      }

      missing.push(item);
    }
    pageToken = res.pageToken;
  } while (pageToken);

  return { ok: true, dryRun, totalAuth, missingCount: missing.length, missing };
});

// ===== LINE 通知：綁定 webhook（綁定碼版）=====
// 金鑰用 Secret（部署時設定，不進程式碼/前端）：
//   firebase functions:secrets:set LINE_CHANNEL_ACCESS_TOKEN
//   firebase functions:secrets:set LINE_CHANNEL_SECRET
const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const crypto = require("crypto");

const LINE_TOKEN = defineSecret("LINE_CHANNEL_ACCESS_TOKEN");
const LINE_SECRET = defineSecret("LINE_CHANNEL_SECRET");

async function lineReply(replyToken, text, token) {
  await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ replyToken, messages: [{ type: "text", text }] }),
  }).catch((e) => console.error("lineReply 失敗", e));
}

// 推播給單一 lineUserId（供之後事件通知共用）
async function linePush(lineUserId, text, token) {
  await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ to: lineUserId, messages: [{ type: "text", text }] }),
  }).catch((e) => console.error("linePush 失敗", e));
}

exports.lineWebhook = onRequest(
  { region: "asia-east1", secrets: [LINE_TOKEN, LINE_SECRET] },
  async (req, res) => {
    // 1. 驗證 X-Line-Signature（防偽造）
    const signature = req.get("x-line-signature") || "";
    const expected = crypto
      .createHmac("sha256", LINE_SECRET.value())
      .update(req.rawBody)
      .digest("base64");
    if (signature !== expected) {
      res.status(401).send("bad signature");
      return;
    }

    const token = LINE_TOKEN.value();
    const db = admin.firestore();
    const events = (req.body && req.body.events) || [];

    // 關鍵字清單（群組完全相符自動回覆）— 一次讀取快取
    let _kwCache = null;
    const getKeywords = async () => {
      if (_kwCache) return _kwCache;
      const s = await db.collection("settings").doc("lineKeywords").get().catch(() => null);
      _kwCache = (s && s.exists && Array.isArray(s.data().list)) ? s.data().list : [];
      return _kwCache;
    };

    for (const ev of events) {
      const lineUserId = ev.source && ev.source.userId;
      const srcType = (ev.source && ev.source.type) || "user"; // user | group | room
      try {
        if (ev.type === "follow") {
          await lineReply(
            ev.replyToken,
            "歡迎加入莉學商行通知！\n請回到 App 點「綁定 LINE」，把畫面上的 6 位數綁定碼傳到這裡即可完成綁定。",
            token
          );
          continue;
        }
        // 群組/多人聊天室：只做關鍵字「完全相符」自動回覆，沒命中就完全不出聲（避免洗版）
        if (ev.type === "message" && ev.message && ev.message.type === "text" && srcType !== "user") {
          const text = (ev.message.text || "").trim();
          const kws = await getKeywords();
          // 一則回覆可對應多個關鍵字（keys 陣列）；相容舊格式 {k}
          const hit = kws.find((p) => {
            if (!p) return false;
            const keys = Array.isArray(p.keys) ? p.keys : (p.k != null ? [p.k] : []);
            return keys.some((k) => String(k || "").trim() === text);
          });
          if (hit && hit.r) await lineReply(ev.replyToken, String(hit.r), token);
          continue;
        }
        if (ev.type === "message" && ev.message && ev.message.type === "text") {
          const code = (ev.message.text || "").trim();
          if (!/^\d{4,8}$/.test(code)) {
            await lineReply(ev.replyToken, "請傳送 App 上顯示的綁定碼（純數字）。", token);
            continue;
          }
          const codeRef = db.collection("lineBindCodes").doc(code);
          const snap = await codeRef.get();
          if (!snap.exists) {
            await lineReply(ev.replyToken, "綁定碼無效，請回 App 重新產生。", token);
            continue;
          }
          const data = snap.data();
          if (data.expiresAt && Date.now() > data.expiresAt) {
            await codeRef.delete().catch(() => {});
            await lineReply(ev.replyToken, "綁定碼已過期，請回 App 重新產生。", token);
            continue;
          }
          const dispName = data.displayName || data.empName || "";
          await db.collection("lineBindings").doc(data.uid).set({
            uid: data.uid,
            empName: data.empName || "",
            displayName: dispName,
            store: data.store || "",
            lineUserId: lineUserId || "",
            boundAt: new Date().toISOString(),
          });
          await codeRef.delete().catch(() => {});
          await lineReply(
            ev.replyToken,
            `✅ 綁定成功！${dispName} 之後會在這裡收到通知。`,
            token
          );
          continue;
        }
      } catch (e) {
        console.error("lineWebhook 事件處理失敗", e);
      }
    }
    res.status(200).send("ok");
  }
);

// ===== LINE 通知：事件推播（步驟3、4）=====
const { onDocumentWritten } = require("firebase-functions/v2/firestore");

// 依 empName 找 LINE 綁定（優先同 store）並推播；buildText(displayName, empName)→訊息
async function notifyEmployees(db, empNames, store, buildText, token) {
  const names = [...new Set((empNames || []).filter(Boolean))];
  if (!names.length) return;
  const snap = await db.collection("lineBindings").get();
  const byEmp = {};
  snap.forEach((d) => {
    const b = d.data();
    if (!b.empName || !b.lineUserId) return;
    (byEmp[b.empName] = byEmp[b.empName] || []).push(b);
  });
  for (const emp of names) {
    const list = byEmp[emp] || [];
    const b = list.find((x) => x.store === store) || list[0];
    if (b) await linePush(b.lineUserId, buildText(b.displayName || emp, emp), token);
  }
}

// ===== 個人週班表文字（條列每日一行）=====
const WEEK_DAYS = ["週一", "週二", "週三", "週四", "週五", "週六", "週日"];
const WEEK_LABELS = ["一", "二", "三", "四", "五", "六", "日"];
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
// 某人某週的班表 map：day → 顯示字串（休 或 時段）
function weekShiftMap(records, empName) {
  const map = {};
  for (const dn of WEEK_DAYS) {
    const r = (records || []).find((x) => x && x.name === empName && x.day === dn && x.shift && String(x.shift).trim() && !x.requestOff);
    map[dn] = r ? String(r.shift).replace(/,/g, "、") + (r.location && r.location !== "本店" ? `（${r.location}）` : "") : "休";
  }
  return map;
}
function weekScheduleText(records, empName, wStr) {
  const mon = weekMondayDate(wStr);
  const map = weekShiftMap(records, empName);
  return WEEK_DAYS.map((dn, i) => {
    const x = new Date(mon); x.setDate(mon.getDate() + i);
    return `${WEEK_LABELS[i]} ${x.getMonth() + 1}/${x.getDate()}　${map[dn]}`;
  }).join("\n");
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
    token
  );
}

// 薪資發布 → 通知該月有記錄的員工（但需已到「可查看月份」才即時通知；
// 若在可查看月份前就發布，改由 scheduledMonthlySalaryNotify 於次月1號補發）
exports.onSalaryPublished = onDocumentWritten(
  { document: "stores/{store}/salary/{month}", region: "asia-east1", secrets: [LINE_TOKEN] },
  async (event) => {
    const before = event.data.before.exists ? event.data.before.data() : {};
    const after = event.data.after.exists ? event.data.after.data() : {};
    if (before.status === "published" || after.status !== "published") return; // 只在「變成 published」
    const month = event.params.month;
    if (!salaryViewable(month)) return; // 尚未到可查看月份 → 不即時通知（次月排程補發）
    const db = admin.firestore();
    await notifySalary(db, fixStoreName(event.params.store), after, month, LINE_TOKEN.value());
  }
);

// 找可審核者（加盟主/admin）的 LINE 綁定並推播
async function notifyApprovers(db, text, token) {
  const uids = new Set();
  for (const p of ["owner", "admin"]) {
    const us = await db.collection("users").where("permission", "==", p).get().catch(() => null);
    if (us) us.forEach((d) => uids.add(d.id));
  }
  for (const uid of uids) {
    const b = await db.collection("lineBindings").doc(uid).get().catch(() => null);
    if (b && b.exists && b.data().lineUserId) await linePush(b.data().lineUserId, text, token);
  }
}

// 店長送出薪資（status→submitted）→ 通知加盟主審核
exports.onSalarySubmitted = onDocumentWritten(
  { document: "stores/{store}/salary/{month}", region: "asia-east1", secrets: [LINE_TOKEN] },
  async (event) => {
    const before = event.data.before.exists ? event.data.before.data() : {};
    const after = event.data.after.exists ? event.data.after.data() : {};
    if (before.status === "submitted" || after.status !== "submitted") return; // 只在「剛送審」
    const store = fixStoreName(event.params.store);
    const month = event.params.month;
    const by = after.submittedBy || "店長";
    const db = admin.firestore();
    await notifyApprovers(
      db,
      `📤 ${store} ${month} 薪資已由 ${by} 送出，請至 App 審核後發布。`,
      LINE_TOKEN.value()
    );
  }
);

// 通知某店店長（permission=manager 且 store 相符）的 LINE 綁定
async function notifyStoreManagers(db, store, text, token) {
  const us = await db.collection("users").where("permission", "==", "manager").get().catch(() => null);
  if (!us) return;
  for (const d of us.docs) {
    if ((d.data().store || "") !== store) continue;
    const b = await db.collection("lineBindings").doc(d.id).get().catch(() => null);
    if (b && b.exists && b.data().lineUserId) await linePush(b.data().lineUserId, text, token);
  }
}

// 加盟主退回薪資（submitted→draft 且 rejectedAt 為本次新設）→ 通知該店店長重新送審
// （與店長自己「收回」區分：收回不會動 rejectedAt）
exports.onSalaryRejected = onDocumentWritten(
  { document: "stores/{store}/salary/{month}", region: "asia-east1", secrets: [LINE_TOKEN] },
  async (event) => {
    const before = event.data.before.exists ? event.data.before.data() : {};
    const after = event.data.after.exists ? event.data.after.data() : {};
    if (!(before.status === "submitted" && after.status === "draft")) return;
    if (!after.rejectedAt || after.rejectedAt === before.rejectedAt) return; // 排除店長自己收回
    const store = fixStoreName(event.params.store);
    const month = event.params.month;
    const by = after.rejectedBy || "加盟主";
    const db = admin.firestore();
    await notifyStoreManagers(
      db, store,
      `↩️ ${store} ${month} 薪資已被 ${by} 退回，請至 App 修改後重新送審。`,
      LINE_TOKEN.value()
    );
  }
);

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

exports.onSchedulePublished = onDocumentWritten(
  { document: "stores/{store}/weeks/{weekStr}", region: "asia-east1", secrets: [LINE_TOKEN] },
  async (event) => {
    const before = event.data.before.exists ? event.data.before.data() : {};
    const after = event.data.after.exists ? event.data.after.data() : {};
    if (before.published === true || after.published !== true) return; // 只在「剛發布」
    const store = fixStoreName(event.params.store);
    const weekStr = event.params.weekStr;
    const label = weekRangeLabel(weekStr);
    const records = after.records || [];
    const db = admin.firestore();
    const empNames = await getActiveEmpNames(db, store);
    await notifyEmployees(
      db, empNames, store,
      (name, emp) => `🗓️ ${name}，${store} ${label} 班表已發布\n\n${weekScheduleText(records, emp, weekStr)}\n\n詳情請至 App 查看`,
      LINE_TOKEN.value()
    );
  }
);

// 已發布班表被異動（published→published 且 records 變動）→ 只通知「班次有變」的員工
exports.onScheduleChanged = onDocumentWritten(
  { document: "stores/{store}/weeks/{weekStr}", region: "asia-east1", secrets: [LINE_TOKEN] },
  async (event) => {
    const before = event.data.before.exists ? event.data.before.data() : {};
    const after = event.data.after.exists ? event.data.after.data() : {};
    if (!(before.published === true && after.published === true)) return; // 僅已發布週的後續異動
    const beforeRecs = before.records || [];
    const afterRecs = after.records || [];
    if (JSON.stringify(beforeRecs) === JSON.stringify(afterRecs)) return; // records 沒變（純 metadata 寫入）→ 略過
    const store = fixStoreName(event.params.store);
    const weekStr = event.params.weekStr;
    const label = weekRangeLabel(weekStr);
    const db = admin.firestore();
    const active = new Set(await getActiveEmpNames(db, store));
    // 找出班次有變動的在職員工（比對每日時段 map）
    const changed = [];
    for (const emp of active) {
      const bMap = weekShiftMap(beforeRecs, emp);
      const aMap = weekShiftMap(afterRecs, emp);
      if (JSON.stringify(bMap) !== JSON.stringify(aMap)) changed.push(emp);
    }
    if (!changed.length) return;
    await notifyEmployees(
      db, changed, store,
      (name, emp) => `🔔 ${name}，${store} ${label} 班表有異動\n\n${weekScheduleText(afterRecs, emp, weekStr)}\n\n請至 App 確認最新班表`,
      LINE_TOKEN.value()
    );
  }
);

// ===== 月加班累計預警（優先2）=====
// 某店某月每位員工的工時與加班（公式同 salary-calc calcEmpHours：每日 max(0,h-8)，isOT 或日>8h；跳過休假/時薪；去重同員工同日）
async function monthWorkedByEmp(db, store, ym) {
  const [y, m] = ym.split("-").map(Number);
  const lastDay = new Date(y, m, 0).getDate();
  const weekSet = new Set();
  for (let d = 1; d <= lastDay; d++) weekSet.add(simpleWeekStr(new Date(y, m - 1, d)));
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
async function monthOtByEmp(db, store, ym) {
  const w = await monthWorkedByEmp(db, store, ym);
  const out = {};
  for (const e in w) out[e] = w[e].ot;
  return out;
}

// ===== 月度聚合 doc（優先3/模組F）=====
// 薪資發布時寫入 stores/{store}/monthly/{ym} 快照，供加盟主儀表板快速讀取（免每次掃全 weeks+salary）。
// 守鐵則：以「已發布薪資快照」聚合；已發布月份鎖定不再變動。
exports.onSalaryAggregate = onDocumentWritten(
  { document: "stores/{store}/salary/{month}", region: "asia-east1" },
  async (event) => {
    const before = event.data.before.exists ? event.data.before.data() : {};
    const after = event.data.after.exists ? event.data.after.data() : {};
    if (before.status === "published" || after.status !== "published") return; // 只在「剛發布」
    const store = fixStoreName(event.params.store);
    const ym = event.params.month;
    const db = admin.firestore();
    const num = (v) => { const x = parseFloat(v); return isNaN(x) ? 0 : x; };
    let totalGross = 0, totalDeduct = 0, totalEr = 0;
    const head = { full: 0, part: 0, manager: 0 };
    for (const r of (after.records || [])) {
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
    await db.collection("stores").doc(store).collection("monthly").doc(ym).set({
      store, month: ym,
      totalGross: Math.round(totalGross), totalDeduct: Math.round(totalDeduct),
      totalEr: Math.round(totalEr), totalCost: Math.round(totalGross + totalEr),
      totalHours: Math.round(totalHours * 10) / 10, otHours: Math.round(otHours * 10) / 10,
      costPerHour: totalHours > 0 ? Math.round((totalGross + totalEr) / totalHours) : 0,
      otRatio: totalHours > 0 ? Math.round(otHours / totalHours * 1000) / 10 : 0, // %
      headcount: head, source: "published", updatedAt: new Date().toISOString(),
    });
  }
);

// 班表變動 → 計算當月加班累計，跨越門檻(黃/紅/嚴重)且「等級升高」時，LINE 通知該店店長
exports.onScheduleOtWarning = onDocumentWritten(
  { document: "stores/{store}/weeks/{weekStr}", region: "asia-east1", secrets: [LINE_TOKEN] },
  async (event) => {
    const after = event.data.after.exists ? event.data.after.data() : null;
    if (!after) return; // 刪除不處理
    const before = event.data.before.exists ? event.data.before.data() : {};
    if (JSON.stringify(before.records || []) === JSON.stringify(after.records || [])) return; // records 沒變
    const store = fixStoreName(event.params.store);
    const weekStr = event.params.weekStr;
    const db = admin.firestore();
    const token = LINE_TOKEN.value();
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
        await notifyStoreManagers(db, store, `⚠️ ${store} ${parseInt(ym.split("-")[1])}月加班預警：${disp(t.emp)} 本月加班已達 ${t.h}h（${label[t.lv]}，勞基法 §32 每月上限 46h），請留意排班。`, token);
      }
      await alertRef.set({ levels: newLevels, updatedAt: new Date().toISOString() });
    }
  }
);

// ===== 週字串工具（雲端複刻前端）=====
// ISO-8601（對應 leave-request.html dateToWeekStr，＝ leaveRequests.week）
function isoWeekStr(dateObj) {
  const d = new Date(dateObj);
  const tmp = new Date(d);
  tmp.setDate(tmp.getDate() + 3 - ((tmp.getDay() + 6) % 7));
  const year = tmp.getFullYear();
  const jan4 = new Date(year, 0, 4);
  const weekNum = 1 + Math.round(((tmp - jan4) / 86400000 - 3 + ((jan4.getDay() + 6) % 7)) / 7);
  return `${year}-W${String(weekNum).padStart(2, "0")}`;
}
// 簡單公式（對應 schedule-V2.html getNextWeekString，＝ weeks doc id）
function simpleWeekStr(dateObj) {
  const d = new Date(dateObj);
  const yr = d.getFullYear();
  const first = new Date(yr, 0, 1);
  const w = Math.ceil((((d - first) / 86400000) + first.getDay() + 1) / 7);
  return `${yr}-W${w < 10 ? "0" + w : w}`;
}
// 以「台北時區」取得今天 YYYY-MM-DD
function taipeiTodayStr() {
  return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
}
// 讀全域門市清單（settings/globalConfig.stores）
async function getAllStores(db) {
  const snap = await db.collection("settings").doc("globalConfig").get();
  const s = snap.exists ? snap.data() : {};
  return Array.isArray(s.stores) ? s.stores.filter(Boolean) : [];
}

const { onSchedule } = require("firebase-functions/v2/scheduler");

// ===== 劃休截止前2天：提醒「未劃休且未打X」的員工（每日 10:00 台北）=====
exports.scheduledLeaveReminder = onSchedule(
  { schedule: "0 10 * * *", timeZone: "Asia/Taipei", region: "asia-east1", secrets: [LINE_TOKEN] },
  async () => {
    const db = admin.firestore();
    const token = LINE_TOKEN.value();
    const today = taipeiTodayStr();
    // 下週（台北）＝ 今日+7 的 ISO 週，對應 leaveRequests.week
    const nextWeek = isoWeekStr(new Date(Date.now() + 8 * 3600000 + 7 * 86400000));
    const stores = await getAllStores(db);
    for (const store of stores) {
      const cfgSnap = await db.collection("stores").doc(store).collection("config").doc("leaveWindow").get();
      const cfg = cfgSnap.exists ? cfgSnap.data() : {};
      if (!cfg.nextWeekOpen || !cfg.closeDate) continue; // 未開放或未設截止日 → 不提醒
      // 截止日前2天 = closeDate - 2 天
      const cd = new Date(cfg.closeDate + "T00:00:00+08:00");
      const remind = new Date(cd.getTime() - 2 * 86400000).toISOString().slice(0, 10);
      if (remind !== today) continue;
      // 已送劃休者（該週、狀態非取消/未成功）
      const lrSnap = await db.collection("stores").doc(store).collection("leaveRequests")
        .where("week", "==", nextWeek).get().catch(() => null);
      const submitted = new Set();
      if (lrSnap) lrSnap.forEach((d) => {
        const r = d.data();
        if (!["cancelled", "unfulfilled"].includes(r.status)) submitted.add(r.empName);
      });
      // 已打X者（首頁提醒關閉，寫入 leaveDismiss/{week}__{empName}）
      const dmSnap = await db.collection("stores").doc(store).collection("leaveDismiss")
        .where("week", "==", nextWeek).get().catch(() => null);
      const dismissed = new Set();
      if (dmSnap) dmSnap.forEach((d) => { const x = d.data(); if (x.empName) dismissed.add(x.empName); });
      // 未劃休且未打X的在職員工
      const active = await getActiveEmpNames(db, store);
      const targets = active.filter((n) => !submitted.has(n) && !dismissed.has(n));
      const closeLabel = cfg.closeDateTime ? cfg.closeDateTime.replace("T", " ") : (cfg.closeDate + " 23:59");
      await notifyEmployees(
        db, targets, store,
        (name) => `⏰ ${name}，${store} 下週劃休將於 ${closeLabel} 截止，你還沒劃休喔！需要休假請到 App 劃休；不需要可忽略。`,
        token
      );
    }
  }
);

// ===== 班表自動發布（每週五 18:00 台北）：未手動發布者補通知 =====
exports.scheduledAutoPublishNotify = onSchedule(
  { schedule: "0 18 * * 5", timeZone: "Asia/Taipei", region: "asia-east1", secrets: [LINE_TOKEN] },
  async () => {
    const db = admin.firestore();
    const token = LINE_TOKEN.value();
    // 下週（台北）＝ 今日+7 的簡單週字串，對應 weeks doc id
    const nextWeek = simpleWeekStr(new Date(Date.now() + 8 * 3600000 + 7 * 86400000));
    const label = weekRangeLabel(nextWeek);
    const stores = await getAllStores(db);
    for (const store of stores) {
      const wSnap = await db.collection("stores").doc(store).collection("weeks").doc(nextWeek).get();
      if (wSnap.exists && wSnap.data().published === true) continue; // 已手動發布 → onSchedulePublished 已通知
      const records = wSnap.exists ? (wSnap.data().records || []) : [];
      const empNames = await getActiveEmpNames(db, store);
      await notifyEmployees(
        db, empNames, store,
        (name, emp) => `🗓️ ${name}，${store} ${label} 班表已發布\n\n${weekScheduleText(records, emp, nextWeek)}\n\n詳情請至 App 查看`,
        token
      );
    }
  }
);

// ===== 每月1號：補發「上個月薪資」通知（該月薪資此時起才可查看）=====
// 例：8/1 通知 7 月薪資（7 月發布但依規則 8 月才可看）。
exports.scheduledMonthlySalaryNotify = onSchedule(
  { schedule: "0 9 1 * *", timeZone: "Asia/Taipei", region: "asia-east1", secrets: [LINE_TOKEN] },
  async () => {
    const db = admin.firestore();
    const token = LINE_TOKEN.value();
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

// ===== 管理者測試通知：推一則測試訊息給呼叫者自己的 LINE（僅店長以上）=====
exports.sendTestNotify = onCall(
  { region: "asia-east1", secrets: [LINE_TOKEN] },
  async (request) => {
    const auth = request.auth;
    if (!auth) throw new HttpsError("unauthenticated", "請先登入");
    const db = admin.firestore();
    const callerSnap = await db.collection("users").doc(auth.uid).get();
    const caller = callerSnap.data();
    if (!caller || !ALLOWED_PERMS.includes(caller.permission)) {
      throw new HttpsError("permission-denied", "僅店長以上可用");
    }
    const bindSnap = await db.collection("lineBindings").doc(auth.uid).get();
    if (!bindSnap.exists) throw new HttpsError("failed-precondition", "你尚未綁定 LINE，請先綁定");
    const b = bindSnap.data();
    const name = b.displayName || b.empName || "";
    const now = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 16).replace("T", " ");
    await linePush(
      b.lineUserId,
      `🔔 測試通知（${now}）\n${name}，若你收到這則訊息，代表 LINE 通知運作正常 ✅`,
      LINE_TOKEN.value()
    );
    return { ok: true };
  }
);
