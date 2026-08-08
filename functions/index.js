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
            // 非綁定碼：已綁定者不再提示綁定碼，改回「無法一對一回覆」；未綁定才提示傳碼
            const bound = lineUserId
              ? await db.collection("lineBindings").where("lineUserId", "==", lineUserId).limit(1).get().catch(() => null)
              : null;
            if (bound && !bound.empty) {
              await lineReply(ev.replyToken, "此為莉學商行系統通知帳號，無法一對一回覆訊息。相關操作請至 App 進行。", token);
            } else {
              await lineReply(ev.replyToken, "請傳送 App 上顯示的綁定碼（純數字）。", token);
            }
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
const { onDocumentWritten, onDocumentCreated } = require("firebase-functions/v2/firestore");

// 特休候補協商：員工寫 leaveNego 文件 → LINE 通知全體(排除候補者本人)＋店長協助換假(措辭方案A)
exports.onLeaveNego = onDocumentCreated(
  { document: "stores/{store}/leaveNego/{id}", region: "asia-east1", secrets: [LINE_TOKEN] },
  async (event) => {
    const snap = event.data; if (!snap) return;
    const d = snap.data(); if (!d || d.notified) return;
    const db = admin.firestore();
    const store = fixStoreName(event.params.store);
    const token = LINE_TOKEN.value();
    const es = await db.collection("stores").doc(store).collection("employees").get().catch(() => null);
    let mgr = ""; const emps = [];
    if (es) es.forEach((x) => { const e = x.data() || {}; if (e.status === "離職" || e.status === "調走") return; emps.push(x.id); if (e.role === "店長" && !mgr) mgr = e.displayName || x.id; });
    const p = String(d.date || "").split("-");
    const md = p.length === 3 ? `${+p[1]}/${+p[2]}` : (d.date || "");
    const msg = `【休假協調】\n${store}｜${md}\n當日休假人數已滿，${d.candidateName || ""} 想請特休。\n若有夥伴當天排休、方便調到別天，\n願意幫忙的請回覆店長${mgr ? " " + mgr : ""}。\n✨ 純自願、不影響任何人權益，感謝！`;
    let sent = 0;
    for (const emp of emps) { if (emp === d.candidateEmp) continue; try { await notifyOneEmp(db, emp, store, msg, token); sent++; } catch (e) { /* skip */ } }
    await snap.ref.set({ notified: true, sentCount: sent, notifiedAt: new Date().toISOString() }, { merge: true });
  }
);

// 依 empName 找 LINE 綁定（優先同 store）並推播；buildText(displayName, empName)→訊息
// 系統維護模式：開啟時，班表相關的 LINE 通知全部暫停（避免維護/整理時狂發）
async function maintenanceOn(db) {
  const d = await db.collection("settings").doc("maintenance").get().catch(() => null);
  return !!(d && d.exists && d.data().enabled);
}
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
// 通知某店「店長」——依門市員工 role=店長 判斷（涵蓋登入權限為 admin/owner 但職務是店長者，如美德楷岳），
// 不再只看 users.permission==manager（會漏掉兼任店長的 admin/owner）。
async function notifyStoreManagers(db, store, text, token) {
  const es = await db.collection("stores").doc(store).collection("employees").get().catch(() => null);
  if (!es) return;
  const leads = [];
  es.forEach((d) => { const e = d.data() || {}; if (e.role === "店長" && !["離職", "調走"].includes(e.status)) leads.push(d.id); });
  for (const emp of leads) {
    const snap = await db.collection("lineBindings").where("empName", "==", emp).get().catch(() => null);
    if (snap && !snap.empty) { const b = snap.docs[0].data(); if (b && b.lineUserId) await linePush(b.lineUserId, text, token); }
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
    if (await maintenanceOn(admin.firestore())) return; // 維護模式不發班表通知
    const store = fixStoreName(event.params.store);
    const weekStr = event.params.weekStr;
    const label = weekRangeLabel(weekStr);
    const records = after.records || [];
    const db = admin.firestore();
    const empNames = await getActiveEmpNames(db, store);
    const so = await supportOutByEmp(db, store, weekStr); // 跨店支援出去的日子
    await notifyEmployees(
      db, empNames, store,
      (name, emp) => `🗓️ ${name}，${store} ${label} 班表已發布\n\n${weekScheduleText(records, emp, weekStr, so[emp])}\n\n詳情請至 App 查看`,
      LINE_TOKEN.value()
    );
  }
);

// 已發布班表被異動（published→published 且 records 變動）→ 不即時發送，改「延遲通知」：
// 進 scheduleNotifyQueue 佇列，靜置滿 10 分鐘無新異動才由 scheduledScheduleNotifyFlush 彙整發送；
// 店長亦可用班表頁「立即通知」按鈕（flushScheduleNotify）即時送出。避免一改就發、通知過於頻繁。
exports.onScheduleChanged = onDocumentWritten(
  { document: "stores/{store}/weeks/{weekStr}", region: "asia-east1" },
  async (event) => {
    const before = event.data.before.exists ? event.data.before.data() : {};
    const after = event.data.after.exists ? event.data.after.data() : {};
    if (!(before.published === true && after.published === true)) return; // 僅已發布週的後續異動
    if (await maintenanceOn(admin.firestore())) return; // 維護模式：不排入通知佇列
    const beforeRecs = before.records || [];
    const afterRecs = after.records || [];
    if (JSON.stringify(beforeRecs) === JSON.stringify(afterRecs)) return; // records 沒變（純 metadata 寫入）→ 略過
    const store = fixStoreName(event.params.store);
    const weekStr = event.params.weekStr;
    const db = admin.firestore();
    const qref = db.collection("scheduleNotifyQueue").doc(`${store}__${weekStr}`);
    const qs = await qref.get().catch(() => null);
    const nowTs = admin.firestore.FieldValue.serverTimestamp();
    if (qs && qs.exists) {
      await qref.update({ lastChangeAt: nowTs }); // 每次新異動 → 重置 10 分鐘靜置計時
    } else {
      // 首次進佇列：baseRecs＝本批異動前的班表，作為「淨變動」比對基準（連改多次只比首尾）
      await qref.set({ store, weekStr, baseRecs: JSON.stringify(beforeRecs), lastChangeAt: nowTs, createdAt: nowTs });
    }
  }
);

// 彙整某週佇列 → 比對 baseRecs vs 目前班表，只通知「班次有淨變動」的在職員工
async function flushScheduleQueueEntry(db, store, weekStr, baseRecs, token) {
  const wkSnap = await db.collection("stores").doc(store).collection("weeks").doc(weekStr).get();
  if (!wkSnap.exists || wkSnap.data().published !== true) return { sent: 0 };
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
    token
  );
  return { sent: changed.length };
}

// ===== 跨店支援請求通知 =====
// 支援記錄(有 supportEmp)存在「請求店(受支援)」的 weeks；supportEmp='{被請求店}-{員工}'。
// 新請求(pending)→通知被請求店審核；核准→通知請求店；取消/拒絕(supportEmp 被清或記錄移除)→兩邊都通知。
exports.onSupportRequest = onDocumentWritten(
  { document: "stores/{store}/weeks/{weekStr}", region: "asia-east1", secrets: [LINE_TOKEN] },
  async (event) => {
    const before = event.data.before.exists ? event.data.before.data() : {};
    const after = event.data.after.exists ? event.data.after.data() : {};
    if (await maintenanceOn(admin.firestore())) return; // 維護模式不發跨店支援通知
    const supKey = (r) => `${r.supportEmp}|${r.day}|${r.shift}`;
    const mapOf = (recs) => {
      const m = {};
      (recs || []).forEach((r) => { if (r && r.supportEmp) m[supKey(r)] = { status: r.approvalStatus || "", r }; });
      return m;
    };
    const b = mapOf(before.records), a = mapOf(after.records);
    const evts = [];
    for (const k in a) {
      if (!b[k]) {
        if (a[k].status === "pending") evts.push({ type: "request", r: a[k].r });               // 申請指定某人(待審核)
        else if (a[k].status === "approved" && a[k].r.claimedBy) evts.push({ type: "filled", r: a[k].r }); // 別店直接認領開放缺口
      }
      else if (b[k].status === "pending" && a[k].status === "approved") evts.push({ type: "approved", r: a[k].r });
    }
    for (const k in b) { if (!a[k]) evts.push({ type: "cancelled", r: b[k].r }); } // supportEmp 被清(拒絕/取消)或記錄移除
    if (!evts.length) return;

    const requestingStore = fixStoreName(event.params.store); // 需要人力、發出請求的店
    const weekStr = event.params.weekStr;
    const db = admin.firestore();
    const token = LINE_TOKEN.value();
    const accSnap = await db.collection("account").get().catch(() => null);
    const dispMap = {};
    if (accSnap) accSnap.forEach((d) => { const x = d.data(); if (x.empName && x.displayName) dispMap[x.empName] = x.displayName; });

    const dateLabel = (day) => {
      const di = WEEK_DAYS.indexOf(day);
      if (di < 0) return day || "";
      const mon = weekMondayDate(weekStr); const d = new Date(mon); d.setDate(mon.getDate() + di);
      return `${d.getMonth() + 1}/${d.getDate()}（${day}）`;
    };
    for (const e of evts) {
      const dash = String(e.r.supportEmp).indexOf("-");
      if (dash < 0) continue;
      const homeStore = e.r.supportEmp.slice(0, dash); // 被請求店(擁有該員工)
      const emp = e.r.supportEmp.slice(dash + 1);
      const disp = dispMap[emp] || emp;
      const when = `${dateLabel(e.r.day)} ${e.r.shift || ""}`.trim();
      if (e.type === "request") {
        await notifyStoreManagers(db, homeStore,
          `🔔 跨店支援請求\n${requestingStore} 需要人力，請求貴店「${disp}」於 ${when} 前往 ${requestingStore} 支援，請至 App 審核。`, token);
      } else if (e.type === "approved") {
        await notifyStoreManagers(db, requestingStore,
          `✅ 跨店支援已核准\n${homeStore} 已核准「${disp}」於 ${when} 到 ${requestingStore} 支援。`, token);
      } else if (e.type === "filled") {
        // 別店店長從「跨店支援請求」看板派人支援本店的開放缺口 → 通知缺工店店長
        await notifyStoreManagers(db, requestingStore,
          `🤝 待補缺口已有人支援\n${homeStore}「${disp}」將於 ${when} 前往 ${requestingStore} 支援（填補待補缺口）。`, token);
      } else if (e.type === "cancelled") {
        const msg = `⚠️ 跨店支援已取消\n「${disp}」（${homeStore}）於 ${when} 支援 ${requestingStore} 的安排已取消／未成立。`;
        await notifyStoreManagers(db, requestingStore, msg, token);
        if (homeStore !== requestingStore) await notifyStoreManagers(db, homeStore, msg, token);
      }
    }
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
    await computeMonthlyAggregate(admin.firestore(), fixStoreName(event.params.store), event.params.month, after);
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
    if (await maintenanceOn(admin.firestore())) return; // 維護模式不發加班預警
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
      const so = await supportOutByEmp(db, store, nextWeek); // 跨店支援：本店員工去他店支援 → 顯示支援而非「休」
      await notifyEmployees(
        db, empNames, store,
        (name, emp) => `🗓️ ${name}，${store} ${label} 班表已發布\n\n${weekScheduleText(records, emp, nextWeek, so[emp])}\n\n詳情請至 App 查看`,
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

// ===== 薪資簽收提醒：每日檢查，對「已發布可查看但未簽收」者每 2 天 LINE 提醒一次（2026-07 起，直到簽收）=====
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
exports.scheduledSalaryAckReminder = onSchedule(
  { schedule: "0 15 * * *", timeZone: "Asia/Taipei", region: "asia-east1", secrets: [LINE_TOKEN] },
  async () => {
    const db = admin.firestore();
    const token = LINE_TOKEN.value();
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
    const resignedInfo = {}; // empName -> {store, retireDate}
    const cfgR = await db.collection("settings").doc("globalConfig").get().catch(() => null);
    for (const st of ((cfgR && cfgR.exists ? cfgR.data().stores : []) || [])) {
      const es = await db.collection("stores").doc(st).collection("employees").get().catch(() => null);
      if (es) es.forEach((d) => { const e = d.data() || {}; if (e.status === "離職") resignedInfo[d.id] = { store: st, retireDate: e.retireDate || "" }; });
    }
    const bindSnap = await db.collection("lineBindings").get();
    const uidByName = {}; bindSnap.forEach((d) => { const b = d.data(); if (b.empName && b.uid) uidByName[b.empName] = b.uid; });
    for (const bd of bindSnap.docs) {
      const b = bd.data();
      if (!b.uid || !b.empName || !b.lineUserId || !b.store) continue;
      if (resignedInfo[b.empName]) continue; // 離職者不再提醒
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
        // 2 天節流（留 1h 緩衝避免每日排程邊界誤判）
        const remRef = db.collection("salaryAckReminder").doc(`${b.uid}_${ym}`);
        const remSnap = await remRef.get().catch(() => null);
        const lastAt = (remSnap && remSnap.exists) ? (remSnap.data().lastAt || 0) : 0;
        if (NOW - lastAt < 2 * 86400000 - 3600000) continue;
        await linePush(b.lineUserId, `💰 ${disp}，你的 ${ym} 薪資已發布但尚未「簽收」。\n請開啟 App →「查看薪水」完成簽名簽收（每 2 天提醒，簽收後即停止）。`, token);
        await remRef.set({ uid: b.uid, ym, empName: b.empName, lastAt: NOW }, { merge: true });
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

// ===== 班表異動「延遲通知」排程：每 5 分鐘檢查佇列，靜置滿 10 分鐘無新異動才彙整發送 =====
exports.scheduledScheduleNotifyFlush = onSchedule(
  { schedule: "*/5 * * * *", timeZone: "Asia/Taipei", region: "asia-east1", secrets: [LINE_TOKEN] },
  async () => {
    const db = admin.firestore();
    if (await maintenanceOn(db)) return; // 維護模式不彙整發送班表異動
    const token = LINE_TOKEN.value();
    const QUIET_MS = 10 * 60 * 1000;
    const now = Date.now();
    const qsnap = await db.collection("scheduleNotifyQueue").get().catch(() => null);
    if (!qsnap) return;
    for (const d of qsnap.docs) {
      const q = d.data();
      const last = q.lastChangeAt && q.lastChangeAt.toMillis ? q.lastChangeAt.toMillis() : 0;
      if (now - last < QUIET_MS) continue; // 尚未靜置滿 10 分鐘 → 等下輪
      await flushScheduleQueueEntry(db, q.store, q.weekStr, JSON.parse(q.baseRecs || "[]"), token).catch(() => {});
      await d.ref.delete().catch(() => {});
    }
  }
);

// ===== 班表異動「立即通知」：店長於班表頁按下按鈕 → 馬上彙整發送並清空佇列（僅店長以上）=====
exports.flushScheduleNotify = onCall(
  { region: "asia-east1", secrets: [LINE_TOKEN] },
  async (request) => {
    const auth = request.auth;
    if (!auth) throw new HttpsError("unauthenticated", "請先登入");
    const db = admin.firestore();
    const callerSnap = await db.collection("users").doc(auth.uid).get();
    const caller = callerSnap.data();
    if (!caller || !ALLOWED_PERMS.includes(caller.permission)) throw new HttpsError("permission-denied", "僅店長以上可用");
    const store = fixStoreName((request.data && request.data.store) || "");
    const weekStr = (request.data && request.data.weekStr) || "";
    if (!store || !weekStr) throw new HttpsError("invalid-argument", "缺少 store / weekStr");
    const token = LINE_TOKEN.value();
    const qref = db.collection("scheduleNotifyQueue").doc(`${store}__${weekStr}`);
    const qs = await qref.get().catch(() => null);
    if (qs && qs.exists) {
      // 有待發異動 → 依 baseRecs 淨變動只通知有異動者
      const res = await flushScheduleQueueEntry(db, store, weekStr, JSON.parse(qs.data().baseRecs || "[]"), token);
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
      token
    );
    return { ok: true, sent: empNames.length };
  }
);

// 通知「店長以上」(manager/owner/admin) 有綁定 LINE 者
async function notifyManagersAndAbove(db, text, token) {
  const uids = new Set();
  for (const p of ["manager", "owner", "admin"]) {
    const us = await db.collection("users").where("permission", "==", p).get().catch(() => null);
    if (us) us.forEach((d) => uids.add(d.id));
  }
  for (const uid of uids) {
    const b = await db.collection("lineBindings").doc(uid).get().catch(() => null);
    if (b && b.exists && b.data().lineUserId) await linePush(b.data().lineUserId, text, token);
  }
}

// ===== 月底提醒（每月最後一天 09:00）：LINE 通知店長以上「結帳/匯款時間、週轉金上限」=====
exports.scheduledMonthEndReminder = onSchedule(
  { schedule: "0 9 * * *", timeZone: "Asia/Taipei", region: "asia-east1", secrets: [LINE_TOKEN] },
  async () => {
    const now = new Date(Date.now() + 8 * 3600000); // 台北時間
    const y = now.getUTCFullYear(), m = now.getUTCMonth();
    const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    if (now.getUTCDate() !== lastDay) return; // 僅每月最後一天
    const db = admin.firestore();
    await notifyManagersAndAbove(
      db,
      "🧾 今天是月底，結帳時間 17:00；匯款時間 17:59 前。\n（週轉金請勿超過留存上限）",
      LINE_TOKEN.value()
    );
  }
);

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
// 通知某店「店長/加盟主/admin」(依 users.store 比對，單一 where 免複合索引)
async function notifyStoreScopedManagers(db, store, text, token){
  const us = await db.collection("users").where("store", "==", store).get().catch(() => null);
  if(!us) return;
  for(const d of us.docs){
    if(!["manager", "owner", "admin"].includes(d.data().permission)) continue;
    const b = await db.collection("lineBindings").doc(d.id).get().catch(() => null);
    if(b && b.exists && b.data().lineUserId) await linePush(b.data().lineUserId, text, token);
  }
}

// 店長輸入/更新某月損益 → 與去年同期比較 → LINE 給全體店長+加盟主
exports.onPnlSubmitted = onDocumentWritten(
  { document: "stores/{store}/pnl/{month}", region: "asia-east1", secrets: [LINE_TOKEN] },
  async (event) => {
    const before = event.data.before.exists ? event.data.before.data() : null;
    const after = event.data.after.exists ? event.data.after.data() : null;
    if(!after) return; // 刪除不通知
    if([after.netSales, after.badGoodsCost, after.grossMargin, after.elecCost, after.miscCost, after.cashDiff, after.operatingReward].some(v => v == null)) return; // 必填不齊(含新欄位) → 不發；舊月份補填後才會通知
    if(pnlSig(before) === pnlSig(after)) return; // 內容沒變(只動 submittedAt 等) → 不重複發
    const store = fixStoreName(event.params.store);
    const month = event.params.month;
    const db = admin.firestore();
    const ps = await db.collection("stores").doc(store).collection("pnl").doc(pnlPrevYM(month)).get().catch(() => null);
    if(!ps || !ps.exists) return; // 無去年同期資料(回填月份) → 不發送
    await notifyManagersAndAbove(db, buildPnlText(store, month, after, ps.data()), LINE_TOKEN.value());
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
exports.scheduledPnlReminder = onSchedule(
  { schedule: "0 9 * * *", timeZone: "Asia/Taipei", region: "asia-east1", secrets: [LINE_TOKEN] },
  async () => {
    const now = new Date(Date.now() + 8 * 3600000); // 台北
    const db = admin.firestore();
    const provideDay = await pnlSendDay(db, now.getUTCFullYear(), now.getUTCMonth() + 1); // 公司提供報表日
    if(now.getUTCDate() < provideDay + 1) return; // 收到報表「隔天」09:00 才開始要求輸入
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)); d.setUTCMonth(d.getUTCMonth() - 1);
    const dueMonth = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`; // 上個月
    if(dueMonth < "2025-07") return;
    const token = LINE_TOKEN.value();
    const stores = await getAllStores(db);
    for(const store of stores){
      const snap = await db.collection("stores").doc(store).collection("pnl").doc(dueMonth).get().catch(() => null);
      if(snap && snap.exists) continue; // 已完成 → 不提醒
      await notifyStoreScopedManagers(db, store,
        `📊 提醒：${store} 尚未輸入 ${parseInt(dueMonth.split("-")[1])}月 經營績效（損益表）。\n請於 10 號前至 App →「更多管理 → 經營績效專區」完成輸入。`,
        token);
    }
  }
);

// ===== 系統維護結束（enabled true→false）→ LINE 通知所有登記「完成後通知我」的使用者，並清除登記 =====
exports.onMaintenanceEnded = onDocumentWritten(
  { document: "settings/maintenance", region: "asia-east1", secrets: [LINE_TOKEN] },
  async (event) => {
    const before = event.data.before.exists ? event.data.before.data() : {};
    const after = event.data.after.exists ? event.data.after.data() : {};
    if (!(before.enabled === true && after.enabled === false)) return; // 只在「維護→關閉」
    const db = admin.firestore();
    const token = LINE_TOKEN.value();
    const snap = await db.collection("maintenanceNotify").get().catch(() => null);
    if (!snap) return;
    const endedAt = new Date().toISOString();
    for (const d of snap.docs) {
      const rec = d.data();
      const disp = rec.displayName || rec.empName || "";
      const b = await db.collection("lineBindings").doc(d.id).get().catch(() => null);
      const bound = !!(b && b.exists && b.data().lineUserId);
      if (bound) {
        await linePush(b.data().lineUserId, `✅ 系統維護已完成${disp ? "，" + disp : ""}，現在可以正常登入使用了！`, token);
      }
      // 歸檔到歷史(可日後查誰登記等候)，再刪除登記
      await db.collection("maintenanceNotifyLog").add({
        uid: d.id, empName: rec.empName || "", displayName: rec.displayName || "", store: rec.store || "",
        registeredAt: rec.at || "", notifiedAt: endedAt, lineNotified: bound,
      }).catch(() => {});
      await d.ref.delete().catch(() => {}); // 通知後清除登記
    }
  }
);

// ===== 經營績效月快照：某月薪資發布 → 重算該月「全門市」perfSnapshot（含支援成本/工時）=====
async function computeMonthSnapshots(db, month) {
  const [y, mo] = month.split("-").map(Number);
  const lastDay = new Date(y, mo, 0).getDate();
  const weekSet = new Set();
  for (let d = 1; d <= lastDay; d++) weekSet.add(simpleWeekStr(new Date(y, mo - 1, d)));
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
    await computeMonthSnapshots(admin.firestore(), event.params.month);
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

// ============ 打卡/出勤 phase2 ============

// 台北 HH:MM
function tpHM(iso, ts) {
  const t = iso ? new Date(iso) : (ts && ts.toDate ? ts.toDate() : new Date());
  return new Date(t.getTime() + 8 * 3600000).toISOString().slice(11, 16);
}
// 解析員工 app 顯示名 + 登入權限（排班/缺卡用短名，通知用顯示名、判斷開放層級用權限）
async function resolveEmpInfo(db, empName) {
  const out = { displayName: empName, permission: "employee" };
  if (!empName) return out;
  let d = null;
  const s = await db.collection("account").where("empName", "==", empName).limit(1).get().catch(() => null);
  if (s && !s.empty) d = s.docs[0].data();
  if (!d || !d.permission) {
    const u = await db.collection("users").where("empName", "==", empName).limit(1).get().catch(() => null);
    if (u && !u.empty) d = Object.assign({}, d, u.docs[0].data());
  }
  if (d) { if (d.displayName) out.displayName = d.displayName; if (d.permission) out.permission = d.permission; }
  return out;
}
// 兩點距離(公尺)
function haversineM(la1, lo1, la2, lo2) {
  const R = 6371000, rad = (x) => x * Math.PI / 180;
  const dLa = rad(la2 - la1), dLo = rad(lo2 - lo1);
  const s = Math.sin(dLa / 2) ** 2 + Math.cos(rad(la1)) * Math.cos(rad(la2)) * Math.sin(dLo / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}
// 該權限在此開放層級是否已能打卡（對應 clock.html canClock）
function canClockPerm(stage, perm) {
  if (stage === "all") return true;
  if (stage === "manager") return ["manager", "owner", "admin"].includes(perm);
  if (stage === "admin") return perm === "admin";
  return false;
}
// 單店打卡開關：全面開放(all)時，本店需店長在出勤管理勾選啟用；其餘階段不受此限(依 stage 判定)
function storeClockOn(clk, store) {
  return (clk && clk.stage === "all") ? (((clk.enabledByStore) || {})[store] === true) : true;
}
// 單一員工通知：只查該員工的綁定(省讀取，不像 notifyEmployees 讀全表)
async function notifyOneEmp(db, empName, store, text, token) {
  if (!empName) return;
  const snap = await db.collection("lineBindings").where("empName", "==", empName).get().catch(() => null);
  if (!snap || snap.empty) return;
  const arr = []; snap.forEach((d) => arr.push(d.data()));
  const b = arr.find((x) => x.store === store) || arr[0];
  if (b && b.lineUserId) await linePush(b.lineUserId, text, token);
}

// A. 打卡事件 → 成功回執給員工；異常(遲到/早退)加通知店長(接收店+原店)
exports.onClockPunch = onDocumentWritten(
  { document: "stores/{store}/attendance/{id}", region: "asia-east1", secrets: [LINE_TOKEN] },
  async (event) => {
    if (event.data.before.exists || !event.data.after.exists) return; // 只在新建
    const db = admin.firestore();
    if (await maintenanceOn(db)) return;
    const r = event.data.after.data();
    if (!r || !r.empName || !r.type) return;
    if (r.source && r.source !== "app") return; // 系統缺卡/管理者補登另有通知
    const token = LINE_TOKEN.value();
    const atStore = r.atStore || fixStoreName(event.params.store);
    const homeStore = r.homeStore || atStore;
    // 店長可關閉該店打卡通知(不用打卡的店)：關閉時「員工自發打卡的成功回執仍發」，只不發異常/缺卡等系統主動通知
    const cfg = await db.collection("settings").doc("globalConfig").get().catch(() => null);
    const clk = (cfg && cfg.exists ? cfg.data().clockIn : {}) || {};
    const notifyOn = !(clk.notifyByStore && clk.notifyByStore[atStore] === false);
    const hm = tpHM(r.deviceTs, r.ts);
    const anomaly = r.status === "遲到" || r.status === "早退";
    const note = r.status === "遲到" ? `（遲到 ${r.lateMin || ""} 分）`
      : r.status === "早退" ? "（早退）"
      : r.status === "警告" ? `（遲到 ${r.lateMin || ""} 分・容許內）`
      : r.status === "到場" ? "（到場記錄）" : "";
    await notifyOneEmp(db, r.empName, homeStore, `✅ 打卡成功\n${r.type}　${hm}　@${atStore}${note}`, token);
    if (notifyOn && anomaly) {
      const dn = r.displayName || r.empName;
      const mtext = `⚠️ 出勤異常\n${dn}（${homeStore}）於 ${atStore} ${r.type} ${hm}${note}\n請至「出勤管理」查看。`;
      await notifyStoreManagers(db, atStore, mtext, token);
      if (homeStore && homeStore !== atStore) await notifyStoreManagers(db, homeStore, mtext, token);
    }
    // 加班申請一律通知店長審核(不受打卡通知開關影響——這是核決流程)
    if (r.otIntent === "apply") {
      const dn = r.displayName || r.empName;
      await notifyStoreManagers(db, atStore, `📝 加班申請待審核\n${dn}（${homeStore}）${r.type} ${hm} @${atStore}\n事由：${r.otContent || "—"}\n請至「出勤管理」審核，同意後記得調整排班表。`, token);
    }
  }
);

// B. 補登/修改申請 → 送出通知店長；核准/駁回通知員工
exports.onAttendanceRequest = onDocumentWritten(
  { document: "stores/{store}/attendanceRequests/{id}", region: "asia-east1", secrets: [LINE_TOKEN] },
  async (event) => {
    const db = admin.firestore();
    const before = event.data.before.exists ? event.data.before.data() : null;
    const after = event.data.after.exists ? event.data.after.data() : null;
    if (!after) return;
    const token = LINE_TOKEN.value();
    const store = after.atStore || fixStoreName(event.params.store);
    const dn = after.displayName || after.empName;
    const when = `${after.targetDate || ""} ${after.punchType || ""} ${after.requestedTime || ""}`.trim();
    if (!before && after.status === "pending") {
      await notifyStoreManagers(db, store,
        `📝 出勤${after.type || "補登"}申請\n${dn} 申請：${when}\n原因：${after.reason || "—"}\n請至「出勤管理」審核。`, token);
      return;
    }
    if (before && before.status === "pending" && after.status && after.status !== "pending") {
      const res = after.status === "approved" ? "✅ 已核准" : "❌ 已駁回";
      await notifyOneEmp(db, after.empName, after.homeStore || store, `${res}　出勤${after.type || "補登"}申請\n${when}${after.reviewNote ? `\n備註：${after.reviewNote}` : ""}`, token);
    }
  }
);

// C. 缺卡排程：每小時，班別結束後 2 小時仍無打卡 → 標記+通知(去重)
exports.scheduledMissingClock = onSchedule(
  { schedule: "5 * * * *", timeZone: "Asia/Taipei", region: "asia-east1", secrets: [LINE_TOKEN] },
  async () => {
    const db = admin.firestore();
    if (await maintenanceOn(db)) return;
    const cfg = await db.collection("settings").doc("globalConfig").get().catch(() => null);
    const conf = cfg && cfg.exists ? cfg.data() : {};
    const stage = conf.clockIn && conf.clockIn.stage;
    if (!stage || stage === "off") return; // 關閉不判；其餘依個別員工「開放層級」判定(見下 canClockPerm)
    const stores = (conf.stores || []).filter((s) => s !== "人力支援");
    const token = LINE_TOKEN.value();
    const nowTp = new Date(Date.now() + 8 * 3600000);
    const ds = nowTp.toISOString().slice(0, 10);
    const nowMin = nowTp.getUTCHours() * 60 + nowTp.getUTCMinutes();
    const wk = simpleWeekStr(nowTp);
    const dayName = WEEK_DAYS[(nowTp.getUTCDay() + 6) % 7];
    const notifyBy = conf.clockIn.notifyByStore || {};
    for (const store of stores) {
      if (!storeClockOn(conf.clockIn || {}, store)) continue; // 全面開放下本店未開啟打卡 → 不判缺卡
      if (notifyBy[store] === false) continue; // 該店關閉打卡通知 → 不判缺卡
      const wd = await db.collection("stores").doc(store).collection("weeks").doc(wk).get().catch(() => null);
      if (!wd || !wd.exists) continue;
      const recs = wd.data().records || [];
      const esSnap = await db.collection("stores").doc(store).collection("employees").get().catch(() => null);
      const statusMap = {}; if (esSnap) esSnap.forEach((d) => { const e = d.data() || {}; statusMap[d.id] = { status: e.status || "", eff: e.retireDate || e.transferDate || "" }; });
      // 排除派出店的「支援X」顯示記錄(loc=支援)＝跨店去重，只認接收店 supportEmp 那筆
      const shifts = recs.filter((r) => r.day === dayName && /^\d{1,2}-\d{1,2}$/.test(String(r.shift || "")) && !String(r.location || "").startsWith("支援"));
      if (!shifts.length) continue;
      const attSnap = await db.collection("stores").doc(store).collection("attendance").where("date", "==", ds).get().catch(() => null);
      const punches = []; if (attSnap) attSnap.forEach((d) => punches.push(d.data()));
      for (const sh of shifts) {
        const m = String(sh.shift).match(/^(\d{1,2})-(\d{1,2})$/);
        if (+m[2] <= +m[1]) continue; // 跨日班先略過
        if (nowMin < (+m[2]) * 60 + 120) continue; // 未到「結束後 2 小時」
        const isSupport = sh.supportEmp && sh.approvalStatus === "approved";
        const emp = (sh.name && !String(sh.name).startsWith("🆘")) ? sh.name
          : (isSupport ? sh.supportEmp.slice(sh.supportEmp.indexOf("-") + 1) : "");
        if (!emp) continue;
        // 離職/調走「生效日(含)後」才跳過；生效日前仍在職 → 照常判缺卡
        const sInfo = statusMap[emp] || {};
        if (!isSupport && ["離職", "調走"].includes(sInfo.status) && (!sInfo.eff || ds >= sInfo.eff)) continue;
        const homeStore = isSupport ? sh.supportEmp.slice(0, sh.supportEmp.indexOf("-")) : store;
        const empPunches = punches.filter((p) => p.empName === emp);
        const hasIn = empPunches.some((p) => p.type === "上班");
        const hasOut = empPunches.some((p) => p.type === "下班");
        if (hasIn && hasOut) continue;
        // 只對「該開放層級已能打卡」的人發缺卡（如 stage=manager 只發店長，不發一般員工）
        const info = await resolveEmpInfo(db, emp);
        if (!canClockPerm(stage, info.permission)) continue;
        const flagId = ("miss_" + ds + "_" + emp + "_" + sh.shift).replace(/[^\w一-龥]/g, "_");
        const flagRef = db.collection("stores").doc(store).collection("attendance").doc(flagId);
        const exist = await flagRef.get().catch(() => null);
        if (exist && exist.exists) continue;
        const missWhat = (!hasIn && !hasOut) ? "整天未打卡" : (!hasIn ? "缺上班卡" : "缺下班卡");
        const dn = info.displayName;
        await flagRef.set({
          empName: emp, displayName: dn, date: ds, type: "缺卡", atStore: store, homeStore,
          shift: sh.shift, status: "缺卡", note: missWhat, source: "system",
          // 缺卡＝沒有打卡時間：不寫 deviceTs/tsMs(否則出勤表會顯示成像有打卡的掃描時間)；等手動補卡才有真時間
          ts: admin.firestore.FieldValue.serverTimestamp(), deviceTs: null, tsMs: null,
        });
        await notifyOneEmp(db, emp, homeStore, `🔴 缺卡提醒\n你 ${ds} 在 ${store} 的班別 ${sh.shift} ${missWhat}，如有出勤請盡快申請補登。\n\n👉 立即補登：https://glade9001.github.io/store-schedule/my-attendance.html`, token);
        await notifyStoreManagers(db, store, `🔴 缺卡\n${dn} ${ds} ${store} 班別 ${sh.shift} ${missWhat}。`, token);
      }

      // 昨日「跨日班(夜班)」的下班卡落在今天：到「下班+2h」才統一判上/下班缺卡，不拆成兩天
      const yTp = new Date(Date.now() + 8 * 3600000 - 86400000);
      const dsY = yTp.toISOString().slice(0, 10);
      const yName = WEEK_DAYS[(yTp.getUTCDay() + 6) % 7];
      const wkY = simpleWeekStr(yTp);
      const wdY = (wkY === wk) ? wd : await db.collection("stores").doc(store).collection("weeks").doc(wkY).get().catch(() => null);
      const recsY = (wdY && wdY.exists) ? (wdY.data().records || []) : [];
      const yShifts = recsY.filter((r) => r.day === yName && !String(r.location || "").startsWith("支援") && (() => { const mm = String(r.shift || "").match(/^(\d{1,2})-(\d{1,2})$/); return mm && +mm[2] <= +mm[1]; })());
      if (yShifts.length) {
        const attSnapY = await db.collection("stores").doc(store).collection("attendance").where("date", "==", dsY).get().catch(() => null);
        const punchesY = []; if (attSnapY) attSnapY.forEach((d) => punchesY.push(d.data()));
        for (const sh of yShifts) {
          const mm = String(sh.shift).match(/^(\d{1,2})-(\d{1,2})$/);
          if (nowMin < (+mm[2]) * 60 + 120) continue; // 今天還沒到「下班+2 小時」
          const isSupport = sh.supportEmp && sh.approvalStatus === "approved";
          const emp = (sh.name && !String(sh.name).startsWith("🆘")) ? sh.name
            : (isSupport ? sh.supportEmp.slice(sh.supportEmp.indexOf("-") + 1) : "");
          if (!emp) continue;
          const sInfo = statusMap[emp] || {};
          if (!isSupport && ["離職", "調走"].includes(sInfo.status) && (!sInfo.eff || dsY >= sInfo.eff)) continue;
          const homeStore = isSupport ? sh.supportEmp.slice(0, sh.supportEmp.indexOf("-")) : store;
          const hasInY = punchesY.some((p) => p.empName === emp && p.type === "上班"); // 昨天的上班
          const hasOutT = punches.some((p) => p.empName === emp && p.type === "下班"); // 今天的下班
          if (hasInY && hasOutT) continue;
          const info = await resolveEmpInfo(db, emp);
          if (!canClockPerm(stage, info.permission)) continue;
          const flagId = ("miss_" + dsY + "_" + emp + "_" + sh.shift).replace(/[^\w一-龥]/g, "_");
          const flagRef = db.collection("stores").doc(store).collection("attendance").doc(flagId);
          const exist = await flagRef.get().catch(() => null);
          if (exist && exist.exists) continue;
          const missWhat = (!hasInY && !hasOutT) ? "整天未打卡" : (!hasInY ? "缺上班卡" : "缺下班卡");
          const dn = info.displayName;
          await flagRef.set({
            empName: emp, displayName: dn, date: dsY, type: "缺卡", atStore: store, homeStore,
            shift: sh.shift, status: "缺卡", note: missWhat + "(跨日班)", source: "system",
            // 缺卡＝沒有打卡時間：不寫 deviceTs/tsMs；等手動補卡才有真時間
            ts: admin.firestore.FieldValue.serverTimestamp(), deviceTs: null, tsMs: null,
          });
          await notifyOneEmp(db, emp, homeStore, `🔴 缺卡提醒\n你 ${dsY} 在 ${store} 的跨日班別 ${sh.shift} ${missWhat}，如有出勤請盡快申請補登。\n\n👉 立即補登：https://glade9001.github.io/store-schedule/my-attendance.html`, token);
          await notifyStoreManagers(db, store, `🔴 缺卡\n${dn} ${dsY} ${store} 跨日班別 ${sh.shift} ${missWhat}。`, token);
        }
      }
    }
  }
);

// 打卡提醒（員工自行開啟）：依排班時間，上班前 X 分鐘 / 下班時間 LINE 提醒打卡。
// 偏好存 clockRemindPrefs/{empName} = {inBefore:分鐘(0=關), outRemind:bool}。每 5 分跑一次，5 分視窗+去重。
exports.scheduledClockRemind = onSchedule(
  { schedule: "*/5 * * * *", timeZone: "Asia/Taipei", region: "asia-east1", secrets: [LINE_TOKEN] },
  async () => {
    const db = admin.firestore();
    if (await maintenanceOn(db)) return;
    const cfg = await db.collection("settings").doc("globalConfig").get().catch(() => null);
    const conf = cfg && cfg.exists ? cfg.data() : {};
    const stage = conf.clockIn && conf.clockIn.stage;
    if (!stage || stage === "off") return;
    const prefsSnap = await db.collection("clockRemindPrefs").get().catch(() => null);
    if (!prefsSnap || prefsSnap.empty) return; // 沒人開提醒 → 早退省讀取
    const prefs = {}; prefsSnap.forEach((d) => { prefs[d.id] = d.data() || {}; });
    const stores = (conf.stores || []).filter((s) => s !== "人力支援");
    const token = LINE_TOKEN.value();
    const nowMs = Date.now();
    const nowTp = new Date(nowMs + 8 * 3600000);
    const ds = nowTp.toISOString().slice(0, 10);
    const wk = simpleWeekStr(nowTp);
    const dayName = WEEK_DAYS[(nowTp.getUTCDay() + 6) % 7];
    const WIN = 5 * 60000; // cron 週期＝視窗長度
    for (const store of stores) {
      if (!storeClockOn(conf.clockIn || {}, store)) continue; // 全面開放下本店未開啟打卡 → 不提醒
      const wd = await db.collection("stores").doc(store).collection("weeks").doc(wk).get().catch(() => null);
      if (!wd || !wd.exists) continue;
      const recs = (wd.data().records || []).filter((r) => r.day === dayName && /^\d{1,2}-\d{1,2}$/.test(String(r.shift || "")) && !String(r.location || "").startsWith("支援"));
      if (!recs.length) continue;
      const esSnap = await db.collection("stores").doc(store).collection("employees").get().catch(() => null);
      const statusMap = {}; if (esSnap) esSnap.forEach((d) => { const e = d.data() || {}; statusMap[d.id] = { status: e.status || "", eff: e.retireDate || e.transferDate || "" }; });
      let attSnap = null;
      for (const r of recs) {
        const isSupport = r.supportEmp && r.approvalStatus === "approved";
        const emp = (r.name && !String(r.name).startsWith("🆘")) ? r.name : (isSupport ? r.supportEmp.slice(r.supportEmp.indexOf("-") + 1) : "");
        if (!emp) continue;
        const pref = prefs[emp];
        if (!pref || (!(Number(pref.inBefore) > 0) && !pref.outRemind)) continue;
        const sInfo = statusMap[emp] || {};
        if (!isSupport && ["離職", "調走"].includes(sInfo.status) && (!sInfo.eff || ds >= sInfo.eff)) continue;
        const homeStore = isSupport ? r.supportEmp.slice(0, r.supportEmp.indexOf("-")) : store;
        const info = await resolveEmpInfo(db, emp);
        if (!canClockPerm(stage, info.permission)) continue;
        const m = String(r.shift).match(/^(\d{1,2})-(\d{1,2})$/);
        const a = +m[1], b = +m[2], dur = (b <= a ? b + 24 : b) - a;
        const startMs = Date.parse(`${ds}T${String(a).padStart(2, "0")}:00:00+08:00`);
        const endMs = startMs + dur * 3600000;
        const inBefore = Number(pref.inBefore) || 0;
        const wantIn = inBefore > 0 && nowMs >= startMs - inBefore * 60000 && nowMs < startMs - inBefore * 60000 + WIN;
        const wantOut = !!pref.outRemind && nowMs >= endMs && nowMs < endMs + WIN;
        if (!wantIn && !wantOut) continue;
        // 讀今日該店打卡（延後到確定有人要提醒才讀）
        if (!attSnap) { attSnap = []; const s = await db.collection("stores").doc(store).collection("attendance").where("date", "==", ds).get().catch(() => null); if (s) s.forEach((d) => attSnap.push(d.data())); }
        const empPunches = attSnap.filter((p) => p.empName === emp);
        const hasIn = empPunches.some((p) => p.type === "上班");
        const hasOut = empPunches.some((p) => p.type === "下班");
        const send = async (kind, msg) => {
          const flagId = ("remind_" + ds + "_" + emp + "_" + r.shift + "_" + kind).replace(/[^\w一-龥]/g, "_");
          const fref = db.collection("stores").doc(store).collection("clockRemindLog").doc(flagId);
          const ex = await fref.get().catch(() => null);
          if (ex && ex.exists) return;
          await fref.set({ empName: emp, date: ds, shift: r.shift, kind, ts: admin.firestore.FieldValue.serverTimestamp() });
          await notifyOneEmp(db, emp, homeStore, msg, token);
        };
        if (wantIn && !hasIn) await send("in", `⏰ 上班打卡提醒\n你今天在 ${store} 的班別 ${r.shift} 即將開始（${inBefore} 分鐘後），記得到店打卡上班。`);
        if (wantOut && hasIn && !hasOut) await send("out", `⏰ 下班打卡提醒\n你今天在 ${store} 的班別 ${r.shift} 已到下班時間，記得打卡下班。`);
      }
    }
  }
);

// ============ 打卡 callable（伺服器權威：時間/圍欄/狀態全後端判定）============
exports.clockPunch = onCall({ region: "asia-east1" }, async (request) => {
  const auth = request.auth;
  if (!auth) throw new HttpsError("unauthenticated", "請先登入");
  const db = admin.firestore();
  const userSnap = await db.collection("users").doc(auth.uid).get();
  const user = userSnap.exists ? userSnap.data() : null;
  if (!user || !user.empName) throw new HttpsError("permission-denied", "查無使用者");
  const empName = user.empName, homeStore = user.store || "", perm = user.permission || "employee";
  const cfgSnap = await db.collection("settings").doc("globalConfig").get();
  const conf = cfgSnap.exists ? cfgSnap.data() : {};
  const clk = conf.clockIn || {};
  if (!canClockPerm(clk.stage || "off", perm)) throw new HttpsError("failed-precondition", "打卡功能尚未對您開放");
  const d = request.data || {};
  const lat = Number(d.lat), lng = Number(d.lng), type = d.type;
  if (!isFinite(lat) || !isFinite(lng)) throw new HttpsError("invalid-argument", "缺少定位資訊");
  if (!["上班", "下班"].includes(type)) throw new HttpsError("invalid-argument", "打卡類型錯誤");
  // 後端複驗圍欄
  const geo = clk.geo || {};
  let atStore = "", distanceM = null;
  for (const st of Object.keys(geo)) {
    const g = geo[st] || {};
    if (typeof g.lat !== "number" || typeof g.lng !== "number") continue;
    const dist = haversineM(lat, lng, g.lat, g.lng);
    if (dist <= (g.radiusM || 120) && (atStore === "" || dist < distanceM)) { atStore = st; distanceM = Math.round(dist); }
  }
  if (!atStore) throw new HttpsError("failed-precondition", "不在任何門市範圍內，無法打卡");
  if (!storeClockOn(clk, atStore)) throw new HttpsError("failed-precondition", "此門市打卡功能尚未開啟");
  // 伺服器時間(台北)
  const nowMs = Date.now();
  const nowTp = new Date(nowMs + 8 * 3600000);
  const ds = nowTp.toISOString().slice(0, 10);
  const nowMin = nowTp.getUTCHours() * 60 + nowTp.getUTCMinutes();
  const attCol = db.collection("stores").doc(atStore).collection("attendance");
  const todaySnap = await attCol.where("date", "==", ds).where("empName", "==", empName).get();
  const punches = []; todaySnap.forEach((x) => punches.push(x.data()));
  // 防抖 10 分 + 上班後 5 分不能下班
  if (punches.some((p) => p.type === type && p.tsMs && (nowMs - p.tsMs) < 10 * 60000)) throw new HttpsError("failed-precondition", `剛剛已${type}打卡，10 分鐘內不用再打`);
  if (type === "下班") {
    const lastIn = Math.max(0, ...punches.filter((p) => p.type === "上班").map((p) => p.tsMs || 0));
    if (lastIn && (nowMs - lastIn) < 5 * 60000) throw new HttpsError("failed-precondition", "上班後 5 分鐘內不能打下班");
  }
  // 排班候選(昨/今/明三天，換算絕對時間) → 依排班表、跨日、視窗比對，並決定歸班日 shiftDate
  const wk = simpleWeekStr(nowTp);
  const dayName = WEEK_DAYS[(nowTp.getUTCDay() + 6) % 7];
  const wd = await db.collection("stores").doc(atStore).collection("weeks").doc(wk).get();
  const dayShifts = async (tpDate) => {
    const wkk = simpleWeekStr(tpDate);
    const dn = WEEK_DAYS[(tpDate.getUTCDay() + 6) % 7];
    const dss = tpDate.toISOString().slice(0, 10);
    const wdd = (wkk === wk) ? wd : await db.collection("stores").doc(atStore).collection("weeks").doc(wkk).get().catch(() => null);
    const out = [];
    if (wdd && wdd.exists) (wdd.data().records || []).forEach((r) => {
      if (r.day !== dn) return;
      const mine = (r.name === empName) || (r.supportEmp === `${homeStore}-${empName}` && r.approvalStatus === "approved");
      if (!mine) return;
      const m = String(r.shift || "").match(/^(\d{1,2})-(\d{1,2})$/);
      if (!m) return;
      const a = +m[1], b = +m[2], dur = (b <= a ? b + 24 : b) - a;
      const startMs = Date.parse(`${dss}T${String(a).padStart(2, "0")}:00:00+08:00`);
      out.push({ shift: r.shift, shiftDate: dss, startMs, endMs: startMs + dur * 3600000 });
    });
    return out;
  };
  const cand = [...await dayShifts(new Date(nowMs + 8 * 3600000 - 86400000)), ...await dayShifts(nowTp), ...await dayShifts(new Date(nowMs + 8 * 3600000 + 86400000))];
  const tol = (clk.tolByStore && clk.tolByStore[atStore] != null) ? clk.tolByStore[atStore]
            : (clk.lateToleranceMin != null ? clk.lateToleranceMin : 10);
  let status = "正常", lateMin = 0, matchedShift = "", shiftDate = ds;
  if (type === "上班") {
    // 視窗：排班起點前 1 小時 ~ 後 4 小時，取最近的班
    const win = cand.filter((c) => nowMs >= c.startMs - 3600000 && nowMs <= c.startMs + 4 * 3600000);
    if (win.length) {
      win.sort((x, y) => Math.abs(nowMs - x.startMs) - Math.abs(nowMs - y.startMs));
      const s = win[0]; matchedShift = s.shift; shiftDate = s.shiftDate;
      const late = Math.round((nowMs - s.startMs) / 60000);
      if (late > tol) { status = "遲到"; lateMin = late; } else if (late > 0) { status = "警告"; lateMin = late; }
    } else { status = "到場"; }
  } else { // 下班：跨日時間序列配對，找尚未打下班的上班 → 歸同一班(shiftDate)、以其排班結束判早退
    // 不能用同日筆數判斷：連續夜班時同一日曆日會同時含「收前晚班」+「開當晚班」使筆數打平而漏配。
    const dsY = new Date(nowMs + 8 * 3600000 - 86400000).toISOString().slice(0, 10);
    const seq = [];
    for (const dd of [dsY, ds]) {
      const sn = await attCol.where("date", "==", dd).where("empName", "==", empName).get();
      sn.forEach((x) => { const p = x.data(); if (p.type === "上班" || p.type === "下班") seq.push(p); });
    }
    seq.sort((a, b) => (a.tsMs || 0) - (b.tsMs || 0));
    const stack = []; seq.forEach((p) => { if (p.type === "上班") stack.push(p); else stack.pop(); });
    const openIn = stack.length ? stack[stack.length - 1] : null;
    if (openIn) {
      shiftDate = openIn.shiftDate || openIn.date || ds;
      matchedShift = openIn.shift || "";
      if (!matchedShift) { status = "到場"; }
      else { const s = cand.find((c) => c.shift === matchedShift && c.shiftDate === shiftDate); if (s && nowMs < s.endMs) status = "早退"; }
    } else {
      const win = cand.filter((c) => nowMs >= c.endMs - 4 * 3600000 && nowMs <= c.endMs + 3600000);
      if (win.length) { win.sort((x, y) => Math.abs(nowMs - x.endMs) - Math.abs(nowMs - y.endMs)); const s = win[0]; matchedShift = s.shift; shiftDate = s.shiftDate; if (nowMs < s.endMs) status = "早退"; }
      else { status = "到場"; }
    }
  }
  const info = await resolveEmpInfo(db, empName);
  const deviceTs = new Date(nowMs).toISOString();
  // 防代打卡對比：手機端當下時間、與伺服器時間差、裝置資訊、打卡方式
  const clientMs = d.clientTime ? Date.parse(d.clientTime) : (typeof d.clientMs === "number" ? d.clientMs : NaN);
  const timeSkewMs = isFinite(clientMs) ? (nowMs - clientMs) : null;
  const deviceInfo = String(d.deviceInfo || "").slice(0, 180);
  // 加班事前防呆：非排班時段打卡的意向(apply=申請加班待審／private=不計工時)
  // private 分兩種用途：①上班/未排班「到場」→只保留給 admin(巡店)；②下班晚打「非加班·私事/忘記」→開放全員(有下班紀錄但不計工時、避免勞基法加班疑慮)。
  // 因此 private 僅在「admin」或「下班」時採用；一般員工的上班 private 一律忽略成正常打卡。
  const otIntent = (d.otIntent === "apply" || (d.otIntent === "private" && (perm === "admin" || type === "下班"))) ? d.otIntent : null;
  await attCol.add({
    empName, displayName: info.displayName, date: ds, shiftDate, weekday: dayName, type, atStore, homeStore,
    lat, lng, accuracy: (typeof d.accuracy === "number" ? d.accuracy : null), distanceM,
    shift: matchedShift, status, lateMin,
    ts: admin.firestore.FieldValue.serverTimestamp(), tsMs: nowMs, deviceTs, source: "app",
    clientTime: (isFinite(clientMs) ? new Date(clientMs).toISOString() : null), timeSkewMs,
    deviceInfo: deviceInfo || null, punchMethod: (d.punchMethod || "GPS"),
    otIntent, otContent: otIntent ? String(d.otContent || "").slice(0, 300) : "",
    otStatus: otIntent === "apply" ? "pending" : (otIntent === "private" ? "private" : null),
  });
  return { ok: true, atStore, distanceM, status, lateMin, hm: nowTp.toISOString().slice(11, 16) };
});

// 伺服器時間（給打卡畫面校時用，避免手機本機時間不準）
exports.serverNow = onCall({ region: "asia-east1" }, async () => {
  const nowMs = Date.now();
  return { nowMs, iso: new Date(nowMs).toISOString(), tp: new Date(nowMs + 8 * 3600000).toISOString() };
});

// 分享本月營運檢討：管理者按分享→LINE 通知各店店長＋加盟主，附 3 天有效連結(sharedReviews 前端已建)。
exports.shareMonthlyReview = onCall({ region: "asia-east1", secrets: [LINE_TOKEN] }, async (request) => {
  const auth = request.auth;
  if (!auth) throw new HttpsError("unauthenticated", "請先登入");
  const db = admin.firestore();
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
  const token = LINE_TOKEN.value();
  const [yy, mm] = ym.split("-");
  const msg = `📋 ${yy}年${+mm}月 三店營運檢討\n\n加盟主已發布本月營運檢討報告，請點連結查看完整數據與檢討：\n${url}\n\n（此連結 3 天後自動失效）`;
  const sent = [], seen = new Set();
  for (const r of recips) {
    if (seen.has(r.emp)) continue; seen.add(r.emp);
    await notifyOneEmp(db, r.emp, r.store, msg, token);
    sent.push(r.emp);
  }
  return { ok: true, count: sent.length };
});

// 離線打卡補傳：訊號不佳時前端暫存、恢復連線後補傳。以「手機當下時間」為打卡時間，標記待店長複核。
exports.clockPunchOffline = onCall({ region: "asia-east1", secrets: [LINE_TOKEN] }, async (request) => {
  const auth = request.auth;
  if (!auth) throw new HttpsError("unauthenticated", "請先登入");
  const db = admin.firestore();
  const userSnap = await db.collection("users").doc(auth.uid).get();
  const user = userSnap.exists ? userSnap.data() : null;
  if (!user || !user.empName) throw new HttpsError("permission-denied", "查無使用者");
  const empName = user.empName, homeStore = user.store || "", perm = user.permission || "employee";
  const cfgSnap = await db.collection("settings").doc("globalConfig").get();
  const conf = cfgSnap.exists ? cfgSnap.data() : {};
  const clk = conf.clockIn || {};
  if (!canClockPerm(clk.stage || "off", perm)) throw new HttpsError("failed-precondition", "打卡功能尚未對您開放");
  const d = request.data || {};
  const lat = Number(d.lat), lng = Number(d.lng), type = d.type;
  if (!isFinite(lat) || !isFinite(lng)) throw new HttpsError("invalid-argument", "缺少定位資訊");
  if (!["上班", "下班"].includes(type)) throw new HttpsError("invalid-argument", "打卡類型錯誤");
  const cptMs = Date.parse(d.clientPunchTime || "");
  if (!isFinite(cptMs)) throw new HttpsError("invalid-argument", "缺少打卡時間");
  // 複驗圍欄（座標為離線當下 GPS）
  const geo = clk.geo || {};
  let atStore = "", distanceM = null;
  for (const st of Object.keys(geo)) {
    const g = geo[st] || {};
    if (typeof g.lat !== "number" || typeof g.lng !== "number") continue;
    const dist = haversineM(lat, lng, g.lat, g.lng);
    if (dist <= (g.radiusM || 120) && (atStore === "" || dist < distanceM)) { atStore = st; distanceM = Math.round(dist); }
  }
  if (!atStore) throw new HttpsError("failed-precondition", "打卡座標不在任何門市範圍內");
  if (!storeClockOn(clk, atStore)) throw new HttpsError("failed-precondition", "此門市打卡功能尚未開啟");
  const nowMs = Date.now(); // 伺服器收到補傳的時間
  const punchTp = new Date(cptMs + 8 * 3600000); // 手機打卡當下(台北)
  const ds = punchTp.toISOString().slice(0, 10);
  const nowMin = punchTp.getUTCHours() * 60 + punchTp.getUTCMinutes();
  const dayName = WEEK_DAYS[(punchTp.getUTCDay() + 6) % 7];
  const attCol = db.collection("stores").doc(atStore).collection("attendance");
  // 去重：同型別、與現有某筆打卡時間相差 10 分內 → 視為重複，直接略過
  const todaySnap = await attCol.where("date", "==", ds).where("empName", "==", empName).get();
  let dup = false; todaySnap.forEach((x) => { const p = x.data(); if (p.type === type && p.tsMs && Math.abs(cptMs - p.tsMs) < 10 * 60000) dup = true; });
  if (dup) return { ok: true, duplicated: true };
  // 上班後 5 分內不能下班（與線上打卡一致）；違反則略過(不入帳、不重試)
  if (type === "下班") {
    let lastIn = 0; todaySnap.forEach((x) => { const p = x.data(); if (p.type === "上班" && p.tsMs) lastIn = Math.max(lastIn, p.tsMs); });
    if (lastIn && (cptMs - lastIn) < 5 * 60000) return { ok: true, skipped: "上班後5分內" };
  }
  // 依手機時間盡力判定狀態（僅供參考，實際以店長複核為準）
  const wk = simpleWeekStr(punchTp);
  const wd = await db.collection("stores").doc(atStore).collection("weeks").doc(wk).get();
  const shifts = [];
  if (wd.exists) (wd.data().records || []).forEach((r) => {
    if (r.day !== dayName) return;
    const mine = (r.name === empName) || (r.supportEmp === `${homeStore}-${empName}` && r.approvalStatus === "approved");
    if (!mine) return;
    const m = String(r.shift || "").match(/^(\d{1,2})-(\d{1,2})$/);
    if (m) shifts.push({ shift: r.shift, start: +m[1], end: +m[2] });
  });
  const tol = (clk.tolByStore && clk.tolByStore[atStore] != null) ? clk.tolByStore[atStore]
            : (clk.lateToleranceMin != null ? clk.lateToleranceMin : 10);
  let status = "正常", lateMin = 0, matchedShift = "";
  if (!shifts.length) { status = "到場"; }
  else if (type === "上班") {
    let best = null; shifts.forEach((s) => { const dd = Math.abs(s.start * 60 - nowMin); if (!best || dd < best.d) best = { s, d: dd }; });
    matchedShift = best.s.shift; const late = nowMin - best.s.start * 60;
    if (late > tol) { status = "遲到"; lateMin = late; } else if (late > 0) { status = "警告"; lateMin = late; }
  } else {
    let best = null; shifts.forEach((s) => { let e = s.end * 60; if (s.end <= s.start) e += 1440; const dd = Math.abs(e - nowMin); if (!best || dd < best.d) best = { s, d: dd }; });
    matchedShift = best.s.shift; let endMin = best.s.end * 60; if (best.s.end <= best.s.start) endMin += 1440; let cur = nowMin; if (best.s.end <= best.s.start && punchTp.getUTCHours() < best.s.start) cur += 1440;
    if (cur < endMin) status = "早退";
  }
  const info = await resolveEmpInfo(db, empName);
  const deviceInfo = String(d.deviceInfo || "").slice(0, 180);
  await attCol.add({
    empName, displayName: info.displayName, date: ds, weekday: dayName, type, atStore, homeStore,
    lat, lng, accuracy: (typeof d.accuracy === "number" ? d.accuracy : null), distanceM,
    shift: matchedShift, status, lateMin,
    ts: admin.firestore.FieldValue.serverTimestamp(), tsMs: cptMs, deviceTs: new Date(cptMs).toISOString(),
    clientTime: new Date(cptMs).toISOString(), source: "offline", needReview: true,
    receivedTs: admin.firestore.FieldValue.serverTimestamp(), receivedDelayMs: (nowMs - cptMs),
    deviceInfo: deviceInfo || null, punchMethod: (d.punchMethod || "GPS"),
  });
  const notifyOn = !(clk.notifyByStore && clk.notifyByStore[atStore] === false);
  const hm = punchTp.toISOString().slice(11, 16);
  if (notifyOn) {
    const token = LINE_TOKEN.value();
    await notifyStoreManagers(db, atStore, `📴 離線補傳待核\n${info.displayName} ${ds} ${hm} ${type} @${atStore}（手機時間），請至出勤管理核對。`, token);
  }
  return { ok: true, atStore, status, hm };
});
